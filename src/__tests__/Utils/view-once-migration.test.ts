import { mkdtemp, rm } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { MultiDbSqliteStore } from '../../Utils/multi-db-sqlite'

describe('msgstore.db migration v9 - view-once media state', () => {
	let dir: string
	let store: MultiDbSqliteStore | undefined

	beforeEach(async () => {
		dir = await mkdtemp(join(tmpdir(), 'view-once-migration-test-'))
	})

	afterEach(async () => {
		store?.close()
		await rm(dir, { recursive: true, force: true })
	})

	it('upgrades a database without the satellite and records migration v9 once', async () => {
		store = new MultiDbSqliteStore({ sessionDir: dir })
		await store.open()
		const db = store.handle('msgstore.db')
		db.exec('DROP TRIGGER IF EXISTS message_bd_for_message_view_once_media_trigger')
		db.exec('DROP TABLE IF EXISTS message_view_once_media')
		db.prepare('DELETE FROM schema_migrations WHERE version = 9').run()
		store.close()
		store = undefined

		store = new MultiDbSqliteStore({ sessionDir: dir })
		await store.open()
		const migrated = store.handle('msgstore.db')
		expect(
			migrated
				.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
				.get('message_view_once_media')
		).toMatchObject({ name: 'message_view_once_media' })
		expect(
			migrated
				.prepare("SELECT name FROM sqlite_master WHERE type = 'trigger' AND name = ?")
				.get('message_bd_for_message_view_once_media_trigger')
		).toMatchObject({ name: 'message_bd_for_message_view_once_media_trigger' })
		expect(migrated.prepare('SELECT name FROM schema_migrations WHERE version = 9').get()).toMatchObject({
			name: 'add Android view-once media state satellite'
		})
	})
})
