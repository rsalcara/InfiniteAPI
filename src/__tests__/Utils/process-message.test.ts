import { jest } from '@jest/globals'
import { proto } from '../../../WAProto'
import type { WAMessage } from '../../Types'
import type { SignalRepositoryWithLIDStore } from '../../Types'
import { aesEncryptGCM, hmacSign } from '../../Utils/crypto'
import {
	cleanMessage,
	decryptPollVote,
	normalizeMessageJids,
	resolvePollCryptoAuthor
} from '../../Utils/process-message'

const createBaseMessage = (key: Partial<WAMessage['key']>, message?: Partial<WAMessage['message']>): WAMessage => {
	return {
		key: {
			remoteJid: 'chat@s.whatsapp.net',
			fromMe: false,
			id: 'ABC',
			...key
		},
		message: message || { conversation: 'hello' },
		messageTimestamp: 1675888000
	}
}

describe('cleanMessage', () => {
	const meId = 'me@s.whatsapp.net'
	const meLid = 'me@lid'
	const otherUserId = 'other@s.whatsapp.net'

	describe('JID Normalization', () => {
		it('should correctly normalize a standard phone number JID with a device', () => {
			const message = createBaseMessage({
				remoteJid: '1234567890:15@s.whatsapp.net',
				participant: '9876543210:5@s.whatsapp.net'
			})

			cleanMessage(message, meId, meLid)

			expect(message.key.remoteJid).toBe('1234567890@s.whatsapp.net')
			expect(message.key.participant).toBe('9876543210@s.whatsapp.net')
		})

		it('should not modify a group JID', () => {
			const message = createBaseMessage({
				remoteJid: '123456-7890@g.us'
			})

			cleanMessage(message, meId, meLid)

			expect(message.key.remoteJid).toBe('123456-7890@g.us')
		})

		it('should correctly normalize a LID with a device', () => {
			const message = createBaseMessage({
				participant: '1234567890:12@lid'
			})

			cleanMessage(message, meId, meLid)

			expect(message.key.participant).toBe('1234567890@lid')
		})
	})

	describe('Hosted JID Handling', () => {
		it('should correctly normalize a hosted PN JID back to PN form', () => {
			const hostedJid = '1234567890:99@hosted'
			const message = createBaseMessage({
				remoteJid: hostedJid
			})

			cleanMessage(message, meId, meLid)

			expect(message.key.remoteJid).toBe('1234567890@s.whatsapp.net')
		})

		it('should correctly normalize a hosted LID JID back to LID form', () => {
			const hostedLidJid = '9876543210:99@hosted.lid'
			const message = createBaseMessage({
				participant: hostedLidJid
			})

			cleanMessage(message, meId, meLid)

			expect(message.key.participant).toBe('9876543210@lid')
		})
	})

	describe('Reaction Message Perspective', () => {
		it("should correct the perspective of a reaction to another user's message", () => {
			const message = createBaseMessage(
				{ fromMe: false, participant: otherUserId },
				{
					reactionMessage: {
						key: {
							remoteJid: 'chat@s.whatsapp.net',
							fromMe: false,
							id: 'MSG_THEY_SENT',
							participant: otherUserId
						},
						text: '😂'
					}
				}
			)

			cleanMessage(message, meId, meLid)

			const reactionKey = message.message!.reactionMessage!.key!
			expect(reactionKey.fromMe).toBe(false)
		})

		it('should not modify a reaction on a message I sent from another device', () => {
			const message = createBaseMessage(
				{ fromMe: true },
				{
					reactionMessage: {
						key: { remoteJid: 'chat@s.whatsapp.net', fromMe: true, id: 'MSG_I_SENT' },
						text: '❤️'
					}
				}
			)

			const originalReactionKey = { ...message.message!.reactionMessage!.key! }

			cleanMessage(message, meId, meLid)

			const reactionKey = message.message!.reactionMessage!.key!
			expect(reactionKey).toEqual(originalReactionKey)
		})
	})

	describe('Edge Cases', () => {
		it('should not crash if JIDs are undefined', () => {
			const message = createBaseMessage({
				remoteJid: undefined,
				participant: undefined
			})

			expect(() => cleanMessage(message, meId, meLid)).not.toThrow()
		})

		it('should not crash on an empty message object', () => {
			const message = createBaseMessage({}, {})
			expect(() => cleanMessage(message, meId, meLid)).not.toThrow()
		})
	})
})

describe('normalizeMessageJids', () => {
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	let mockGetPNForLID: any
	let signalRepository: SignalRepositoryWithLIDStore

	beforeEach(() => {
		mockGetPNForLID = jest.fn()
		signalRepository = {
			lidMapping: {
				getPNForLID: mockGetPNForLID
			}
		} as unknown as SignalRepositoryWithLIDStore
	})

	it('should resolve remoteJid LID to PN when mapping exists', async () => {
		const message = createBaseMessage({
			remoteJid: '123456789@lid'
		})

		mockGetPNForLID.mockResolvedValue('5511999999999@s.whatsapp.net')

		await normalizeMessageJids(message, signalRepository)

		expect(message.key.remoteJid).toBe('5511999999999@s.whatsapp.net')
	})

	it('should keep LID when no PN mapping exists', async () => {
		const message = createBaseMessage({
			remoteJid: '123456789@lid'
		})

		mockGetPNForLID.mockResolvedValue(null)

		await normalizeMessageJids(message, signalRepository)

		expect(message.key.remoteJid).toBe('123456789@lid')
	})

	it('should resolve participant LID to PN when mapping exists', async () => {
		const message = createBaseMessage({
			participant: '999999999@lid'
		})

		mockGetPNForLID.mockResolvedValue('5511888888888@s.whatsapp.net')

		await normalizeMessageJids(message, signalRepository)

		expect(message.key.participant).toBe('5511888888888@s.whatsapp.net')
	})
})

describe('resolvePollCryptoAuthor', () => {
	const pn = '5511999999999@s.whatsapp.net'
	const lid = '123456789012345@lid'
	const mePn = '5511888888888@s.whatsapp.net'
	const meLid = '987654321012345@lid'
	const lidMapping = {
		getLIDForPN: jest.fn(async (jid: string) => (jid === pn ? lid : jid === mePn ? meLid : null)),
		getPNForLID: jest.fn(async (jid: string) => (jid === lid ? pn : jid === meLid ? mePn : null))
	} as unknown as SignalRepositoryWithLIDStore['lidMapping']

	it('restores the LID selected by addressing_mode after storage normalisation', async () => {
		const key = {
			remoteJid: pn,
			remoteJidAlt: pn,
			fromMe: false,
			addressingMode: 'lid'
		}

		await expect(resolvePollCryptoAuthor(key, 'lid', mePn, meLid, lidMapping)).resolves.toBe(lid)
	})

	it('uses the persisted own LID for a fromMe poll key in LID mode', async () => {
		const key = { remoteJid: pn, fromMe: true }

		await expect(resolvePollCryptoAuthor(key, 'lid', mePn, meLid, lidMapping)).resolves.toBe(meLid)
	})

	it('keeps PN identities in PN mode', async () => {
		const key = { remoteJid: pn, remoteJidAlt: lid, fromMe: false, addressingMode: 'pn' }

		await expect(resolvePollCryptoAuthor(key, 'pn', mePn, meLid, lidMapping)).resolves.toBe(pn)
	})

	it('produces identities that authenticate a real LID-addressed poll vote', async () => {
		const pollMsgId = 'poll-message-id'
		const pollSecret = Buffer.alloc(32, 0x42)
		const iv = Buffer.alloc(12, 0x24)
		const selectedOption = Buffer.alloc(32, 0x11)
		const sign = Buffer.concat([
			Buffer.from(pollMsgId),
			Buffer.from(meLid),
			Buffer.from(lid),
			Buffer.from('Poll Vote'),
			Buffer.from([1])
		])
		const key0 = hmacSign(pollSecret, Buffer.alloc(32), 'sha256')
		const encKey = hmacSign(sign, key0, 'sha256')
		const plaintext = proto.Message.PollVoteMessage.encode({ selectedOptions: [selectedOption] }).finish()
		const encPayload = aesEncryptGCM(plaintext, encKey, iv, Buffer.from(`${pollMsgId}\u0000${lid}`))
		const voterJid = await resolvePollCryptoAuthor(
			{ remoteJid: pn, remoteJidAlt: pn, fromMe: false, addressingMode: 'lid' },
			'lid',
			mePn,
			meLid,
			lidMapping
		)
		const creatorJid = await resolvePollCryptoAuthor({ remoteJid: pn, fromMe: true }, 'lid', mePn, meLid, lidMapping)

		expect(
			decryptPollVote(
				{ encPayload, encIv: iv },
				{ pollEncKey: pollSecret, pollCreatorJid: creatorJid, pollMsgId, voterJid }
			).selectedOptions?.[0]
		).toEqual(selectedOption)
		expect(() =>
			decryptPollVote(
				{ encPayload, encIv: iv },
				{ pollEncKey: pollSecret, pollCreatorJid: mePn, pollMsgId, voterJid: pn }
			)
		).toThrow()
	})
})
