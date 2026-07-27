import { appendParticipantFanoutNode } from '../../Utils/relay-stanza'
import type { BinaryNode } from '../../WABinary'

const encNode = (value: number): BinaryNode => ({
	tag: 'enc',
	attrs: { v: '2', type: 'msg' },
	content: Buffer.from([value])
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
