/**
 * Phase 9.15 — verifies processMessage mirrors received status/story updates
 * into an injected `statusBackend` (status/status_info), without depending
 * on a real SQLite handle — mirrors process-message.location.test.ts's
 * mock-based pattern.
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
	me: { id: 'me@s.whatsapp.net' } as any
})

const makeStatusBackendMock = () => ({
	recordReceivedStatus: jest.fn()
})

const makeContext = (statusBackend: ReturnType<typeof makeStatusBackendMock>) => {
	const events = new EventEmitter() as unknown as BaileysEventEmitter
	return {
		ctx: {
			shouldProcessHistoryMsg: false,
			placeholderResendCache: undefined,
			ev: events,
			creds: credsWithMe(),
			keyStore: {} as any,
			signalRepository: { lidMapping: { getPNForLID: async (jid: string) => jid } } as any,
			logger: silent,
			options: {},
			getMessage: async () => undefined,
			statusBackend: statusBackend as any
		}
	}
}

const inboundStatus = (id: string, message: proto.IMessage): WAMessage => ({
	key: { remoteJid: 'status@broadcast', fromMe: false, id, participant: 'sender@s.whatsapp.net' },
	message,
	messageTimestamp: 1770000000
})

describe('processMessage — status.db mirror (Phase 9.15)', () => {
	it('records a received status update for a status-broadcast message', async () => {
		const statusBackend = makeStatusBackendMock()
		const { ctx } = makeContext(statusBackend)

		const msg = inboundStatus('status-1', { extendedTextMessage: { text: 'hello world' } })
		await processMessage(msg, ctx as any)

		expect(statusBackend.recordReceivedStatus).toHaveBeenCalledWith(
			expect.objectContaining({
				senderUserJid: 'sender@s.whatsapp.net',
				uuid: 'status-1',
				timestamp: 1770000000,
				textData: 'hello world'
			})
		)
	})

	it('does not record anything for a normal (non-broadcast) chat message', async () => {
		const statusBackend = makeStatusBackendMock()
		const { ctx } = makeContext(statusBackend)

		const msg: WAMessage = {
			key: { remoteJid: 'chat@s.whatsapp.net', fromMe: false, id: 'msg-1', participant: 'sender@s.whatsapp.net' },
			message: { conversation: 'hi' },
			messageTimestamp: 1770000000
		}
		await processMessage(msg, ctx as any)

		expect(statusBackend.recordReceivedStatus).not.toHaveBeenCalled()
	})

	it('does nothing when statusBackend is not configured (additive/opt-in)', async () => {
		const { ctx } = makeContext(makeStatusBackendMock())
		;(ctx as any).statusBackend = undefined

		const msg = inboundStatus('status-2', { conversation: 'x' })
		await expect(processMessage(msg, ctx as any)).resolves.not.toThrow()
	})
})
