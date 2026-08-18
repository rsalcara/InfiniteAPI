/**
 * Regression: the blanket `if (!message.key.fromMe) return` guard added by
 * `1d7549df1f` ("add guard for protocolMessage processing") dropped every
 * inbound protocol message — including legitimate REVOKE / MESSAGE_EDIT /
 * EPHEMERAL_SETTING / GROUP_MEMBER_LABEL_CHANGE messages from other users.
 *
 * The fix narrows the guard to the protocol message types that should only
 * ever originate from our own device, mirroring whatsmeow's
 * `handleProtocolMessage` scope. See
 * https://github.com/tulir/whatsmeow/blob/8d3700152a/message.go#L842-L845
 */
import { EventEmitter } from 'events'
import P from 'pino'
import { proto } from '../../../WAProto/index.js'
import type { AuthenticationCreds, BaileysEventEmitter, WAMessage } from '../../Types'
import { initAuthCreds } from '../../Utils/auth-utils'
import processMessage from '../../Utils/process-message'

const silent = P({ level: 'silent' })

const credsWithMe = (): AuthenticationCreds => ({
	...initAuthCreds(),
	me: { id: 'me@s.whatsapp.net' } as any
})

const makeContext = () => {
	const events = new EventEmitter() as unknown as BaileysEventEmitter
	const updates: any[] = []
	;(events as any).on('messages.update', (upd: any) => updates.push(upd))

	return {
		updates,
		ctx: {
			shouldProcessHistoryMsg: false,
			placeholderResendCache: undefined,
			ev: events,
			creds: credsWithMe(),
			keyStore: {} as any,
			signalRepository: {} as any,
			logger: silent,
			options: {},
			getMessage: async () => undefined
		}
	}
}

const protocolMessage = (
	type: proto.Message.ProtocolMessage.Type,
	extra: Partial<proto.Message.IProtocolMessage> = {}
): proto.IMessage => ({
	protocolMessage: {
		type,
		key: { id: 'target-msg-id', remoteJid: 'chat@s.whatsapp.net', fromMe: false },
		...extra
	}
})

const inbound = (id: string, fromMe: boolean, message: proto.IMessage): WAMessage => ({
	key: {
		remoteJid: 'chat@s.whatsapp.net',
		fromMe,
		id,
		participant: 'sender@s.whatsapp.net'
	},
	message,
	messageTimestamp: 1675888000
})

describe('processMessage — protocolMessage guard (regression for blanket fromMe drop)', () => {
	it('processes inbound REVOKE from a non-self sender (emits messages.update) when the target message is known', async () => {
		const { ctx, updates } = makeContext()
		// getMessage finding the target is what gates the emit (see
		// process-message.orphan-queue.test.ts for the "target not found yet" case)
		ctx.getMessage = async () => ({ conversation: 'target' }) as any
		const msg = inbound('msg-1', false, protocolMessage(proto.Message.ProtocolMessage.Type.REVOKE))

		await processMessage(msg, ctx as any)

		expect(updates).toHaveLength(1)
		expect(updates[0][0].update.messageStubType).toBeDefined()
	})

	it('processes inbound MESSAGE_EDIT from a non-self sender (emits messages.update)', async () => {
		const { ctx, updates } = makeContext()
		const editedMessage = { conversation: 'edited' } as proto.IMessage
		const msg = inbound(
			'msg-2',
			false,
			protocolMessage(proto.Message.ProtocolMessage.Type.MESSAGE_EDIT, { editedMessage })
		)

		await processMessage(msg, ctx as any)

		expect(updates).toHaveLength(1)
		expect(updates[0][0].update.message?.editedMessage).toBeDefined()
	})

	it('drops a spoofed HISTORY_SYNC_NOTIFICATION from a non-self sender', async () => {
		const { ctx } = makeContext()
		const msg = inbound(
			'msg-3',
			false,
			protocolMessage(proto.Message.ProtocolMessage.Type.HISTORY_SYNC_NOTIFICATION, {
				historySyncNotification: {} as any
			})
		)

		// Should NOT throw / NOT process the history sync. processedHistoryMessages stays empty.
		const credsBefore = ctx.creds.processedHistoryMessages?.length ?? 0
		await processMessage(msg, ctx as any)
		expect(ctx.creds.processedHistoryMessages?.length ?? 0).toBe(credsBefore)
	})

	it('drops a spoofed APP_STATE_SYNC_KEY_SHARE from a non-self sender', async () => {
		const events = new EventEmitter() as unknown as BaileysEventEmitter
		const credUpdates: any[] = []
		;(events as any).on('creds.update', (u: any) => credUpdates.push(u))

		const ctx = {
			shouldProcessHistoryMsg: false,
			placeholderResendCache: undefined,
			ev: events,
			creds: credsWithMe(),
			keyStore: { set: async () => {}, get: async () => ({}), transaction: async (w: any) => w() } as any,
			signalRepository: {} as any,
			logger: silent,
			options: {},
			getMessage: async () => undefined
		}

		const msg = inbound(
			'msg-4',
			false,
			protocolMessage(proto.Message.ProtocolMessage.Type.APP_STATE_SYNC_KEY_SHARE, {
				appStateSyncKeyShare: { keys: [] } as any
			})
		)

		await processMessage(msg, ctx as any)

		// No creds.update fired — the spoofed key share was rejected.
		expect(credUpdates.filter(u => u.myAppStateKeyId !== undefined)).toHaveLength(0)
	})

	it('routes type 39 once through the durable lifecycle handler', async () => {
		const { ctx } = makeContext()
		let handled = 0
		;(ctx as any).onAppStateSyncKeyRequest = async () => {
			handled++
		}

		const msg: WAMessage = {
			key: {
				remoteJid: 'me@s.whatsapp.net',
				participant: 'me:2@s.whatsapp.net',
				fromMe: true,
				id: 'request-39'
			},
			message: protocolMessage(proto.Message.ProtocolMessage.Type.APP_STATE_SYNC_KEY_REQUEST, {
				appStateSyncKeyRequest: { keyIds: [{ keyId: Buffer.from('AAAAAEGV', 'base64') }] }
			}),
			messageTimestamp: 1675888000
		}

		await processMessage(msg, ctx as any)
		expect(handled).toBe(1)
	})

	it('routes type 38 once without also writing the legacy peer-message mirror', async () => {
		const events = new EventEmitter() as unknown as BaileysEventEmitter
		const credUpdates: any[] = []
		;(events as any).on('creds.update', (update: any) => credUpdates.push(update))
		let handled = 0
		let legacyKeyWrites = 0
		let legacyMirrorWrites = 0
		const ctx = {
			shouldProcessHistoryMsg: false,
			placeholderResendCache: undefined,
			ev: events,
			creds: credsWithMe(),
			keyStore: {
				set: async () => {
					legacyKeyWrites++
				},
				get: async () => ({}),
				transaction: async (work: () => Promise<void>) => work()
			},
			signalRepository: {},
			logger: silent,
			options: {},
			getMessage: async () => undefined,
			appStateBackend: {
				recordPeerMessage: () => {
					legacyMirrorWrites++
					return 1
				},
				ackPeerMessage: () => {}
			},
			onAppStateSyncKeyShare: async () => {
				handled++
				return 'AAAAAEGV'
			}
		}
		const msg: WAMessage = {
			key: {
				remoteJid: 'me@s.whatsapp.net',
				participant: 'me:2@s.whatsapp.net',
				fromMe: true,
				id: 'share-38'
			},
			message: protocolMessage(proto.Message.ProtocolMessage.Type.APP_STATE_SYNC_KEY_SHARE, {
				appStateSyncKeyShare: {
					keys: [{ keyId: { keyId: Buffer.from('AAAAAEGV', 'base64') } }]
				}
			}),
			messageTimestamp: 1675888000
		}

		await processMessage(msg, ctx as any)
		expect(handled).toBe(1)
		expect(legacyKeyWrites).toBe(0)
		expect(legacyMirrorWrites).toBe(0)
		expect(credUpdates).toEqual([{ myAppStateKeyId: 'AAAAAEGV' }])
	})
})

// ─── GROUP_MEMBER_LABEL_CHANGE — assignment + removal ──────────────────────
//
// Regression cover for upstream PR #2609 port: `group.member-tag.update`
// must fire for both assignment AND removal patches. The previous guard
// (`if (labelAssociationMsg?.label)`) silently swallowed removals because
// removal arrives as a `memberLabel` patch with NO populated label
// — matching WA Web `WAWebHandleMemberLabelChange`'s
// `var f = (n = a.label) != null ? n : "";` (live source verified via CDP).
describe('processMessage — GROUP_MEMBER_LABEL_CHANGE event emission', () => {
	const makeGroupCtx = () => {
		const events = new EventEmitter() as unknown as BaileysEventEmitter
		const tagUpdates: any[] = []
		;(events as any).on('group.member-tag.update', (upd: any) => tagUpdates.push(upd))

		return {
			tagUpdates,
			ctx: {
				shouldProcessHistoryMsg: false,
				placeholderResendCache: undefined,
				ev: events,
				creds: credsWithMe(),
				keyStore: {} as any,
				signalRepository: {} as any,
				logger: silent,
				options: {},
				getMessage: async () => undefined
			}
		}
	}

	const groupInbound = (id: string, message: proto.IMessage): WAMessage => ({
		key: {
			remoteJid: '120363000000000000@g.us',
			fromMe: false,
			id,
			participant: 'admin@s.whatsapp.net',
			participantAlt: 'admin@lid'
		},
		message,
		messageTimestamp: 1770000000
	})

	it('emits group.member-tag.update when a label is assigned', async () => {
		const { ctx, tagUpdates } = makeGroupCtx()
		const msg = groupInbound(
			'lbl-set',
			protocolMessage(proto.Message.ProtocolMessage.Type.GROUP_MEMBER_LABEL_CHANGE, {
				memberLabel: { label: 'moderator', labelTimestamp: 1770000000 } as any
			})
		)

		await processMessage(msg, ctx as any)

		expect(tagUpdates).toHaveLength(1)
		expect(tagUpdates[0]).toEqual({
			groupId: '120363000000000000@g.us',
			label: 'moderator',
			participant: 'admin@s.whatsapp.net',
			participantAlt: 'admin@lid',
			messageTimestamp: 1770000000
		})
	})

	it('emits group.member-tag.update with empty label when label is REMOVED (no label field)', async () => {
		const { ctx, tagUpdates } = makeGroupCtx()
		const msg = groupInbound(
			'lbl-removed',
			protocolMessage(proto.Message.ProtocolMessage.Type.GROUP_MEMBER_LABEL_CHANGE, {
				// removal arrives as memberLabel patch WITHOUT label populated —
				// previously silently swallowed by the `if (labelAssociationMsg?.label)` guard
				memberLabel: { labelTimestamp: 1770000000 } as any
			})
		)

		await processMessage(msg, ctx as any)

		expect(tagUpdates).toHaveLength(1)
		expect(tagUpdates[0]).toEqual({
			groupId: '120363000000000000@g.us',
			label: '',
			participant: 'admin@s.whatsapp.net',
			participantAlt: 'admin@lid',
			messageTimestamp: 1770000000
		})
	})

	it('emits group.member-tag.update with empty label when label is the empty string', async () => {
		const { ctx, tagUpdates } = makeGroupCtx()
		const msg = groupInbound(
			'lbl-empty',
			protocolMessage(proto.Message.ProtocolMessage.Type.GROUP_MEMBER_LABEL_CHANGE, {
				memberLabel: { label: '', labelTimestamp: 1770000000 } as any
			})
		)

		await processMessage(msg, ctx as any)

		expect(tagUpdates).toHaveLength(1)
		expect(tagUpdates[0].label).toBe('')
	})

	it('does NOT emit when memberLabel patch is entirely absent', async () => {
		const { ctx, tagUpdates } = makeGroupCtx()
		const msg = groupInbound(
			'lbl-noop',
			protocolMessage(proto.Message.ProtocolMessage.Type.GROUP_MEMBER_LABEL_CHANGE, {
				// no memberLabel field at all → no event
			})
		)

		await processMessage(msg, ctx as any)

		expect(tagUpdates).toHaveLength(0)
	})
})
