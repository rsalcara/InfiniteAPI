import type { NewChatMessageCapInfo, ReachoutTimelockState } from '../Types/State'

export type OutboundRestriction = {
	code: 'reachout-timelock' | 'message-capping'
	category: 'reachout' | 'capping'
	reason: string
	enforcementType?: string
	expiresAt?: number
	quota?: { total?: number; used?: number }
	cycleStart?: number
	cycleEnd?: number
	action: 'blocked-no-retry'
}

export type OutboundPolicyDecision = {
	allowed: boolean
	restriction?: OutboundRestriction
}

const epochSeconds = (value: string | undefined): number | undefined => {
	if (!value) return undefined
	const parsed = Number(value)
	return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined
}

const activeReachout = (state: ReachoutTimelockState | undefined, now: number): OutboundRestriction | undefined => {
	if (!state?.isActive) return undefined
	const expiresAt = state.timeEnforcementEnds?.getTime()
	if (expiresAt !== undefined && expiresAt <= now) return undefined

	return {
		code: 'reachout-timelock',
		category: 'reachout',
		reason: state.enforcementType || 'reason unavailable',
		...(state.enforcementType ? { enforcementType: state.enforcementType } : {}),
		...(expiresAt ? { expiresAt } : {}),
		action: 'blocked-no-retry'
	}
}

const activeCapping = (
	info: NewChatMessageCapInfo | undefined,
	nowSeconds: number
): OutboundRestriction | undefined => {
	if (!info) return undefined
	const cycleStart = epochSeconds(info.cycle_start_timestamp)
	const cycleEnd = epochSeconds(info.cycle_end_timestamp)
	if (cycleEnd !== undefined && cycleEnd <= nowSeconds) return undefined

	const cappedByStatus = info.capping_status === 'CAPPED'
	const cappedByQuota =
		typeof info.total_quota === 'number' &&
		typeof info.used_quota === 'number' &&
		info.used_quota >= info.total_quota &&
		(cycleEnd === undefined || cycleEnd > nowSeconds)
	if (!cappedByStatus && !cappedByQuota) return undefined

	return {
		code: 'message-capping',
		category: 'capping',
		reason: cappedByStatus
			? info.capping_status || 'status-capped'
			: cappedByQuota
				? 'quota-exhausted'
				: 'reason unavailable',
		quota: { total: info.total_quota, used: info.used_quota },
		...(cycleStart ? { cycleStart } : {}),
		...(cycleEnd ? { cycleEnd } : {}),
		action: 'blocked-no-retry'
	}
}

export const evaluateOutboundPolicy = ({
	reachout,
	capping,
	now = Date.now()
}: {
	reachout?: ReachoutTimelockState
	capping?: NewChatMessageCapInfo
	now?: number
}): OutboundPolicyDecision => {
	const restriction = activeReachout(reachout, now) || activeCapping(capping, Math.floor(now / 1000))
	return restriction ? { allowed: false, restriction } : { allowed: true }
}
