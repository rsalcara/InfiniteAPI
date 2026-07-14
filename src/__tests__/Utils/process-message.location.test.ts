/**
 * Verifies processMessage mirrors locationMessage/liveLocationMessage
 * into an injected `locationBackend` (location_cache/location_sharer), without
 * depending on a real SQLite handle — a lightweight mock stands in for
 * `LocationBackend`, matching the pattern used elsewhere for this file's tests.
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

const makeLocationBackendMock = () => ({
	upsertLocationCache: jest.fn(),
	upsertLocationSharer: jest.fn()
})

const makeContext = (locationBackend: ReturnType<typeof makeLocationBackendMock>) => {
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
			locationBackend: locationBackend as any
		}
	}
}

const inbound = (id: string, message: proto.IMessage, fromMe = false): WAMessage => ({
	key: { remoteJid: 'chat@s.whatsapp.net', fromMe, id, participant: fromMe ? undefined : 'sender@s.whatsapp.net' },
	message,
	messageTimestamp: 1770000000
})

describe('processMessage — location.db mirror', () => {
	it('upserts location_cache for a static locationMessage', async () => {
		const locationBackend = makeLocationBackendMock()
		const { ctx } = makeContext(locationBackend)

		const msg = inbound('loc-1', {
			locationMessage: {
				degreesLatitude: -23.55,
				degreesLongitude: -46.63,
				accuracyInMeters: 12
			}
		})

		await processMessage(msg, ctx as any)

		expect(locationBackend.upsertLocationCache).toHaveBeenCalledWith(
			expect.objectContaining({
				jid: 'sender@s.whatsapp.net',
				latitude: -23.55,
				longitude: -46.63,
				accuracy: 12
			})
		)
		expect(locationBackend.upsertLocationSharer).not.toHaveBeenCalled()
	})

	it('upserts both location_cache AND location_sharer for a liveLocationMessage', async () => {
		const locationBackend = makeLocationBackendMock()
		const { ctx } = makeContext(locationBackend)

		const msg = inbound('live-loc-1', {
			liveLocationMessage: {
				degreesLatitude: -23.5,
				degreesLongitude: -46.6,
				accuracyInMeters: 8,
				speedInMps: 1.5
			}
		})

		await processMessage(msg, ctx as any)

		expect(locationBackend.upsertLocationCache).toHaveBeenCalledWith(
			expect.objectContaining({ jid: 'sender@s.whatsapp.net', latitude: -23.5, longitude: -46.6, speed: 1.5 })
		)
		expect(locationBackend.upsertLocationSharer).toHaveBeenCalledWith(
			expect.objectContaining({
				remoteJid: 'chat@s.whatsapp.net',
				fromMe: 0,
				messageId: 'live-loc-1',
				expires: 0,
				receivedTs: 1770000000
			})
		)
	})

	it('lets the backend use current time when a received live location has no message timestamp', async () => {
		const locationBackend = makeLocationBackendMock()
		const { ctx } = makeContext(locationBackend)
		const msg = inbound('live-loc-without-ts', {
			liveLocationMessage: { degreesLatitude: -23.5, degreesLongitude: -46.6 }
		})
		msg.messageTimestamp = undefined

		await processMessage(msg, ctx as any)

		expect(locationBackend.upsertLocationSharer).toHaveBeenCalledWith(
			expect.objectContaining({ receivedTs: undefined })
		)
	})

	it('does nothing when locationBackend is not configured (additive/opt-in)', async () => {
		const { ctx } = makeContext(makeLocationBackendMock())
		;(ctx as any).locationBackend = undefined

		const msg = inbound('loc-2', {
			locationMessage: { degreesLatitude: 1, degreesLongitude: 2 }
		})

		// Must not throw even without a locationBackend configured.
		await expect(processMessage(msg, ctx as any)).resolves.not.toThrow()
	})

	it('does not record anything for messages with no location content', async () => {
		const locationBackend = makeLocationBackendMock()
		const { ctx } = makeContext(locationBackend)

		const msg = inbound('txt-1', { conversation: 'hello' })
		await processMessage(msg, ctx as any)

		expect(locationBackend.upsertLocationCache).not.toHaveBeenCalled()
		expect(locationBackend.upsertLocationSharer).not.toHaveBeenCalled()
	})
})
