import { mkdtemp, rm } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { MultiDbSqliteStore } from '../../Utils/multi-db-sqlite/store'

describe('msgstore.db migration v1 — lid_chat_state backfill', () => {
	let dir: string
	let store: MultiDbSqliteStore | undefined

	beforeEach(async () => {
		dir = await mkdtemp(join(tmpdir(), 'lid-chat-state-mig-'))
	})

	afterEach(async () => {
		store?.close()
		await rm(dir, { recursive: true, force: true })
	})

	it('backfills existing jid_map rows and preserves other state columns', async () => {
		store = new MultiDbSqliteStore({ sessionDir: dir })
		await store.open()

		const db = store.handle('msgstore.db')
		const insertJid = db.prepare('INSERT INTO jid (raw_string, user, server, type) VALUES (?, ?, ?, ?)')
		const lidRowId = Number(insertJid.run('123456789@lid', '123456789', 'lid', 1).lastInsertRowid)
		const pnRowId = Number(
			insertJid.run('5511999999999@s.whatsapp.net', '5511999999999', 's.whatsapp.net', 0).lastInsertRowid
		)
		db.prepare('INSERT INTO jid_map (lid_row_id, jid_row_id, sort_id) VALUES (?, ?, ?)').run(lidRowId, pnRowId, 1)
		db.prepare(
			'INSERT INTO lid_chat_state (jid_row_id, is_pn_shared, pn_requested_ts, pnh_duplicate_lid_thread) ' +
				'VALUES (?, 0, 1234, 1)'
		).run(lidRowId)

		// Simulate an installation whose mapping predates this migration.
		db.prepare('DELETE FROM schema_migrations WHERE version = 1').run()
		store.close()
		store = undefined

		store = new MultiDbSqliteStore({ sessionDir: dir })
		await store.open()

		const migrated = store
			.handle('msgstore.db')
			.prepare(
				'SELECT is_pn_shared, pn_requested_ts, pnh_duplicate_lid_thread FROM lid_chat_state WHERE jid_row_id = ?'
			)
			.get(lidRowId) as {
			is_pn_shared: number
			pn_requested_ts: number
			pnh_duplicate_lid_thread: number
		}
		expect(migrated).toEqual({ is_pn_shared: 1, pn_requested_ts: 1234, pnh_duplicate_lid_thread: 1 })
	})
})
