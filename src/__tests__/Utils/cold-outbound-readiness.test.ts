import { NewChatMessageCappingStatusType, ReachoutTimelockEnforcementType } from '../../Types'
import { evaluateColdOutboundReadiness } from '../../Utils/cold-outbound-readiness'

const open = {
	reachout: { isActive: false, enforcementType: ReachoutTimelockEnforcementType.DEFAULT },
	capping: { capping_status: NewChatMessageCappingStatusType.NONE }
}
const salt = new Uint8Array(32).fill(7)

describe('evaluateColdOutboundReadiness', () => {
	it('treats an unknown timelock or quota as not ready (strict and policy)', () => {
		for (const mode of ['strict', 'policy'] as const) {
			const reasons = evaluateColdOutboundReadiness({ mode, nctSalt: salt, csTokenMode: 'salt' })
			expect(reasons).toEqual(expect.arrayContaining(['reachout_state_unknown', 'capping_state_unknown']))
		}
	})

	it('treats a timelock answer without is_active as unknown', () => {
		const reasons = evaluateColdOutboundReadiness({
			mode: 'policy',
			reachout: { isActive: undefined, enforcementType: ReachoutTimelockEnforcementType.DEFAULT },
			capping: open.capping,
			csTokenMode: 'salt'
		})
		expect(reasons).toEqual(['reachout_state_unknown'])
	})

	it('requires a first-contact token only in strict mode', () => {
		expect(evaluateColdOutboundReadiness({ mode: 'policy', ...open, csTokenMode: 'salt' })).toEqual([])
		expect(evaluateColdOutboundReadiness({ mode: 'strict', ...open, csTokenMode: 'salt' })).toEqual([
			'nct_salt_missing'
		])
		expect(evaluateColdOutboundReadiness({ mode: 'strict', ...open, nctSalt: salt, csTokenMode: 'salt' })).toEqual([])
		expect(evaluateColdOutboundReadiness({ mode: 'strict', ...open, nctSalt: salt, csTokenMode: 'off' })).toEqual([
			'cstoken_disabled'
		])
	})

	it('follows AB prop 24941 in ab-prop mode: unknown, off and on', () => {
		const base = { mode: 'strict' as const, ...open, nctSalt: salt, csTokenMode: 'ab-prop' as const }
		expect(evaluateColdOutboundReadiness({ ...base, abProps: {} })).toEqual(['ab_prop_24941_unknown'])
		expect(evaluateColdOutboundReadiness({ ...base, abProps: { '24941': 'false' } })).toEqual([
			'ab_prop_24941_disabled'
		])
		expect(evaluateColdOutboundReadiness({ ...base, abProps: { '24941': 'true' } })).toEqual([])
	})

	it('keeps the old behavior in legacy mode', () => {
		expect(evaluateColdOutboundReadiness({ mode: 'legacy', csTokenMode: 'off' })).toEqual([])
	})
})
