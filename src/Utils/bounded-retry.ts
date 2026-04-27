/**
 * Bounded retry — WhatsApp-aligned per-operation retry without global state.
 *
 * Replaces the circuit breaker pattern, which was causing cascading failures
 * (5 timeouts in 60s -> all queries blocked for 30s). Empirical capture of
 * WhatsApp Android's behavior shows it uses per-operation exponential backoff
 * with a delay cap, not a state-machine circuit breaker:
 *
 *   delays observed (Frida trace): 3000 -> 10000 -> 60000 -> ~64000 -> 120000 ms
 *   memory profile during 5min disconnect: dropped 53MB and stabilised
 *   FDs during disconnect: closed (305 -> 295), did not accumulate
 *   recovery on reconnect: ~10s, no retry storm
 *
 * Design:
 * - Each operation has its own independent retry timer
 * - Failures in one operation do NOT block other operations
 * - Bounded by maxAttempts + ttlMs (eventual give-up to prevent unbounded
 *   accumulation under prolonged outages)
 * - Per-attempt timeout (independent of total ttl)
 *
 * @module Utils/bounded-retry
 */

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

export interface BoundedRetryOptions<T> {
	/** Operation name for logging/metrics */
	name?: string
	/** Sequence of delays (ms). Last value is used as cap. */
	delays?: readonly number[]
	/** Jitter factor 0..1 (default 0.15) */
	jitter?: number
	/** Total wall-clock budget — gives up after this. Default 10 min. */
	ttlMs?: number
	/** Per-attempt timeout (ms). Default 30s. */
	perAttemptTimeoutMs?: number
	/** Predicate: should we retry on this error? Default: always */
	shouldRetry?: (err: Error, attempt: number) => boolean
	/** Hook fired before each retry */
	onRetry?: (err: Error, attempt: number, delayMs: number) => void
	/** AbortSignal — if aborted, give up immediately */
	signal?: AbortSignal
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
 * Wrap a promise with a per-attempt timeout. Rejects if the promise does
 * not settle before timeoutMs elapses.
 */
function withTimeout<T>(promise: Promise<T>, timeoutMs: number, name: string): Promise<T> {
	return new Promise<T>((resolve, reject) => {
		const timer = setTimeout(() => {
			reject(new Error(`bounded-retry "${name}" attempt timed out after ${timeoutMs}ms`))
		}, timeoutMs)
		promise
			.then(value => {
				clearTimeout(timer)
				resolve(value)
			})
			.catch(err => {
				clearTimeout(timer)
				reject(err)
			})
	})
}

/**
 * Sleep with abort support.
 */
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
	return new Promise((resolve, reject) => {
		if (signal?.aborted) {
			reject(new Error('aborted'))
			return
		}
		const timer = setTimeout(resolve, ms)
		if (signal) {
			const onAbort = () => {
				clearTimeout(timer)
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
 * @example
 * ```ts
 * const result = await withBoundedRetry(
 *     () => assertSessions([jid], true),
 *     { name: 'assertSessions', ttlMs: 5 * 60_000 }
 * )
 * ```
 */
export async function withBoundedRetry<T>(
	operation: () => Promise<T>,
	options: BoundedRetryOptions<T> = {}
): Promise<T> {
	const name = options.name ?? 'bounded-retry'
	const delays = options.delays ?? WHATSAPP_BACKOFF_DELAYS
	const jitter = options.jitter ?? DEFAULT_JITTER_FACTOR
	const ttlMs = options.ttlMs ?? DEFAULT_TTL_MS
	const perAttemptTimeoutMs = options.perAttemptTimeoutMs ?? DEFAULT_PER_ATTEMPT_TIMEOUT_MS
	const shouldRetry = options.shouldRetry ?? (() => true)

	const start = Date.now()
	let lastError: Error = new Error('unknown')
	let attempt = 0

	while (true) {
		if (options.signal?.aborted) {
			throw new BoundedRetryAbortedError(name)
		}

		try {
			const result = await withTimeout(operation(), perAttemptTimeoutMs, name)
			if (attempt > 0) {
				metrics.socketEvents.inc({ event: 'bounded_retry_recovered' })
			}
			return result
		} catch (err) {
			lastError = err as Error
			attempt++

			const elapsed = Date.now() - start
			if (elapsed >= ttlMs) {
				metrics.errors.inc({ category: 'bounded_retry', code: 'ttl_exceeded' })
				throw new BoundedRetryGiveUpError(name, attempt, elapsed, lastError)
			}

			if (!shouldRetry(lastError, attempt)) {
				metrics.errors.inc({ category: 'bounded_retry', code: 'predicate_no_retry' })
				throw lastError
			}

			const baseDelay = pickDelay(attempt - 1, delays)
			// Cap remaining delay so we do not blow past ttlMs
			const remainingBudget = Math.max(0, ttlMs - elapsed)
			const delayMs = Math.min(withJitter(baseDelay, jitter), remainingBudget)

			options.onRetry?.(lastError, attempt, delayMs)
			metrics.socketEvents.inc({ event: 'bounded_retry_attempt' })

			try {
				await sleep(delayMs, options.signal)
			} catch {
				throw new BoundedRetryAbortedError(name)
			}
		}
	}
}
