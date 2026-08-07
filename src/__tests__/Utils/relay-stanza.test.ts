import { jest } from '@jest/globals'
import {
	appendParticipantFanoutNode,
	appendTcTokensToParticipantFanout,
	buildGroupParticipantNode,
	canonicalizeParticipantFanoutRecipient,
	canonicalizeSelfSendFanoutRecipient,
	dedupeParticipantFanout,
	mapParticipantFanout,
	resolveSelfSendLid
} from '../../Utils/relay-stanza'
import type { BinaryNode } from '../../WABinary'

const encNode = (value: number): BinaryNode => ({
	tag: 'enc',
	attrs: { v: '2', type: 'msg' },
	content: Buffer.from([value])
})

describe('participant fanout admission', () => {
	it('resolves a PN self-send to the connected account LID', () => {
		expect(
			resolveSelfSendLid('5515991426667@s.whatsapp.net', '5515991426667:24@s.whatsapp.net', '207421150646274:24@lid')
		).toBe('207421150646274@lid')
	})

	it('uses a stored mapping when the connected credentials do not include meLid', () => {
		expect(
			resolveSelfSendLid('5515991426667@c.us', '5515991426667:24@s.whatsapp.net', undefined, '207421150646274@lid')
		).toBe('207421150646274@lid')
	})

	it('keeps an own LID destination canonical when the caller already uses LID', () => {
		expect(resolveSelfSendLid('207421150646274@lid', '5515991426667:24@s.whatsapp.net', '207421150646274:24@lid')).toBe(
			'207421150646274@lid'
		)
	})

	it('does not switch a remote PN recipient to LID under the self-send rule', () => {
		expect(
			resolveSelfSendLid(
				'5511986557008@s.whatsapp.net',
				'5515991426667:24@s.whatsapp.net',
				'207421150646274@lid',
				'56307306467375@lid'
			)
		).toBeNull()
	})

	it('keeps every self-send participant in the own LID domain without losing device IDs', () => {
		const meId = '5515991426667:24@s.whatsapp.net'
		const meLid = '207421150646274@lid'
		const recipients = [
			canonicalizeSelfSendFanoutRecipient('5515991426667:1@s.whatsapp.net', meId, meLid),
			canonicalizeSelfSendFanoutRecipient('5515991426667:24@s.whatsapp.net', meId, meLid),
			canonicalizeSelfSendFanoutRecipient('207421150646274:43@lid', meId, meLid)
		]

		expect(recipients).toEqual(['207421150646274:1@lid', '207421150646274:24@lid', '207421150646274:43@lid'])
	})

	it('does not alter a remote participant while canonicalizing self-send devices', () => {
		expect(
			canonicalizeSelfSendFanoutRecipient(
				'5511986557008:7@s.whatsapp.net',
				'5515991426667:24@s.whatsapp.net',
				'207421150646274@lid'
			)
		).toBe('5511986557008:7@s.whatsapp.net')
	})

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

	it('adds one token per user without collapsing device recipients', async () => {
		const participants = [
			participantNode('207421150646274:1@lid', 1),
			participantNode('207421150646274:2@lid', 2),
			participantNode('56307306467375:3@lid', 3)
		]
		const resolveToken = jest.fn(async (userJid: string) =>
			userJid.startsWith('207421150646274') ? Buffer.from([9]) : Buffer.from([8])
		)

		await appendTcTokensToParticipantFanout(participants, { resolveToken })

		expect(resolveToken).toHaveBeenCalledTimes(2)
		expect((participants[0]!.content as BinaryNode[]).map(node => node.tag)).toEqual(['enc', 'tctoken'])
		expect((participants[1]!.content as BinaryNode[]).map(node => node.tag)).toEqual(['enc'])
		expect((participants[2]!.content as BinaryNode[]).map(node => node.tag)).toEqual(['enc', 'tctoken'])
		expect(participants.map(node => node.attrs.jid)).toEqual([
			'207421150646274:1@lid',
			'207421150646274:2@lid',
			'56307306467375:3@lid'
		])
	})

	it('keeps encrypted fanout intact when token lookup fails or hits the user cap', async () => {
		const participants = [participantNode('1:1@lid', 1), participantNode('2:1@lid', 2)]
		const onResolveError = jest.fn()

		await appendTcTokensToParticipantFanout(participants, {
			maxUsers: 1,
			resolveToken: async () => {
				throw new Error('store unavailable')
			},
			onResolveError
		})

		expect(onResolveError).toHaveBeenCalledTimes(1)
		expect(participants.map(node => (node.content as BinaryNode[]).map(child => child.tag))).toEqual([['enc'], ['enc']])
	})

	it('honors the official AB gate when fanout token contribution is disabled', async () => {
		const participants = [participantNode('1:1@lid', 1)]
		const resolveToken = jest.fn(async () => Buffer.from([9]))

		await appendTcTokensToParticipantFanout(participants, { enabled: false, resolveToken })

		expect(resolveToken).not.toHaveBeenCalled()
		expect((participants[0]!.content as BinaryNode[]).map(node => node.tag)).toEqual(['enc'])
	})

	it('uses privacy only in the captured legacy group-add participant shape', () => {
		expect(buildGroupParticipantNode('123@lid', Buffer.from([7]))).toEqual({
			tag: 'participant',
			attrs: { jid: '123@lid' },
			content: [{ tag: 'privacy', attrs: {}, content: Buffer.from([7]) }]
		})
		expect(buildGroupParticipantNode('123@lid')).toEqual({ tag: 'participant', attrs: { jid: '123@lid' } })
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
