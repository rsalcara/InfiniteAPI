import type { NewChatMessageCapInfo, ReachoutTimelockState } from '../Types'

export type MessageAckErrorPolicy = {
	kind: 'message-account-restriction' | 'smax-invalid' | 'other'
	retry: false
	privacyTokenAction: 'none'
}

/**
 * Error ACK policy shared by the production handler and regression tests.
 * Neither 463 nor 479 is a request to fetch a peer privacy token: the only
 * privacy IQ available to companions is `type=set` (our-token issuance).
 */
export const getMessageAckErrorPolicy = (error: string): MessageAckErrorPolicy => ({
	kind: error === '463' ? 'message-account-restriction' : error === '479' ? 'smax-invalid' : 'other',
	retry: false,
	privacyTokenAction: 'none'
})

export type MessageAccountRestrictionDiagnostic = {
	jid: string
	msgId?: string
	code: string
	category: 'message-account-restriction'
	reason: string
	enforcementType?: string
	enforcementEndsAt?: number
	isReachoutActive?: boolean
	cappingStatus?: string
	quota: { total?: number; used?: number }
	cycleStart?: string
	cycleEnd?: string
	reachoutDiagnostic: 'lookup-complete' | 'lookup-failed'
	cappingDiagnostic: 'lookup-complete' | 'lookup-failed'
}

/** Builds the structured 463 evidence without guessing missing server fields. */
export const buildMessageAccountRestrictionDiagnostic = ({
	jid,
	msgId,
	code,
	reason,
	reachout,
	capping,
	reachoutLookup,
	cappingLookup
}: {
	jid: string
	msgId?: string
	code: string
	reason: string
	reachout?: ReachoutTimelockState
	capping?: NewChatMessageCapInfo
	reachoutLookup: 'lookup-complete' | 'lookup-failed'
	cappingLookup: 'lookup-complete' | 'lookup-failed'
}): MessageAccountRestrictionDiagnostic => ({
	jid,
	msgId,
	code,
	category: 'message-account-restriction',
	reason,
	...(reachout?.enforcementType ? { enforcementType: reachout.enforcementType } : {}),
	...(reachout?.timeEnforcementEnds ? { enforcementEndsAt: reachout.timeEnforcementEnds.getTime() } : {}),
	...(reachout?.isActive !== undefined ? { isReachoutActive: reachout.isActive } : {}),
	cappingStatus: capping?.capping_status,
	quota: { total: capping?.total_quota, used: capping?.used_quota },
	cycleStart: capping?.cycle_start_timestamp,
	cycleEnd: capping?.cycle_end_timestamp,
	reachoutDiagnostic: reachoutLookup,
	cappingDiagnostic: cappingLookup
})
