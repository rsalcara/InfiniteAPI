import { mkdtemp, rm } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { MultiDbSqliteStore } from '../../Utils/multi-db-sqlite'

describe('msgstore.db migration v8 — orphan receipt retention', () => {
	let dir: string
	let store: MultiDbSqliteStore | undefined

	beforeEach(async () => {
		dir = await mkdtemp(join(tmpdir(), 'receipt-orphan-migration-test-'))
	})

	afterEach(async () => {
		store?.close()
		await rm(dir, { recursive: true, force: true })
	})

	it('backfills missing timestamps and creates the retention index on upgrade', async () => {
		store = new MultiDbSqliteStore({ sessionDir: dir })
		await store.open()
		const db = store.handle('msgstore.db')
		// The schema permits legacy NULL/zero values; force v8 to replay as an
		// upgrade so the test covers the repair, not only a fresh database.
		db.prepare(
			"INSERT INTO jid (user, server, raw_string) VALUES ('legacy', 's.whatsapp.net', 'legacy@s.whatsapp.net')"
		).run()
		const jidRow = db.prepare("SELECT _id FROM jid WHERE raw_string = 'legacy@s.whatsapp.net'").get() as {
			_id: number
		}
		const jidRowId = jidRow._id
		const realChatRowId = Number(db.prepare('INSERT INTO chat (jid_row_id) VALUES (?)').run(jidRowId).lastInsertRowid)
		const insert = db.prepare(
			'INSERT INTO receipt_orphaned (chat_row_id, from_me, key_id, receipt_device_jid_row_id, status, timestamp) VALUES (?, 1, ?, ?, 0, ?)'
		)
		insert.run(realChatRowId, 'NULL-TIME', jidRowId, null)
		insert.run(realChatRowId, 'ZERO-TIME', jidRowId, 0)
		db.exec('DROP INDEX receipt_orphaned_timestamp_idx')
		db.prepare('DELETE FROM schema_migrations WHERE version = 8').run()
		store.close()
		store = undefined

		const before = Math.floor(Date.now() / 1000)
		store = new MultiDbSqliteStore({ sessionDir: dir })
		await store.open()
		const migrated = store.handle('msgstore.db')
		const rows = migrated
			.prepare("SELECT timestamp FROM receipt_orphaned WHERE key_id IN ('NULL-TIME', 'ZERO-TIME') ORDER BY key_id")
			.all() as Array<{ timestamp: number }>
		expect(rows).toHaveLength(2)
		for (const row of rows) expect(row.timestamp).toBeGreaterThanOrEqual(before)

		const indexes = migrated.prepare("PRAGMA index_list('receipt_orphaned')").all() as Array<{ name: string }>
		expect(indexes.map(index => index.name)).toContain('receipt_orphaned_timestamp_idx')
		expect(migrated.prepare('SELECT name FROM schema_migrations WHERE version = 8').get()).toMatchObject({
			name: 'index orphan receipt retention and backfill missing arrival timestamps'
		})
	})
})
