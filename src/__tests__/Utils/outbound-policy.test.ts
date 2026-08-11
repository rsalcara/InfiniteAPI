import { NewChatMessageCappingStatusType, ReachoutTimelockEnforcementType } from '../../Types'
import { evaluateOutboundPolicy } from '../../Utils/outbound-policy'

describe('outbound cold-recipient policy', () => {
	it('reports quota exhaustion instead of a non-blocking capping status', () => {
		expect(
			evaluateOutboundPolicy({
				capping: {
					capping_status: NewChatMessageCappingStatusType.NONE,
					total_quota: 10,
					used_quota: 10
				}
			})
		).toMatchObject({ allowed: false, restriction: { reason: 'quota-exhausted' } })
	})

	it('blocks an active reachout restriction without retry or bypass', () => {
		const now = Date.UTC(2026, 7, 6)
		expect(
			evaluateOutboundPolicy({
				now,
				reachout: {
					isActive: true,
					enforcementType: ReachoutTimelockEnforcementType.RESTRICT_ALL_COMPANIONS,
					timeEnforcementEnds: new Date(now + 60_000)
				}
			})
		).toEqual({
			allowed: false,
			restriction: {
				code: 'reachout-timelock',
				category: 'reachout',
				reason: ReachoutTimelockEnforcementType.RESTRICT_ALL_COMPANIONS,
				enforcementType: ReachoutTimelockEnforcementType.RESTRICT_ALL_COMPANIONS,
				expiresAt: now + 60_000,
				action: 'blocked-no-retry'
			}
		})
	})

	it('blocks an exhausted new-chat quota and preserves server diagnostics', () => {
		const now = Date.UTC(2026, 7, 6)
		const nowSeconds = Math.floor(now / 1000)
		const decision = evaluateOutboundPolicy({
			now,
			capping: {
				capping_status: NewChatMessageCappingStatusType.CAPPED,
				total_quota: 10,
				used_quota: 10,
				cycle_start_timestamp: String(nowSeconds - 100),
				cycle_end_timestamp: String(nowSeconds + 100)
			}
		})

		expect(decision).toMatchObject({
			allowed: false,
			restriction: {
				code: 'message-capping',
				category: 'capping',
				reason: NewChatMessageCappingStatusType.CAPPED,
				quota: { total: 10, used: 10 },
				action: 'blocked-no-retry'
			}
		})
	})

	it('allows an expired or inactive restriction', () => {
		const now = Date.UTC(2026, 7, 6)
		expect(
			evaluateOutboundPolicy({
				now,
				reachout: { isActive: true, timeEnforcementEnds: new Date(now - 1) },
				capping: {
					capping_status: NewChatMessageCappingStatusType.NONE,
					total_quota: 10,
					used_quota: 1
				}
			})
		).toEqual({ allowed: true })
	})
})
