import { jest } from '@jest/globals'
import type { BaileysEventEmitter } from '../../Types'
import { buildMessageDeliveryState, emitMessageDeliveryState } from '../../Utils/message-delivery-state'

describe('message delivery state contract', () => {
	const key = { remoteJid: '5511999999999@s.whatsapp.net', fromMe: true, id: 'message-1' }

	it.each(['accepted', 'server_ack', 'delivered', 'failed'] as const)(
		'emits %s with a local observation timestamp',
		state => {
			const emit = jest.fn()
			const ev = { emit } as unknown as BaileysEventEmitter

			emitMessageDeliveryState(ev, { key, state, observedAt: 10_000 })

			expect(emit).toHaveBeenCalledWith(
				'message.delivery-state',
				expect.objectContaining({ key, state, timestamp: 10_000 })
			)
		}
	)

	it('keeps the server receipt timestamp separate from local observation time', () => {
		expect(buildMessageDeliveryState({ key, state: 'delivered', observedAt: 20_000, serverTimestamp: 19_000 })).toEqual(
			{ key, state: 'delivered', timestamp: 20_000, serverTimestamp: 19_000 }
		)
	})

	it('serializes the public chat identity and wire route separately', () => {
		const update = buildMessageDeliveryState({
			key: { remoteJid: '554391910391@s.whatsapp.net', fromMe: true, id: 'cold-1' },
			state: 'accepted',
			requestedJid: '5543991910391@s.whatsapp.net',
			canonicalJid: '554391910391@s.whatsapp.net',
			wireJid: '127496221651050@lid',
			observedAt: 20_000
		})

		expect(JSON.parse(JSON.stringify(update))).toMatchObject({
			key: { remoteJid: '554391910391@s.whatsapp.net' },
			requestedJid: '5543991910391@s.whatsapp.net',
			canonicalJid: '554391910391@s.whatsapp.net',
			wireJid: '127496221651050@lid'
		})
	})

	it('isolates synchronous consumer listener failures', () => {
		const logger = { warn: jest.fn() } as any
		const ev = {
			emit: jest.fn(() => {
				throw new Error('consumer failed')
			})
		} as unknown as BaileysEventEmitter

		expect(() => emitMessageDeliveryState(ev, { key, state: 'accepted', observedAt: 10_000 }, logger)).not.toThrow()
		expect(logger.warn).toHaveBeenCalledWith(
			expect.objectContaining({ state: 'accepted', messageId: key.id }),
			'message.delivery-state listener failed; message processing continues'
		)
	})
})
