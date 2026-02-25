import { jest } from '@jest/globals'

/**
 * Tests for the offline-buffer safety timer introduced in socket.ts.
 *
 * The timer caps how long the CB:ib,,offline phase can block live message
 * delivery.  Its behaviour spans three interaction points that must all be
 * correct for the feature to work safely:
 *
 *   1. startBuffer()   – called inside process.nextTick when the socket connects
 *                        and creds.me?.id is set.  Arms the timer.
 *   2. onOffline()     – called when CB:ib,,offline arrives (happy path).
 *                        Must cancel the timer and flush exactly once.
 *   3. onClose()       – called inside end() when the socket closes for any
 *                        reason.  Must cancel the timer so the callback cannot
 *                        call ev.flush() on a dead session.
 *
 * Because these closures live deep inside makeSocket we mirror their logic
 * here as standalone functions, exactly the same approach used in
 * bad-ack-handling.test.ts.
 */

const OFFLINE_BUFFER_TIMEOUT_MS = 5_000

/** Mirrors the state variables declared at the top of makeSocket */
interface OfflineBufferState {
	didStartBuffer: boolean
	offlineBufferTimeout: NodeJS.Timeout | undefined
}

function makeState(): OfflineBufferState {
	return { didStartBuffer: false, offlineBufferTimeout: undefined }
}

/**
 * Mirrors the process.nextTick block that arms the offline-buffer timer.
 * Only called when creds.me?.id is set (reconnection path).
 */
function startBuffer(
	state: OfflineBufferState,
	flush: () => void,
	warn: () => void
): void {
	state.didStartBuffer = true
	state.offlineBufferTimeout = setTimeout(() => {
		state.offlineBufferTimeout = undefined
		if(state.didStartBuffer) {
			warn()
			flush()
			state.didStartBuffer = false
		}
	}, OFFLINE_BUFFER_TIMEOUT_MS)
}

/**
 * Mirrors the CB:ib,,offline handler — the happy path where the server
 * delivers all offline notifications before the safety timer fires.
 */
function onOffline(state: OfflineBufferState, flush: () => void): void {
	if(state.offlineBufferTimeout) {
		clearTimeout(state.offlineBufferTimeout)
		state.offlineBufferTimeout = undefined
	}

	if(state.didStartBuffer) {
		flush()
		state.didStartBuffer = false
	}
}

/**
 * Mirrors the relevant portion of end() — clears the timer and resets the
 * flag so a closing socket cannot emit stale events after the fact.
 */
function onClose(state: OfflineBufferState): void {
	if(state.offlineBufferTimeout) {
		clearTimeout(state.offlineBufferTimeout)
		state.offlineBufferTimeout = undefined
	}

	state.didStartBuffer = false
}

// ---------------------------------------------------------------------------

describe('offline-buffer safety timer (socket.ts)', () => {
	let state: OfflineBufferState
	let mockFlush: jest.Mock
	let mockWarn: jest.Mock

	beforeEach(() => {
		jest.useFakeTimers()
		state = makeState()
		mockFlush = jest.fn()
		mockWarn = jest.fn()
	})

	afterEach(() => {
		// Clean up any remaining timer to avoid cross-test interference
		if(state.offlineBufferTimeout) {
			clearTimeout(state.offlineBufferTimeout)
		}

		jest.useRealTimers()
	})

	// -------------------------------------------------------------------------
	// 1. Timeout path — CB:ib,,offline never arrives within 5 s
	// -------------------------------------------------------------------------

	it('fires after 5 s and flushes when CB:ib,,offline is delayed', () => {
		startBuffer(state, mockFlush, mockWarn)

		expect(mockFlush).not.toHaveBeenCalled()

		jest.advanceTimersByTime(OFFLINE_BUFFER_TIMEOUT_MS)

		expect(mockWarn).toHaveBeenCalledTimes(1)
		expect(mockFlush).toHaveBeenCalledTimes(1)
	})

	it('resets didStartBuffer to false after the timeout fires', () => {
		startBuffer(state, mockFlush, mockWarn)
		expect(state.didStartBuffer).toBe(true)

		jest.advanceTimersByTime(OFFLINE_BUFFER_TIMEOUT_MS)

		expect(state.didStartBuffer).toBe(false)
	})

	it('sets offlineBufferTimeout to undefined after the callback executes', () => {
		startBuffer(state, mockFlush, mockWarn)

		jest.advanceTimersByTime(OFFLINE_BUFFER_TIMEOUT_MS)

		expect(state.offlineBufferTimeout).toBeUndefined()
	})

	it('does not flush if didStartBuffer is already false when timeout fires', () => {
		startBuffer(state, mockFlush, mockWarn)
		// Simulate external reset (e.g. onClose was called before the timer fired)
		state.didStartBuffer = false

		jest.advanceTimersByTime(OFFLINE_BUFFER_TIMEOUT_MS)

		expect(mockFlush).not.toHaveBeenCalled()
		expect(mockWarn).not.toHaveBeenCalled()
	})

	// -------------------------------------------------------------------------
	// 2. Happy path — CB:ib,,offline arrives before the 5 s timer fires
	// -------------------------------------------------------------------------

	it('CB:ib,,offline cancels the timer and flushes exactly once', () => {
		startBuffer(state, mockFlush, mockWarn)

		// Server responds before the 5 s timeout
		jest.advanceTimersByTime(1_000)
		onOffline(state, mockFlush)

		// Timer should be cancelled — advancing past 5 s must not cause a second flush
		jest.advanceTimersByTime(OFFLINE_BUFFER_TIMEOUT_MS)

		expect(mockFlush).toHaveBeenCalledTimes(1)
		expect(mockWarn).not.toHaveBeenCalled()
	})

	it('CB:ib,,offline resets didStartBuffer to false', () => {
		startBuffer(state, mockFlush, mockWarn)
		onOffline(state, mockFlush)

		expect(state.didStartBuffer).toBe(false)
	})

	it('CB:ib,,offline clears offlineBufferTimeout reference', () => {
		startBuffer(state, mockFlush, mockWarn)
		onOffline(state, mockFlush)

		expect(state.offlineBufferTimeout).toBeUndefined()
	})

	it('CB:ib,,offline is idempotent when called twice (no double flush)', () => {
		startBuffer(state, mockFlush, mockWarn)
		onOffline(state, mockFlush)
		onOffline(state, mockFlush) // spurious second call

		expect(mockFlush).toHaveBeenCalledTimes(1)
	})

	// -------------------------------------------------------------------------
	// 3. Socket close path — end() called before CB:ib,,offline or timer fires
	// -------------------------------------------------------------------------

	it('end() cancels the timer so the callback never flushes after socket close', () => {
		startBuffer(state, mockFlush, mockWarn)

		onClose(state)

		// Timer must be gone — advancing past 5 s must not trigger any flush
		jest.advanceTimersByTime(OFFLINE_BUFFER_TIMEOUT_MS)

		expect(mockFlush).not.toHaveBeenCalled()
		expect(mockWarn).not.toHaveBeenCalled()
	})

	it('end() resets didStartBuffer to false', () => {
		startBuffer(state, mockFlush, mockWarn)
		expect(state.didStartBuffer).toBe(true)

		onClose(state)

		expect(state.didStartBuffer).toBe(false)
	})

	it('end() clears offlineBufferTimeout reference', () => {
		startBuffer(state, mockFlush, mockWarn)
		onClose(state)

		expect(state.offlineBufferTimeout).toBeUndefined()
	})

	it('end() is safe to call when no buffer was started', () => {
		// State has never been touched — must not throw
		expect(() => onClose(state)).not.toThrow()
		expect(state.didStartBuffer).toBe(false)
		expect(state.offlineBufferTimeout).toBeUndefined()
	})

	it('end() after CB:ib,,offline has already arrived is a no-op', () => {
		startBuffer(state, mockFlush, mockWarn)
		onOffline(state, mockFlush)

		// end() should not throw and should leave state clean
		expect(() => onClose(state)).not.toThrow()
		expect(state.offlineBufferTimeout).toBeUndefined()
		expect(state.didStartBuffer).toBe(false)
	})

	// -------------------------------------------------------------------------
	// 4. Boundary / timing edge cases
	// -------------------------------------------------------------------------

	it('does not flush before exactly 5 s have elapsed', () => {
		startBuffer(state, mockFlush, mockWarn)

		jest.advanceTimersByTime(OFFLINE_BUFFER_TIMEOUT_MS - 1)

		expect(mockFlush).not.toHaveBeenCalled()
	})

	it('flushes at exactly the 5 s boundary', () => {
		startBuffer(state, mockFlush, mockWarn)

		jest.advanceTimersByTime(OFFLINE_BUFFER_TIMEOUT_MS)

		expect(mockFlush).toHaveBeenCalledTimes(1)
	})
})
