import { jest } from '@jest/globals'
import P from 'pino'
import type { SignalRepositoryWithLIDStore } from '../../Types'
import { decodeMessageNode } from '../../Utils/decode-wa-message'
import { MessageRetryManager } from '../../Utils/message-retry-manager'
import { pdoRequestCacheKey } from '../../Utils/pdo-recovery'
import { normalizeMessageJids } from '../../Utils/process-message'
import type { BinaryNode } from '../../WABinary'

const silent = P({ level: 'silent' })
const ME_PN = '5511800000000@s.whatsapp.net'
const ME_LID = '200000000000000@lid'
const PEER_PN = '5511900000000@s.whatsapp.net'
const PEER_LID = '200000000000001@lid'
const GROUP_JID = '120363400000000000@g.us'
const messageId = 'NORMALIZATION-1'

const messageStanza = (attrs: BinaryNode['attrs']): BinaryNode => ({
	tag: 'message',
	attrs: {
		id: messageId,
		type: 'text',
		addressing_mode: 'lid',
		...attrs
	},
	content: [{ tag: 'enc', attrs: { type: 'msg' }, content: Buffer.from([1, 2, 3]) }]
})

describe('PDO retry identity across message JID normalization', () => {
	it.each([
		['DM LID with sender_pn', messageStanza({ from: PEER_LID, sender_pn: PEER_PN })],
		['DM LID without sender_pn', messageStanza({ from: PEER_LID })],
		['group JID without participant_pn', messageStanza({ from: GROUP_JID, participant: PEER_LID })]
	])('clears retry state staged before normalization for %s', async (_name, stanza) => {
		const getPNForLID = jest.fn(async (jid: string) => (jid === PEER_LID ? PEER_PN : null))
		const signalRepository = {
			lidMapping: { getPNForLID }
		} as unknown as SignalRepositoryWithLIDStore

		const { fullMessage } = decodeMessageNode(stanza, ME_PN, ME_LID)
		const retryIdentity = pdoRequestCacheKey(fullMessage.key)

		await normalizeMessageJids(fullMessage, signalRepository)
		const normalizedIdentity = pdoRequestCacheKey(fullMessage.key)

		// These are the unstable-key scenarios. The production fix must complete the
		// retry with the identity captured before normalization, not the normalized one.
		expect(normalizedIdentity).not.toBe(retryIdentity)

		const manager = new MessageRetryManager(silent, 5)
		expect(manager.tryIncrement(retryIdentity)).toEqual({ proceed: true, count: 1 })
		expect(manager.markInboundRetrySuccess(normalizedIdentity)).toBe(false)
		expect(manager.markInboundRetrySuccess(retryIdentity)).toBe(true)
	})
})
