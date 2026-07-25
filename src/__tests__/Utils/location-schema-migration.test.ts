import Database from 'better-sqlite3'
import { mkdtemp, rm } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { MultiDbSqliteStore } from '../../Utils/multi-db-sqlite'

describe('location.db migration v2 — canonical location_sharer', () => {
	let dir: string
	let store: MultiDbSqliteStore | undefined

	beforeEach(async () => {
		dir = await mkdtemp(join(tmpdir(), 'location-schema-mig-'))
	})

	afterEach(async () => {
		store?.close()
		store = undefined
		await rm(dir, { recursive: true, force: true })
	})

	it('removes received_ts atomically while preserving rows and the natural-key index', async () => {
		const pre = new Database(join(dir, 'location.db'))
		pre.exec(`
			CREATE TABLE location_sharer (
				_id INTEGER PRIMARY KEY AUTOINCREMENT,
				remote_jid TEXT NOT NULL DEFAULT '',
				from_me BOOLEAN NOT NULL DEFAULT 0,
				remote_resource TEXT NOT NULL DEFAULT '',
				expires INTEGER NOT NULL DEFAULT 0,
				message_id TEXT NOT NULL DEFAULT '',
				received_ts INTEGER NOT NULL DEFAULT 0
			);
			CREATE UNIQUE INDEX location_sharer_index
				ON location_sharer (remote_jid, from_me, remote_resource, message_id);
			CREATE TABLE schema_migrations (
				version INTEGER PRIMARY KEY,
				name TEXT NOT NULL,
				applied_at INTEGER NOT NULL
			);
			INSERT INTO schema_migrations VALUES (1, 'add location_sharer.received_ts', 1);
			INSERT INTO location_sharer
				(_id, remote_jid, from_me, remote_resource, expires, message_id, received_ts)
			VALUES
				(7, 'chat@s.whatsapp.net', 0, 'sender@s.whatsapp.net', 1700000900000, 'LIVE-1', 123),
				(8, 'open@s.whatsapp.net', 0, 'open@s.whatsapp.net', 0, 'LIVE-OPEN', 124);
		`)
		pre.close()

		store = new MultiDbSqliteStore({ sessionDir: dir })
		await store.open()

		const db = store.handle('location.db')
		const columns = db.prepare('PRAGMA table_info(location_sharer)').all() as Array<{ name: string }>
		expect(columns.map(column => column.name)).toEqual([
			'_id',
			'remote_jid',
			'from_me',
			'remote_resource',
			'expires',
			'message_id'
		])
		expect(db.prepare('SELECT * FROM location_sharer').get()).toMatchObject({
			_id: 7,
			remote_jid: 'chat@s.whatsapp.net',
			remote_resource: 'sender@s.whatsapp.net',
			expires: 1_700_000_900_000,
			message_id: 'LIVE-1'
		})
		expect(
			db.prepare("SELECT CAST(expires AS TEXT) AS expires FROM location_sharer WHERE message_id = 'LIVE-OPEN'").get()
		).toEqual({ expires: '9223372036854775807' })
		expect(db.prepare('SELECT version FROM schema_migrations ORDER BY version').all()).toEqual([
			{ version: 1 },
			{ version: 2 },
			{ version: 3 }
		])
		const indexes = db.prepare("PRAGMA index_list('location_sharer')").all() as Array<{ name: string; unique: number }>
		expect(indexes).toEqual(
			expect.arrayContaining([expect.objectContaining({ name: 'location_sharer_index', unique: 1 })])
		)
	})

	it('fresh database is created directly in the canonical observable shape', async () => {
		store = new MultiDbSqliteStore({ sessionDir: dir })
		await store.open()

		const db = store.handle('location.db')
		const columns = db.prepare('PRAGMA table_info(location_sharer)').all() as Array<{ name: string }>
		expect(columns.map(column => column.name)).not.toContain('received_ts')
		expect(db.prepare('SELECT version FROM schema_migrations ORDER BY version').all()).toEqual([
			{ version: 1 },
			{ version: 2 },
			{ version: 3 }
		])
	})
})
