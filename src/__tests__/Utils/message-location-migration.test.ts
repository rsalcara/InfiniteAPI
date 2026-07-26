import Database from 'better-sqlite3'
import { mkdtemp, rm } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { MultiDbSqliteStore } from '../../Utils/multi-db-sqlite'

describe('msgstore.db migration v7 — final live-location columns', () => {
	let dir: string

	beforeEach(async () => {
		dir = await mkdtemp(join(tmpdir(), 'message-location-migration-test-'))
	})

	afterEach(async () => {
		await rm(dir, { recursive: true, force: true })
	})

	it('upgrades a legacy message_location before addon statements are prepared', async () => {
		const legacy = new Database(join(dir, 'msgstore.db'))
		legacy.exec(`
			CREATE TABLE message_location (
				message_row_id INTEGER PRIMARY KEY,
				chat_row_id INTEGER,
				latitude REAL,
				longitude REAL,
				place_name TEXT,
				place_address TEXT,
				url TEXT,
				live_location_share_duration INTEGER,
				live_location_sequence_number INTEGER
			);
		`)
		legacy.close()

		const store = new MultiDbSqliteStore({ sessionDir: dir })
		await expect(store.open()).resolves.toBeUndefined()
		const columns = store.handle('msgstore.db').prepare('PRAGMA table_info(message_location)').all() as Array<{
			name: string
		}>
		expect(columns.map(column => column.name)).toEqual(
			expect.arrayContaining([
				'live_location_final_latitude',
				'live_location_final_longitude',
				'live_location_final_timestamp',
				'map_download_status'
			])
		)
		store.close()
	})
})
