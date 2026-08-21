import { NewChatMessageCappingStatusType, ReachoutTimelockEnforcementType } from '../../Types'
import { buildMessageAccountRestrictionDiagnostic, getMessageAckErrorPolicy } from '../../Utils/message-ack-error'

describe('message error ACK policy', () => {
	it('treats 463 as an account/reachout restriction without retry or token fetch', () => {
		expect(getMessageAckErrorPolicy('463')).toEqual({
			kind: 'message-account-restriction',
			retry: false,
			privacyTokenAction: 'none'
		})
	})

	it('treats 479 as smax-invalid diagnostics without retry or token fetch', () => {
		expect(getMessageAckErrorPolicy('479')).toEqual({
			kind: 'smax-invalid',
			retry: false,
			privacyTokenAction: 'none'
		})
	})

	it('does not invent retries for other server errors', () => {
		expect(getMessageAckErrorPolicy('421')).toEqual({
			kind: 'other',
			retry: false,
			privacyTokenAction: 'none'
		})
	})

	it('retains concrete reachout and capping fields in 463 diagnostics', () => {
		expect(
			buildMessageAccountRestrictionDiagnostic({
				jid: '5511999999999@s.whatsapp.net',
				msgId: 'message-1',
				code: '463',
				reason: 'reachout restricted',
				reachout: {
					isActive: true,
					enforcementType: ReachoutTimelockEnforcementType.RESTRICT_ALL_COMPANIONS,
					timeEnforcementEnds: new Date(1_700_000_000_000)
				},
				capping: {
					capping_status: NewChatMessageCappingStatusType.CAPPED,
					total_quota: 10,
					used_quota: 10,
					cycle_start_timestamp: '100',
					cycle_end_timestamp: '200'
				},
				reachoutLookup: 'lookup-complete',
				cappingLookup: 'lookup-complete'
			})
		).toEqual({
			jid: '5511999999999@s.whatsapp.net',
			msgId: 'message-1',
			code: '463',
			category: 'message-account-restriction',
			reason: 'reachout restricted',
			enforcementType: 'RESTRICT_ALL_COMPANIONS',
			enforcementEndsAt: 1_700_000_000_000,
			isReachoutActive: true,
			cappingStatus: 'CAPPED',
			quota: { total: 10, used: 10 },
			cycleStart: '100',
			cycleEnd: '200',
			reachoutDiagnostic: 'lookup-complete',
			cappingDiagnostic: 'lookup-complete'
		})
	})
})
