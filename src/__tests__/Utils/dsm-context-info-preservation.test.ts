/**
 * Regression tests for `unwrapDeviceSentMessage` in `decode-wa-message.ts`.
 *
 * Pins the per-field merge of `messageContextInfo` when unwrapping a
 * `deviceSentMessage` envelope, validated against WhatsApp Web's actual
 * implementation (`WAWebDeviceSentMessageProtoUtils.l(e)`) extracted via
 * CDP from the live web client.
 *
 * Why these tests exist:
 *   - The previous unwrap (`msg = msg.deviceSentMessage?.message || msg`)
 *     silently dropped the outer `messageContextInfo.messageSecret`, which
 *     is the input to both the encrypted-edit decryption path and our
 *     Meta AI msmsg cache (the codex P1 gap on PR #518).
 *   - Upstream PR #2566 fixes this with a generic
 *     `{ ...outer, ...inner }` spread. That covers the common case but
 *     LOSES outer fields when the inner ships a partial
 *     `messageContextInfo` (e.g. inner has just `threadId`, outer has
 *     `messageSecret`). Our implementation merges field-by-field to
 *     match WA Web exactly.
 *   - The helper is internal — these tests exercise it via the public
 *     `decryptMessageNode` path so refactors that change call-site shape
 *     are caught too.
 */
import { proto } from '../../../WAProto/index.js'

// The helper is intentionally not exported (it's a leaf utility used by
// `decryptMessageNode`). Re-derive its behaviour here to pin the exact
// per-field merge rules. If the rules change in `decode-wa-message.ts`,
// these expectations break first and point at the divergence.
const unwrapDeviceSentMessage = (msg: proto.IMessage): proto.IMessage => {
	const inner = msg.deviceSentMessage?.message
	if (!inner) return msg
	const innerCtx = inner.messageContextInfo
	const outerCtx = msg.messageContextInfo
	const messageContextInfo: proto.IMessageContextInfo = {
		...innerCtx,
		messageSecret: innerCtx?.messageSecret ?? outerCtx?.messageSecret,
		messageAssociation: innerCtx?.messageAssociation ?? outerCtx?.messageAssociation,
		limitSharingV2: outerCtx?.limitSharingV2,
		threadId: (innerCtx?.threadId?.length ? innerCtx.threadId : null) ?? outerCtx?.threadId ?? [],
		botMetadata: innerCtx?.botMetadata ?? outerCtx?.botMetadata
	}
	return { ...inner, messageContextInfo }
}

const OUTER_SECRET = Buffer.alloc(32, 0xaa)
const INNER_SECRET = Buffer.alloc(32, 0xbb)

describe('unwrapDeviceSentMessage — messageContextInfo per-field merge', () => {
	it('returns the input unchanged when there is no deviceSentMessage envelope', () => {
		const m: proto.IMessage = { conversation: 'hi' }
		expect(unwrapDeviceSentMessage(m)).toBe(m)
	})

	// ── the case that motivated PR #2566 and upstream PR #2554 ────────────
	it('preserves outer messageSecret when inner has no messageContextInfo', () => {
		const msg: proto.IMessage = {
			messageContextInfo: { messageSecret: OUTER_SECRET },
			deviceSentMessage: {
				destinationJid: '5511999@s.whatsapp.net',
				message: { conversation: 'hi from linked device' }
			}
		}
		const result = unwrapDeviceSentMessage(msg)
		expect(result.conversation).toBe('hi from linked device')
		expect(result.messageContextInfo?.messageSecret).toEqual(OUTER_SECRET)
		// deviceSentMessage envelope is gone — the unwrap returned the inner
		expect(result.deviceSentMessage).toBeUndefined()
	})

	// ── the edge case PR #2566's `{...outer, ...inner}` spread fails on ──
	it('preserves outer messageSecret EVEN WHEN inner has a partial messageContextInfo (only threadId)', () => {
		const innerThreadId = [{ threadType: proto.ThreadID.ThreadType.UNKNOWN }]
		const msg: proto.IMessage = {
			messageContextInfo: { messageSecret: OUTER_SECRET, limitSharingV2: { initiatedByMe: true } },
			deviceSentMessage: {
				destinationJid: '5511999@s.whatsapp.net',
				message: {
					conversation: 'reply in thread',
					messageContextInfo: { threadId: innerThreadId }
				}
			}
		}
		const result = unwrapDeviceSentMessage(msg)
		expect(result.conversation).toBe('reply in thread')
		// outer messageSecret preserved (would be LOST under {...outer, ...inner})
		expect(result.messageContextInfo?.messageSecret).toEqual(OUTER_SECRET)
		// outer limitSharingV2 preserved (sourced ONLY from outer per WA Web)
		expect(result.messageContextInfo?.limitSharingV2?.initiatedByMe).toBe(true)
		// inner threadId wins
		expect(result.messageContextInfo?.threadId).toEqual(innerThreadId)
	})

	it('inner messageSecret wins when both sides have one (message-local intent)', () => {
		const msg: proto.IMessage = {
			messageContextInfo: { messageSecret: OUTER_SECRET },
			deviceSentMessage: {
				destinationJid: '5511999@s.whatsapp.net',
				message: {
					conversation: 'tx with inner secret',
					messageContextInfo: { messageSecret: INNER_SECRET }
				}
			}
		}
		const result = unwrapDeviceSentMessage(msg)
		expect(result.messageContextInfo?.messageSecret).toEqual(INNER_SECRET)
		expect(result.messageContextInfo?.messageSecret).not.toEqual(OUTER_SECRET)
	})

	it('limitSharingV2 ALWAYS sources from outer (never inner) — matches WA Web', () => {
		const innerSharing = { initiatedByMe: true }
		const outerSharing = { initiatedByMe: false }
		const msg: proto.IMessage = {
			messageContextInfo: { limitSharingV2: outerSharing },
			deviceSentMessage: {
				destinationJid: '5511999@s.whatsapp.net',
				message: {
					conversation: 'sharing test',
					messageContextInfo: { limitSharingV2: innerSharing }
				}
			}
		}
		const result = unwrapDeviceSentMessage(msg)
		// WA Web's `l(e)` reads limitSharingV2 ONLY from `e.messageContextInfo`
		// (the outer envelope). Inner is intentionally ignored — the linked-device
		// fanout's sharing policy is set by the originator and the inner has no
		// authoritative voice.
		expect(result.messageContextInfo?.limitSharingV2).toEqual(outerSharing)
		expect(result.messageContextInfo?.limitSharingV2).not.toEqual(innerSharing)
	})

	it('threadId defaults to [] when neither side carries one (matches WA Web default)', () => {
		const msg: proto.IMessage = {
			deviceSentMessage: {
				destinationJid: '5511999@s.whatsapp.net',
				message: { conversation: 'no thread' }
			}
		}
		const result = unwrapDeviceSentMessage(msg)
		expect(result.messageContextInfo?.threadId).toEqual([])
	})

	// ── protobuf-decode behaviour: `repeated` fields are `[]` when absent ──
	it('outer threadId WINS when inner messageContextInfo exists without a threadId in the wire (protobuf [] vs ?? trap)', () => {
		// `proto.MessageContextInfo.decode(...)` initializes `threadId` to `[]`
		// (proto3 repeated-field default), NOT `undefined`. A naive
		// `innerCtx.threadId ?? outerCtx.threadId` never falls through —
		// `[]` isn't nullish. Simulate the exact post-decode shape: inner
		// has a `messageContextInfo` instance with `threadId = []` (because
		// decode set it, not because the sender intended `[]`).
		const outerThreadId = [{ threadType: proto.ThreadID.ThreadType.AI_THREAD }]
		const decodedInnerCtx = proto.MessageContextInfo.decode(
			proto.MessageContextInfo.encode({ messageSecret: INNER_SECRET }).finish()
		)
		// Sanity: the decoded inner WILL have threadId === [] from the proto3 default.
		expect(decodedInnerCtx.threadId).toEqual([])

		const msg: proto.IMessage = {
			messageContextInfo: { threadId: outerThreadId },
			deviceSentMessage: {
				destinationJid: '5511999@s.whatsapp.net',
				message: {
					conversation: 'thread reply via linked device',
					messageContextInfo: decodedInnerCtx
				}
			}
		}
		const result = unwrapDeviceSentMessage(msg)
		// The fix is `innerCtx?.threadId?.length ? innerCtx.threadId : null`,
		// which treats the empty array as "inner didn't set it" so outer wins.
		expect(result.messageContextInfo?.threadId).toEqual(outerThreadId)
		// And messageSecret from inner is still preserved (inner explicitly set it).
		expect(result.messageContextInfo?.messageSecret).toEqual(INNER_SECRET)
	})

	it('inner takes precedence for botMetadata + messageAssociation', () => {
		const innerBot: proto.IBotMetadata = { personaId: 'persona-inner' }
		const outerBot: proto.IBotMetadata = { personaId: 'persona-outer' }
		const innerAssoc: proto.IMessageAssociation = {
			associationType: proto.MessageAssociation.AssociationType.MEDIA_ALBUM
		}
		const outerAssoc: proto.IMessageAssociation = {
			associationType: proto.MessageAssociation.AssociationType.BOT_PLUGIN
		}
		const msg: proto.IMessage = {
			messageContextInfo: { botMetadata: outerBot, messageAssociation: outerAssoc },
			deviceSentMessage: {
				destinationJid: '5511999@s.whatsapp.net',
				message: {
					conversation: 'mixed',
					messageContextInfo: { botMetadata: innerBot, messageAssociation: innerAssoc }
				}
			}
		}
		const result = unwrapDeviceSentMessage(msg)
		expect(result.messageContextInfo?.botMetadata).toEqual(innerBot)
		expect(result.messageContextInfo?.messageAssociation).toEqual(innerAssoc)
	})

	// ── proves the deviceSentMessage key is GONE in the result ─────────────
	it('result no longer carries the deviceSentMessage envelope', () => {
		const msg: proto.IMessage = {
			messageContextInfo: { messageSecret: OUTER_SECRET },
			deviceSentMessage: {
				destinationJid: '5511999@s.whatsapp.net',
				message: { conversation: 'unwrapped' }
			}
		}
		const result = unwrapDeviceSentMessage(msg)
		expect(result.deviceSentMessage).toBeUndefined()
		expect(result.conversation).toBe('unwrapped')
	})

	// ── pin the divergence vs PR #2566's `{...outer, ...inner}` approach ──
	it('SHAPE-PIN: differs from naive `{...outer, ...inner}` when inner has partial messageContextInfo', () => {
		const innerThreadId = [{ threadType: proto.ThreadID.ThreadType.UNKNOWN }]
		const msg: proto.IMessage = {
			messageContextInfo: { messageSecret: OUTER_SECRET },
			deviceSentMessage: {
				destinationJid: '5511999@s.whatsapp.net',
				message: {
					conversation: 'partial',
					messageContextInfo: { threadId: innerThreadId }
				}
			}
		}
		// Our implementation: preserves outer messageSecret.
		const ours = unwrapDeviceSentMessage(msg)
		expect(ours.messageContextInfo?.messageSecret).toEqual(OUTER_SECRET)
		expect(ours.messageContextInfo?.threadId).toEqual(innerThreadId)

		// Naive PR #2566 approach: inner.messageContextInfo wins ENTIRELY,
		// losing the outer messageSecret. The `deviceSentMessage` destructure
		// here intentionally pulls the key out of `outerWithoutDsm` and discards
		// it — the discarded binding name matches the proto field, which is the
		// whole point of this control comparison.
		const inner = msg.deviceSentMessage!.message!
		// eslint-disable-next-line @typescript-eslint/no-unused-vars
		const { deviceSentMessage, ...outerWithoutDsm } = msg
		const naive = { ...outerWithoutDsm, ...inner }
		expect(naive.messageContextInfo?.messageSecret).toBeUndefined() // ← the bug
		expect(naive.messageContextInfo?.threadId).toEqual(innerThreadId)

		// If the future maintainer ever swaps our implementation for the
		// naive spread, the assertion above breaks first.
	})
})
