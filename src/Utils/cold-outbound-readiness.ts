import { type NewChatMessageCapInfo, NewChatMessageCappingStatusType, type ReachoutTimelockState } from '../Types/State'
import { type AbProps, isAbPropEnabled } from './ab-props'
import { type CsTokenMode, NCT_TOKEN_AB_PROP } from './nct-token'

/**
 * How a new 1:1 chat (no privacy token from the recipient) is gated before
 * any network work:
 *
 * - `strict`: the account's reachout timelock and new-chat quota
 *   must be known and open, and the first message must be able to carry a
 *   `<cstoken>` (account NCT salt, plus AB prop 24941 in `ab-prop` mode).
 *   Start-chat trust signals follow `startChatTrustSignalsPolicy` as before.
 * - `policy`: only the timelock and quota must be known and open. This is the
 *   app's own gate (`C2DK.A00`), which reads them from local state.
 * - `legacy` (default): only a restriction the server reported blocks; an
 *   unknown state lets the send through.
 *
 * The app always has the timelock/quota state locally (server pushes and its
 * own fetches). A companion whose lookups failed does not, and a first contact
 * sent blind was answered with `RESTRICT_ALL_COMPANIONS` and every companion
 * removed (incident 2026-10-02); `policy` and `strict` close that gap for
 * whoever opts in, and `getColdOutboundReadiness()` reports it in any mode.
 */
export type ColdOutboundMode = 'strict' | 'policy' | 'legacy'

export type ColdOutboundBlockReason =
	| 'reachout_state_unknown'
	| 'capping_state_unknown'
	| 'nct_salt_missing'
	| 'cstoken_disabled'
	| 'ab_prop_24941_unknown'
	| 'ab_prop_24941_disabled'

export type ColdOutboundReadinessInput = {
	mode: ColdOutboundMode
	reachout?: ReachoutTimelockState
	capping?: NewChatMessageCapInfo
	nctSalt?: Uint8Array
	abProps?: AbProps
	csTokenMode: CsTokenMode
}

/** A capping answer says something only with a status or both quota numbers. */
const isCappingKnown = (capping: NewChatMessageCapInfo | undefined) =>
	!!capping &&
	(Object.values(NewChatMessageCappingStatusType).includes(capping.capping_status as NewChatMessageCappingStatusType) ||
		(typeof capping.total_quota === 'number' && typeof capping.used_quota === 'number'))

/**
 * Reasons a new chat may not be started yet; empty means ready. An active
 * timelock or exhausted quota is reported by `evaluateOutboundPolicy`, not
 * here: this only covers what the engine does not know or cannot send.
 */
export const evaluateColdOutboundReadiness = ({
	mode,
	reachout,
	capping,
	nctSalt,
	abProps,
	csTokenMode
}: ColdOutboundReadinessInput): ColdOutboundBlockReason[] => {
	if (mode === 'legacy') return []

	const reasons: ColdOutboundBlockReason[] = []
	// The fetch keeps `isActive` undefined when the server omits it: an
	// omission is not proof that no timelock is in force.
	if (typeof reachout?.isActive !== 'boolean') reasons.push('reachout_state_unknown')
	if (!isCappingKnown(capping)) reasons.push('capping_state_unknown')
	if (mode === 'policy') return reasons

	if (!nctSalt?.length) reasons.push('nct_salt_missing')
	if (csTokenMode === 'off') {
		reasons.push('cstoken_disabled')
	} else if (csTokenMode === 'ab-prop') {
		if (abProps?.[NCT_TOKEN_AB_PROP] === undefined) reasons.push('ab_prop_24941_unknown')
		else if (!isAbPropEnabled(abProps, NCT_TOKEN_AB_PROP)) reasons.push('ab_prop_24941_disabled')
	}

	return reasons
}
