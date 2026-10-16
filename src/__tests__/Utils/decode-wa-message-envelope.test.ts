import { decodeMessageNode } from '../../Utils/decode-wa-message'
import { clearUsernameMap, getKnownUsername } from '../../Utils/username-map'
import type { BinaryNode } from '../../WABinary'

const ME_PN = '5511999999999@s.whatsapp.net'
const PEER_PN = '5515991426667@s.whatsapp.net'

const messageStanza = (content: BinaryNode['content'], attrs: Record<string, string> = {}): BinaryNode => ({
	tag: 'message',
	attrs: { id: 'ENV-1', from: PEER_PN, type: 'text', ...attrs },
	content
})

describe('decodeMessageNode envelope metadata', () => {
	it('keeps reporting_tag as the raw bytes it carries (C1VN BLOB, never base64)', () => {
		// Bytes that are neither valid UTF-8 nor base64: any text/base64 round
		// trip corrupts them. The APK stores node.A01 verbatim as a BLOB.
		const raw = new Uint8Array([0x00, 0xff, 0x80, 0x2b, 0x61, 0x00, 0x10])
		const { fullMessage } = decodeMessageNode(
			messageStanza([
				{
					tag: 'reporting',
					attrs: {},
					content: [{ tag: 'reporting_tag', attrs: {}, content: raw }]
				}
			]),
			ME_PN,
			''
		)

		expect(fullMessage.reportingTag).toEqual(raw)
	})

	it('encodes a text reporting_tag as its UTF-8 wire bytes', () => {
		const { fullMessage } = decodeMessageNode(
			messageStanza([
				{
					tag: 'reporting',
					attrs: {},
					content: [{ tag: 'reporting_tag', attrs: {}, content: 'AB+' }]
				}
			]),
			ME_PN,
			''
		)

		expect(fullMessage.reportingTag).toEqual(new Uint8Array(Buffer.from('AB+', 'utf8')))
	})

	it('leaves reportingTag undefined without a reporting node and passes sts through', () => {
		const { fullMessage } = decodeMessageNode(messageStanza([], { sts: '1728000000000000' }), ME_PN, '')

		expect(fullMessage.reportingTag).toBeUndefined()
		expect(fullMessage.sts).toBe('1728000000000000')
	})

	it('remembers the peer username the stanza carries for the outbound map', () => {
		clearUsernameMap()
		try {
			const { fullMessage } = decodeMessageNode(messageStanza([], { username: 'peeruser' }), ME_PN, '')

			// The same attr feeds key.remoteJidUsername (consumer view) and the
			// peer username map A07 stamps outbound peer_recipient_username from.
			expect(fullMessage.key.remoteJidUsername).toBe('peeruser')
			expect(getKnownUsername(PEER_PN)).toBe('peeruser')
		} finally {
			clearUsernameMap()
		}
	})
})
