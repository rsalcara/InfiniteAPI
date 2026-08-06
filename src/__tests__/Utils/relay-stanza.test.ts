import { jest } from '@jest/globals'
import {
	appendParticipantFanoutNode,
	canonicalizeParticipantFanoutRecipient,
	dedupeParticipantFanout,
	mapParticipantFanout
} from '../../Utils/relay-stanza'
import type { BinaryNode } from '../../WABinary'

const encNode = (value: number): BinaryNode => ({
	tag: 'enc',
	attrs: { v: '2', type: 'msg' },
	content: Buffer.from([value])
})

describe('participant fanout admission', () => {
	it('preserves device IDs while canonicalizing PN and LID recipients', async () => {
		const getLIDForPN = jest.fn(async () => '207421150646274@lid')
		const recipients = await Promise.all([
			canonicalizeParticipantFanoutRecipient('5511999999999:1@s.whatsapp.net', getLIDForPN),
			canonicalizeParticipantFanoutRecipient('5511999999999:2@s.whatsapp.net', getLIDForPN),
			canonicalizeParticipantFanoutRecipient('207421150646274:3@lid', getLIDForPN)
		])

		expect(recipients).toEqual(['207421150646274:1@lid', '207421150646274:2@lid', '207421150646274:3@lid'])
		expect(new Set(recipients).size).toBe(3)
	})

	it('deduplicates exact canonical PN/LID targets while preserving order', () => {
		const targets = [
			{ input: 'pn', canonical: '123:1@lid' },
			{ input: 'lid', canonical: '123:1@lid' },
			{ input: 'device-2', canonical: '123:2@lid' }
		]

		expect(dedupeParticipantFanout(targets, target => target.canonical).map(target => target.input)).toEqual([
			'pn',
			'device-2'
		])
	})

	it('applies bounded backpressure without reordering a large fanout', async () => {
		let active = 0
		let peak = 0
		const result = await mapParticipantFanout(
			Array.from({ length: 25 }, (_, index) => index),
			async value => {
				active++
				peak = Math.max(peak, active)
				await Promise.resolve()
				active--
				return value * 2
			},
			{ max: 30, concurrency: 4 }
		)

		expect(peak).toBeLessThanOrEqual(4)
		expect(result).toEqual(Array.from({ length: 25 }, (_, index) => index * 2))
	})

	it('rejects oversized fanout before mapping any recipient', async () => {
		const map = jest.fn(async (value: number) => value)

		await expect(mapParticipantFanout([1, 2, 3], map, { max: 2 })).rejects.toMatchObject({
			output: { statusCode: 413 }
		})
		expect(map).not.toHaveBeenCalled()
	})
})

const participantNode = (jid: string, value: number): BinaryNode => ({
	tag: 'to',
	attrs: { jid },
	content: [encNode(value)]
})

describe('relay stanza participant fanout', () => {
	it('keeps a direct retry as one top-level enc without participants', () => {
		const content = [encNode(1)]

		appendParticipantFanoutNode(content, [], true, false)

		expect(content.map(node => node.tag)).toEqual(['enc'])
	})

	it('fails closed if a direct retry also contains participant fanout', () => {
		const content = [encNode(1)]
		const participants = [participantNode('207421150646274:40@lid', 2)]

		expect(() => appendParticipantFanoutNode(content, participants, true, false)).toThrow(
			'Direct retry resend cannot include participant fanout'
		)
		expect(content.map(node => node.tag)).toEqual(['enc'])
	})

	it('preserves participant fanout for a normal one-to-one send', () => {
		const content: BinaryNode[] = []
		const participants = [participantNode('207421150646274:40@lid', 1), participantNode('207421150646274:43@lid', 2)]

		appendParticipantFanoutNode(content, participants, false, false)

		expect(content).toEqual([{ tag: 'participants', attrs: {}, content: participants }])
	})

	it('preserves the peer path that promotes only its first enc node', () => {
		const content: BinaryNode[] = []
		const peerEnc = encNode(7)
		const participants: BinaryNode[] = [
			{
				tag: 'to',
				attrs: { jid: '46802258641027:40@lid' },
				content: [peerEnc]
			}
		]

		appendParticipantFanoutNode(content, participants, false, true)

		expect(content).toEqual([peerEnc])
	})
})
