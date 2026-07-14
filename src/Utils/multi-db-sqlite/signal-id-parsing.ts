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
 *   - `identity-key` id is ALSO a `ProtocolAddress.toString()` (`signalUser.
 *     deviceId`, e.g. `46802258641027_1.0`), NOT a plain jid — libsignal keys
 *     identities by protocol address, same as sessions. `jidDecode` can't parse
 *     it (no `@server`); use {@link parseIdentityKey}.
 *
 * A parse miss here only means the value resolves from `axolotl.db.signal_kv`
 * (the source libsignal actually reads from) via the read-time fallback — never
 * a crypto-affecting outcome.
 */
import { jidDecode, jidEncode, WAJIDDomains } from '../../WABinary/jid-utils'

/** Real Android's `recipient_account_type`/`recipient_type` columns are binary: 0=PN, 1=LID. */
export type AccountType = 0 | 1

/**
 * Only PN and LID have a confirmed mapping in the typed Android schema.
 * Hosted and unknown domains must stay in `signal_kv`: collapsing them to
 * PN would let their composite keys overwrite a legitimate PN row.
 */
export const domainTypeToAccountType = (domainType: number): AccountType | null => {
	if (domainType === WAJIDDomains.WHATSAPP) return 0
	if (domainType === WAJIDDomains.LID) return 1
	return null
}

export type ParsedSignalUser = {
	user: string
	domainType: number
}

/**
 * Splits the `signalUser` component `jidToSignalProtocolAddress` builds
 * (`user` or `user_domainType`) back into its parts. Returns `null` when
 * the trailing `_<digits>` isn't a plain non-negative decimal — treated as
 * "can't mirror this one" rather than a fabricated guess. Uses the same
 * strict `parseNonNegativeInt` gate as the device/pre-key ids: a bare
 * `Number()` would coerce an empty suffix to 0 and accept negative /
 * exponential / hex forms, silently fabricating a domainType from junk.
 */
export function parseSignalUser(signalUser: string): ParsedSignalUser | null {
	const underscoreIdx = signalUser.indexOf('_')
	if (underscoreIdx < 0) return { user: signalUser, domainType: WAJIDDomains.WHATSAPP }

	const domainType = parseNonNegativeInt(signalUser.slice(underscoreIdx + 1))
	if (domainType === null) return null

	return { user: signalUser.slice(0, underscoreIdx), domainType }
}

/**
 * Parses a base-10 non-negative integer, or `null` for anything else.
 *
 * Uses `Number()` ONLY after a strict `/^\d+$/` gate because `Number('')`
 * and `Number('  ')` both return `0` (and pass `Number.isInteger`), which
 * would silently fabricate a device/pre-key id of 0 from an empty or
 * whitespace string. `Number('0x1f')`/`Number('1e3')` are likewise rejected
 * — Signal ids are always plain decimal.
 */
export function parseNonNegativeInt(s: string): number | null {
	if (!/^\d+$/.test(s)) return null
	return Number(s)
}

export type ParsedProtocolAddressId = ParsedSignalUser & { deviceId: number }

/** Parses a `session` key id (`ProtocolAddress.toString()` = `"signalUser.deviceId"`). */
export function parseProtocolAddressId(id: string): ParsedProtocolAddressId | null {
	const lastDot = id.lastIndexOf('.')
	if (lastDot < 0) return null

	const deviceId = parseNonNegativeInt(id.slice(lastDot + 1))
	if (deviceId === null) return null

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
	const deviceId = parseNonNegativeInt(deviceIdStr)
	if (deviceId === null) return null

	const parsedUser = parseSignalUser(signalUser)
	if (!parsedUser) return null

	return { groupId, sender: { ...parsedUser, deviceId } }
}

export type ParsedIdentityKey = { jid: string; recipientType: AccountType; deviceId: number | null }

export type IdentityKeyFallbackReason = 'unparseable' | 'hosted-domain' | 'unknown-domain' | 'unsupported-jid-server'

export type IdentityKeyFallback = {
	kind: 'fallback'
	reason: IdentityKeyFallbackReason
	domainType?: number
	server?: string
}

export type IdentityKeyParseResult = { kind: 'typed'; key: ParsedIdentityKey } | IdentityKeyFallback

/**
 * Parses an `identity-key` id into the structured `identities` key. Like a
 * session id, this is a libsignal PROTOCOL ADDRESS (`signalUser.deviceId`), NOT a
 * plain jid — so we parse it the same way and reconstruct the canonical
 * `user@server` jid for the `jid`-table FK (a jid-shaped id, with no device
 * separator, still resolves via the `jidDecode` fallback).
 *
 * ONLY PN and LID are mapped into the typed table; HOSTED / HOSTED_LID and any
 * unknown domain return a classified fallback so they resolve via `signal_kv`.
 * This is DELIBERATE and load-bearing: their `recipient_type`/server semantics
 * aren't confirmed against real Android, and reconstructing a hosted id onto a
 * shared server (`s.whatsapp.net`) would COLLIDE with a real PN identity on the
 * `(recipient_id, recipient_type, device_id)` key — the upsert could then
 * overwrite the PN public key, and a later PN read would hand back the wrong
 * (hosted) key material as a typed hit. Leaving hosted to signal_kv is correct.
 */
export function classifyIdentityKey(id: string): IdentityKeyParseResult {
	const addr = parseProtocolAddressId(id)
	if (addr) {
		if (!addr.user) return { kind: 'fallback', reason: 'unparseable' }

		if (addr.domainType === WAJIDDomains.WHATSAPP) {
			return {
				kind: 'typed',
				key: { jid: jidEncode(addr.user, 's.whatsapp.net'), recipientType: 0, deviceId: addr.deviceId }
			}
		}

		if (addr.domainType === WAJIDDomains.LID) {
			return {
				kind: 'typed',
				key: { jid: jidEncode(addr.user, 'lid'), recipientType: 1, deviceId: addr.deviceId }
			}
		}

		if (addr.domainType === WAJIDDomains.HOSTED || addr.domainType === WAJIDDomains.HOSTED_LID) {
			return { kind: 'fallback', reason: 'hosted-domain', domainType: addr.domainType }
		}

		return { kind: 'fallback', reason: 'unknown-domain', domainType: addr.domainType }
	}

	const decoded = jidDecode(id)
	if (!decoded?.user) return { kind: 'fallback', reason: 'unparseable' }

	const domainType = decoded.domainType ?? WAJIDDomains.WHATSAPP
	if (decoded.server === 'hosted' || decoded.server === 'hosted.lid') {
		return { kind: 'fallback', reason: 'hosted-domain', domainType, server: decoded.server }
	}

	if (decoded.server === 's.whatsapp.net') {
		if (domainType !== WAJIDDomains.WHATSAPP) {
			return { kind: 'fallback', reason: 'unknown-domain', domainType, server: decoded.server }
		}

		return {
			kind: 'typed',
			key: { jid: jidEncode(decoded.user, 's.whatsapp.net'), recipientType: 0, deviceId: decoded.device ?? null }
		}
	}

	if (decoded.server === 'lid') {
		return {
			kind: 'typed',
			key: { jid: jidEncode(decoded.user, 'lid'), recipientType: 1, deviceId: decoded.device ?? null }
		}
	}

	// jidDecode intentionally accepts arbitrary `@server` values and defaults
	// their domainType to WHATSAPP. Never use that default to canonicalize an
	// unknown server onto s.whatsapp.net: doing so would let (for example)
	// `123@g.us` overwrite the typed identity for `123@s.whatsapp.net`.
	return { kind: 'fallback', reason: 'unsupported-jid-server', domainType, server: decoded.server }
}

/** Compatibility helper for callers that only need a typed key or a miss. */
export function parseIdentityKey(id: string): ParsedIdentityKey | null {
	const result = classifyIdentityKey(id)
	return result.kind === 'typed' ? result.key : null
}
