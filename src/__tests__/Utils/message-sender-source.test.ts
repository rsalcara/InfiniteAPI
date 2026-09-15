import {
	classifyCurrentClientMessageSenderSource,
	classifyMessageWithoutAuthorDevice,
	classifyProtocolMessageSenderSource,
	messageSenderSourceLogFields
} from '../../Utils/message-sender-source'

describe('message sender source classification', () => {
	it('classifies a device-zero author as the primary phone', () => {
		expect(classifyProtocolMessageSenderSource({ authorJid: '5511000000000:0@s.whatsapp.net' })).toEqual({
			type: 'primary_device',
			deviceId: 0,
			confidence: 'high',
			evidence: 'author_device_jid'
		})
	})

	it('does not treat a bare user JID as device zero evidence', () => {
		expect(classifyProtocolMessageSenderSource({ authorJid: '5511000000000@s.whatsapp.net' })).toEqual({
			type: 'unknown',
			confidence: 'unknown',
			evidence: 'missing_author_device'
		})
	})

	it('classifies a positive device suffix as a linked device', () => {
		expect(classifyProtocolMessageSenderSource({ authorJid: '5511000000000:7@s.whatsapp.net' })).toEqual({
			type: 'linked_device',
			deviceId: 7,
			confidence: 'high',
			evidence: 'author_device_jid'
		})
	})

	it('uses web only when the current configured web client is the author', () => {
		expect(
			classifyProtocolMessageSenderSource({
				authorJid: '5511000000000:7@s.whatsapp.net',
				currentDeviceJids: ['5511000000000:7@s.whatsapp.net'],
				currentTransportProfile: 'web'
			})
		).toMatchObject({
			type: 'web',
			deviceId: 7,
			platform: 'WEB',
			evidence: 'current_client_transport'
		})
	})

	it('matches equivalent c.us and s.whatsapp.net own-device forms', () => {
		expect(
			classifyProtocolMessageSenderSource({
				authorJid: '5511000000000:7@c.us',
				currentDeviceJids: ['5511000000000:7@s.whatsapp.net'],
				currentTransportProfile: 'web'
			})
		).toMatchObject({
			type: 'web',
			deviceId: 7,
			platform: 'WEB',
			evidence: 'current_client_transport'
		})
	})

	it('does not infer a platform for an unrelated linked device', () => {
		const source = classifyProtocolMessageSenderSource({
			authorJid: '5511000000000:7@s.whatsapp.net',
			currentDeviceJids: ['5511000000000:8@s.whatsapp.net'],
			currentTransportProfile: 'web'
		})
		expect(source.type).toBe('linked_device')
		expect(source.platform).toBeUndefined()
	})

	it('keeps history without a lossless author device unknown', () => {
		expect(classifyMessageWithoutAuthorDevice()).toEqual({
			type: 'unknown',
			confidence: 'unknown',
			evidence: 'missing_author_device'
		})
	})

	it('does not classify server or system JIDs as people devices', () => {
		expect(classifyProtocolMessageSenderSource({ authorJid: 'server@c.us' }).type).toBe('unknown')
		expect(classifyProtocolMessageSenderSource({ authorJid: '0@c.us' }).type).toBe('unknown')
		expect(classifyProtocolMessageSenderSource({ authorJid: 'status@broadcast' }).type).toBe('unknown')
	})

	it('exposes redacted attribution log fields for representative payloads', () => {
		const source = classifyProtocolMessageSenderSource({ authorJid: '5511000000000:7@s.whatsapp.net' })
		const messages = [
			{ key: { id: 'txt', fromMe: false }, message: { conversation: 'redacted' }, senderSource: source },
			{
				key: { id: 'img', fromMe: false },
				message: { imageMessage: { mimetype: 'image/jpeg' } },
				senderSource: source
			},
			{ key: { id: 'aud', fromMe: false }, message: { audioMessage: { mimetype: 'audio/ogg' } }, senderSource: source },
			{ key: { id: 'call', fromMe: false }, message: { call: { callKey: Buffer.from('call') } }, senderSource: source }
		]

		for (const message of messages) {
			expect(messageSenderSourceLogFields(message as never)).toMatchObject({
				fromMe: false,
				senderSource: 'linked_device',
				senderDeviceId: 7,
				senderSourceEvidence: 'author_device_jid'
			})
		}
	})

	it('exposes only redacted attribution fields in logs', () => {
		const fields = messageSenderSourceLogFields({
			key: { id: 'msg-1', fromMe: false },
			senderSource: {
				type: 'primary_device',
				deviceId: 0,
				confidence: 'high',
				evidence: 'author_device_jid'
			}
		} as never)
		expect(fields).toEqual({
			msgId: 'msg-1',
			fromMe: false,
			senderSource: 'primary_device',
			senderDeviceId: 0,
			senderPlatform: undefined,
			senderSourceConfidence: 'high',
			senderSourceEvidence: 'author_device_jid'
		})
		expect(JSON.stringify(fields)).not.toContain('@s.whatsapp.net')
	})

	it('classifies locally generated messages from the configured transport', () => {
		expect(classifyCurrentClientMessageSenderSource('native_android', '5511000000000:3@s.whatsapp.net')).toMatchObject({
			type: 'linked_device',
			deviceId: 3,
			platform: 'ANDROID',
			evidence: 'current_client_transport'
		})
	})

	it('keeps an explicit current-client device zero as primary', () => {
		expect(classifyCurrentClientMessageSenderSource('native_android', '5511000000000:0@s.whatsapp.net')).toMatchObject({
			type: 'primary_device',
			deviceId: 0,
			platform: 'ANDROID',
			evidence: 'current_client_transport'
		})
	})
})
