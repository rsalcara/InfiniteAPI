/**
 * Backend smoke tests for the remaining components:
 *
 *   - `MsgRetryCounterSqliteAdapter` — retry counter persistence with TTL
 *   - `MessageQuarantineBackend` — quarantine row inserts + upsert-on-retry
 *   - `TrustedContactsBackend` — incoming + outbound TC token state
 *   - `AppStateBackend` — collection_versions + syncd_mutations
 *   - `LocationBackend` — location_cache + location_sharer
 *   - `ChatSettingsBackend` — mute_end + pinned/pinned_time
 *
 * One file covers all four since they share setup/teardown (a single
 * MultiDbSqliteStore handle).
 */
import { jest } from '@jest/globals'
import { mkdtemp, rm } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import {
	AppStateBackend,
	ChatSettingsBackend,
	LocationBackend,
	MessageQuarantineBackend,
	MsgRetryCounterSqliteAdapter,
	MultiDbSqliteStore,
	PEER_MESSAGE_TYPE_APP_STATE_SYNC_KEY_SHARE,
	StatusBackend,
	StickersBackend,
	TrustedContactsBackend
} from '../../Utils/multi-db-sqlite'
import { STATUS_BACKFILL_LAST_TIMESTAMP_SQL } from '../../Utils/multi-db-sqlite/store'

describe('backends', () => {
	let dir: string
	let store: MultiDbSqliteStore

	beforeEach(async () => {
		dir = await mkdtemp(join(tmpdir(), 'multi-db-backends-test-'))
		store = new MultiDbSqliteStore({ sessionDir: dir })
		await store.open()
	})

	afterEach(async () => {
		store.close()
		await rm(dir, { recursive: true, force: true })
	})

	describe('MsgRetryCounterSqliteAdapter', () => {
		it('round-trips a retry counter with TTL', () => {
			const adapter = new MsgRetryCounterSqliteAdapter(store.handle('msgstore.db'), {
				defaultTtlSeconds: 5
			})
			adapter.set('key-1', 1)
			adapter.set('key-2', 3)

			expect(adapter.get<number>('key-1')).toBe(1)
			expect(adapter.get<number>('key-2')).toBe(3)
			expect(adapter.get<number>('missing')).toBeUndefined()

			adapter.set('key-1', 2)
			expect(adapter.get<number>('key-1')).toBe(2)

			expect(adapter.del(['key-1', 'key-2'])).toBe(2)
			expect(adapter.get('key-1')).toBeUndefined()
		})
	})

	describe('MessageQuarantineBackend', () => {
		it('quarantines a stanza and increments retry_count on duplicate', () => {
			const backend = new MessageQuarantineBackend(store.handle('msgstore.db'))
			const first = backend.quarantine({
				keyId: 'msg-1',
				fromMe: false,
				chatRowId: 42,
				senderJidRowId: 7,
				originalProtobuf: Buffer.from([1, 2, 3]),
				serializedStanza: Buffer.from([9, 8, 7]),
				failureReason: 'Bad MAC'
			})
			expect(first.retryCount).toBe(1)

			const second = backend.quarantine({
				keyId: 'msg-1',
				fromMe: false,
				chatRowId: 42,
				senderJidRowId: 7,
				failureReason: 'Bad MAC again'
			})
			expect(second.retryCount).toBe(2)
			expect(second.id).toBe(first.id)
		})

		it('lists rows by chat and supports dismiss / prune', () => {
			const backend = new MessageQuarantineBackend(store.handle('msgstore.db'))
			const ts = Date.now()
			backend.quarantine({ keyId: 'a', fromMe: false, chatRowId: 1, senderJidRowId: 100, quarantinedAt: ts - 1000 })
			backend.quarantine({ keyId: 'b', fromMe: false, chatRowId: 1, senderJidRowId: 100, quarantinedAt: ts })
			backend.quarantine({ keyId: 'c', fromMe: false, chatRowId: 2, senderJidRowId: 200, quarantinedAt: ts })

			expect(backend.listByChat(1)).toHaveLength(2)
			expect(backend.listSince(ts)).toHaveLength(2) // b + c
			expect(backend.dismiss('a', false, 1, 100)).toBe(true)
			expect(backend.dismiss('does-not-exist', false, 1, 100)).toBe(false)
			expect(backend.listByChat(1)).toHaveLength(1)

			const pruned = backend.pruneOlderThan(ts) // removes only rows STRICTLY older than ts
			expect(pruned).toBe(0) // 'a' was dismissed; 'b' and 'c' are exactly ts, not older
		})
	})

	describe('TrustedContactsBackend', () => {
		it('round-trips incoming + outbound TC token state', () => {
			const backend = new TrustedContactsBackend(store.handle('wa.db'))
			const jid = '5515991426667@s.whatsapp.net'
			backend.setIncoming(jid, Buffer.from([1, 2, 3, 4]), 1_000)
			backend.setSent(jid, 2_000, 3_000)

			const inc = backend.getIncoming(jid)
			expect(inc?.timestamp).toBe(1_000)
			expect(Buffer.from(inc!.token).toString('hex')).toBe('01020304')

			const sent = backend.getSent(jid)
			expect(sent).toEqual({ sentTimestamp: 2_000, realIssueTimestamp: 3_000 })

			const stats = backend.stats()
			expect(stats).toEqual({ incomingCount: 1, sentCount: 1 })

			expect(backend.deleteIncoming(jid)).toBe(true)
			expect(backend.deleteSent(jid)).toBe(true)
			expect(backend.stats()).toEqual({ incomingCount: 0, sentCount: 0 })
		})
	})

	describe('AppStateBackend', () => {
		it('persists collection_versions + mutations and lists since version', () => {
			const backend = new AppStateBackend(store.handle('sync.db'))
			backend.setCollectionVersion({
				collectionName: 'regular',
				version: 5,
				ltHash: Buffer.from([0xab, 0xcd]),
				dirtyVersion: -1
			})
			expect(backend.getCollectionVersion('regular')?.version).toBe(5)

			backend.setCollectionVersion({ collectionName: 'critical_block', version: 1, dirtyVersion: -1 })
			expect(backend.listCollectionVersions()).toHaveLength(2)

			backend.insertMutation({
				mutationIndex: 'idx-1',
				mutationValue: Buffer.from([0]),
				mutationVersion: 1,
				collectionName: 'regular',
				areDependenciesMissing: 0,
				deviceId: 0,
				epoch: 0
			})
			backend.insertMutation({
				mutationIndex: 'idx-2',
				mutationValue: Buffer.from([1]),
				mutationVersion: 2,
				collectionName: 'regular',
				areDependenciesMissing: 0,
				deviceId: 0,
				epoch: 0
			})

			const all = backend.listMutations('regular')
			expect(all).toHaveLength(2)

			const since1 = backend.listMutationsSince('regular', 1)
			expect(since1).toHaveLength(1)
			expect(since1[0]?.mutationVersion).toBe(2)

			expect(backend.clearCollection('regular')).toBe(2)
			expect(backend.listMutations('regular')).toHaveLength(0)
		})

		it('never lets a delayed collection-version mirror move the high-water mark backward', () => {
			const backend = new AppStateBackend(store.handle('sync.db'))
			backend.setCollectionVersion({
				collectionName: 'regular',
				version: 8,
				ltHash: Buffer.from([0x08]),
				dirtyVersion: -1
			})
			backend.setCollectionVersion({
				collectionName: 'regular',
				version: 7,
				ltHash: Buffer.from([0x07]),
				dirtyVersion: -1
			})

			const row = backend.getCollectionVersion('regular')
			expect(row?.version).toBe(8)
			expect(row?.ltHash).toEqual(Buffer.from([0x08]))
		})

		it('insertMutation upserts on a repeated mutation_index instead of throwing (real schema has it UNIQUE)', () => {
			const backend = new AppStateBackend(store.handle('sync.db'))
			backend.insertMutation({
				mutationIndex: 'mute chat@s.whatsapp.net',
				mutationValue: Buffer.from([1]),
				mutationVersion: 1,
				collectionName: 'regular_high',
				areDependenciesMissing: 0,
				deviceId: 0,
				epoch: 0,
				mutationName: 'mute',
				chatJid: 'chat@s.whatsapp.net'
			})
			// Same index, e.g. the chat gets unmuted later — must replace, not throw.
			expect(() =>
				backend.insertMutation({
					mutationIndex: 'mute chat@s.whatsapp.net',
					mutationValue: Buffer.from([0]),
					mutationVersion: 2,
					collectionName: 'regular_high',
					areDependenciesMissing: 0,
					deviceId: 0,
					epoch: 0,
					mutationName: 'mute',
					chatJid: 'chat@s.whatsapp.net'
				})
			).not.toThrow()

			const rows = backend.listMutations('regular_high')
			expect(rows).toHaveLength(1)
			expect(rows[0]?.mutationVersion).toBe(2)
			expect(rows[0]?.mutationValue).toEqual(Buffer.from([0]))
		})

		it('round-trips peer_messages through the insert → ack → delete lifecycle', () => {
			const backend = new AppStateBackend(store.handle('sync.db'))
			const id = backend.recordPeerMessage({
				messageType: PEER_MESSAGE_TYPE_APP_STATE_SYNC_KEY_SHARE,
				keyRemoteJid: '5515981907008@s.whatsapp.net',
				keyFromMe: 1,
				keyId: '3EB0-TEST',
				deviceId: '5515981907008.0:0@s.whatsapp.net',
				timestamp: 1_700_000_000,
				data: JSON.stringify({ appStateSyncKeyShareProtoString: 'Ckc=', isNewlyGeneratedKey: true }),
				acked: 0
			})

			let unacked = backend.listUnackedPeerMessages()
			expect(unacked).toHaveLength(1)
			expect(unacked[0]).toMatchObject({
				id,
				messageType: PEER_MESSAGE_TYPE_APP_STATE_SYNC_KEY_SHARE,
				keyRemoteJid: '5515981907008@s.whatsapp.net',
				keyFromMe: 1,
				acked: 0
			})

			backend.ackPeerMessage(id)
			unacked = backend.listUnackedPeerMessages()
			expect(unacked).toHaveLength(0)

			backend.deletePeerMessage(id)
		})
	})

	describe('LocationBackend', () => {
		it('upserts location_cache — one row per jid, newest report wins', () => {
			const backend = new LocationBackend(store.handle('location.db'), {
				pruneIntervalMs: Number.MAX_SAFE_INTEGER
			})
			backend.upsertLocationCache({
				jid: '5515991426667@s.whatsapp.net',
				latitude: -23.55,
				longitude: -46.63,
				accuracy: 10,
				speed: 0,
				bearing: 0,
				locationTs: 1_000
			})
			backend.upsertLocationCache({
				jid: '5515991426667@s.whatsapp.net',
				latitude: -23.56,
				longitude: -46.64,
				accuracy: 5,
				speed: 1.2,
				bearing: 90,
				locationTs: 2_000
			})

			const row = backend.getLocationCache('5515991426667@s.whatsapp.net')
			expect(row).toMatchObject({ latitude: -23.56, longitude: -46.64, locationTs: 2_000 })
		})

		it('keeps the first location received for an equal second-resolution timestamp', () => {
			const backend = new LocationBackend(store.handle('location.db'), {
				pruneIntervalMs: Number.MAX_SAFE_INTEGER
			})
			const base = { jid: 'equal@s.whatsapp.net', accuracy: 5, speed: 0, bearing: 0, locationTs: 2_000 }
			backend.upsertLocationCache({ ...base, latitude: -23.55, longitude: -46.63 })
			backend.upsertLocationCache({ ...base, latitude: 0, longitude: 0 })

			expect(backend.getLocationCache(base.jid)).toMatchObject({ latitude: -23.55, longitude: -46.63 })
		})

		it('upserts location_sharer keyed by (remote_jid, from_me, remote_resource, message_id)', () => {
			const backend = new LocationBackend(store.handle('location.db'), {
				pruneIntervalMs: Number.MAX_SAFE_INTEGER
			})
			backend.upsertLocationSharer({
				remoteJid: 'chat@s.whatsapp.net',
				fromMe: 0,
				remoteResource: '',
				expires: 0,
				messageId: 'live-loc-1'
			})
			expect(backend.listLocationSharers()).toHaveLength(1)

			// same key resyncs (e.g. a later liveLocationMessage update) — must upsert, not duplicate.
			backend.upsertLocationSharer({
				remoteJid: 'chat@s.whatsapp.net',
				fromMe: 0,
				remoteResource: '',
				expires: 0,
				messageId: 'live-loc-1'
			})
			expect(backend.listLocationSharers()).toHaveLength(1)

			expect(backend.endLocationSharer('chat@s.whatsapp.net', 0, '', 'live-loc-1')).toBe(true)
			expect(backend.listLocationSharers()).toHaveLength(0)
		})

		it('SENT share (from_me=1) carries a real expires; RECEIVED (from_me=0) stays 0', () => {
			// The send/receive asymmetry is the crux of this feature: a companion never
			// gets the peer's duration on the wire (received → expires 0), but WE
			// choose the duration when originating a share (sent → real expires).
			// Units are UNIX SECONDS on both paths (receive uses messageTimestamp;
			// send uses unixTimestampSeconds), and 1:1 remote_resource is ''.
			const backend = new LocationBackend(store.handle('location.db'), {
				pruneIntervalMs: Number.MAX_SAFE_INTEGER
			})
			const nowSecs = 1_700_000_000 // seconds, as production writes
			backend.upsertLocationSharer({
				remoteJid: 'peer@s.whatsapp.net',
				fromMe: 0,
				remoteResource: '',
				expires: 0,
				messageId: 'rx-1'
			})
			backend.upsertLocationSharer({
				remoteJid: 'peer@s.whatsapp.net',
				fromMe: 1,
				remoteResource: '',
				expires: nowSecs + 900, // now + 15min, in seconds
				messageId: 'tx-1'
			})

			const sharers = backend.listLocationSharers()
			expect(sharers).toHaveLength(2)
			expect(sharers.find(s => s.fromMe === 1)?.expires).toBe(nowSecs + 900)
			expect(sharers.find(s => s.fromMe === 0)?.expires).toBe(0)
		})

		it('re-upsert with expires=0 (own-event replay) does NOT wipe a real expires', () => {
			// emitOwnEvents replays a SENT liveLocationMessage through the receive
			// mirror, which re-upserts the SAME key with expires=0. That must not
			// erase the duration written by the send path.
			const backend = new LocationBackend(store.handle('location.db'), {
				pruneIntervalMs: Number.MAX_SAFE_INTEGER
			})
			const nowSecs = 1_700_000_000
			const key = { remoteJid: 'peer@s.whatsapp.net', fromMe: 1 as const, remoteResource: '', messageId: 'tx-1' }
			backend.upsertLocationSharer({ ...key, expires: nowSecs + 3600 })
			// replay: same key, expires=0 (receive path always writes 0)
			backend.upsertLocationSharer({ ...key, expires: 0 })
			expect(backend.getLocationSharer(key.remoteJid, 1, '', 'tx-1')?.expires).toBe(nowSecs + 3600)
			// but a real new expires (e.g. a later explicit send) still updates
			backend.upsertLocationSharer({ ...key, expires: nowSecs + 7200 })
			expect(backend.getLocationSharer(key.remoteJid, 1, '', 'tx-1')?.expires).toBe(nowSecs + 7200)
		})

		it('listActiveLocationSharers filters out expired shares (expires>0 && <= now)', () => {
			const backend = new LocationBackend(store.handle('location.db'), {
				pruneIntervalMs: Number.MAX_SAFE_INTEGER
			})
			const nowSecs = 1_700_000_000
			backend.upsertLocationSharer({
				remoteJid: 'a@s.whatsapp.net',
				fromMe: 1,
				remoteResource: '',
				expires: nowSecs - 10,
				messageId: 'expired'
			})
			backend.upsertLocationSharer({
				remoteJid: 'b@s.whatsapp.net',
				fromMe: 1,
				remoteResource: '',
				expires: nowSecs + 900,
				messageId: 'active'
			})
			backend.upsertLocationSharer({
				remoteJid: 'c@s.whatsapp.net',
				fromMe: 0,
				remoteResource: '',
				expires: 0,
				messageId: 'open-ended',
				receivedTs: nowSecs // received just now → within the retention window
			})
			backend.upsertLocationSharer({
				remoteJid: 'd@s.whatsapp.net',
				fromMe: 1,
				remoteResource: '',
				expires: 0,
				messageId: 'sent-open-ended'
			})

			expect(backend.listLocationSharers()).toHaveLength(4)
			const active = backend
				.listActiveLocationSharers(nowSecs)
				.map(s => s.messageId)
				.sort()
			expect(active).toEqual(['active', 'open-ended', 'sent-open-ended'])
		})

		it('ages out a RECEIVED share whose last activity is past the retention window (#636)', () => {
			const backend = new LocationBackend(store.handle('location.db'), {
				pruneIntervalMs: Number.MAX_SAFE_INTEGER
			})
			const nowSecs = 1_700_000_000
			const RETENTION = 8 * 60 * 60
			// A received share exactly at the cutoff is no longer active.
			backend.upsertLocationSharer({
				remoteJid: 'stale@s.whatsapp.net',
				fromMe: 0,
				remoteResource: '',
				expires: 0,
				messageId: 'stale',
				receivedTs: nowSecs - RETENTION
			})
			// A received share still within the window (share ongoing).
			backend.upsertLocationSharer({
				remoteJid: 'fresh@s.whatsapp.net',
				fromMe: 0,
				remoteResource: '',
				expires: 0,
				messageId: 'fresh',
				receivedTs: nowSecs - 60
			})
			// Sent/open-ended rows do not use received retention and must survive
			// both the active read and a hard prune even with received_ts=0.
			backend.upsertLocationSharer({
				remoteJid: 'sent@s.whatsapp.net',
				fromMe: 1,
				remoteResource: '',
				expires: 0,
				messageId: 'sent-open-ended'
			})

			// The stale one is filtered from the active read …
			expect(
				backend
					.listActiveLocationSharers(nowSecs)
					.map(s => s.messageId)
					.sort()
			).toEqual(['fresh', 'sent-open-ended'])

			// … and hard-pruned so the table stays bounded.
			expect(backend.pruneStaleReceivedSharers(nowSecs - RETENTION)).toBe(1)
			expect(
				backend
					.listLocationSharers()
					.map(s => s.messageId)
					.sort()
			).toEqual(['fresh', 'sent-open-ended'])
		})

		it('defaults a received share activity timestamp to the current unix time', () => {
			const nowSecs = 1_700_000_000
			const nowSpy = jest.spyOn(Date, 'now').mockReturnValue(nowSecs * 1000)
			try {
				const backend = new LocationBackend(store.handle('location.db'), {
					pruneIntervalMs: Number.MAX_SAFE_INTEGER
				})
				backend.upsertLocationSharer({
					remoteJid: 'received@s.whatsapp.net',
					fromMe: 0,
					remoteResource: '',
					expires: 0,
					messageId: 'received-with-default'
				})

				expect(backend.listActiveLocationSharers(nowSecs).map(s => s.messageId)).toEqual(['received-with-default'])
			} finally {
				nowSpy.mockRestore()
			}
		})

		it('upsertLocationSharer keeps the NEWEST received_ts (out-of-order older update)', () => {
			const backend = new LocationBackend(store.handle('location.db'), {
				pruneIntervalMs: Number.MAX_SAFE_INTEGER
			})
			const key = { remoteJid: 'peer@s.whatsapp.net', fromMe: 0 as const, remoteResource: '', messageId: 'live' }
			backend.upsertLocationSharer({ ...key, expires: 0, receivedTs: 2_000 })
			backend.upsertLocationSharer({ ...key, expires: 0, receivedTs: 1_000 }) // older, out of order
			// received_ts must NOT roll back — the share is still active at t=2500
			// (cutoff far below) via the newest activity.
			expect(backend.listActiveLocationSharers(2_500).map(s => s.receivedTs)).toEqual([2_000])
		})
	})

	describe('ChatSettingsBackend', () => {
		it('lazily creates the row on first setMuteEnd, and setPinned only touches its own columns', () => {
			const backend = new ChatSettingsBackend(store.handle('chatsettings.db'))
			expect(backend.getSettings('chat@s.whatsapp.net')).toBeNull()

			backend.setMuteEnd('chat@s.whatsapp.net', 1_700_000_000)
			expect(backend.getSettings('chat@s.whatsapp.net')).toMatchObject({
				muteEnd: 1_700_000_000,
				pinned: null,
				pinnedTime: null
			})

			// setPinned on the SAME jid must not clobber the mute_end set above.
			backend.setPinned('chat@s.whatsapp.net', true, 1_700_000_500)
			expect(backend.getSettings('chat@s.whatsapp.net')).toMatchObject({
				muteEnd: 1_700_000_000,
				pinned: 1,
				pinnedTime: 1_700_000_500
			})

			// unmute (muteEnd=null) must not clobber the pinned state.
			backend.setMuteEnd('chat@s.whatsapp.net', null)
			expect(backend.getSettings('chat@s.whatsapp.net')).toMatchObject({
				muteEnd: null,
				pinned: 1,
				pinnedTime: 1_700_000_500
			})
		})
	})

	describe('StatusBackend', () => {
		it('creates status_info lazily and increments its aggregate counters per received status', () => {
			// Disable the opportunistic 24h prune: these fixtures use tiny synthetic
			// timestamps that would all be "expired" and swept on the first write.
			const backend = new StatusBackend(store.handle('status.db'), { pruneIntervalMs: Number.MAX_SAFE_INTEGER })
			const sender = '5515991426667@s.whatsapp.net'

			backend.recordReceivedStatus({ senderUserJid: sender, uuid: 'status-1', timestamp: 1_000, textData: 'oi' })
			backend.recordReceivedStatus({ senderUserJid: sender, uuid: 'status-2', timestamp: 2_000 })

			const rows = backend.listStatusesForSender(sender)
			expect(rows).toHaveLength(2)
			expect(rows[0]).toMatchObject({ uuid: 'status-1', sort_id: 1, text_data: 'oi', type: 4, state: 3 })
			expect(rows[1]).toMatchObject({ uuid: 'status-2', sort_id: 2, text_data: null })
			// both rows share the same status_info_row_id (one aggregate per sender)
			expect(rows[0]?.status_info_row_id).toBe(rows[1]?.status_info_row_id)
		})

		it('keeps separate sort_id sequences per sender', () => {
			const backend = new StatusBackend(store.handle('status.db'), { pruneIntervalMs: Number.MAX_SAFE_INTEGER })
			backend.recordReceivedStatus({ senderUserJid: 'a@s.whatsapp.net', uuid: 'a-1', timestamp: 1 })
			backend.recordReceivedStatus({ senderUserJid: 'b@s.whatsapp.net', uuid: 'b-1', timestamp: 1 })
			backend.recordReceivedStatus({ senderUserJid: 'a@s.whatsapp.net', uuid: 'a-2', timestamp: 2 })

			expect(backend.listStatusesForSender('a@s.whatsapp.net').map(r => r.sort_id)).toEqual([1, 2])
			expect(backend.listStatusesForSender('b@s.whatsapp.net').map(r => r.sort_id)).toEqual([1])
		})

		it('does not regress the last-status aggregate when older history arrives later', () => {
			const backend = new StatusBackend(store.handle('status.db'), { pruneIntervalMs: Number.MAX_SAFE_INTEGER })
			const sender = 'history@s.whatsapp.net'
			backend.recordReceivedStatus({ senderUserJid: sender, uuid: 'newer', timestamp: 2_000 })
			backend.recordReceivedStatus({ senderUserJid: sender, uuid: 'older', timestamp: 1_000 })
			const info = store
				.handle('status.db')
				.prepare(
					'SELECT total_count, unread_count, last_status_sort_id, last_status_timestamp FROM status_info WHERE chat_jid = ?'
				)
				.get(sender)
			expect(info).toMatchObject({
				total_count: 2,
				unread_count: 2,
				last_status_sort_id: 1,
				last_status_timestamp: 2_000
			})
		})

		it('recordSeenReceipt resolves status_row_id by uuid and upserts on repeated views', () => {
			const backend = new StatusBackend(store.handle('status.db'), { pruneIntervalMs: Number.MAX_SAFE_INTEGER })
			backend.recordReceivedStatus({ senderUserJid: 'me@s.whatsapp.net', uuid: 'my-status-1', timestamp: 1_000 })

			backend.recordSeenReceipt({
				statusUuid: 'my-status-1',
				receiptUserJid: 'viewer1@s.whatsapp.net',
				seenTimestamp: 5_000,
				receivedTimestamp: 5_100
			})
			// Simulate a row written by the previous implementation, which left
			// received_timestamp NULL. The next upsert repairs it once.
			store
				.handle('status.db')
				.prepare('UPDATE status_seen_receipt SET received_timestamp = NULL WHERE receipt_user_jid = ?')
				.run('viewer1@s.whatsapp.net')
			backend.recordSeenReceipt({
				statusUuid: 'my-status-1',
				receiptUserJid: 'viewer1@s.whatsapp.net',
				seenTimestamp: 6_000,
				receivedTimestamp: 6_100
			})
			backend.recordSeenReceipt({
				statusUuid: 'my-status-1',
				receiptUserJid: 'viewer1@s.whatsapp.net',
				seenTimestamp: 5_500,
				receivedTimestamp: 6_200
			})
			backend.recordSeenReceipt({
				statusUuid: 'my-status-1',
				receiptUserJid: 'viewer2@s.whatsapp.net',
				seenTimestamp: 5_500
			})

			const receipts = backend.listSeenReceiptsForStatus('my-status-1')
			expect(receipts).toHaveLength(2) // viewer1's repeat view upserted, not duplicated
			expect(receipts.find(r => r.receipt_user_jid === 'viewer1@s.whatsapp.net')?.seen_timestamp).toBe(6_000)
			expect(receipts.find(r => r.receipt_user_jid === 'viewer1@s.whatsapp.net')?.received_timestamp).toBe(6_100)
			expect(receipts.find(r => r.receipt_user_jid === 'viewer2@s.whatsapp.net')?.seen_timestamp).toBe(5_500)
			expect(receipts.every(r => typeof r.status_row_id === 'number')).toBe(true)
		})

		it('recordSeenReceipt SKIPS (no null-FK orphan) when the status uuid has no local row', () => {
			const backend = new StatusBackend(store.handle('status.db'))
			// No recordReceivedStatus call for this uuid — mirrors a receipt for
			// a status this gateway never recorded (e.g. the user's own post).
			// It must be skipped, not stored as a null-FK orphan (which would be
			// unretrievable, un-pruned and un-dedupable).
			expect(
				backend.recordSeenReceipt({ statusUuid: 'unknown', receiptUserJid: 'v@s.whatsapp.net', seenTimestamp: 1 })
			).toBe(false)
			// Repeated skips do not accumulate rows.
			backend.recordSeenReceipt({ statusUuid: 'unknown', receiptUserJid: 'v@s.whatsapp.net', seenTimestamp: 2 })
			const total = (
				store.handle('status.db').prepare('SELECT COUNT(*) c FROM status_seen_receipt').get() as { c: number }
			).c
			expect(total).toBe(0)
			expect(backend.listSeenReceiptsForStatus('unknown')).toEqual([])
		})

		it('pruneExpired deletes old statuses; triggers keep status_info counters + cascade seen_receipt', () => {
			const backend = new StatusBackend(store.handle('status.db'), { pruneIntervalMs: Number.MAX_SAFE_INTEGER })
			const sender = 'alice@s.whatsapp.net'
			backend.recordReceivedStatus({ senderUserJid: sender, uuid: 'old', timestamp: 1_000 })
			backend.recordReceivedStatus({ senderUserJid: sender, uuid: 'new', timestamp: 9_000 })
			backend.recordSeenReceipt({ statusUuid: 'old', receiptUserJid: 'bob@s.whatsapp.net', seenTimestamp: 1_500 })

			const db = store.handle('status.db')
			const info = () =>
				db.prepare('SELECT total_count, unread_count FROM status_info WHERE chat_jid=?').get(sender) as {
					total_count: number
					unread_count: number
				}
			expect(info()).toMatchObject({ total_count: 2, unread_count: 2 })
			expect(backend.listSeenReceiptsForStatus('old')).toHaveLength(1)

			// Prune everything older than 5000 → 'old' goes, 'new' stays.
			expect(backend.pruneExpired(5_000)).toBe(1)
			expect(backend.listStatusesForSender(sender).map(s => s.uuid)).toEqual(['new'])
			// AFTER DELETE triggers decremented the aggregates …
			expect(info()).toMatchObject({ total_count: 1, unread_count: 1 })
			// … and the BEFORE DELETE trigger cascaded the seen receipt away.
			expect((db.prepare('SELECT COUNT(*) c FROM status_seen_receipt').get() as { c: number }).c).toBe(0)
		})

		it('recordReceivedStatus is idempotent by uuid (no duplicate row, no double-count)', () => {
			// Audit #637: the same status is legitimately re-delivered (history sync
			// overlapping the live stream, retry/re-decrypt). A second call for the
			// same uuid must NOT insert a second row or double-count the aggregates.
			const backend = new StatusBackend(store.handle('status.db'), { pruneIntervalMs: Number.MAX_SAFE_INTEGER })
			const sender = 'dup@s.whatsapp.net'
			expect(backend.recordReceivedStatus({ senderUserJid: sender, uuid: 'u1', timestamp: 1_000 })).toBe(true)
			expect(backend.recordReceivedStatus({ senderUserJid: sender, uuid: 'u1', timestamp: 1_000 })).toBe(false)
			expect(backend.recordReceivedStatus({ senderUserJid: sender, uuid: 'u2', timestamp: 2_000 })).toBe(true)

			expect(backend.listStatusesForSender(sender).map(r => r.uuid)).toEqual(['u1', 'u2'])
			const info = store
				.handle('status.db')
				.prepare('SELECT total_count, unread_count FROM status_info WHERE chat_jid=?')
				.get(sender) as { total_count: number; unread_count: number }
			expect(info).toMatchObject({ total_count: 2, unread_count: 2 })
		})

		it('last_status_timestamp trigger is order-independent (falls back when newest is deleted)', () => {
			// Audit #637: the mobile-verbatim trigger guarded on `last_status_sort_id
			// = old.sort_id`, a column the sibling sort_id trigger overwrites — and
			// SQLite doesn't define a fire order between them. The fixed body guards
			// on `last_status_timestamp` (untouched by siblings) so deleting the
			// newest status always refreshes the aggregate to the next-newest.
			const backend = new StatusBackend(store.handle('status.db'), { pruneIntervalMs: Number.MAX_SAFE_INTEGER })
			const db = store.handle('status.db')
			const sender = 'ord@s.whatsapp.net'
			backend.recordReceivedStatus({ senderUserJid: sender, uuid: 'u1', timestamp: 1_000 })
			backend.recordReceivedStatus({ senderUserJid: sender, uuid: 'u2', timestamp: 2_000 })

			const ts = () =>
				(
					db.prepare('SELECT last_status_timestamp t FROM status_info WHERE chat_jid=?').get(sender) as {
						t: number
					}
				).t
			expect(ts()).toBe(2_000)

			// Deterministically prove the guard is the NEW one (on last_status_timestamp),
			// not the old order-dependent one (on last_status_sort_id): force
			// `last_status_sort_id` to a value that does NOT match u2's sort_id, so the
			// OLD guard (`last_status_sort_id = old.sort_id`) would be false and leave
			// the aggregate stale — while the NEW guard still fires. Independent of
			// whichever order SQLite happens to run the sibling triggers in.
			db.prepare('UPDATE status_info SET last_status_sort_id = 999 WHERE chat_jid=?').run(sender)

			db.prepare('DELETE FROM status WHERE uuid=?').run('u2') // delete the newest
			expect(ts()).toBe(1_000) // aggregate fell back to u1, not left stale at 2_000
		})

		it('status.db v1 migration backfills a stale last_status_timestamp (repairs old-trigger damage)', () => {
			// Audit #637 follow-up: swapping the trigger only prevents FUTURE staleness.
			// A DB that already ran the buggy trigger can hold a last_status_timestamp
			// pointing at an already-deleted status. The migration must REPAIR it — this
			// exercises the backfill SQL the migration runs.
			const backend = new StatusBackend(store.handle('status.db'), { pruneIntervalMs: Number.MAX_SAFE_INTEGER })
			const db = store.handle('status.db')
			const sender = 'heal@s.whatsapp.net'
			backend.recordReceivedStatus({ senderUserJid: sender, uuid: 'h1', timestamp: 1_000 })
			backend.recordReceivedStatus({ senderUserJid: sender, uuid: 'h2', timestamp: 2_000 })

			// Simulate the corruption the OLD trigger left behind: newest (h2) is gone
			// from `status`, but `status_info.last_status_timestamp` still points at it.
			db.prepare('DELETE FROM status WHERE uuid=?').run('h2')
			db.prepare('UPDATE status_info SET last_status_timestamp = 2_000 WHERE chat_jid=?').run(sender)
			const readTs = () =>
				(db.prepare('SELECT last_status_timestamp t FROM status_info WHERE chat_jid=?').get(sender) as { t: number }).t
			expect(readTs()).toBe(2_000) // corrupted: points at the deleted h2

			// Run the migration's backfill → repairs to the newest REMAINING status (h1).
			db.exec(STATUS_BACKFILL_LAST_TIMESTAMP_SQL)
			expect(readTs()).toBe(1_000)
		})

		it('listActiveStatusesForSender drops rows past the 24h retention at read time', () => {
			// Audit #637: the write-path prune is throttled/best-effort, so a just-
			// expired status can still be on disk between prunes. The active read
			// enforces the same 24h window so the consumer never sees a stale status.
			const backend = new StatusBackend(store.handle('status.db'), { pruneIntervalMs: Number.MAX_SAFE_INTEGER })
			const sender = 'ret@s.whatsapp.net'
			const now = 2_000_000 // unix seconds; cutoff = now - 86400 = 1_913_600
			backend.recordReceivedStatus({ senderUserJid: sender, uuid: 'stale', timestamp: 1_000 })
			backend.recordReceivedStatus({ senderUserJid: sender, uuid: 'fresh', timestamp: 1_999_000 })

			expect(backend.listStatusesForSender(sender).map(r => r.uuid)).toEqual(['stale', 'fresh'])
			expect(backend.listActiveStatusesForSender(sender, now).map(r => r.uuid)).toEqual(['fresh'])
		})
	})

	describe('StickersBackend', () => {
		it('upserts a starred sticker (dedup by plaintext_hash) and lists/removes it', () => {
			const backend = new StickersBackend(store.handle('stickers.db'))
			backend.upsertStarred({
				plaintextHash: 'HASH1',
				timestamp: 100,
				url: 'https://cdn/s.webp',
				encHash: 'ZW5j',
				mediaKey: 'bWs=',
				directPath: '/o1/v/t62/x',
				mimetype: 'image/webp',
				fileSize: 4096,
				width: 512,
				height: 512,
				isLottie: 0,
				isAvatar: 0
			})
			// same hash re-stars → upsert, not duplicate (refreshes timestamp)
			backend.upsertStarred({ plaintextHash: 'HASH1', timestamp: 200 })

			const starred = backend.listStarred()
			expect(starred).toHaveLength(1)
			expect(starred[0]).toMatchObject({ plaintext_hash: 'HASH1', timestamp: 200, mimetype: 'image/webp' })
			expect(backend.getStarred('HASH1')?.media_key).toBe('bWs=')

			expect(backend.removeStarred('HASH1')).toBe(true)
			expect(backend.listStarred()).toEqual([])
			expect(backend.removeStarred('HASH1')).toBe(false)
		})

		it('upserts recent stickers and removes by lastStickerSentTs (removeRecentStickerAction)', () => {
			const backend = new StickersBackend(store.handle('stickers.db'))
			backend.upsertRecent({ plaintextHash: 'R1', entryWeight: 1.5, lastStickerSentTs: 1_700_000_000 })
			backend.upsertRecent({ plaintextHash: 'R2', entryWeight: 0.5, lastStickerSentTs: 1_700_000_100 })
			expect(backend.listRecent().map(r => r.plaintext_hash)).toEqual(['R1', 'R2']) // by entry_weight DESC

			expect(backend.removeRecentByTs(1_700_000_000)).toBe(true)
			expect(backend.listRecent().map(r => r.plaintext_hash)).toEqual(['R2'])
		})
	})
})
