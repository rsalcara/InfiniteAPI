import { mkdtemp, rm } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { JidMapBackend, MessageStoreBackend, MultiDbSqliteStore } from '../../Utils/multi-db-sqlite'

describe('msgstore.db migration v3 — message status backfill', () => {
	let dir: string
	let store: MultiDbSqliteStore

	beforeEach(async () => {
		dir = await mkdtemp(join(tmpdir(), 'message-status-migration-test-'))
		store = new MultiDbSqliteStore({ sessionDir: dir })
		await store.open()
	})

	afterEach(async () => {
		store.close()
		await rm(dir, { recursive: true, force: true })
	})

	it('repairs legacy NULL rows conservatively by direction', async () => {
		const db = store.handle('msgstore.db')
		const messages = new MessageStoreBackend(db, new JidMapBackend(db))
		const chatJid = '5511991426667@s.whatsapp.net'
		messages.recordMessage({ chatJid, fromMe: false, keyId: 'INCOMING', status: 0 })
		messages.recordMessage({ chatJid, fromMe: true, keyId: 'OUTGOING', status: 4 })
		db.prepare('UPDATE message SET status = NULL').run()
		db.prepare('DELETE FROM schema_migrations WHERE version = 3').run()

		store.close()
		store = new MultiDbSqliteStore({ sessionDir: dir })
		await store.open()

		const rows = store
			.handle('msgstore.db')
			.prepare('SELECT key_id, status FROM message ORDER BY key_id')
			.all() as Array<{ key_id: string; status: number }>
		expect(rows).toEqual([
			{ key_id: 'INCOMING', status: 0 },
			{ key_id: 'OUTGOING', status: 4 }
		])
	})
})
