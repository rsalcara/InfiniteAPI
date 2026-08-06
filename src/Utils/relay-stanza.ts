import { Boom } from '@hapi/boom'
import { type BinaryNode, isAnyPnUser, jidDecode, jidEncode, jidNormalizedUser, transferDevice } from '../WABinary'

export const MAX_PARTICIPANT_FANOUT = 4096
export const PARTICIPANT_FANOUT_CONCURRENCY = 32

/** Canonicalizes PN recipients to LID without collapsing companion device IDs. */
export const canonicalizeParticipantFanoutRecipient = async (
	jid: string,
	getLIDForPN: (pn: string) => Promise<string | null>
): Promise<string> => {
	const source = jidDecode(jid)
	const normalized = jidNormalizedUser(jid)
	if (!source || !normalized) return normalized
	if (!isAnyPnUser(normalized)) return transferDevice(jid, normalized)

	const lid = await getLIDForPN(jidEncode(source.user, 's.whatsapp.net'))
	const target = lid && jidDecode(lid)?.user ? lid : normalized
	return transferDevice(jid, target)
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

/** Maps fanout entries in bounded batches so large groups cannot exhaust memory or Signal locks. */
export const mapParticipantFanout = async <T, R>(
	items: readonly T[],
	map: (item: T) => Promise<R>,
	options: { max?: number; concurrency?: number } = {}
): Promise<R[]> => {
	const max = options.max ?? MAX_PARTICIPANT_FANOUT
	const concurrency = options.concurrency ?? PARTICIPANT_FANOUT_CONCURRENCY
	if (!Number.isInteger(concurrency) || concurrency < 1) throw new Boom('Participant fanout concurrency must be positive')
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
