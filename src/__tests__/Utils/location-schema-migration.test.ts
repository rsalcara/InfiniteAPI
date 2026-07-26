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

	it('converts legacy seconds and bounds received rows before removing received_ts', async () => {
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
				(7, 'chat@s.whatsapp.net', 1, 'sender@s.whatsapp.net', 1700000900, 'LIVE-TIMED', 0),
				(8, 'received@s.whatsapp.net', 0, 'sender@s.whatsapp.net', 0, 'LIVE-RECEIVED', 1700000000),
				(9, 'open@s.whatsapp.net', 1, 'open@s.whatsapp.net', 0, 'LIVE-OPEN', 0),
				(10, 'unknown-received@s.whatsapp.net', 0, 'sender@s.whatsapp.net', 0, 'LIVE-RX-NO-TS', 0);
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
		expect(db.prepare("SELECT * FROM location_sharer WHERE message_id = 'LIVE-TIMED'").get()).toMatchObject({
			_id: 7,
			remote_jid: 'chat@s.whatsapp.net',
			remote_resource: 'sender@s.whatsapp.net',
			expires: 1_700_000_900_000,
			message_id: 'LIVE-TIMED'
		})
		expect(db.prepare("SELECT * FROM location_sharer WHERE message_id = 'LIVE-RECEIVED'").get()).toMatchObject({
			_id: 8,
			from_me: 0,
			expires: 1_700_028_800_000
		})
		expect(
			db.prepare("SELECT CAST(expires AS TEXT) AS expires FROM location_sharer WHERE message_id = 'LIVE-OPEN'").get()
		).toEqual({ expires: '9223372036854775807' })
		expect(db.prepare("SELECT expires FROM location_sharer WHERE message_id = 'LIVE-RX-NO-TS'").get()).toEqual({
			expires: 28_800_000
		})
		expect(db.prepare('SELECT version FROM schema_migrations ORDER BY version').all()).toEqual([
			{ version: 1 },
			{ version: 2 },
			{ version: 3 },
			{ version: 4 }
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
			{ version: 3 },
			{ version: 4 }
		])
	})

	it('repairs an intermediate v3 database without retaining resurrected received rows', async () => {
		const pre = new Database(join(dir, 'location.db'))
		pre.exec(`
			CREATE TABLE location_cache (
				_id INTEGER PRIMARY KEY AUTOINCREMENT,
				jid TEXT NOT NULL DEFAULT '',
				latitude REAL NOT NULL DEFAULT 0,
				longitude REAL NOT NULL DEFAULT 0,
				accuracy INTEGER NOT NULL DEFAULT 0,
				speed REAL NOT NULL DEFAULT 0,
				bearing INTEGER NOT NULL DEFAULT 0,
				location_ts INTEGER NOT NULL DEFAULT 0
			);
			CREATE UNIQUE INDEX user_location_index ON location_cache (jid);
			CREATE TABLE location_sharer (
				_id INTEGER PRIMARY KEY AUTOINCREMENT,
				remote_jid TEXT NOT NULL DEFAULT '',
				from_me BOOLEAN NOT NULL DEFAULT 0,
				remote_resource TEXT NOT NULL DEFAULT '',
				expires INTEGER NOT NULL DEFAULT 0,
				message_id TEXT NOT NULL DEFAULT ''
			);
			CREATE UNIQUE INDEX location_sharer_index
				ON location_sharer (remote_jid, from_me, remote_resource, message_id);
			CREATE TABLE schema_migrations (
				version INTEGER PRIMARY KEY,
				name TEXT NOT NULL,
				applied_at INTEGER NOT NULL
			);
			INSERT INTO schema_migrations VALUES
				(1, 'legacy retention', 1),
				(2, 'canonical schema', 1),
				(3, 'unscoped sentinel repair', 1);
			INSERT INTO location_cache
				(jid, latitude, longitude, accuracy, speed, bearing, location_ts)
			VALUES ('contact@s.whatsapp.net', 1, 2, 3, 4, 5, 1700000000);
			INSERT INTO location_sharer
				(remote_jid, from_me, remote_resource, expires, message_id)
			VALUES
				('received@s.whatsapp.net', 0, 'sender@s.whatsapp.net', 9223372036854775807, 'OLD-RX'),
				('sent@s.whatsapp.net', 1, 'me@s.whatsapp.net', 1700000900, 'ACTIVE-TX');
		`)
		pre.close()

		store = new MultiDbSqliteStore({ sessionDir: dir })
		await store.open()
		const db = store.handle('location.db')

		expect(
			db.prepare("SELECT CAST(expires AS TEXT) AS expires FROM location_sharer WHERE message_id = 'OLD-RX'").get()
		).toEqual({
			expires: '9223372036854775807'
		})
		expect(db.prepare("SELECT expires FROM location_sharer WHERE message_id = 'ACTIVE-TX'").get()).toEqual({
			expires: 1_700_000_900_000
		})
		expect(db.prepare("SELECT location_ts FROM location_cache WHERE jid = 'contact@s.whatsapp.net'").get()).toEqual({
			location_ts: 1_700_000_000_000
		})
	})
})
