import { describe, expect, it } from '@jest/globals'
import { isSelfSyncReceiptFailureNonFatal } from '../../Socket/messages-recv'
import { decodeMessageNode, getSelfSyncChatJid, isRecoverableLidSelfSyncStanza } from '../../Utils/decode-wa-message'
import type { BinaryNode } from '../../WABinary'

const ME_PN = '5511999999999@s.whatsapp.net'
const ME_LID = '1029384756@lid'
const PEER_PN = '5515991426667@s.whatsapp.net'
const PEER_LID = '207421150646274@lid'

const selfSyncStanza = (overrides: Partial<Record<string, string>> = {}): BinaryNode => ({
	tag: 'message',
	attrs: {
		id: 'TEST-ID-1',
		from: ME_LID,
		recipient: PEER_LID,
		type: 'chat',
		t: String(Date.now()),
		peer_recipient_pn: PEER_PN,
		...overrides
	},
	content: [{ tag: 'enc', attrs: { type: 'msg' } }]
})

describe('isRecoverableLidSelfSyncStanza', () => {
	it('accepts a canonical self-sync stanza (from=LID of me, peer_recipient_pn, enc=msg)', () => {
		expect(isRecoverableLidSelfSyncStanza(selfSyncStanza(), ME_PN, ME_LID)).toBe(true)
	})

	it('accepts enc=pkmsg as well', () => {
		const stanza: BinaryNode = {
			...selfSyncStanza(),
			content: [{ tag: 'enc', attrs: { type: 'pkmsg' } }]
		}
		expect(isRecoverableLidSelfSyncStanza(stanza, ME_PN, ME_LID)).toBe(true)
	})

	it('rejects when peer_recipient_pn is missing', () => {
		const stanza = selfSyncStanza()
		delete stanza.attrs.peer_recipient_pn
		expect(isRecoverableLidSelfSyncStanza(stanza, ME_PN, ME_LID)).toBe(false)
	})

	it('rejects when from is not a LID', () => {
		const stanza = selfSyncStanza({ from: ME_PN })
		expect(isRecoverableLidSelfSyncStanza(stanza, ME_PN, ME_LID)).toBe(false)
	})

	it('rejects when from is not me (by LID)', () => {
		const stanza = selfSyncStanza({ from: '9999999999@lid' })
		expect(isRecoverableLidSelfSyncStanza(stanza, ME_PN, ME_LID)).toBe(false)
	})

	it('rejects when recipient is absent', () => {
		const stanza = selfSyncStanza()
		delete stanza.attrs.recipient
		expect(isRecoverableLidSelfSyncStanza(stanza, ME_PN, ME_LID)).toBe(false)
	})

	it('rejects when recipient is our own LID instead of the peer', () => {
		const stanza = selfSyncStanza({ recipient: ME_LID })
		expect(isRecoverableLidSelfSyncStanza(stanza, ME_PN, ME_LID)).toBe(false)
	})

	it('rejects when enc type is not msg or pkmsg', () => {
		const stanza: BinaryNode = {
			...selfSyncStanza(),
			content: [{ tag: 'enc', attrs: { type: 'msmsg' } }]
		}
		expect(isRecoverableLidSelfSyncStanza(stanza, ME_PN, ME_LID)).toBe(false)
	})
})

describe('getSelfSyncChatJid', () => {
	it('returns peer_recipient_pn for a self-sync stanza', () => {
		expect(getSelfSyncChatJid(selfSyncStanza(), ME_PN, ME_LID)).toBe(PEER_PN)
	})

	it('returns undefined for a non-self-sync stanza', () => {
		const stanza = selfSyncStanza({ from: '5515981907008@s.whatsapp.net' })
		expect(getSelfSyncChatJid(stanza, ME_PN, ME_LID)).toBeUndefined()
	})

	it('returns undefined when peer_recipient_pn is missing', () => {
		const stanza = selfSyncStanza()
		delete stanza.attrs.peer_recipient_pn
		expect(getSelfSyncChatJid(stanza, ME_PN, ME_LID)).toBeUndefined()
	})
})

describe('self-sync decode wiring', () => {
	it('uses peer_recipient_pn as remoteJid and keeps the peer LID in remoteJidAlt', () => {
		const { fullMessage } = decodeMessageNode(selfSyncStanza(), ME_PN, ME_LID)

		expect(fullMessage.key).toMatchObject({
			remoteJid: PEER_PN,
			remoteJidAlt: PEER_LID,
			fromMe: true,
			id: 'TEST-ID-1'
		})
	})
})

describe('self-sync receipt guard', () => {
	const receiptKey = { remoteJid: PEER_PN, remoteJidAlt: PEER_LID, fromMe: true, id: 'TEST-ID-1' }

	it('uses the exact decode fingerprint before tolerating a receipt failure', () => {
		expect(isSelfSyncReceiptFailureNonFatal('sender', receiptKey, ME_LID, selfSyncStanza(), ME_PN, ME_LID)).toBe(true)
		expect(
			isSelfSyncReceiptFailureNonFatal(
				'sender',
				receiptKey,
				ME_LID,
				selfSyncStanza({ recipient: ME_LID }),
				ME_PN,
				ME_LID
			)
		).toBe(false)
		expect(
			isSelfSyncReceiptFailureNonFatal(
				'sender',
				receiptKey,
				ME_LID,
				selfSyncStanza(),
				'5511888888888@s.whatsapp.net',
				'999999999@lid'
			)
		).toBe(false)
		expect(isSelfSyncReceiptFailureNonFatal('inactive', receiptKey, ME_LID, selfSyncStanza(), ME_PN, ME_LID)).toBe(
			false
		)
	})
})
