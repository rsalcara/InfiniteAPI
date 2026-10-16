import { proto } from '../../../WAProto/index.js'
import { isSamePlaceholderRecovery, pdoRequestCacheKey } from '../../Utils/pdo-recovery'

describe('PDO request identity', () => {
	it('includes the group sender so client-generated message IDs cannot collide', () => {
		const first = {
			remoteJid: '120363400000000000@g.us',
			id: 'same-client-id',
			fromMe: false,
			participant: '5511900000000@s.whatsapp.net'
		} as proto.IMessageKey
		const second = {
			remoteJid: '120363400000000000@g.us',
			id: 'same-client-id',
			fromMe: false,
			participant: '5511800000000@s.whatsapp.net'
		} as proto.IMessageKey

		expect(pdoRequestCacheKey(first)).not.toBe(pdoRequestCacheKey(second))
	})

	it('uses exact key identity when no JID mapping is available', async () => {
		const request = {
			remoteJid: '120363400000000000@g.us',
			id: 'same-client-id',
			participant: '5511900000000@lid'
		} as proto.IMessageKey
		const response = {
			remoteJid: '120363400000000000@g.us',
			id: 'same-client-id',
			participant: '5511900000000@s.whatsapp.net'
		} as proto.IMessageKey

		await expect(isSamePlaceholderRecovery(request, response)).resolves.toBe(false)
	})

	it('accepts PN and LID spellings of the same sender', async () => {
		const request = {
			remoteJid: '120363400000000000@g.us',
			id: 'same-client-id',
			participant: '5511900000000@lid'
		} as proto.IMessageKey
		const response = {
			remoteJid: '120363400000000000@g.us',
			id: 'same-client-id',
			participant: '5511900000000@s.whatsapp.net'
		} as proto.IMessageKey
		const aliases = async (jid: string) => [
			jid,
			jid === request.participant ? response.participant! : request.participant!
		]

		await expect(isSamePlaceholderRecovery(request, response, aliases)).resolves.toBe(true)
	})

	it('rejects the opposite message direction when the direct-chat sender falls back to remoteJid', async () => {
		const request = {
			remoteJid: '5511900000000@s.whatsapp.net',
			id: 'same-client-id',
			fromMe: true
		} as proto.IMessageKey
		const response = {
			remoteJid: '5511900000000@s.whatsapp.net',
			id: 'same-client-id',
			fromMe: false
		} as proto.IMessageKey

		await expect(isSamePlaceholderRecovery(request, response)).resolves.toBe(false)
	})

	it('keeps the same canonical PN identity before and after normalization collapses an LID alt', () => {
		const beforeNormalization = {
			remoteJid: '120363400000000000@g.us',
			id: 'same-client-id',
			fromMe: false,
			participant: '5511900000000@s.whatsapp.net',
			participantAlt: '5511900000000@lid'
		} as proto.IMessageKey
		const afterNormalization = {
			...beforeNormalization,
			participantAlt: '5511900000000@s.whatsapp.net'
		} as proto.IMessageKey

		expect(pdoRequestCacheKey(afterNormalization)).toBe(pdoRequestCacheKey(beforeNormalization))
	})

	it('resolves the chat alias before accepting a PDO response', async () => {
		const request = {
			remoteJid: '5511900000000@s.whatsapp.net',
			id: 'same-client-id',
			fromMe: false
		} as proto.IMessageKey
		const response = {
			remoteJid: '5511900000000@lid',
			id: 'same-client-id',
			fromMe: false
		} as proto.IMessageKey
		const aliases = async (jid: string) => [jid, jid === request.remoteJid ? response.remoteJid! : request.remoteJid!]

		await expect(isSamePlaceholderRecovery(request, response, aliases)).resolves.toBe(true)
	})
})
