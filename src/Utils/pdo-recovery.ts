import type { WAMessageKey } from '../Types'
import { isAnyPnUser } from '../WABinary/jid-utils'

/** Explicit escape keeps NUL visible in source review. */
const KEY_SEPARATOR = '\u0000'

const senderOf = (key: WAMessageKey): string | undefined =>
	key.participantAlt || key.remoteJidAlt || key.participant || key.remoteJid || undefined

/**
 * Choose the sender spelling that survives inbound JID normalization.
 * Normalization resolves LID to PN when a mapping is available, so a key built
 * from an LID alt before normalization would no longer match its own message
 * after success. PN is the stable canonical spelling for retry state.
 */
const canonicalKeySenderOf = (key: WAMessageKey): string | undefined => {
	const candidates = [key.participantAlt, key.participant, key.remoteJidAlt, key.remoteJid].filter(
		(jid): jid is string => !!jid
	)
	return candidates.find(candidate => isAnyPnUser(candidate)) ?? candidates[0]
}

const aliasesOverlap = async (
	first: string | undefined,
	second: string | undefined,
	resolveAliases?: (jid: string) => Promise<string[]>
): Promise<boolean> => {
	if (!first || !second) return false
	if (first === second) return true

	const firstAliases = new Set(resolveAliases ? await resolveAliases(first) : [first])
	const secondAliases = resolveAliases ? await resolveAliases(second) : [second]
	return secondAliases.some(alias => alias && firstAliases.has(alias))
}

/**
 * Build the in-flight PDO request identity.
 *
 * WhatsApp message IDs are chosen by the sending client, so a group can carry
 * the same ID from two participants. Gating requests by chat and ID alone
 * silently suppresses the second sender's recovery.
 *
 * The identity is a NUL-separated composite of `[remoteJid, fromMe, sender, id]`.
 * Callers MUST capture the key from the raw decoded message **before**
 * `normalizeMessageJids`, because normalization rewrites both the chat
 * (component 0, `remoteJid` LID→PN) and the sender (component 2, via
 * `canonicalKeySenderOf`) when a LID→PN mapping is available. Capturing
 * after normalization would produce a different key than the one staged by
 * `sendRetryRequest`, causing counters and timers to leak.
 */
export const pdoRequestCacheKey = (messageKey: WAMessageKey): string => {
	const remoteJid = messageKey.remoteJid ?? ''
	const sender = canonicalKeySenderOf(messageKey) ?? ''

	return [remoteJid, messageKey.fromMe ? '1' : '0', sender, messageKey.id ?? ''].join(KEY_SEPARATOR)
}

/**
 * Verify that a PDO response describes the message that was requested.
 *
 * `resolveAliases` returns the PN and LID spellings for a participant when a
 * mapping is available. A caller without mappings can omit it; exact spelling
 * comparison remains safe and merely skips cross-domain aliasing.
 */
export const isSamePlaceholderRecovery = async (
	requestKey: WAMessageKey,
	responseKey: WAMessageKey,
	resolveAliases?: (jid: string) => Promise<string[]>
): Promise<boolean> => {
	const requestedChat = requestKey.remoteJid ?? ''
	const responseChat = responseKey.remoteJid ?? ''
	if (!!requestKey.fromMe !== !!responseKey.fromMe) return false
	if (requestKey.id !== responseKey.id) return false

	const chatMatches = await aliasesOverlap(requestedChat || undefined, responseChat || undefined, resolveAliases)
	if (!chatMatches) return false

	const requestSender = senderOf(requestKey)
	const responseSender = senderOf(responseKey)
	if (!requestSender || !responseSender) return chatMatches
	if (requestSender === responseSender) return true

	return aliasesOverlap(requestSender, responseSender, resolveAliases)
}
