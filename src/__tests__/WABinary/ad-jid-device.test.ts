import { classifyProtocolMessageSenderSource } from '../../Utils/message-sender-source'
import { decodeBinaryNode, encodeBinaryNode } from '../../WABinary'

describe('AD_JID device attribution', () => {
	it('preserves an explicit primary-device zero through binary decoding', async () => {
		const decoded = await decodeBinaryNode(
			encodeBinaryNode({
				tag: 'message',
				attrs: { from: '5511000000000:0@lid' }
			})
		)

		expect(decoded.attrs.from).toBe('5511000000000:0@lid')
		expect(classifyProtocolMessageSenderSource({ authorJid: decoded.attrs.from })).toEqual({
			type: 'primary_device',
			authorDeviceJid: '5511000000000:0@lid',
			deviceId: 0,
			confidence: 'high',
			evidence: 'author_device_jid'
		})
	})

	it('keeps a device-less JID_PAIR distinct from an AD_JID device zero', async () => {
		const decoded = await decodeBinaryNode(
			encodeBinaryNode({
				tag: 'message',
				attrs: { from: '5511000000000@lid' }
			})
		)

		expect(decoded.attrs.from).toBe('5511000000000@lid')
		expect(classifyProtocolMessageSenderSource({ authorJid: decoded.attrs.from })).toEqual({
			type: 'unknown',
			confidence: 'unknown',
			evidence: 'missing_author_device'
		})
	})

	it('continues to preserve positive linked-device IDs', async () => {
		const decoded = await decodeBinaryNode(
			encodeBinaryNode({
				tag: 'message',
				attrs: { from: '5511000000000:19@lid' }
			})
		)

		expect(decoded.attrs.from).toBe('5511000000000:19@lid')
		expect(classifyProtocolMessageSenderSource({ authorJid: decoded.attrs.from })).toMatchObject({
			type: 'linked_device',
			authorDeviceJid: '5511000000000:19@lid',
			deviceId: 19,
			evidence: 'author_device_jid'
		})
	})
})
