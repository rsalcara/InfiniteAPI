import { type BinaryNode, S_WHATSAPP_NET } from '../WABinary'

/**
 * xmlns of the server→client keepalive ping. The server sends
 * `<iq type="get" xmlns="urn:xmpp:ping" t="<unix>"/>` to probe liveness
 * (W4B 2.26.36.72 inbound handler `X/AbstractC37331lB.java:384`, the sole
 * consumer of this xmlns; it reads `t` and never echoes the request id).
 */
export const SERVER_PING_XMLNS = 'urn:xmpp:ping'

/**
 * The pong the client sends back, byte-for-byte as the app builds it
 * (`X/C17Q.java:175`, logged "WriterThread/write/onSendServerPong"):
 *
 *   <iq type="result" to="s.whatsapp.net"/>
 *
 * A bare, id-less result — attribute order `type` then `to`, and NO id, xmlns,
 * from or child. The inbound ping's id is deliberately NOT echoed; adding any
 * of those attributes or a child would break wire parity.
 *
 * `to` is `S_WHATSAPP_NET` (`@s.whatsapp.net`): the engine's in-memory form of
 * the server jid, which the binary encoder serializes to the same server-jid
 * wire token the app emits as `s.whatsapp.net` (`C1UD.getServer()`). Keep the
 * `@` prefix — it is how every server-directed IQ in this engine is addressed;
 * dropping it would mis-encode the destination.
 *
 * SHARED PARITY SOURCE: this is the single source of truth for the pong shape.
 * The companion keepalive (`Socket/socket.ts`) and the native-android primary
 * (PR #8) must both answer the server ping with exactly this stanza — import
 * this builder on both paths rather than re-creating the node, so they can
 * never drift.
 */
export const buildServerPongNode = (): BinaryNode => ({
	tag: 'iq',
	attrs: { type: 'result', to: S_WHATSAPP_NET }
})
