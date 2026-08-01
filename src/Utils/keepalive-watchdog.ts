export type KeepAliveWatchdogDecision = {
	shouldDisconnect: boolean
	networkIdleMs: number
	watchdogDelayMs: number
	watchdogWasDelayed: boolean
}

/**
 * Separates actual network inactivity from a watchdog callback delayed by a
 * blocked event loop. A delayed callback gets one chance to send a fresh ping;
 * the next normally scheduled check disconnects if no frame was received.
 */
export const evaluateKeepAliveWatchdog = (
	now: number,
	lastNetworkActivityAt: number,
	lastWatchdogCheckAt: number,
	keepAliveIntervalMs: number,
	toleranceMs = 5000
): KeepAliveWatchdogDecision => {
	const deadlineMs = keepAliveIntervalMs + toleranceMs
	const networkIdleMs = Math.max(0, now - lastNetworkActivityAt)
	const watchdogDelayMs = Math.max(0, now - lastWatchdogCheckAt)
	const watchdogWasDelayed = watchdogDelayMs > deadlineMs

	return {
		shouldDisconnect: networkIdleMs > deadlineMs && !watchdogWasDelayed,
		networkIdleMs,
		watchdogDelayMs,
		watchdogWasDelayed
	}
}
