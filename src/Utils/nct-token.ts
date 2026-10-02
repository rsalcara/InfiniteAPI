import type { proto } from '../../WAProto/index.js'
import type { ConnectionTransportProfile } from '../Types'
import { type BinaryNode, isLidUser, jidNormalizedUser, S_WHATSAPP_NET } from '../WABinary'
import { type AbProps, isAbPropEnabled } from './ab-props'
import { decodeSyncdSnapshot } from './chat-utils'
import { hmacSign } from './crypto'

/**
 * New-chat (NCT) token: the `<cstoken>` a 1:1 message carries when the
 * recipient has no usable privacy token, so the server can tell a first
 * contact from this account apart from an anonymous reach-out.
 *
 * App: `NctTokenMessageSendStanzaContributor` (`X/C30120DHe.java`) runs right
 * after the privacy-token contributor, only when `PrivacyTokenStore.A0X` has no
 * usable token and AB prop 24941 is on, and signs
 * `HMAC-SHA256(key = account NCT salt, data = UTF-8 of the recipient JID)`
 * (`X/AbstractC36991kN.java`); it logs "recipient LID is empty" for the JID.
 * WA Web (and whatsmeow, which follows it) sends it whenever the salt is
 * present, over the recipient LID without device.
 *
 * The salt belongs to the account. A companion never creates it
 * (`NctSaltProvider.A00`, `X/C69453Aa.java`, returns null when
 * `registration_device_id > 0`); it stores the one the primary sends in the
 * initial history bootstrap (`HistorySync.nctSalt`,
 * `X/C29379CuL.java:474-476`) or in a SET `nct_salt_sync` mutation of
 * `regular_high` (`X/AbstractC25280B9y.java:5197-5205`).
 */
export const NCT_TOKEN_AB_PROP = '24941'

export type CsTokenMode = 'off' | 'ab-prop' | 'salt'

export const resolveCsTokenMode = (profile: ConnectionTransportProfile, mode?: CsTokenMode): CsTokenMode =>
	mode ?? (profile === 'native_android' ? 'ab-prop' : 'salt')

export const computeCsToken = (salt: Uint8Array, recipientLid: string) =>
	hmacSign(Buffer.from(recipientLid, 'utf8'), salt)

/**
 * The `<cstoken>` node for a 1:1 send, or undefined when it must not be sent:
 * mode off, no salt, no recipient LID, or (in `ab-prop` mode) prop 24941 off.
 */
export const buildCsTokenNode = (
	recipientLid: string | null | undefined,
	salt: Uint8Array | undefined,
	mode: CsTokenMode,
	abProps: AbProps | undefined
): BinaryNode | undefined => {
	if (mode === 'off' || !salt?.length || !recipientLid || !isLidUser(recipientLid)) {
		return undefined
	}

	if (mode === 'ab-prop' && !isAbPropEnabled(abProps, NCT_TOKEN_AB_PROP)) {
		return undefined
	}

	return { tag: 'cstoken', attrs: {}, content: computeCsToken(salt, jidNormalizedUser(recipientLid)) }
}

/** The app files `nct_salt_sync` under `regular_high` (`X/C1LE.java`, ordinal 73). */
export const NCT_SALT_COLLECTION = 'regular_high' as const

/** `w:sync:app:state` query for a `regular_high` snapshot, read-only for the caller. */
export const buildNctSaltSnapshotQuery = (version: number): BinaryNode => ({
	tag: 'iq',
	attrs: { to: S_WHATSAPP_NET, xmlns: 'w:sync:app:state', type: 'set' },
	content: [
		{
			tag: 'sync',
			attrs: {},
			content: [
				{
					tag: 'collection',
					attrs: { name: NCT_SALT_COLLECTION, version: String(version), return_snapshot: 'true' }
				}
			]
		}
	]
})

/**
 * Finds the account salt in a `regular_high` snapshot. Only `nct_salt_sync` is
 * read: the caller neither persists the snapshot nor applies its other
 * mutations. Throws the decode error (e.g. a missing app-state key) as is.
 */
export const findNctSaltInSnapshot = async (
	snapshot: proto.ISyncdSnapshot,
	getAppStateSyncKey: Parameters<typeof decodeSyncdSnapshot>[2],
	validateMacs: boolean
): Promise<Uint8Array | undefined> => {
	const { mutationMap } = await decodeSyncdSnapshot(
		NCT_SALT_COLLECTION,
		snapshot,
		getAppStateSyncKey,
		undefined,
		validateMacs
	)
	let salt: Uint8Array | undefined
	for (const mutation of Object.values(mutationMap)) {
		const candidate = mutation.syncAction.value?.nctSaltSyncAction?.salt
		if (mutation.index[0] === 'nct_salt_sync' && candidate?.length) salt = candidate
	}

	return salt
}
