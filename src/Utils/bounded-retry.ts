/**
 * Bounded retry — WhatsApp-aligned per-operation retry without global state.
 *
 * # Why this exists
 *
 * Replaces the circuit breaker pattern that was causing cascading failures
 * in production: 5 timeouts in 60s would trip the global breaker, blocking
 * EVERY socket query (typing indicators, profile pic fetches, contact
 * validation, presence updates) for 30s — even queries to peers that were
 * perfectly healthy.
 *
 * # Empirical justification
 *
 * Captured WhatsApp Android's actual retry behavior via Frida hooks
 * (`hook-circuit-breaker-re-v2.js`, `hook-retry-bounds.js`) on a real
 * device under controlled WiFi off/on cycles. Findings:
 *
 *   1. Delay sequence (per-operation): 3s -> 10s -> 60s -> ~64s -> 120s
 *      (cap at 2 min). Last value reused for further attempts.
 *   2. Memory profile during 5-min network outage: PSS dropped 53MB and
 *      stabilised. FDs closed (305 -> 295). NO unbounded accumulation.
 *   3. Recovery on reconnect: ~10s. No retry storm.
 *   4. NO global state machine observed. Each operation has its own timer.
 *      Failures of operation A do NOT block operation B.
 *
 * The default delays in WHATSAPP_BACKOFF_DELAYS below match the captured
 * sequence directly. The default 10-min TTL is empirical 3-5 min stability
 * + safety buffer.
 *
 * # Design properties
 *
 * - Per-operation isolation: each call to `withBoundedRetry` has its own
 *   timer. No shared state. Operation A failing has zero effect on B.
 * - Bounded by `ttlMs` (wall-clock budget). The TTL is enforced strictly
 *   at three points: (a) before each attempt, (b) cap on per-attempt
 *   timeout, (c) cap on retry delay.
 * - Per-attempt timeout: each attempt has its own deadline (default 30s),
 *   automatically capped to remaining TTL budget so total runtime never
 *   exceeds ttlMs.
 * - AbortSignal cancellation: external cancellation supported, both for
 *   the sleep between retries AND (optionally) the in-flight operation
 *   when the operation accepts a signal parameter.
 * - Memory bound: at most one outstanding retry timer per call. Listeners
 *   are explicitly removed when timers settle. Once the call resolves /
 *   rejects / aborts, all state is freed.
 *
 * # Logging
 *
 * Pass `logger` in options to get structured logs at each retry attempt,
 * give-up, and post-failure recovery. The module emits Prometheus metrics
 * regardless of whether a logger is provided.
 *
 * # When to use this vs. plain query()
 *
 * - Use plain `query()` when you want fast-fail semantics (caller decides
 *   what to do on failure). Most call sites in InfiniteAPI use this.
 * - Use `withBoundedRetry(() => query(...), { name: 'X' })` when the
 *   operation is "must-eventually-succeed" with no upstream retry — e.g.
 *   `uploadPreKeys` or other write paths where the alternative is data loss.
 *
 * # Examples
 *
 * ```ts
 * // Single attempt with 5-min TTL, give up after that:
 * await withBoundedRetry(
 *   () => assertSessions([jid], true),
 *   { name: 'assertSessions', ttlMs: 5 * 60_000, logger }
 * )
 *
 * // Tight deadline, fast give-up:
 * await withBoundedRetry(
 *   () => sendNode(node),
 *   { name: 'send', ttlMs: 30_000, perAttemptTimeoutMs: 5_000 }
 * )
 *
 * // Operation that respects abort signal (best practice):
 * await withBoundedRetry(
 *   (signal) => fetchSomething({ signal }),
 *   { name: 'fetch', logger }
 * )
 * ```
 *
 * @module Utils/bounded-retry
 */

import type { ILogger } from './logger'
import { metrics } from './prometheus-metrics.js'

/**
 * Default delay sequence (milliseconds) — matches WhatsApp Android empirical
 * behavior. After exhausting the sequence, the last value is used (cap).
 */
export const WHATSAPP_BACKOFF_DELAYS = [3000, 10000, 60000, 60000, 120000] as const

/**
 * Default jitter (+/- 15%) to prevent thundering-herd retries.
 */
export const DEFAULT_JITTER_FACTOR = 0.15 as const

/**
 * Default time-to-live for retries: 10 minutes.
 *
 * Empirical justification: WhatsApp Android stabilises memory in ~3-5 min
 * during a network outage; 10 min gives a generous safety buffer while
 * preventing unbounded retry accumulation.
 */
export const DEFAULT_TTL_MS = 10 * 60 * 1000

/**
 * Default per-attempt timeout: 30 seconds.
 *
 * Most WhatsApp queries respond within seconds. A 30s timeout is generous
 * enough for slow networks but prevents a single hang from blocking retries.
 */
export const DEFAULT_PER_ATTEMPT_TIMEOUT_MS = 30000

export interface BoundedRetryOptions {
	/** Operation name for logging/metrics */
	name?: string
	/** Sequence of delays (ms). Last value is used as cap. */
	delays?: readonly number[]
	/** Jitter factor 0..1 (default 0.15) */
	jitter?: number
	/** Total wall-clock budget — gives up after this. Default 10 min. */
	ttlMs?: number
	/** Per-attempt timeout (ms). Default 30s. Capped by remaining TTL. */
	perAttemptTimeoutMs?: number
	/** Predicate: should we retry on this error? Default: always */
	shouldRetry?: (err: Error, attempt: number) => boolean
	/** Hook fired before each retry */
	onRetry?: (err: Error, attempt: number, delayMs: number) => void
	/**
	 * AbortSignal — when fired, the loop stops at the next observation point:
	 *   - If the loop is sleeping between retries, the sleep rejects immediately.
	 *   - If an attempt is in flight, the abort is forwarded to the operation
	 *     via the per-attempt signal. The operation must ITSELF observe the
	 *     signal (e.g. `(signal) => fetch({ signal })`) for cancellation to
	 *     be truly immediate; otherwise it cancels at the next per-attempt
	 *     timeout boundary.
	 *   - Either way, on the next loop iteration BoundedRetryAbortedError is
	 *     thrown, so the caller never sees more than one trailing attempt
	 *     after the abort.
	 */
	signal?: AbortSignal
	/** Optional logger for structured retry/give-up/recovery logs */
	logger?: ILogger
}

export class BoundedRetryGiveUpError extends Error {
	constructor(
		public readonly opName: string,
		public readonly attempts: number,
		public readonly elapsedMs: number,
		public readonly lastError: Error
	) {
		super(
			`bounded-retry "${opName}" gave up after ${attempts} attempts ` +
				`(${elapsedMs}ms elapsed). Last error: ${lastError.message}`
		)
		this.name = 'BoundedRetryGiveUpError'
	}
}

export class BoundedRetryAbortedError extends Error {
	constructor(public readonly opName: string) {
		super(`bounded-retry "${opName}" aborted via signal`)
		this.name = 'BoundedRetryAbortedError'
	}
}

/**
 * Apply jitter to a delay: returns delay * (1 +/- jitter)
 */
function withJitter(delayMs: number, jitter: number): number {
	if (jitter <= 0) return delayMs
	const factor = 1 + (Math.random() * 2 - 1) * jitter
	return Math.max(0, Math.round(delayMs * factor))
}

/**
 * Pick the delay for a given attempt index. Falls back to the last value
 * (cap) once the sequence is exhausted.
 */
function pickDelay(attempt: number, delays: readonly number[]): number {
	if (delays.length === 0) return 0
	if (attempt < delays.length) return delays[attempt]!
	return delays[delays.length - 1]!
}

/**
 * Wrap a promise with a per-attempt timeout. Aborts the supplied controller
 * when the timeout fires so the caller can cancel any in-flight work
 * (operations that accept the signal). Always clears the timer on settlement.
 */
function withTimeout<T>(
	promise: Promise<T>,
	timeoutMs: number,
	name: string,
	abortOnTimeout: AbortController
): Promise<T> {
	return new Promise<T>((resolve, reject) => {
		const timer = setTimeout(() => {
			abortOnTimeout.abort()
			reject(new Error(`bounded-retry "${name}" attempt timed out after ${timeoutMs}ms`))
		}, timeoutMs)
		promise
			.then(value => {
				clearTimeout(timer)
				resolve(value)
			})
			.catch(err => {
				clearTimeout(timer)
				reject(err as Error)
			})
	})
}

/**
 * Sleep with abort support. Always removes the abort listener on settlement
 * so listeners do not accumulate on long-lived signals.
 */
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
	return new Promise((resolve, reject) => {
		if (signal?.aborted) {
			reject(new Error('aborted'))
			return
		}

		let onAbort: (() => void) | undefined
		const cleanup = () => {
			if (onAbort && signal) {
				signal.removeEventListener('abort', onAbort)
			}
		}

		const timer = setTimeout(() => {
			cleanup()
			resolve()
		}, ms)

		if (signal) {
			onAbort = () => {
				clearTimeout(timer)
				cleanup()
				reject(new Error('aborted'))
			}

			signal.addEventListener('abort', onAbort, { once: true })
		}
	})
}

/**
 * Run an async operation with bounded exponential-backoff retry.
 *
 * Independent per-call: no global state, no cross-operation interaction.
 * Memory bound: at most one outstanding retry timer per call.
 *
 * The operation may optionally accept an `AbortSignal` parameter — when the
 * per-attempt timeout fires (or the outer signal is aborted), the inner
 * signal is aborted so the operation can stop in-flight work cleanly.
 *
 * @example
 * ```ts
 * const result = await withBoundedRetry(
 *     (signal) => assertSessions([jid], true, { signal }),
 *     { name: 'assertSessions', ttlMs: 5 * 60_000, logger }
 * )
 * ```
 */
export async function withBoundedRetry<T>(
	operation: (signal?: AbortSignal) => Promise<T>,
	options: BoundedRetryOptions = {}
): Promise<T> {
	const name = options.name ?? 'bounded-retry'
	const delays = options.delays ?? WHATSAPP_BACKOFF_DELAYS
	const jitter = options.jitter ?? DEFAULT_JITTER_FACTOR
	const ttlMs = options.ttlMs ?? DEFAULT_TTL_MS
	const perAttemptTimeoutMs = options.perAttemptTimeoutMs ?? DEFAULT_PER_ATTEMPT_TIMEOUT_MS
	const shouldRetry = options.shouldRetry ?? (() => true)
	const logger = options.logger

	const start = Date.now()
	let lastError: Error = new Error('unknown')
	let attempt = 0

	while (true) {
		// Check abort + TTL BEFORE starting an attempt — strict wall-clock
		// budget. Without this check the loop could begin a new attempt with
		// 0ms remaining and then run for up to `perAttemptTimeoutMs`.
		if (options.signal?.aborted) {
			throw new BoundedRetryAbortedError(name)
		}

		const elapsedBeforeAttempt = Date.now() - start
		const remainingBudget = ttlMs - elapsedBeforeAttempt
		if (remainingBudget <= 0) {
			metrics.errors?.inc({ category: 'bounded_retry', code: 'ttl_exceeded' })
			logger?.warn?.(
				{ op: name, attempts: attempt, elapsedMs: elapsedBeforeAttempt, ttlMs, lastError: lastError.message },
				'bounded-retry: TTL exceeded before next attempt — giving up'
			)
			throw new BoundedRetryGiveUpError(name, attempt, elapsedBeforeAttempt, lastError)
		}

		// Cap the per-attempt timeout to the remaining TTL budget so a single
		// attempt cannot run past the wall-clock deadline.
		const attemptTimeoutMs = Math.min(perAttemptTimeoutMs, remainingBudget)
		const attemptAbort = new AbortController()

		// Forward outer abort to the per-attempt controller so the in-flight
		// operation is cancelled when the user aborts. Cleaned up below.
		let onOuterAbort: (() => void) | undefined
		if (options.signal) {
			onOuterAbort = () => attemptAbort.abort()
			if (options.signal.aborted) {
				attemptAbort.abort()
			} else {
				options.signal.addEventListener('abort', onOuterAbort, { once: true })
			}
		}

		try {
			const result = await withTimeout(operation(attemptAbort.signal), attemptTimeoutMs, name, attemptAbort)

			if (attempt > 0) {
				metrics.socketEvents?.inc({ event: 'bounded_retry_recovered' })
				logger?.info?.(
					{ op: name, attempts: attempt + 1, elapsedMs: Date.now() - start },
					'bounded-retry: operation succeeded after retries'
				)
			}

			return result
		} catch (err) {
			lastError = err as Error
			attempt++

			// (outer-abort listener detachment happens in the finally below —
			// avoiding a double-remove that breaks listener-count assertions.)

			// If the outer signal aborted us mid-attempt, surface that explicitly
			// rather than as a generic operation failure.
			if (options.signal?.aborted) {
				throw new BoundedRetryAbortedError(name)
			}

			const elapsed = Date.now() - start

			if (!shouldRetry(lastError, attempt)) {
				metrics.errors?.inc({ category: 'bounded_retry', code: 'predicate_no_retry' })
				logger?.warn?.(
					{ op: name, attempts: attempt, elapsedMs: elapsed, error: lastError.message },
					'bounded-retry: shouldRetry returned false — giving up'
				)
				throw lastError
			}

			// Re-check budget after the failure so we do not sleep past TTL.
			const remainingAfterFailure = ttlMs - elapsed
			if (remainingAfterFailure <= 0) {
				metrics.errors?.inc({ category: 'bounded_retry', code: 'ttl_exceeded' })
				logger?.warn?.(
					{ op: name, attempts: attempt, elapsedMs: elapsed, ttlMs, lastError: lastError.message },
					'bounded-retry: TTL exceeded after attempt — giving up'
				)
				throw new BoundedRetryGiveUpError(name, attempt, elapsed, lastError)
			}

			const baseDelay = pickDelay(attempt - 1, delays)
			const delayMs = Math.min(withJitter(baseDelay, jitter), remainingAfterFailure)

			options.onRetry?.(lastError, attempt, delayMs)
			metrics.socketEvents?.inc({ event: 'bounded_retry_attempt' })
			logger?.debug?.(
				{ op: name, attempt, delayMs, elapsedMs: elapsed, error: lastError.message },
				'bounded-retry: scheduling next attempt'
			)

			try {
				await sleep(delayMs, options.signal)
			} catch {
				throw new BoundedRetryAbortedError(name)
			}
		} finally {
			// Belt-and-suspenders: ensure the outer-abort listener is always
			// removed even on early throws.
			if (options.signal && onOuterAbort) {
				options.signal.removeEventListener('abort', onOuterAbort)
			}
		}
	}
}
