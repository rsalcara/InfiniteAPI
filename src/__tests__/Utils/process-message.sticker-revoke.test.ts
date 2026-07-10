/**
 * Verifies two process-message mirror fixes, using lightweight mocked
 * backends (no real SQLite handle), matching process-message.location.test.ts:
 *
 *   1. `stickerMessage` is recorded into `mediaBackend` (message_media) — it
 *      was previously omitted from the image/video/audio/document media list.
 *   2. A REVOKE records into `messageStoreBackend` when the STORE has the
 *      target message, even if the consumer's `getMessage` returns undefined
 *      (the default). Previously the revoke was gated solely on `getMessage`,
 *      so a consumer without its own cache never recorded delete-for-everyone.
 */
import { jest } from '@jest/globals'
import { EventEmitter } from 'events'
import P from 'pino'
import { proto } from '../../../WAProto/index.js'
import type { AuthenticationCreds, BaileysEventEmitter, WAMessage } from '../../Types'
import { initAuthCreds } from '../../Utils/auth-utils'
import processMessage from '../../Utils/process-message'

const silent = P({ level: 'silent' })

const credsWithMe = (): AuthenticationCreds => ({
	...initAuthCreds(),
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	me: { id: 'me@s.whatsapp.net' } as any
})

const makeMediaBackendMock = () => ({
	recordMedia: jest.fn(),
	recordThumbnail: jest.fn(),
	recordAudioData: jest.fn(),
	recordStreamingSidecar: jest.fn()
})

const makeStoreBackendMock = (opts?: { hasMessage?: boolean }) => ({
	recordMessage: jest.fn(() => 42),
	getMessageByKeyId: jest.fn(() => (opts?.hasMessage ? { _id: 42 } : null)),
	recordRevoke: jest.fn()
})

const makeContext = (extra: Record<string, unknown>) => {
	const events = new EventEmitter() as unknown as BaileysEventEmitter
	return {
		ctx: {
			shouldProcessHistoryMsg: false,
			placeholderResendCache: undefined,
			ev: events,
			creds: credsWithMe(),
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			keyStore: {} as any,
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			signalRepository: { lidMapping: { getPNForLID: async (jid: string) => jid } } as any,
			logger: silent,
			options: {},
			getMessage: async () => undefined,
			...extra
		}
	}
}

const inbound = (id: string, message: proto.IMessage, fromMe = false): WAMessage => ({
	key: { remoteJid: 'chat@s.whatsapp.net', fromMe, id, participant: fromMe ? undefined : 'sender@s.whatsapp.net' },
	message,
	messageTimestamp: 1770000000
})

describe('processMessage — sticker media + store-driven revoke', () => {
	it('records a stickerMessage into mediaBackend (message_media)', async () => {
		const messageStoreBackend = makeStoreBackendMock()
		const mediaBackend = makeMediaBackendMock()
		const { ctx } = makeContext({ messageStoreBackend, mediaBackend })

		const msg = inbound('stk-1', {
			stickerMessage: {
				mimetype: 'image/webp',
				fileLength: 12345,
				mediaKey: new Uint8Array([1, 2, 3]),
				directPath: '/sticker/path',
				fileSha256: new Uint8Array([9]),
				width: 512,
				height: 512
			}
		})

		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		await processMessage(msg, ctx as any)

		expect(mediaBackend.recordMedia).toHaveBeenCalledWith(
			expect.objectContaining({ messageRowId: 42, mimeType: 'image/webp', fileLength: 12345, width: 512, height: 512 })
		)
	})

	it('records a REVOKE via the store when getMessage is undefined but the store has the target', async () => {
		const messageStoreBackend = makeStoreBackendMock({ hasMessage: true })
		// getMessage defaults to `() => undefined` (as a consumer without its own cache).
		const { ctx } = makeContext({ messageStoreBackend })

		const revoke = inbound(
			'revoke-stanza-1',
			{
				protocolMessage: {
					type: proto.Message.ProtocolMessage.Type.REVOKE,
					key: { id: 'target-msg-id', remoteJid: 'chat@s.whatsapp.net', fromMe: true }
				}
			},
			true
		)

		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		await processMessage(revoke, ctx as any)

		expect(messageStoreBackend.getMessageByKeyId).toHaveBeenCalledWith('chat@s.whatsapp.net', true, 'target-msg-id')
		expect(messageStoreBackend.recordRevoke).toHaveBeenCalledWith(
			expect.objectContaining({ revokedKeyId: 'target-msg-id', fromMe: true })
		)
	})

	it('does NOT record a REVOKE when neither getMessage nor the store has the target (and no orphan queue)', async () => {
		const messageStoreBackend = makeStoreBackendMock({ hasMessage: false })
		const { ctx } = makeContext({ messageStoreBackend })

		const revoke = inbound(
			'revoke-stanza-2',
			{
				protocolMessage: {
					type: proto.Message.ProtocolMessage.Type.REVOKE,
					key: { id: 'unknown-msg-id', remoteJid: 'chat@s.whatsapp.net', fromMe: true }
				}
			},
			true
		)

		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		await processMessage(revoke, ctx as any)

		expect(messageStoreBackend.recordRevoke).not.toHaveBeenCalled()
	})
})
