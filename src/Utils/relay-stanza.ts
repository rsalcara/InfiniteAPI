import { Boom } from '@hapi/boom'
import {
	areJidsSameUser,
	type BinaryNode,
	isAnyLidUser,
	isAnyPnUser,
	jidDecode,
	jidEncode,
	jidNormalizedUser,
	transferDevice
} from '../WABinary'

export const MAX_PARTICIPANT_FANOUT = 4096
export const PARTICIPANT_FANOUT_CONCURRENCY = 32

export type ParticipantTcTokenFanoutOptions = {
	enabled?: boolean
	maxUsers?: number
	concurrency?: number
	resolveToken: (userJid: string) => Promise<Buffer | undefined>
	onResolveError?: (error: unknown, userJid: string) => void
}

/** Official legacy group-add participant shape: privacy is a child of participant. */
export const buildGroupParticipantNode = (jid: string, privacyToken?: Buffer): BinaryNode => ({
	tag: 'participant',
	attrs: { jid },
	...(privacyToken?.length ? { content: [{ tag: 'privacy', attrs: {}, content: privacyToken }] } : {})
})

/** Canonicalizes PN recipients to LID without collapsing companion device IDs. */
export const canonicalizeParticipantFanoutRecipient = async (
	jid: string,
	getLIDForPN: (pn: string) => Promise<string | null>
): Promise<string> => {
	const source = jidDecode(jid)
	const normalized = jidNormalizedUser(jid)
	if (!source || !normalized) return normalized
	if (!isAnyPnUser(normalized)) return transferDevice(jid, normalized)

	const lid = await getLIDForPN(jidEncode(source.user, source.server === 'hosted' ? 'hosted' : 's.whatsapp.net'))
	const target = lid && jidDecode(lid)?.user ? lid : normalized
	return transferDevice(jid, target)
}

/** Resolves the canonical LID only when a direct destination is the connected account itself. */
export const resolveSelfSendLid = (
	destinationJid: string,
	meId: string,
	meLid?: string,
	mappedLid?: string | null
): string | null => {
	const destination = jidNormalizedUser(destinationJid)
	const ownPn = jidNormalizedUser(meId)
	const normalizedMeLid = jidNormalizedUser(meLid ?? undefined)
	const normalizedMappedLid = jidNormalizedUser(mappedLid ?? undefined)
	const isValidLid = (jid: string): boolean => Boolean(isAnyLidUser(jid) && jidDecode(jid)?.user)
	const lidCandidates = [normalizedMeLid, normalizedMappedLid].filter(
		(jid): jid is string => Boolean(jid) && isValidLid(jid)
	)
	const matchingLid = isAnyLidUser(destination)
		? lidCandidates.find(lid => areJidsSameUser(destination, lid))
		: undefined
	if (matchingLid) return matchingLid

	const isOwnPnDestination = isAnyPnUser(destination) && isAnyPnUser(ownPn) && areJidsSameUser(destination, ownPn)
	if (!isOwnPnDestination) return null

	// A mapping resolved for the requested PN is fresher than a possibly stale
	// credential LID. Fall back to the credential only when no mapping exists.
	return (
		(isValidLid(normalizedMappedLid) && normalizedMappedLid) || (isValidLid(normalizedMeLid) ? normalizedMeLid : null)
	)
}

/** Selects the matching own identity for a direct retry participant. */
export const isSelfRetryParticipant = (participantJid: string, meId: string, meLid?: string): boolean =>
	areJidsSameUser(participantJid, isAnyLidUser(participantJid) ? meLid : meId)

/** Moves only the connected account's participant devices to its canonical LID domain. */
export const canonicalizeSelfSendFanoutRecipient = (
	jid: string,
	meId: string,
	selfLid: string,
	credentialLid?: string
): string => {
	const normalized = jidNormalizedUser(jid)
	const isOwnPn = isAnyPnUser(normalized) && areJidsSameUser(normalized, meId)
	const isOwnLid =
		isAnyLidUser(normalized) &&
		(areJidsSameUser(normalized, selfLid) || Boolean(credentialLid && areJidsSameUser(normalized, credentialLid)))
	// A self-send device list can contain a stale/rotated or hosted LID that no
	// longer matches either current credential. It was still returned by the
	// own-device lookup, so preserve its device id while moving it to the fresh
	// canonical self LID before the strict fanout guard runs.
	const isLegacyOwnLid = isAnyLidUser(normalized) && !isOwnLid

	return isOwnPn || isOwnLid || isLegacyOwnLid ? transferDevice(jid, selfLid) : jid
}

/** Fails closed if a self-send participant escaped the canonical LID domain. */
export const assertSelfSendFanoutLid = (selfLid: string, recipients: readonly string[]): void => {
	const expected = jidDecode(selfLid)
	const invalid = recipients.filter(recipient => {
		const decoded = jidDecode(recipient)
		return !decoded || decoded.user !== expected?.user || decoded.server !== expected.server
	})

	if (invalid.length > 0) {
		throw new Boom('Self-send participant fanout is not canonicalized to the own LID', {
			statusCode: 503,
			data: { selfLid, invalidRecipients: invalid, category: 'self-send-addressing' }
		})
	}
}

export const dedupeParticipantFanout = <T>(items: readonly T[], key: (item: T) => string): T[] => {
	const seen = new Set<string>()
	return items.filter(item => {
		const value = key(item)
		if (seen.has(value)) return false
		seen.add(value)
		return true
	})
}

/** Deduplicates canonical self-send fanout, preferring the DSM copy for own devices. */
export const dedupeSelfSendFanout = (
	meRecipients: readonly string[],
	otherRecipients: readonly string[]
): { meRecipients: string[]; otherRecipients: string[]; allRecipients: string[] } => {
	const dedupedMe = dedupeParticipantFanout(meRecipients, recipient => recipient)
	const meSet = new Set(dedupedMe)
	const dedupedOther = dedupeParticipantFanout(otherRecipients, recipient => recipient).filter(
		recipient => !meSet.has(recipient)
	)

	return {
		meRecipients: dedupedMe,
		otherRecipients: dedupedOther,
		allRecipients: [...dedupedMe, ...dedupedOther]
	}
}

/** Maps fanout entries in bounded batches so large groups cannot exhaust memory or Signal locks. */
export const mapParticipantFanout = async <T, R>(
	items: readonly T[],
	map: (item: T) => Promise<R>,
	options: { max?: number; concurrency?: number } = {}
): Promise<R[]> => {
	const max = options.max ?? MAX_PARTICIPANT_FANOUT
	const concurrency = options.concurrency ?? PARTICIPANT_FANOUT_CONCURRENCY
	if (!Number.isInteger(concurrency) || concurrency < 1)
		throw new Boom('Participant fanout concurrency must be positive')
	if (items.length > max) {
		throw new Boom(`Participant fanout exceeds limit (${items.length}/${max})`, { statusCode: 413 })
	}

	const results: R[] = []
	for (let offset = 0; offset < items.length; offset += concurrency) {
		results.push(...(await Promise.all(items.slice(offset, offset + concurrency).map(map))))
	}

	return results
}

/**
 * Adds one trusted-contact token per user to the first matching `<to>` node.
 * Companion devices remain separate encrypted recipients; only token lookup is
 * deduplicated by user, matching Android's PrivacyToken stanza contributor.
 * Token lookup is best-effort and can never suppress an encrypted recipient.
 */
export const appendTcTokensToParticipantFanout = async (
	participants: BinaryNode[],
	options: ParticipantTcTokenFanoutOptions
): Promise<void> => {
	if (options.enabled === false || !participants.length) return

	const maxUsers = options.maxUsers ?? MAX_PARTICIPANT_FANOUT
	if (!Number.isInteger(maxUsers) || maxUsers < 0) throw new Boom('TcToken fanout user limit must be non-negative')
	if (maxUsers === 0) return

	const firstParticipantByUser = new Map<string, BinaryNode>()
	for (const participant of participants) {
		if (participant.tag !== 'to') continue
		const userJid = jidNormalizedUser(participant.attrs.jid)
		if (userJid && !firstParticipantByUser.has(userJid)) firstParticipantByUser.set(userJid, participant)
	}

	const targets = [...firstParticipantByUser.entries()].slice(0, maxUsers)
	await mapParticipantFanout(
		targets,
		async ([userJid, participant]) => {
			try {
				const token = await options.resolveToken(userJid)
				if (!token?.length) return
				const content = Array.isArray(participant.content) ? participant.content : []
				if (!content.some(child => child.tag === 'tctoken')) {
					participant.content = [...content, { tag: 'tctoken', attrs: {}, content: token }]
				}
			} catch (error) {
				options.onResolveError?.(error, userJid)
			}
		},
		{ max: maxUsers, concurrency: options.concurrency }
	)
}

/**
 * Appends the per-device fanout assembled for a normal message send.
 *
 * A direct retry already carries one top-level `<enc>` addressed to the
 * requested device. Combining it with `<participants>` encryptions is an
 * invalid mixed delivery mode and is rejected by the server as SmaxInvalid
 * (479). Keep this guard fail-closed so a future fanout refactor cannot
 * silently recreate that wire shape.
 */
export const appendParticipantFanoutNode = (
	binaryNodeContent: BinaryNode[],
	participants: BinaryNode[],
	isRetryResend: boolean,
	isPeerMessage: boolean
): void => {
	if (isRetryResend) {
		if (participants.length) {
			throw new Boom('Direct retry resend cannot include participant fanout')
		}

		return
	}

	if (!participants.length) return

	if (isPeerMessage) {
		const peerNode = participants[0]?.content?.[0] as BinaryNode | undefined
		if (peerNode) binaryNodeContent.push(peerNode)
		return
	}

	binaryNodeContent.push({
		tag: 'participants',
		attrs: {},
		content: participants
	})
}
