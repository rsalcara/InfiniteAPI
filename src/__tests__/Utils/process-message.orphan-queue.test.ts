/**
 * Regression: REVOKE and event-response used to be dropped (or, for REVOKE,
 * fired uselessly with nothing to update) when their target/parent message
 * hadn't been seen locally yet — a real out-of-order scenario during history
 * sync / offline catch-up. Confirmed against WhatsApp's own "orphan" holding
 * pen pattern (message_orphan/status_orphan on Android; message-orphans/
 * orphan-revoke on Web — see the wa-14-databases-parity investigation).
 *
 * Fix: queue the dependent via OrphanQueue when getMessage() can't find the
 * parent, and replay it once the parent is actually processed.
 */
import { EventEmitter } from 'events'
import { jest } from '@jest/globals'
import P from 'pino'
import { proto } from '../../../WAProto/index.js'
import type { AuthenticationCreds, BaileysEventEmitter, WAMessage } from '../../Types'
import { initAuthCreds } from '../../Utils/auth-utils'
import { OrphanQueue } from '../../Utils/orphan-queue'
import processMessage from '../../Utils/process-message'

const silent = P({ level: 'silent' })

const credsWithMe = (): AuthenticationCreds => ({
	...initAuthCreds(),
	me: { id: 'me@s.whatsapp.net' } as any
})

const makeContext = (getMessage: () => Promise<any>) => {
	const events = new EventEmitter() as unknown as BaileysEventEmitter
	const updates: any[] = []
	;(events as any).on('messages.update', (upd: any) => updates.push(upd))

	return {
		updates,
		orphanQueue: new OrphanQueue(silent),
		ctx: {
			shouldProcessHistoryMsg: false,
			placeholderResendCache: undefined,
			ev: events,
			creds: credsWithMe(),
			keyStore: {} as any,
			signalRepository: { lidMapping: { getPNForLID: async (jid: string) => jid } } as any,
			logger: silent,
			options: {},
			getMessage
		}
	}
}

const inbound = (id: string, message: proto.IMessage): WAMessage => ({
	key: { remoteJid: 'chat@s.whatsapp.net', fromMe: false, id, participant: 'sender@s.whatsapp.net' },
	message,
	messageTimestamp: 1770000000
})

describe('processMessage — orphan queue (REVOKE)', () => {
	it('does NOT emit messages.update when the revoke target is not found, and queues it instead', async () => {
		const { ctx, updates, orphanQueue } = makeContext(async () => undefined)
		const targetKey = { id: 'target-1', remoteJid: 'chat@s.whatsapp.net', fromMe: false }
		const revokeMsg = inbound('revoke-1', {
			protocolMessage: { type: proto.Message.ProtocolMessage.Type.REVOKE, key: targetKey }
		})

		await processMessage(revokeMsg, { ...ctx, orphanQueue } as any)

		expect(updates).toHaveLength(0)
		expect(orphanQueue.drain(targetKey)).toHaveLength(1)
	})

	it('replays the queued revoke once the target message is processed', async () => {
		const { ctx, updates, orphanQueue } = makeContext(async () => undefined)
		const targetKey = { id: 'target-2', remoteJid: 'chat@s.whatsapp.net', fromMe: false }
		const revokeMsg = inbound('revoke-2', {
			protocolMessage: { type: proto.Message.ProtocolMessage.Type.REVOKE, key: targetKey }
		})

		// 1) revoke arrives first — target unknown, gets queued
		await processMessage(revokeMsg, { ...ctx, orphanQueue } as any)
		expect(updates).toHaveLength(0)

		// 2) the target message itself arrives afterward (real content, matches key.id)
		const targetMsg: WAMessage = {
			key: targetKey,
			message: { conversation: 'the original message' },
			messageTimestamp: 1770000001
		}
		await processMessage(targetMsg, { ...ctx, orphanQueue } as any)

		// the queued revoke is replayed against the now-known target
		expect(updates).toHaveLength(1)
		expect(updates[0][0].key.id).toBe('target-2')
		expect(updates[0][0].update.messageStubType).toBeDefined()
		expect(updates[0][0].update.message).toBeNull()

		// and it's gone from the queue — a third unrelated real message doesn't replay it again
		expect(orphanQueue.drain(targetKey)).toHaveLength(0)
	})

	it('emits immediately (no queueing) when the revoke target is already known', async () => {
		const { ctx, updates, orphanQueue } = makeContext(async () => ({ conversation: 'known' }) as any)
		const targetKey = { id: 'target-3', remoteJid: 'chat@s.whatsapp.net', fromMe: false }
		const revokeMsg = inbound('revoke-3', {
			protocolMessage: { type: proto.Message.ProtocolMessage.Type.REVOKE, key: targetKey }
		})

		await processMessage(revokeMsg, { ...ctx, orphanQueue } as any)

		expect(updates).toHaveLength(1)
		expect(orphanQueue.drain(targetKey)).toHaveLength(0) // nothing was ever queued
	})

	it('without an orphanQueue configured, falls back to dropping (today\'s pre-fix behavior)', async () => {
		const { ctx, updates } = makeContext(async () => undefined)
		const targetKey = { id: 'target-4', remoteJid: 'chat@s.whatsapp.net', fromMe: false }
		const revokeMsg = inbound('revoke-4', {
			protocolMessage: { type: proto.Message.ProtocolMessage.Type.REVOKE, key: targetKey }
		})

		await processMessage(revokeMsg, { ...ctx, orphanQueue: undefined } as any)

		expect(updates).toHaveLength(0)
	})
})

describe('processMessage — orphan queue (event-response)', () => {
	it('queues an event-response when the event-creation message is not found yet', async () => {
		const { ctx, updates, orphanQueue } = makeContext(async () => undefined)
		const creationKey = { id: 'event-1', remoteJid: 'chat@s.whatsapp.net', fromMe: false }
		const responseMsg = inbound('resp-1', {
			encEventResponseMessage: {
				eventCreationMessageKey: creationKey,
				encPayload: Buffer.from('x'),
				encIv: Buffer.from('x')
			}
		})

		await processMessage(responseMsg, { ...ctx, orphanQueue } as any)

		expect(updates).toHaveLength(0)
		const drained = orphanQueue.drain(creationKey)
		expect(drained).toHaveLength(1)
		expect(drained[0]!.kind).toBe('event-response')
	})

	it('attempts replay once the event-creation message is processed (no longer silently dropped)', async () => {
		const { ctx, orphanQueue } = makeContext(async () => undefined)
		const creationKey = { id: 'event-2', remoteJid: 'chat@s.whatsapp.net', fromMe: false }
		const responseMsg = inbound('resp-2', {
			encEventResponseMessage: {
				eventCreationMessageKey: creationKey,
				encPayload: Buffer.from('x'),
				encIv: Buffer.from('x')
			}
		})

		await processMessage(responseMsg, { ...ctx, orphanQueue } as any)
		expect(orphanQueue.drain(creationKey)).toHaveLength(1) // queued by the call above; drain() also removes it
		orphanQueue.enqueue(creationKey, 'event-response', responseMsg) // put it back to exercise the replay path below

		const warnSpy = jest.spyOn(ctx.logger, 'warn')
		const creationMsg: WAMessage = {
			key: creationKey,
			message: { conversation: 'the event', messageContextInfo: { messageSecret: Buffer.from('secret-32-bytes-padding-abcdefg') } },
			messageTimestamp: 1770000002
		}
		await processMessage(creationMsg, { ...ctx, orphanQueue } as any)

		// Replay was attempted (decryption fails on this fabricated ciphertext, which
		// is expected — the point is it's no longer silently dropped as "not found").
		expect(warnSpy).not.toHaveBeenCalledWith(
			expect.objectContaining({ creationMsgKey: creationKey }),
			'event creation message not found, cannot decrypt response'
		)
		expect(orphanQueue.drain(creationKey)).toHaveLength(0)
	})
})
