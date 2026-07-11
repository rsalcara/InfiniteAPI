/**
 * `HistorySyncCompanionBackend` smoke tests — the per-chunk companion
 * history-sync tracking table in `sync.db`. Exercises the captured mobile
 * lifecycle: INSERT (put) → UPDATE local_path (markProcessed) → DELETE, plus
 * upsert-on-same-message_id and clear().
 */
import { mkdtemp, rm } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { HistorySyncCompanionBackend, MultiDbSqliteStore } from '../../Utils/multi-db-sqlite'

describe('HistorySyncCompanionBackend', () => {
	let dir: string
	let store: MultiDbSqliteStore
	let backend: HistorySyncCompanionBackend

	const countRows = () =>
		(store.handle('sync.db').prepare('SELECT COUNT(*) AS n FROM history_sync_companion').get() as { n: number }).n

	beforeEach(async () => {
		dir = await mkdtemp(join(tmpdir(), 'hist-sync-companion-test-'))
		store = new MultiDbSqliteStore({ sessionDir: dir })
		await store.open()
		backend = new HistorySyncCompanionBackend(store.handle('sync.db'))
	})

	afterEach(async () => {
		store.close()
		await rm(dir, { recursive: true, force: true })
	})

	it('inserts, updates local_path, and deletes a chunk row (full lifecycle)', () => {
		backend.put({
			messageId: 'HSC-1',
			syncType: 4,
			chunkOrder: 0,
			mediaKey: Buffer.from([0x11, 0x22]),
			mediaHash: 'aGFzaA==',
			mediaEncHash: 'ZW5jaGFzaA==',
			fileSize: 670998,
			directPath: '/v/t62.7119-24/abc.enc'
		})

		const row = backend.get('HSC-1')
		expect(row).not.toBeNull()
		expect(row!.sync_type).toBe(4)
		expect(row!.file_size).toBe(670998)
		expect(row!.direct_path).toBe('/v/t62.7119-24/abc.enc')
		expect(Buffer.from(row!.media_key!).toString('hex')).toBe('1122')
		expect(row!.local_path).toBeNull()

		// UPDATE local_path (chunk downloaded / consumed).
		expect(backend.markProcessed('HSC-1', 'in-memory')).toBe(true)
		expect(backend.get('HSC-1')!.local_path).toBe('in-memory')

		// DELETE (chunk consumed).
		expect(backend.delete('HSC-1')).toBe(true)
		expect(backend.get('HSC-1')).toBeNull()
	})

	it('upserts on the same message_id (no duplicate chunk row, local_path replaced)', () => {
		backend.put({ messageId: 'HSC-2', syncType: 1, chunkOrder: 0, localPath: '/old/path' })
		expect(backend.get('HSC-2')!.local_path).toBe('/old/path')

		// The conflict update covers local_path too — a re-delivered notification
		// (no local_path) replaces the stale value rather than retaining it.
		backend.put({ messageId: 'HSC-2', syncType: 1, chunkOrder: 5 })
		expect(countRows()).toBe(1)
		expect(backend.get('HSC-2')!.chunk_order).toBe(5)
		expect(backend.get('HSC-2')!.local_path).toBeNull()
	})

	it('stores an inline_payload chunk (no media)', () => {
		backend.put({ messageId: 'HSC-3', syncType: 2, inlinePayload: Buffer.from([0xde, 0xad]) })
		const row = backend.get('HSC-3')
		expect(Buffer.from(row!.inline_payload!).toString('hex')).toBe('dead')
		expect(row!.media_hash).toBe('')
	})

	it('wipes every row on clear() (socket close)', () => {
		backend.put({ messageId: 'HSC-A' })
		backend.put({ messageId: 'HSC-B' })
		expect(countRows()).toBe(2)
		backend.clear()
		expect(countRows()).toBe(0)
	})
})
