/**
 * Phase 9.3–9.7 — backend smoke tests for the remaining components:
 *
 *   - `MsgRetryCounterSqliteAdapter` — retry counter persistence with TTL
 *   - `MessageQuarantineBackend` — quarantine row inserts + upsert-on-retry
 *   - `TrustedContactsBackend` — incoming + outbound TC token state
 *   - `AppStateBackend` — collection_versions + syncd_mutations
 *
 * One file covers all four since they share setup/teardown (a single
 * MultiDbSqliteStore handle).
 */
import { mkdtemp, rm } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import {
	AppStateBackend,
	MessageQuarantineBackend,
	MsgRetryCounterSqliteAdapter,
	MultiDbSqliteStore,
	TrustedContactsBackend
} from '../../Utils/multi-db-sqlite'

describe('Phase 9 backends', () => {
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
	})
})
