/**
 * Offline-phase event buffer — safety state machine extracted from
 * `makeSocket` so the three interaction points (arm / cancel-on-arrival /
 * cancel-on-close) can be unit tested directly. (audit TST-06)
 *
 * The factory captures the consumer's `flush` + `warn` callbacks and the
 * timeout duration; the returned object exposes the three transitions that
 * used to be inline closures over `didStartBuffer` + `offlineBufferTimeout`
 * in `socket.ts`. State is fully private.
 */

export interface OfflineBufferHandle {
	/**
	 * Arm the safety timer. Mirrors the `process.nextTick` block that fired
	 * inside makeSocket when the socket connected with `creds.me?.id` set.
	 * Called by the socket immediately after `ev.buffer()` so a large
	 * offline backlog can't hold live messages hostage past `timeoutMs`.
	 */
	startBuffer(): void

	/**
	 * Cancel the timer and flush exactly once. Happy path — fired when
	 * `CB:ib,,offline` arrives before the safety timer expires.
	 */
	onOffline(): void

	/**
	 * Cancel the timer without flushing. Called from `end()` when the
	 * socket closes for any reason, so the callback cannot call
	 * `ev.flush()` on a dead session.
	 */
	onClose(): void

	/** Inspection — for tests + diagnostics. */
	getState(): { didStartBuffer: boolean; hasTimeout: boolean }
}

export const createOfflineBufferState = (
	flush: () => void,
	warn: () => void,
	timeoutMs: number
): OfflineBufferHandle => {
	let didStartBuffer = false
	let offlineBufferTimeout: NodeJS.Timeout | undefined

	return {
		startBuffer(): void {
			// Defensive: if `startBuffer` is ever called twice without an
			// intervening `onOffline` / `onClose` (e.g. a future reconnection
			// path that double-fires the CB:ib trigger), drop the stale
			// timer so two flushes can't race. Today's socket lifecycle
			// guarantees a single call, so this is belt-and-suspenders.
			// (audit thread 9)
			if (offlineBufferTimeout) {
				clearTimeout(offlineBufferTimeout)
				offlineBufferTimeout = undefined
			}

			didStartBuffer = true
			offlineBufferTimeout = setTimeout(() => {
				offlineBufferTimeout = undefined
				if (didStartBuffer) {
					warn()
					flush()
					didStartBuffer = false
				}
			}, timeoutMs)
		},
		onOffline(): void {
			if (offlineBufferTimeout) {
				clearTimeout(offlineBufferTimeout)
				offlineBufferTimeout = undefined
			}

			if (didStartBuffer) {
				flush()
				didStartBuffer = false
			}
		},
		onClose(): void {
			if (offlineBufferTimeout) {
				clearTimeout(offlineBufferTimeout)
				offlineBufferTimeout = undefined
			}

			didStartBuffer = false
		},
		getState(): { didStartBuffer: boolean; hasTimeout: boolean } {
			return { didStartBuffer, hasTimeout: !!offlineBufferTimeout }
		}
	}
}
