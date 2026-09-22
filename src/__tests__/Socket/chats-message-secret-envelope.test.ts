import { jest } from '@jest/globals'
import { proto } from '../../../WAProto/index.js'
import { DEFAULT_CONNECTION_CONFIG } from '../../Defaults'
import makeWASocket from '../../Socket'
import type { WAMessage } from '../../Types'
import { aesEncryptGCM } from '../../Utils/crypto'
import type { ILogger } from '../../Utils/logger'
import { deriveMessageSecretKey } from '../../Utils/message-secret-envelope'
import { makeSession, mockWebSocket } from '../TestUtils/session'

mockWebSocket()

const chat = '120363400000000000@g.us'
const sender = '5511900000000@s.whatsapp.net'
const targetAuthor = '5511800000000@s.whatsapp.net'
const parentSecret = Buffer.alloc(32, 0x42)

const silentLogger = (): ILogger =>
	({
		level: 'silent',
		trace: () => {},
		debug: () => {},
		info: () => {},
		warn: () => {},
		error: () => {},
		child: () => silentLogger()
	}) as ILogger

const encryptedComment = (): proto.Message.IEncCommentMessage => {
	const targetMessageKey = { remoteJid: chat, id: 'PARENT-1', fromMe: false, participant: targetAuthor }
	const key = deriveMessageSecretKey(parentSecret, 'Enc Comment', {
		targetAuthorRaw: '5511800000000',
		senderRaw: '5511900000000',
		targetMessageId: 'PARENT-1'
	})
	const plaintext = proto.Message.encode(
		proto.Message.create({
			commentMessage: proto.Message.CommentMessage.create({
				message: proto.Message.create({ conversation: 'plaintext only' }),
				targetMessageKey
			})
		})
	).finish()
	return proto.Message.EncCommentMessage.create({
		targetMessageKey,
		encIv: new Uint8Array(12),
		encPayload: aesEncryptGCM(plaintext, key, new Uint8Array(12), new Uint8Array(0))
	})
}

const envelopeMessage = (): WAMessage => ({
	key: { remoteJid: chat, fromMe: false, id: 'comment-1', participant: sender },
	message: { encCommentMessage: encryptedComment() },
	messageTimestamp: 1770000000
})

const parentContent = (): proto.IMessage => ({
	conversation: 'the post',
	messageContextInfo: { messageSecret: parentSecret }
})

describe('upsertMessage — encrypted CAG envelope admission', () => {
	it('does not expose ciphertext when a child arrives before its parent', async () => {
		const session = await makeSession()
		session.state.creds.me = { id: '5511000000000@s.whatsapp.net' } as any
		const getMessage = jest.fn(async () => undefined)
		const sock = makeWASocket({
			...DEFAULT_CONNECTION_CONFIG,
			auth: { creds: session.state.creds, keys: session.state.keys },
			logger: silentLogger(),
			getMessage
		})
		const upserts: any[] = []
		sock.ev.on('messages.upsert', upsert => upserts.push(...upsert.messages))

		await sock.upsertMessage(envelopeMessage(), 'notify')
		// Buffered events must be drained synchronously; otherwise a mutant that
		// removes the suppression guard would only fail after Jest assertions.
		sock.ev.flush(true)

		expect(upserts).toHaveLength(0)

		await sock.end(new Error('test complete'))
		await session.clear()
	})

	it('emits the decrypted comment when the parent is available', async () => {
		const session = await makeSession()
		session.state.creds.me = { id: '5511000000000@s.whatsapp.net' } as any
		const getMessage = jest.fn(async () => parentContent())
		const sock = makeWASocket({
			...DEFAULT_CONNECTION_CONFIG,
			auth: { creds: session.state.creds, keys: session.state.keys },
			logger: silentLogger(),
			getMessage
		})
		const upserts: any[] = []
		sock.ev.on('messages.upsert', upsert => upserts.push(...upsert.messages))

		await sock.upsertMessage(envelopeMessage(), 'notify')
		sock.ev.flush(true)

		expect(upserts).toHaveLength(1)
		expect(upserts[0]!.message!.encCommentMessage).toBeNull()
		expect(upserts[0]!.message!.commentMessage!.message!.conversation).toBe('plaintext only')

		await sock.end(new Error('test complete'))
		await session.clear()
	})
})
