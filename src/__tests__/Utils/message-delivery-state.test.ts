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
})
