import { describe, expect, it } from '@jest/globals'
import { decodeMessageNode } from '../../Utils/decode-wa-message'
import type { BinaryNode } from '../../WABinary'

const ME_PN = '5515981907008@s.whatsapp.net'
const ME_LID = '46802258641027@lid'
const BOT_JID = '718584497008509@bot'
const PROMPT_ID = '3EB09E8A6BB1621D2D4E66'

const botReplyStanza = (): BinaryNode => ({
	tag: 'message',
	attrs: {
		id: '6C52AFA32B6674EFD933B8EBB11AA610',
		from: BOT_JID,
		type: 'text',
		t: '1789936490',
		notify: 'Meta AI'
	},
	content: [
		{ tag: 'bot', attrs: { edit: 'first', edit_target_id: '', sender_timestamp_ms: '0' } },
		{ tag: 'meta', attrs: { target_id: PROMPT_ID } },
		{ tag: 'enc', attrs: { v: '2', type: 'msmsg' }, content: Buffer.from([1, 2, 3]) }
	]
})

describe('Meta AI inbound envelope', () => {
	it('classifies a direct @bot reply as a bot chat instead of rejecting it', () => {
		const { fullMessage, author, sender } = decodeMessageNode(botReplyStanza(), ME_PN, ME_LID)

		expect(author).toBe(BOT_JID)
		expect(sender).toBe(BOT_JID)
		expect(fullMessage.key).toMatchObject({
			remoteJid: BOT_JID,
			fromMe: false,
			id: '6C52AFA32B6674EFD933B8EBB11AA610'
		})
	})

	it('classifies every direct bot reply, not only the Meta AI FBID', () => {
		const arbitraryBotJid = '999999999999@bot'
		const stanza = botReplyStanza()
		stanza.attrs.from = arbitraryBotJid

		const { fullMessage, author, sender } = decodeMessageNode(stanza, ME_PN, ME_LID)

		expect(author).toBe(arbitraryBotJid)
		expect(sender).toBe(arbitraryBotJid)
		expect(fullMessage.key).toMatchObject({ remoteJid: arbitraryBotJid, fromMe: false })
	})

	it('classifies the phone-form bot identity, which only isJidBot matches', () => {
		// 13135550202@c.us is the PN identity this PR maps the FBID onto.
		// It does NOT end in @bot, so isJidMetaAI cannot catch it — only the
		// isJidBot half of the branch can. Without this case that half is dead
		// to the suite while being live in production.
		const stanza = botReplyStanza()
		stanza.attrs.from = '13135550202@c.us'

		const { fullMessage, author, sender } = decodeMessageNode(stanza, ME_PN, ME_LID)

		expect(author).toBe('13135550202@c.us')
		expect(sender).toBe('13135550202@c.us')
		expect(fullMessage.key).toMatchObject({ remoteJid: '13135550202@c.us', fromMe: false })
	})

	it('still rejects an ordinary @c.us contact', () => {
		const stanza = botReplyStanza()
		stanza.attrs.from = '5511999999999@c.us'
		// Guards the branch against widening into normal traffic.
		expect(() => decodeMessageNode(stanza, ME_PN, ME_LID)).toThrow('Unknown message type')
	})
})
