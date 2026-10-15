import { mkdtemp, rm } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { MultiDbSqliteStore } from '../../Utils/multi-db-sqlite'

// R6 (audit PR-30): receipt_orphaned.status now stores the app's Android
// status integer (delivery 5, read 13, played 8 — MessageStatusUpdateHelper,
// X/C28106CSb.java in 2.26.38.10). Older builds invented private codes
// (0 device ack, 1/2/3 user delivery/read/played); migration v10 rewrites
// them in place. NULL (pre-hardening generic ack) keeps its replay shape.
describe('msgstore.db migration v10 — legacy receipt orphan codes to Android integers', () => {
	let dir: string
	let store: MultiDbSqliteStore | undefined

	beforeEach(async () => {
		dir = await mkdtemp(join(tmpdir(), 'receipt-orphan-status-migration-test-'))
	})

	afterEach(async () => {
		store?.close()
		await rm(dir, { recursive: true, force: true })
	})

	it('rewrites legacy codes 0-3 to the app integers and leaves NULL and known integers untouched', async () => {
		store = new MultiDbSqliteStore({ sessionDir: dir })
		await store.open()
		const db = store.handle('msgstore.db')
		db.prepare(
			"INSERT INTO jid (user, server, raw_string) VALUES ('legacy', 's.whatsapp.net', 'legacy@s.whatsapp.net')"
		).run()
		const jidRowId = (
			db.prepare("SELECT _id FROM jid WHERE raw_string = 'legacy@s.whatsapp.net'").get() as { _id: number }
		)._id
		const chatRowId = Number(db.prepare('INSERT INTO chat (jid_row_id) VALUES (?)').run(jidRowId).lastInsertRowid)
		const insert = db.prepare(
			'INSERT INTO receipt_orphaned (chat_row_id, from_me, key_id, receipt_device_jid_row_id, receipt_recipient_jid_row_id, status, timestamp) VALUES (?, 1, ?, ?, ?, ?, 1000)'
		)
		insert.run(chatRowId, 'LEGACY-DEVICE-0', jidRowId, null, 0)
		insert.run(chatRowId, 'LEGACY-USER-1', jidRowId, jidRowId, 1)
		insert.run(chatRowId, 'LEGACY-USER-2', jidRowId, jidRowId, 2)
		insert.run(chatRowId, 'LEGACY-USER-3', jidRowId, jidRowId, 3)
		insert.run(chatRowId, 'LEGACY-NULL', jidRowId, null, null)
		insert.run(chatRowId, 'ALREADY-RAW-13', jidRowId, jidRowId, 13)
		db.prepare('DELETE FROM schema_migrations WHERE version = 10').run()
		store.close()
		store = undefined

		store = new MultiDbSqliteStore({ sessionDir: dir })
		await store.open()
		const migrated = store.handle('msgstore.db')
		const rows = migrated
			.prepare('SELECT key_id, status FROM receipt_orphaned ORDER BY key_id')
			.all() as Array<{ key_id: string; status: number | null }>
		expect(rows).toEqual([
			{ key_id: 'ALREADY-RAW-13', status: 13 },
			{ key_id: 'LEGACY-DEVICE-0', status: 5 },
			{ key_id: 'LEGACY-NULL', status: null },
			{ key_id: 'LEGACY-USER-1', status: 5 },
			{ key_id: 'LEGACY-USER-2', status: 13 },
			{ key_id: 'LEGACY-USER-3', status: 8 }
		])
		expect(migrated.prepare('SELECT name FROM schema_migrations WHERE version = 10').get()).toMatchObject({
			name: 'rewrite legacy receipt orphan codes to Android status integers'
		})
	})
})
