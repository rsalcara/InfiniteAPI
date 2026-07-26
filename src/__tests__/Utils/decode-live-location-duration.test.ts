import P from 'pino'
import { proto } from '../../../WAProto/index.js'
import { decryptMessageNode } from '../../Utils/decode-wa-message'
import { writeRandomPadMax16 } from '../../Utils/generics'
import type { BinaryNode } from '../../WABinary'

describe('live-location transport metadata', () => {
	it('copies <enc duration> into WebMessageInfo before processing the live payload', async () => {
		const plaintext = writeRandomPadMax16(
			proto.Message.encode({
				liveLocationMessage: {
					degreesLatitude: -23.5,
					degreesLongitude: -46.6,
					sequenceNumber: 123
				}
			}).finish()
		)
		const stanza: BinaryNode = {
			tag: 'message',
			attrs: {
				id: 'LIVE-DURATION',
				from: '5511999999999@s.whatsapp.net',
				t: '1770000000'
			},
			content: [
				{
					tag: 'enc',
					attrs: { type: 'msg', v: '2', duration: '900' },
					content: new Uint8Array([1, 2, 3])
				}
			]
		}
		const repository = {
			lidMapping: {
				getLIDForPN: async () => undefined,
				storeLIDPNMappings: async () => undefined
			},
			decryptMessage: async () => plaintext,
			migrateSession: async () => undefined
		} as any

		const decoded = decryptMessageNode(
			stanza,
			'5511888888888@s.whatsapp.net',
			'123456789@lid',
			repository,
			P({ level: 'silent' }) as any
		)
		await decoded.decrypt()

		expect(decoded.fullMessage.duration).toBe(900)
		expect(decoded.fullMessage.message?.liveLocationMessage).toMatchObject({
			degreesLatitude: -23.5,
			degreesLongitude: -46.6
		})
		const sequenceNumber = decoded.fullMessage.message?.liveLocationMessage?.sequenceNumber
		expect(typeof sequenceNumber === 'number' ? sequenceNumber : sequenceNumber?.toNumber()).toBe(123)
	})

	it.each(['-1', '1.5', 'not-a-number'])('ignores malformed duration=%s', async duration => {
		const stanza: BinaryNode = {
			tag: 'message',
			attrs: { id: `BAD-${duration}`, from: '5511999999999@s.whatsapp.net', t: '1770000000' },
			content: [
				{
					tag: 'enc',
					attrs: { type: 'msg', v: '2', duration },
					content: new Uint8Array([1])
				}
			]
		}
		const plaintext = writeRandomPadMax16(proto.Message.encode({ conversation: 'ok' }).finish())
		const decoded = decryptMessageNode(
			stanza,
			'5511888888888@s.whatsapp.net',
			'123456789@lid',
			{
				lidMapping: { getLIDForPN: async () => undefined },
				decryptMessage: async () => plaintext
			} as any,
			P({ level: 'silent' }) as any
		)
		await decoded.decrypt()
		expect(decoded.fullMessage.duration).toBeUndefined()
	})
})
