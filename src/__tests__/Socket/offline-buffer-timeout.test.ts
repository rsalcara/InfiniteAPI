import { jest } from '@jest/globals'
/**
 * Tests for the offline-buffer safety timer.
 *
 * Imports `createOfflineBufferState` from PRODUCTION (`src/Socket/offline-
 * buffer-state.ts`), no longer mirroring the logic locally. Previously
 * (audit TST-06) this file re-implemented `startBuffer` / `onOffline` /
 * `onClose` as standalone functions — the tests passed even when the
 * production code diverged. Now `socket.ts` calls exactly the same
 * `createOfflineBufferState` factory the tests do, so a regression here
 * would also be a regression in production.
 */
import { createOfflineBufferState, type OfflineBufferHandle } from '../../Socket/offline-buffer-state'

const OFFLINE_BUFFER_TIMEOUT_MS = 2_000

describe('offline-buffer safety timer (production createOfflineBufferState)', () => {
	let mockFlush: jest.Mock
	let mockWarn: jest.Mock
	let buffer: OfflineBufferHandle

	beforeEach(() => {
		jest.useFakeTimers()
		mockFlush = jest.fn()
		mockWarn = jest.fn()
		buffer = createOfflineBufferState(
			() => mockFlush(),
			() => mockWarn(),
			OFFLINE_BUFFER_TIMEOUT_MS
		)
	})

	afterEach(() => {
		buffer.onClose()
		jest.useRealTimers()
	})

	// -------------------------------------------------------------------------
	// 1. Timeout path
	// -------------------------------------------------------------------------

	it('fires after 2 s and flushes when CB:ib,,offline is delayed', () => {
		buffer.startBuffer()
		expect(mockFlush).not.toHaveBeenCalled()

		jest.advanceTimersByTime(OFFLINE_BUFFER_TIMEOUT_MS)

		expect(mockWarn).toHaveBeenCalledTimes(1)
		expect(mockFlush).toHaveBeenCalledTimes(1)
	})

	it('resets internal state after the timeout fires', () => {
		buffer.startBuffer()
		expect(buffer.getState().didStartBuffer).toBe(true)

		jest.advanceTimersByTime(OFFLINE_BUFFER_TIMEOUT_MS)

		expect(buffer.getState()).toEqual({ didStartBuffer: false, hasTimeout: false })
	})

	// -------------------------------------------------------------------------
	// 2. Happy path
	// -------------------------------------------------------------------------

	it('CB:ib,,offline cancels the timer and flushes exactly once', () => {
		buffer.startBuffer()
		jest.advanceTimersByTime(1_000)
		buffer.onOffline()

		jest.advanceTimersByTime(OFFLINE_BUFFER_TIMEOUT_MS)

		expect(mockFlush).toHaveBeenCalledTimes(1)
		expect(mockWarn).not.toHaveBeenCalled()
	})

	it('CB:ib,,offline is idempotent on a second call', () => {
		buffer.startBuffer()
		buffer.onOffline()
		buffer.onOffline() // spurious second call

		expect(mockFlush).toHaveBeenCalledTimes(1)
	})

	// -------------------------------------------------------------------------
	// 3. Close path
	// -------------------------------------------------------------------------

	it('onClose() cancels the timer so the callback never flushes after socket close', () => {
		buffer.startBuffer()
		buffer.onClose()

		jest.advanceTimersByTime(OFFLINE_BUFFER_TIMEOUT_MS)

		expect(mockFlush).not.toHaveBeenCalled()
		expect(mockWarn).not.toHaveBeenCalled()
	})

	it('onClose() is safe to call when no buffer was started', () => {
		expect(() => buffer.onClose()).not.toThrow()
		expect(buffer.getState()).toEqual({ didStartBuffer: false, hasTimeout: false })
	})

	it('onClose() after CB:ib,,offline already arrived is a no-op', () => {
		buffer.startBuffer()
		buffer.onOffline()
		expect(() => buffer.onClose()).not.toThrow()
		expect(buffer.getState()).toEqual({ didStartBuffer: false, hasTimeout: false })
	})

	// -------------------------------------------------------------------------
	// 4. Boundary timing
	// -------------------------------------------------------------------------

	it('does not flush before exactly 2 s have elapsed', () => {
		buffer.startBuffer()
		jest.advanceTimersByTime(OFFLINE_BUFFER_TIMEOUT_MS - 1)
		expect(mockFlush).not.toHaveBeenCalled()
	})

	it('flushes at exactly the 2 s boundary', () => {
		buffer.startBuffer()
		jest.advanceTimersByTime(OFFLINE_BUFFER_TIMEOUT_MS)
		expect(mockFlush).toHaveBeenCalledTimes(1)
	})
})
