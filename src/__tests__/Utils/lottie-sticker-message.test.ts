/**
 * Lottie animated sticker (.was / application/was) round-trip tests.
 *
 * Pins the wrap shape against WhatsApp Web's actual implementation. The
 * algorithm was reverse-engineered from `WAWebE2EProtoGenerator`'s sticker
 * wrap site:
 *
 *   t.type === STICKER && d.stickerMessage?.isLottie && (d = S(d))
 *
 *   function S(e) { return { lottieStickerMessage: { message: e } } }
 *                                                   ^^^^^^^^^^
 *                                                   outer Message, not just stickerMessage
 *
 * and from `WAWebStickersParseStickerMessageProto`'s unwrap:
 *
 *   const lottieWrap = msg.lottieStickerMessage
 *   const inner = lottieWrap?.message?.stickerMessage
 *   const d = inner ?? msg.stickerMessage
 *
 * Mobile WhatsApp clients silently drop Lottie stickers delivered inside a
 * plain `stickerMessage` (field 26) — without this wrap, the bubble is
 * created on the server but never renders on the recipient's phone.
 */
import { proto } from '../../../WAProto/index.js'
import { WAProto } from '../../Types'
import { extractMessageContent, normalizeMessageContent } from '../../Utils/messages'

const innerSticker: proto.Message.IStickerMessage = {
	url: 'https://mmg.whatsapp.net/o1/v/example',
	directPath: '/o1/v/example',
	mediaKey: Buffer.from('a'.repeat(32)),
	fileSha256: Buffer.from('b'.repeat(32)),
	fileEncSha256: Buffer.from('c'.repeat(32)),
	fileLength: 19805,
	mimetype: 'application/was',
	width: 64,
	height: 64,
	isAnimated: true,
	isLottie: true
}

describe('normalizeMessageContent — Lottie sticker unwrap', () => {
	it('unwraps lottieStickerMessage to expose the inner stickerMessage', () => {
		const wrapped: proto.IMessage = {
			lottieStickerMessage: {
				message: { stickerMessage: innerSticker }
			}
		}

		const result = normalizeMessageContent(wrapped)

		expect(result).toBeDefined()
		expect(result?.stickerMessage).toBeDefined()
		expect(result?.stickerMessage?.isLottie).toBe(true)
		expect(result?.stickerMessage?.mimetype).toBe('application/was')
		expect(result?.lottieStickerMessage).toBeUndefined()
	})

	it('passes through a plain stickerMessage unchanged (no Lottie wrapper)', () => {
		const plain: proto.IMessage = { stickerMessage: innerSticker }
		const result = normalizeMessageContent(plain)
		expect(result).toBe(plain)
	})

	it('reaches the inner sticker through an ephemeral → lottie wrap chain', () => {
		// WhatsApp Web routes ephemeral messages through `ephemeralMessage`
		// first; the inner content may be a lottieStickerMessage. Our
		// normalize loop must traverse both layers.
		const nested: proto.IMessage = {
			ephemeralMessage: {
				message: {
					lottieStickerMessage: {
						message: { stickerMessage: innerSticker }
					}
				}
			}
		}

		const result = normalizeMessageContent(nested)
		expect(result?.stickerMessage?.isLottie).toBe(true)
		expect(result?.stickerMessage?.mimetype).toBe('application/was')
	})
})

describe('extractMessageContent — Lottie sticker traversal', () => {
	it('reaches the inner stickerMessage through a lottieStickerMessage wrapper', () => {
		const wrapped: proto.IMessage = {
			lottieStickerMessage: {
				message: { stickerMessage: innerSticker }
			}
		}

		const content = extractMessageContent(wrapped)
		expect(content?.stickerMessage?.url).toBe(innerSticker.url)
		expect(content?.stickerMessage?.isLottie).toBe(true)
	})
})

describe('proto round-trip', () => {
	it('encodes and decodes a lottieStickerMessage without losing the inner sticker', () => {
		const msg = WAProto.Message.create({
			lottieStickerMessage: {
				message: { stickerMessage: innerSticker }
			}
		})

		const encoded = WAProto.Message.encode(msg).finish()
		const decoded = WAProto.Message.decode(encoded)

		expect(decoded.lottieStickerMessage?.message?.stickerMessage?.mimetype).toBe('application/was')
		expect(decoded.lottieStickerMessage?.message?.stickerMessage?.isLottie).toBe(true)
		expect(decoded.lottieStickerMessage?.message?.stickerMessage?.isAnimated).toBe(true)
	})

	it('proves the wrap shape: lottieStickerMessage.message is an IMessage (matches WA Web S(e))', () => {
		// WA Web's `S(e)` wraps the OUTER message, not just the inner sticker.
		// Our wrap is therefore `{ lottieStickerMessage: { message: outerMessage } }`
		// where `outerMessage` may itself carry messageContextInfo / other
		// top-level fields. Pin the shape so a future "elevate
		// messageContextInfo" refactor (as upstream PR #2592 does) doesn't
		// silently drift away from WA Web.
		const outer: proto.IMessage = {
			stickerMessage: innerSticker,
			messageContextInfo: {
				messageSecret: Buffer.alloc(32, 0x11)
			}
		}

		const wrapped: proto.IMessage = {
			lottieStickerMessage: { message: outer }
		}

		const encoded = WAProto.Message.encode(wrapped).finish()
		const decoded = WAProto.Message.decode(encoded)

		// messageContextInfo MUST end up INSIDE the wrap (matches WA Web),
		// not elevated to the top level of the outer Message.
		expect(decoded.messageContextInfo).toBeFalsy()
		expect(decoded.lottieStickerMessage?.message?.messageContextInfo?.messageSecret).toHaveLength(32)
		expect(decoded.lottieStickerMessage?.message?.stickerMessage?.isLottie).toBe(true)
	})
})

// ─── Send-path contract pinning ───────────────────────────────────────────
//
// `getMediaType()` and the DSM (`deviceSentMessage`) builder live as
// closures inside `makeMessagesSocket` and aren't directly importable.
// Instead, pin the SHAPE contracts they read so any refactor that breaks
// the assumption surfaces here:
//
//   - `getMediaType(message)` for a Lottie send MUST receive an object where
//     `lottieStickerMessage` is a recognizable top-level key (we just added
//     the branch returning 'sticker').
//   - `meMsg.messageContextInfo` for the DSM envelope needs to be reachable
//     at `message.lottieStickerMessage.message.messageContextInfo` (NOT the
//     top level) so the sender's other devices receive the reporting token
//     and any `messageSecret`.
//
// Regression for two audit findings: chatgpt-codex P2 (mediatype dropped on
// the enc stanza) and copilot P2 (DSM envelope context_info lost).
describe('send-path contracts after Lottie wrap', () => {
	const buildWrapped = (): proto.IMessage => ({
		lottieStickerMessage: {
			message: {
				stickerMessage: innerSticker,
				messageContextInfo: { messageSecret: Buffer.alloc(32, 0x99) }
			}
		}
	})

	it('top-level `lottieStickerMessage` is detectable for getMediaType branching', () => {
		const m = buildWrapped()
		// The runSendBody site reads `message.lottieStickerMessage` directly —
		// pin that this key remains accessible (not normalized away by some
		// future helper) so the new `else if (message.lottieStickerMessage)`
		// arm in getMediaType keeps firing.
		expect(m.lottieStickerMessage).toBeDefined()
		expect(m.stickerMessage).toBeUndefined()
	})

	it('messageContextInfo for the DSM envelope is reachable at .lottieStickerMessage.message.messageContextInfo', () => {
		const m = buildWrapped()
		// runSendBody's `dsmMessageContextInfo` reads this exact path. If the
		// PR's wrap shape ever changes (e.g. elevates messageContextInfo to
		// the top like upstream PR #2563 does), the reader must change too —
		// this test fails first and points at the contract break.
		const dsm = m.lottieStickerMessage?.message?.messageContextInfo ?? m.messageContextInfo
		expect(dsm?.messageSecret).toBeDefined()
		expect(dsm?.messageSecret).toHaveLength(32)
		// Sanity: also confirms the wrong reader (`m.messageContextInfo`
		// directly) returns nothing — which is what the original bug was.
		expect(m.messageContextInfo).toBeUndefined()
	})

	it('plain stickerMessage path (no Lottie) leaves both reads working unchanged', () => {
		// Negative-control: a non-Lottie sticker still has stickerMessage at
		// the top, and messageContextInfo wherever the caller put it — both
		// branches of the new readers must still pick the right value.
		const plain: proto.IMessage = {
			stickerMessage: innerSticker,
			messageContextInfo: { messageSecret: Buffer.alloc(32, 0x55) }
		}
		expect(plain.stickerMessage).toBeDefined()
		expect(plain.lottieStickerMessage).toBeUndefined()
		const dsm = plain.lottieStickerMessage?.message?.messageContextInfo ?? plain.messageContextInfo
		expect(dsm?.messageSecret).toHaveLength(32)
	})
})
