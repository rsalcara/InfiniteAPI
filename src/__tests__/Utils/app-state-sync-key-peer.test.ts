import { Boom } from '@hapi/boom'
import { buildAppStateSyncKeyPeerNode } from '../../Utils/app-state-sync-key-peer'

describe('buildAppStateSyncKeyPeerNode — official SendPeerMessageJob wire contract', () => {
	const targetDeviceJid = '5511999999999:2@s.whatsapp.net'

	it('builds a direct peer stanza without conversation fanout or TcToken', () => {
		const node = buildAppStateSyncKeyPeerNode({
			targetDeviceJid,
			messageId: 'peer-request-39',
			encrypted: { type: 'msg', ciphertext: Buffer.from([1, 2, 3]) }
		})

		expect(node).toEqual({
			tag: 'message',
			attrs: {
				id: 'peer-request-39',
				to: targetDeviceJid,
				type: 'protocol',
				category: 'peer',
				push_priority: 'high'
			},
			content: [
				{
					tag: 'enc',
					attrs: { v: '2', type: 'msg' },
					content: Buffer.from([1, 2, 3])
				}
			]
		})
		const tags = (node.content as Array<{ tag: string }>).map(child => child.tag)
		expect(tags).not.toContain('participants')
		expect(tags).not.toContain('tctoken')
		expect(tags).not.toContain('device-identity')
	})

	it('includes signed device identity for pkmsg and only for pkmsg', () => {
		const node = buildAppStateSyncKeyPeerNode({
			targetDeviceJid,
			messageId: 'peer-share-38',
			encrypted: { type: 'pkmsg', ciphertext: Buffer.from([4, 5]) },
			deviceIdentity: Buffer.from([9, 9])
		})
		const content = node.content as Array<{ tag: string; content?: Uint8Array }>

		expect(content.map(child => child.tag)).toEqual(['enc', 'device-identity'])
		expect(content[1]?.content).toEqual(Buffer.from([9, 9]))
	})

	it('keeps primary device 0 explicit on the peer wire', () => {
		const primary = '5511999999999:0@s.whatsapp.net'
		const node = buildAppStateSyncKeyPeerNode({
			targetDeviceJid: primary,
			messageId: 'peer-primary',
			encrypted: { type: 'msg', ciphertext: Buffer.from([1]) }
		})
		expect(node.attrs.to).toBe(primary)
	})

	it('fails closed for a pkmsg without signed device identity', () => {
		expect(() =>
			buildAppStateSyncKeyPeerNode({
				targetDeviceJid,
				messageId: 'peer-share-38',
				encrypted: { type: 'pkmsg', ciphertext: Buffer.from([4, 5]) }
			})
		).toThrow(Boom)
	})

	it.each(['5511999999999@s.whatsapp.net', 'invalid', '120363000000000000@g.us'])(
		'rejects a non-device target: %s',
		to => {
			expect(() =>
				buildAppStateSyncKeyPeerNode({
					targetDeviceJid: to,
					messageId: 'bad-target',
					encrypted: { type: 'msg', ciphertext: Buffer.alloc(1) }
				})
			).toThrow('requires an explicit target device')
		}
	)
})
