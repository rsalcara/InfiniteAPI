import { Boom } from '@hapi/boom'
import type { BinaryNode } from '../WABinary'

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
