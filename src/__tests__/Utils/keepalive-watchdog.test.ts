import { evaluateKeepAliveWatchdog } from '../../Utils/keepalive-watchdog'

describe('evaluateKeepAliveWatchdog', () => {
	const intervalMs = 15_000

	it('disconnects after network inactivity when the watchdog ran on schedule', () => {
		const decision = evaluateKeepAliveWatchdog(30_000, 0, 15_000, intervalMs)

		expect(decision.shouldDisconnect).toBe(true)
		expect(decision.watchdogWasDelayed).toBe(false)
	})

	it('defers one disconnect when the event loop delayed the watchdog', () => {
		const decision = evaluateKeepAliveWatchdog(45_000, 0, 15_000, intervalMs)

		expect(decision.shouldDisconnect).toBe(false)
		expect(decision.watchdogWasDelayed).toBe(true)
	})

	it('disconnects on the next scheduled check if no network frame arrived', () => {
		const decision = evaluateKeepAliveWatchdog(60_000, 0, 45_000, intervalMs)

		expect(decision.shouldDisconnect).toBe(true)
	})
})
