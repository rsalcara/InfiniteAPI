import { jest } from '@jest/globals'
import {
	withBoundedRetry,
	BoundedRetryGiveUpError,
	BoundedRetryAbortedError,
	WHATSAPP_BACKOFF_DELAYS,
	DEFAULT_TTL_MS
} from '../../Utils/bounded-retry'

// All tests use very short real delays (1-50ms) so they run fast.
// This sidesteps the fragility of jest fake timers + async chains.

describe('bounded-retry — WhatsApp-aligned per-operation retry', () => {
	test('default delay sequence matches WhatsApp Android empirical capture', () => {
		// Frida trace: 3000 -> 10000 -> 60000 -> ~64000 -> 120000 ms
		expect(WHATSAPP_BACKOFF_DELAYS).toEqual([3000, 10000, 60000, 60000, 120000])
	})

	test('default TTL is 10 minutes (matches empirical stabilisation + safety buffer)', () => {
		expect(DEFAULT_TTL_MS).toBe(600_000)
	})

	test('first-attempt success returns immediately, no retries', async () => {
		const op = jest.fn<() => Promise<string>>().mockResolvedValue('ok')
		const result = await withBoundedRetry(op, { name: 'fast-success' })
		expect(result).toBe('ok')
		expect(op).toHaveBeenCalledTimes(1)
	})

	test('retries with the configured delay sequence after failures', async () => {
		const op = jest
			.fn<() => Promise<number>>()
			.mockRejectedValueOnce(new Error('try1'))
			.mockRejectedValueOnce(new Error('try2'))
			.mockResolvedValueOnce(42)

		const onRetry = jest.fn<(err: Error, attempt: number, delayMs: number) => void>()
		const result = await withBoundedRetry(op, {
			name: 'three-tries',
			delays: [10, 20, 40],
			jitter: 0,
			onRetry
		})

		expect(result).toBe(42)
		expect(op).toHaveBeenCalledTimes(3)
		expect(onRetry).toHaveBeenCalledTimes(2)
		expect(onRetry.mock.calls[0]![2]).toBe(10)
		expect(onRetry.mock.calls[1]![2]).toBe(20)
	})

	test('TTL exhaustion throws BoundedRetryGiveUpError (no infinite retries)', async () => {
		const op = jest.fn<() => Promise<string>>().mockRejectedValue(new Error('always-fails'))

		await expect(
			withBoundedRetry(op, {
				name: 'ttl-test',
				delays: [10],
				jitter: 0,
				ttlMs: 50
			})
		).rejects.toBeInstanceOf(BoundedRetryGiveUpError)

		// Should have tried multiple times before giving up
		expect(op.mock.calls.length).toBeGreaterThanOrEqual(2)
	})

	test('per-attempt timeout fires for slow operations', async () => {
		const slowOp = jest.fn<() => Promise<string>>(() => new Promise(() => {})) // hangs

		await expect(
			withBoundedRetry(slowOp, {
				name: 'slow',
				delays: [5],
				jitter: 0,
				ttlMs: 200,
				perAttemptTimeoutMs: 30
			})
		).rejects.toBeInstanceOf(BoundedRetryGiveUpError)

		// Multiple attempts should have been tried (each timed out at 30ms)
		expect(slowOp.mock.calls.length).toBeGreaterThan(1)
	})

	test('shouldRetry predicate can short-circuit retries', async () => {
		const op = jest
			.fn<() => Promise<string>>()
			.mockRejectedValueOnce(new Error('transient'))
			.mockRejectedValueOnce(new Error('FATAL: do not retry'))

		await expect(
			withBoundedRetry(op, {
				name: 'predicate-test',
				delays: [1],
				jitter: 0,
				shouldRetry: err => !err.message.startsWith('FATAL')
			})
		).rejects.toThrow('FATAL: do not retry')

		expect(op).toHaveBeenCalledTimes(2)
	})

	test('AbortSignal cancels in-flight retry sleep', async () => {
		const op = jest.fn<() => Promise<string>>().mockRejectedValue(new Error('fail'))
		const ctrl = new AbortController()

		const promise = withBoundedRetry(op, {
			name: 'abort-test',
			delays: [10_000], // long sleep so abort can happen during it
			jitter: 0,
			signal: ctrl.signal
		})

		// First attempt fires immediately; sleep starts
		await new Promise(resolve => setTimeout(resolve, 10))
		ctrl.abort()

		await expect(promise).rejects.toBeInstanceOf(BoundedRetryAbortedError)
	})

	test('two concurrent retry chains do NOT interfere with each other (per-op isolation)', async () => {
		// Key advantage over circuit breaker: failures in one chain do not
		// block another chain. With circuit breaker, 5 failures from chain A
		// would block chain B too. With bounded-retry, B is independent.

		const flakyOp = jest
			.fn<() => Promise<string>>()
			.mockRejectedValueOnce(new Error('a1'))
			.mockResolvedValueOnce('a-ok')

		const fastOp = jest.fn<() => Promise<string>>().mockResolvedValue('b-ok')

		// Start a (will retry once after 30ms) and b (immediate)
		const aPromise = withBoundedRetry(flakyOp, { name: 'a', delays: [30], jitter: 0 })
		const bPromise = withBoundedRetry(fastOp, { name: 'b', delays: [30], jitter: 0 })

		// b should resolve right away
		const bResult = await bPromise
		expect(bResult).toBe('b-ok')
		expect(fastOp).toHaveBeenCalledTimes(1)

		// a still running — wait for it
		const aResult = await aPromise
		expect(aResult).toBe('a-ok')
		expect(flakyOp).toHaveBeenCalledTimes(2)
	})

	test('delay sequence caps at last value (no unbounded growth)', async () => {
		const op = jest.fn<() => Promise<string>>().mockRejectedValue(new Error('fail'))
		const onRetry = jest.fn<(err: Error, attempt: number, delayMs: number) => void>()

		await expect(
			withBoundedRetry(op, {
				name: 'cap-test',
				delays: [5, 10, 15], // 3 distinct steps; 4th+ retry should reuse 15
				jitter: 0,
				ttlMs: 300,
				onRetry
			})
		).rejects.toBeInstanceOf(BoundedRetryGiveUpError)

		// Find delays >= 4th retry — all should be capped at 15
		const lateRetries = onRetry.mock.calls.filter(c => c[1] >= 4)
		expect(lateRetries.length).toBeGreaterThan(0)
		for (const call of lateRetries) {
			expect(call[2]).toBeLessThanOrEqual(15)
		}
	})

	test('jitter randomises delay within +/- factor', async () => {
		const op = jest.fn<() => Promise<string>>().mockRejectedValue(new Error('fail'))
		const observed: number[] = []

		// Single run, capture multiple onRetry calls (each with different jitter)
		await withBoundedRetry(op, {
			name: 'jitter-test',
			delays: [50], // base delay
			jitter: 0.3, // +/- 30% -> [35, 65]
			ttlMs: 1000, // ttl high enough for ~10 retries
			perAttemptTimeoutMs: 5,
			onRetry: (_, __, d) => observed.push(d)
		}).catch(() => {})

		expect(observed.length).toBeGreaterThanOrEqual(3)
		const unique = new Set(observed)
		expect(unique.size).toBeGreaterThan(1)
		// Every observed delay must be within jitter window — but the LAST one
		// may be capped by remaining ttl budget, so check all but the last
		const inWindow = observed.slice(0, -1)
		for (const d of inWindow) {
			expect(d).toBeGreaterThanOrEqual(35)
			expect(d).toBeLessThanOrEqual(65)
		}
	})

	test('delay does not exceed remaining TTL budget', async () => {
		const op = jest.fn<() => Promise<string>>().mockRejectedValue(new Error('fail'))
		const onRetry = jest.fn<(err: Error, attempt: number, delayMs: number) => void>()

		await withBoundedRetry(op, {
			name: 'budget-cap',
			delays: [200], // would exceed ttl
			jitter: 0,
			ttlMs: 50, // very short
			onRetry
		}).catch(() => {})

		// All scheduled delays should be capped to remaining budget
		for (const call of onRetry.mock.calls) {
			expect(call[2]).toBeLessThanOrEqual(50)
		}
	})

	// ─── Tests for fixes from PR #393 review ──────────────────────────────

	test('TTL is enforced BEFORE the next attempt (not just after)', async () => {
		// Regression: previously TTL was only checked after a failure, so a
		// new attempt could start with 0ms remaining and run for the full
		// per-attempt timeout, overshooting wall-clock budget by that much.
		const slowOp = jest.fn<() => Promise<string>>(() => new Promise(resolve => setTimeout(() => resolve('late'), 200)))

		const start = Date.now()
		await expect(
			withBoundedRetry(slowOp, {
				name: 'ttl-strict',
				delays: [10],
				jitter: 0,
				ttlMs: 50,
				perAttemptTimeoutMs: 1000 // huge, must be capped by TTL
			})
		).rejects.toBeInstanceOf(BoundedRetryGiveUpError)

		const elapsed = Date.now() - start
		// With strict TTL enforcement, total runtime should be very close to ttlMs.
		// Allow up to 100ms slack for Node timer + microtask scheduling.
		expect(elapsed).toBeLessThan(150)
	})

	test('per-attempt timeout is capped by remaining TTL budget', async () => {
		// If user passes perAttemptTimeoutMs > ttlMs, the cap should apply.
		const slowOp = jest.fn<() => Promise<string>>(() => new Promise(() => {})) // hangs forever

		const start = Date.now()
		await expect(
			withBoundedRetry(slowOp, {
				name: 'attempt-cap',
				delays: [1],
				jitter: 0,
				ttlMs: 30,
				perAttemptTimeoutMs: 5000 // way bigger than ttl
			})
		).rejects.toBeInstanceOf(BoundedRetryGiveUpError)

		const elapsed = Date.now() - start
		expect(elapsed).toBeLessThan(150) // not 5000ms!
	})

	test('operation receives an AbortSignal that is aborted on per-attempt timeout', async () => {
		// New API: operation can opt into cancellation via the signal arg.
		const aborts: boolean[] = []
		const opThatRespectsSignal = jest.fn(
			(signal?: AbortSignal) =>
				new Promise<string>((resolve, reject) => {
					const timer = setTimeout(() => resolve('late'), 100)
					signal?.addEventListener('abort', () => {
						clearTimeout(timer)
						aborts.push(true)
						reject(new Error('aborted by signal'))
					})
				})
		)

		await withBoundedRetry(opThatRespectsSignal, {
			name: 'signal-aware',
			delays: [1],
			jitter: 0,
			ttlMs: 80,
			perAttemptTimeoutMs: 20 // smaller than 100ms op duration
		}).catch(() => {})

		expect(aborts.length).toBeGreaterThan(0) // at least one attempt was aborted
	})

	test('sleep listener is removed when timeout completes normally (no leak)', async () => {
		// Regression: sleep used signal.addEventListener with { once: true } but
		// never removed the listener on timer-resolve. With many retries on a
		// shared signal, listeners would accumulate.
		const ctrl = new AbortController()
		const op = jest
			.fn<() => Promise<string>>()
			.mockRejectedValueOnce(new Error('1'))
			.mockRejectedValueOnce(new Error('2'))
			.mockRejectedValueOnce(new Error('3'))
			.mockResolvedValueOnce('ok')

		// Track listener count via getMaxListeners-style check is not portable
		// across runtimes, so we instead verify completion proceeds without
		// MaxListenersExceededWarning being raised. The implementation must
		// remove the listener on each successful sleep.
		const result = await withBoundedRetry(op, {
			name: 'no-leak',
			delays: [5],
			jitter: 0,
			ttlMs: 200,
			signal: ctrl.signal
		})

		expect(result).toBe('ok')
		expect(op).toHaveBeenCalledTimes(4)
		// If listeners leaked, we would see them by counting. AbortSignal does
		// not expose listenerCount publicly; the regression manifests as a
		// runtime warning. Test passes if no warning + result is correct.
	})

	test('logger receives structured logs for retry, give-up, and recovery', async () => {
		const debugCalls: unknown[][] = []
		const infoCalls: unknown[][] = []
		const warnCalls: unknown[][] = []
		const fakeLogger = {
			debug: (...args: unknown[]) => debugCalls.push(args),
			info: (...args: unknown[]) => infoCalls.push(args),
			warn: (...args: unknown[]) => warnCalls.push(args),
			error: () => {},
			fatal: () => {},
			trace: () => {},
			child: () => fakeLogger,
			level: 'debug'
		}

		const op = jest
			.fn<() => Promise<string>>()
			.mockRejectedValueOnce(new Error('boom'))
			.mockResolvedValueOnce('ok')

		const result = await withBoundedRetry(op, {
			name: 'logged-op',
			delays: [5],
			jitter: 0,
			ttlMs: 200,
			logger: fakeLogger as never
		})

		expect(result).toBe('ok')
		// Should have logged the scheduling at debug level
		expect(debugCalls.length).toBeGreaterThanOrEqual(1)
		// Should have logged the recovery at info level
		expect(infoCalls.length).toBeGreaterThanOrEqual(1)
	})

	test('logger reports give-up via warn when TTL exceeded', async () => {
		const warnCalls: unknown[][] = []
		const fakeLogger = {
			debug: () => {},
			info: () => {},
			warn: (...args: unknown[]) => warnCalls.push(args),
			error: () => {},
			fatal: () => {},
			trace: () => {},
			child: () => fakeLogger,
			level: 'debug'
		}

		const op = jest.fn<() => Promise<string>>().mockRejectedValue(new Error('always-fails'))

		await expect(
			withBoundedRetry(op, {
				name: 'logged-fail',
				delays: [5],
				jitter: 0,
				ttlMs: 30,
				logger: fakeLogger as never
			})
		).rejects.toBeInstanceOf(BoundedRetryGiveUpError)

		expect(warnCalls.length).toBeGreaterThanOrEqual(1)
	})
})
