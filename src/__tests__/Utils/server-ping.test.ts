import { buildServerPongNode, SERVER_PING_XMLNS } from '../../Utils/server-ping'
import { S_WHATSAPP_NET } from '../../WABinary'

describe('server ping parity (W4B 2.26.36.72)', () => {
	it('uses the urn:xmpp:ping xmlns the server pings on', () => {
		// X/AbstractC37331lB.java:384 — the sole inbound consumer of this xmlns.
		expect(SERVER_PING_XMLNS).toBe('urn:xmpp:ping')
	})

	it('answers with the exact bare pong stanza (X/C17Q.java:175)', () => {
		const pong = buildServerPongNode()
		// Full shape: <iq type="result" to="s.whatsapp.net"/> and nothing else.
		// `to` is the engine's server-jid form (`@s.whatsapp.net`), which encodes
		// to the same wire token the app sends as `s.whatsapp.net`.
		expect(pong).toEqual({ tag: 'iq', attrs: { type: 'result', to: S_WHATSAPP_NET } })
	})

	it('emits attributes in the app order (type before to)', () => {
		// The binary encoder serializes attrs in object-key order, so key order
		// IS wire order. The app builds type first, then to (C17Q.java:175).
		expect(Object.keys(buildServerPongNode().attrs)).toEqual(['type', 'to'])
	})

	it('never adds id, xmlns, from or a child (the bare shape is the parity)', () => {
		const pong = buildServerPongNode()
		expect(pong.attrs.id).toBeUndefined()
		expect(pong.attrs.xmlns).toBeUndefined()
		expect(pong.attrs.from).toBeUndefined()
		expect(pong.content).toBeUndefined()
	})
})
