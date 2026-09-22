import { jest } from '@jest/globals'
import { randomBytes } from 'crypto'
import { EventEmitter } from 'events'
import P from 'pino'
import { proto } from '../../../WAProto/index.js'
import type { AuthenticationCreds, BaileysEventEmitter, WAMessage, WAMessageKey } from '../../Types'
import { initAuthCreds } from '../../Utils/auth-utils'
import { aesDecryptGCM, aesEncryptGCM } from '../../Utils/crypto'
import { decryptEncComment, decryptEncReaction, deriveMessageSecretKey } from '../../Utils/message-secret-envelope'
import { OrphanQueue } from '../../Utils/orphan-queue'
import processMessage from '../../Utils/process-message'

const silent = P({ level: 'silent' })
const chat = '120363400000000000@g.us'
const sender = '5511900000000@s.whatsapp.net'
const targetAuthor = '5511800000000@s.whatsapp.net'
const targetMessageKey: WAMessageKey = {
	remoteJid: chat,
	id: 'PARENT-1',
	fromMe: false,
	participant: targetAuthor
}
const parentSecret = randomBytes(32)

const credsWithMe = (): AuthenticationCreds => ({
	...initAuthCreds(),
	me: { id: 'me@s.whatsapp.net' } as any
})

const makeContext = (getMessage: ReturnType<typeof jest.fn>) => {
	const events = new EventEmitter() as unknown as BaileysEventEmitter
	const upserts: any[][] = []
	const reactions: any[][] = []
	;(events as any).on('messages.upsert', (upsert: any) => upserts.push(upsert.messages))
	;(events as any).on('messages.reaction', (reaction: any[]) => reactions.push(reaction))

	const orphanQueue = new OrphanQueue(silent)
	return {
		upserts,
		reactions,
		orphanQueue,
		ctx: {
			orphanQueue,
			shouldProcessHistoryMsg: false,
			placeholderResendCache: undefined,
			ev: events,
			creds: credsWithMe(),
			keyStore: {} as any,
			signalRepository: {
				lidMapping: { getPNForLID: async (jid: string) => jid }
			} as any,
			logger: silent,
			options: {},
			getMessage
		}
	}
}

const inbound = (id: string, message: proto.IMessage): WAMessage => ({
	key: { remoteJid: chat, fromMe: false, id, participant: sender },
	message,
	messageTimestamp: 1770000000
})

const parentMessage = (): WAMessage => ({
	key: targetMessageKey,
	message: {
		conversation: 'the post',
		messageContextInfo: { messageSecret: parentSecret }
	},
	messageTimestamp: 1769999000
})

const encryptedCommentEnvelope = (): proto.Message.IEncCommentMessage => {
	const commentKey = deriveMessageSecretKey(parentSecret, 'Enc Comment', {
		targetAuthorRaw: '5511800000000',
		senderRaw: '5511900000000',
		targetMessageId: 'PARENT-1'
	})
	const commentPlaintext = proto.Message.encode(
		proto.Message.create({
			commentMessage: proto.Message.CommentMessage.create({
				message: proto.Message.create({ conversation: 'Recovered post comment' }),
				targetMessageKey
			})
		})
	).finish()
	return proto.Message.EncCommentMessage.create({
		targetMessageKey,
		...encrypt(commentPlaintext, commentKey)
	})
}

const pdoMessageWithRecoveredChild = (child: proto.Message.IEncCommentMessage): WAMessage => {
	const controller = inbound('pdo-controller', {
		protocolMessage: {
			type: proto.Message.ProtocolMessage.Type.PEER_DATA_OPERATION_REQUEST_RESPONSE_MESSAGE,
			peerDataOperationRequestResponseMessage: {
				peerDataOperationResult: [
					{
						placeholderMessageResendResponse: {
							webMessageInfoBytes: proto.WebMessageInfo.encode({
								key: { remoteJid: chat, fromMe: false, id: 'comment-recovered', participant: sender },
								message: { encCommentMessage: child },
								messageTimestamp: 1770000001
							}).finish()
						}
					}
				]
			}
		}
	})
	// PDO responses are self-only protocol traffic.
	controller.key.fromMe = true
	controller.key.participant = undefined
	return controller
}

describe('processMessage — encrypted CAG comments and reactions', () => {
	it('queues an encrypted comment when the parent post has not arrived, then uses the arriving parent to replay', async () => {
		const getMessage = jest.fn<() => Promise<any>>()
		getMessage.mockResolvedValueOnce(undefined).mockResolvedValueOnce(parentMessage().message)
		const { ctx, upserts, orphanQueue } = makeContext(getMessage as any)

		const commentKey = deriveMessageSecretKey(parentSecret, 'Enc Comment', {
			targetAuthorRaw: '5511800000000',
			senderRaw: '5511900000000',
			targetMessageId: 'PARENT-1'
		})
		const commentPlaintext = proto.Message.encode(
			proto.Message.create({
				commentMessage: proto.Message.CommentMessage.create({
					message: proto.Message.create({ conversation: 'Great post!' }),
					targetMessageKey
				})
			})
		).finish()
		const encCommentMessage = proto.Message.EncCommentMessage.create({
			targetMessageKey,
			...encrypt(commentPlaintext, commentKey)
		})

		const comment = inbound('comment-1', { encCommentMessage })
		await processMessage(comment, { ...ctx } as any)
		expect(upserts).toHaveLength(0)
		expect(orphanQueue.drain(targetMessageKey)).toHaveLength(1)

		// Restore the queue entry and process the post that arrived late.
		orphanQueue.enqueue(targetMessageKey, 'comment', comment)
		const post = parentMessage()
		post.key = { ...post.key, id: 'PARENT-1' }
		await processMessage(post, { ...ctx } as any)

		expect(upserts).toHaveLength(1)
		// The arriving parent's message content must be passed to replay; a normal
		// consumer-backed getMessage() may not observe it until processing returns.
		expect(getMessage).toHaveBeenCalledTimes(1)
		const child = upserts[0]![0]
		expect(child.key.id).toBe('comment-1')
		expect(child.message.encCommentMessage).toBeNull()
		expect(child.message.commentMessage.message.conversation).toBe('Great post!')
		expect(orphanQueue.drain(targetMessageKey)).toHaveLength(0)
	})

	it('decrypts an encrypted reaction immediately when the parent post is known', async () => {
		const getMessage = jest.fn<() => Promise<any>>()
		getMessage.mockResolvedValue(parentMessage().message)
		const { ctx, reactions } = makeContext(getMessage as any)

		const key = deriveMessageSecretKey(parentSecret, 'Enc Reaction', {
			targetAuthorRaw: '5511800000000',
			senderRaw: '5511900000000',
			targetMessageId: 'PARENT-1'
		})
		const plaintext = proto.Message.ReactionMessage.encode(
			proto.Message.ReactionMessage.create({ text: '🔥' })
		).finish()
		const encReactionMessage = proto.Message.EncReactionMessage.create({
			targetMessageKey,
			...encrypt(plaintext, key)
		})

		await processMessage(inbound('reaction-1', { encReactionMessage }), { ...ctx } as any)

		expect(reactions).toHaveLength(1)
		expect(reactions[0]![0].reaction.text).toBe('🔥')
		expect(reactions[0]![0].key.id).toBe('PARENT-1')
	})

	it('hydrates an encrypted CAG comment recovered through PDO before emitting it', async () => {
		const getMessage = jest.fn<() => Promise<any>>()
		getMessage.mockResolvedValue(parentMessage().message)
		const { ctx, upserts } = makeContext(getMessage as any)

		await processMessage(pdoMessageWithRecoveredChild(encryptedCommentEnvelope()), { ...ctx } as any)

		expect(upserts).toHaveLength(1)
		expect(upserts[0]![0].key.id).toBe('comment-recovered')
		expect(upserts[0]![0].message.encCommentMessage).toBeNull()
		expect(upserts[0]![0].message.commentMessage.message.conversation).toBe('Recovered post comment')
	})

	it('does not emit ciphertext when PDO recovers a CAG child before its parent', async () => {
		const getMessage = jest.fn<() => Promise<any>>()
		getMessage.mockResolvedValue(undefined)
		const { ctx, upserts, orphanQueue } = makeContext(getMessage as any)

		await processMessage(pdoMessageWithRecoveredChild(encryptedCommentEnvelope()), { ...ctx } as any)

		expect(upserts).toHaveLength(0)
		expect(orphanQueue.drain(targetMessageKey)).toHaveLength(1)
	})

	it('normalizes a decrypted reaction key even when the wire target is sparse', async () => {
		const getMessage = jest.fn<() => Promise<any>>()
		getMessage.mockResolvedValue(parentMessage().message)
		const { ctx, reactions } = makeContext(getMessage as any)

		const key = deriveMessageSecretKey(parentSecret, 'Enc Reaction', {
			targetAuthorRaw: '5511800000000',
			senderRaw: '5511900000000',
			targetMessageId: 'PARENT-1'
		})
		const plaintext = proto.Message.ReactionMessage.encode(
			proto.Message.ReactionMessage.create({ text: '🔥' })
		).finish()
		const encReactionMessage = proto.Message.EncReactionMessage.create({
			targetMessageKey: { id: 'PARENT-1', participant: targetAuthor },
			...encrypt(plaintext, key)
		})

		await processMessage(inbound('reaction-2', { encReactionMessage }), { ...ctx } as any)

		expect(reactions[0]![0].key).toEqual(
			expect.objectContaining({ remoteJid: chat, id: 'PARENT-1', participant: targetAuthor, fromMe: false })
		)
	})

	it('isolates identity-resolution failures without disrupting processing', async () => {
		const getMessage = jest.fn<() => Promise<any>>()
		getMessage.mockResolvedValue(parentMessage().message)
		const { ctx, upserts } = makeContext(getMessage as any)
		;(ctx.signalRepository.lidMapping as any).getPNForLID = jest.fn(async () => {
			throw new Error('mapping unavailable')
		})

		const key = deriveMessageSecretKey(parentSecret, 'Enc Comment', {
			targetAuthorRaw: '5511800000000',
			senderRaw: '5511900000000',
			targetMessageId: 'PARENT-1'
		})
		const commentBytes = proto.Message.encode(
			proto.Message.create({
				commentMessage: proto.Message.CommentMessage.create({
					message: proto.Message.create({ conversation: 'Great post!' }),
					targetMessageKey
				})
			})
		).finish()
		const envelope = proto.Message.EncCommentMessage.create({
			targetMessageKey,
			...encrypt(commentBytes, key)
		})
		const message = inbound('comment-3', {
			encCommentMessage: envelope
		})
		message.key.participant = '5511900000000@lid'

		await expect(processMessage(message, { ...ctx } as any)).resolves.toBeUndefined()
		expect(upserts).toHaveLength(0)
	})
})

describe('message-secret-envelope framing', () => {
	it('keeps comments as E2E.Message and reactions as bare ReactionMessage', () => {
		const key = deriveMessageSecretKey(parentSecret, 'Enc Comment', {
			targetAuthorRaw: '5511800000000',
			senderRaw: '5511900000000',
			targetMessageId: 'PARENT-1'
		})
		const iv = randomBytes(12)
		const commentBytes = proto.Message.encode(
			proto.Message.create({
				commentMessage: proto.Message.CommentMessage.create({
					message: proto.Message.create({ conversation: 'hi' }),
					targetMessageKey
				})
			})
		).finish()
		const comment = decryptEncComment(
			proto.Message.EncCommentMessage.create({ ...encrypt(commentBytes, key, iv) }),
			key
		)
		expect(comment.message?.conversation).toBe('hi')

		const reactionBytes = proto.Message.ReactionMessage.encode(
			proto.Message.ReactionMessage.create({ text: '👍' })
		).finish()
		const reaction = decryptEncReaction(
			proto.Message.EncReactionMessage.create({ ...encrypt(reactionBytes, key, randomBytes(12)) }),
			key
		)
		expect(reaction.text).toBe('👍')
		expect(aesDecryptGCM).toBeDefined()
	})
})

function encrypt(plaintext: Uint8Array, key: Uint8Array, iv = randomBytes(12)) {
	return { encPayload: aesEncryptGCM(plaintext, key, iv, new Uint8Array(0)), encIv: iv }
}
