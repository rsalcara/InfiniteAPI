/**
 * Pure parsing helpers that decompose the opaque string ids the generic
 * Signal key store (`session`/`sender-key`/`identity-key`) already uses
 * back into the structured fields `SignalTypedBackend`'s typed tables need.
 *
 * These ids are never invented here — they're exactly what
 * `Signal/libsignal.ts` already produces via `jidToSignalProtocolAddress`/
 * `jidToSignalSenderKeyName`/`jidDecode`, reverse-engineered from those
 * exact call sites (not guessed):
 *   - `session` id = `ProtocolAddress.toString()` = `"${signalUser}.${deviceId}"`
 *     (`node_modules/libsignal/src/protocol_address.js`), where
 *     `signalUser` is `user` for a plain PN/WhatsApp jid, or
 *     `${user}_${domainType}` for LID/hosted jids (see
 *     `jidToSignalProtocolAddress` in libsignal.ts).
 *   - `sender-key` id = `SenderKeyName.serialize()` =
 *     `"${groupId}::${sender.id}::${sender.deviceId}"` — `sender.id` is the
 *     SAME `signalUser` shape as above, accessed as a property (not through
 *     `.toString()`), so it is NOT dot-encoded with the device id here.
 *   - `identity-key` id is a plain jid string (`jidDecode`-able directly) —
 *     no ProtocolAddress involved.
 *
 * Only used to build a BEST-EFFORT MIRROR into the typed axolotl.db tables
 * (`sessions`/`sender_keys`/`identities`) — `axolotl.db.signal_kv` stays the
 * one source libsignal actually reads from. A parse miss here only means a
 * stale/missing mirror row, never a crypto-affecting outcome.
 */
import { WAJIDDomains } from '../../WABinary'

/** Real Android's `recipient_account_type`/`recipient_type` columns are binary: 0=PN, 1=LID. */
export type AccountType = 0 | 1

/**
 * `WAJIDDomains.LID` maps to the real schema's `1`. Every other domain type
 * — including `HOSTED`/`HOSTED_LID`, which have no confirmed real-Android
 * capture for this column — collapses to `0`. This is a simplification,
 * not a confirmed mapping for hosted numbers; documented rather than
 * guessed as gospel.
 */
export const domainTypeToAccountType = (domainType: number): AccountType => (domainType === WAJIDDomains.LID ? 1 : 0)

export type ParsedSignalUser = {
	user: string
	domainType: number
}

/**
 * Splits the `signalUser` component `jidToSignalProtocolAddress` builds
 * (`user` or `user_domainType`) back into its parts. Returns `null` when
 * the trailing `_<digits>` isn't a valid integer — treated as "can't mirror
 * this one" rather than a fabricated guess.
 */
export function parseSignalUser(signalUser: string): ParsedSignalUser | null {
	const underscoreIdx = signalUser.indexOf('_')
	if (underscoreIdx < 0) return { user: signalUser, domainType: WAJIDDomains.WHATSAPP }

	const domainTypeStr = signalUser.slice(underscoreIdx + 1)
	const domainType = Number(domainTypeStr)
	if (!Number.isInteger(domainType)) return null

	return { user: signalUser.slice(0, underscoreIdx), domainType }
}

export type ParsedProtocolAddressId = ParsedSignalUser & { deviceId: number }

/** Parses a `session` key id (`ProtocolAddress.toString()` = `"signalUser.deviceId"`). */
export function parseProtocolAddressId(id: string): ParsedProtocolAddressId | null {
	const lastDot = id.lastIndexOf('.')
	if (lastDot < 0) return null

	const deviceId = Number(id.slice(lastDot + 1))
	if (!Number.isInteger(deviceId)) return null

	const parsedUser = parseSignalUser(id.slice(0, lastDot))
	if (!parsedUser) return null

	return { ...parsedUser, deviceId }
}

export type ParsedSenderKeyId = {
	groupId: string
	sender: ParsedProtocolAddressId
}

/** Parses a `sender-key` id (`SenderKeyName.serialize()` = `"groupId::signalUser::deviceId"`). */
export function parseSenderKeyId(id: string): ParsedSenderKeyId | null {
	const parts = id.split('::')
	if (parts.length !== 3) return null

	const [groupId, signalUser, deviceIdStr] = parts as [string, string, string]
	const deviceId = Number(deviceIdStr)
	if (!Number.isInteger(deviceId)) return null

	const parsedUser = parseSignalUser(signalUser)
	if (!parsedUser) return null

	return { groupId, sender: { ...parsedUser, deviceId } }
}
