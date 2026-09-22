import { createCipheriv, createHmac, randomBytes } from 'crypto'
import { proto } from '../../../WAProto/index.js'
import { decryptEncComment, decryptEncReaction, deriveMessageSecretKey } from '../../Utils/message-secret-envelope'
import { generateWAMessageContent } from '../../Utils/messages'

const parentSecret = randomBytes(32)
const sender = '5511900000000@s.whatsapp.net'
const targetAuthor = '5511800000000@s.whatsapp.net'
const targetMessageKey = {
	remoteJid: '120363400000000000@g.us',
	id: 'PARENT-1',
	fromMe: false,
	participant: targetAuthor
}

const generationOptions = {
	userJid: sender
} as any

describe('message-secret envelopes', () => {
	it('uses the Android HMAC base, HKDF info order and trailing counter byte', () => {
		const fixedSecret = Buffer.alloc(32, 0x42)
		const key = deriveMessageSecretKey(fixedSecret, 'Enc Comment', {
			targetAuthorRaw: '5511800000000',
			senderRaw: '5511900000000',
			targetMessageId: 'PARENT-1'
		})

		// Android: AbstractC36491ji.A00(data=secret, key=zeros), followed by
		// AbstractC36481jh.A01(key=base, info=..., 32).
		const base = createHmac('sha256', Buffer.alloc(32)).update(fixedSecret).digest()
		const info = Buffer.concat([
			Buffer.from('PARENT-1'),
			Buffer.from('5511800000000'),
			Buffer.from('5511900000000'),
			Buffer.from('Enc Comment'),
			Buffer.from([1])
		])
		expect(key).toEqual(createHmac('sha256', base).update(info).digest())
		expect(key.toString('hex')).toBe('7936d0fe2b3d6cf2462e5f413f9486621db27621c493ad08e225778ade313853')
	})

	it('sends comments only as encCommentMessage and encrypts an E2E.Message child', async () => {
		const content = {
			channelComment: {
				targetMessageKey,
				parentMessageSecret: parentSecret,
				message: { text: 'Great post!' },
				senderJid: sender,
				targetAuthorJid: targetAuthor
			}
		} as const

		const message = await generateWAMessageContent(content, generationOptions)

		expect(message.encCommentMessage).toBeDefined()
		expect(message.commentMessage).toBeNull()
		expect(message.encCommentMessage?.targetMessageKey).toMatchObject({ id: 'PARENT-1' })
		expect(message.encCommentMessage?.encIv).toHaveLength(12)
		expect(message.encCommentMessage?.encPayload?.length).toBeGreaterThan(16)

		const key = deriveMessageSecretKey(parentSecret, 'Enc Comment', {
			targetAuthorRaw: '5511800000000',
			senderRaw: '5511900000000',
			targetMessageId: 'PARENT-1'
		})
		const comment = decryptEncComment(message.encCommentMessage!, key)
		expect(comment.targetMessageKey?.id).toBe('PARENT-1')
		expect(comment.message?.extendedTextMessage?.text).toBe('Great post!')
	})

	it('sends CAG reactions only as encReactionMessage and omits the nested reaction key', async () => {
		const content = {
			react: {
				text: '🔥',
				key: targetMessageKey,
				senderTimestampMs: 1770000000000,
				parentMessageSecret: parentSecret,
				senderJid: sender,
				targetAuthorJid: targetAuthor
			}
		} as const

		const message = await generateWAMessageContent(content, generationOptions)

		expect(message.encReactionMessage).toBeDefined()
		expect(message.reactionMessage).toBeNull()
		expect(message.encReactionMessage?.targetMessageKey?.id).toBe('PARENT-1')

		const key = deriveMessageSecretKey(parentSecret, 'Enc Reaction', {
			targetAuthorRaw: '5511800000000',
			senderRaw: '5511900000000',
			targetMessageId: 'PARENT-1'
		})
		const reaction = decryptEncReaction(message.encReactionMessage!, key)
		expect(reaction.text).toBe('🔥')
		expect(reaction.key).toBeNull()
	})

	it('decrypts with no AAD, matching FE9.ASx() for both use cases', () => {
		const key = deriveMessageSecretKey(parentSecret, 'Enc Reaction', {
			targetAuthorRaw: targetAuthor,
			senderRaw: sender,
			targetMessageId: targetMessageKey.id
		})
		const plaintext = proto.Message.ReactionMessage.encode(
			proto.Message.ReactionMessage.create({ text: '🎉' })
		).finish()
		const iv = randomBytes(12)
		const envelope = {
			encPayload: aesEncryptForTest(plaintext, key, iv),
			encIv: iv
		}

		expect(decryptEncReaction(envelope, key).text).toBe('🎉')
	})

	it('requires the reaction target key before deriving an encrypted CAG reaction', async () => {
		const content = {
			react: {
				text: '🔥',
				parentMessageSecret: parentSecret,
				senderJid: sender
			}
		}

		await expect(generateWAMessageContent(content as any, generationOptions)).rejects.toThrow(
			'react.key.id is required for an encrypted CAG reaction'
		)
	})

	it('rejects non-12-byte IVs before GCM decryption', () => {
		const key = deriveMessageSecretKey(parentSecret, 'Enc Reaction', {
			targetAuthorRaw: targetAuthor,
			senderRaw: sender,
			targetMessageId: targetMessageKey.id!
		})
		const envelope = {
			encPayload: aesEncryptForTest(Buffer.alloc(0), key, Buffer.alloc(12)),
			encIv: Buffer.alloc(16)
		}

		expect(() => decryptEncReaction(envelope, key)).toThrow('requires a 12-byte IV')
	})
})

function aesEncryptForTest(plaintext: Uint8Array, key: Uint8Array, iv: Uint8Array): Buffer {
	// Reuse the helper's tag-suffixed AES layout; this small local wrapper keeps
	// the no-AAD property explicit in the test under discussion.
	const cipher = createCipheriv('aes-256-gcm', key, iv)
	return Buffer.concat([cipher.update(plaintext), cipher.final(), cipher.getAuthTag()])
}
