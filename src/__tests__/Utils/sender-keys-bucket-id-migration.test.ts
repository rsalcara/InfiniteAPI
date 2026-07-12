/**
 * Schema migration v1 — `axolotl.db` adds `sender_keys.bucket_id`.
 *
 * Schema-fidelity column: the canonical mobile `sender_keys` carries a
 * `bucket_id` (part of its natural key). InfiniteAPI keys sender-keys by the
 * 4-tuple (group/device/sender/type) — Baileys has no bucket concept — so the
 * column stays empty and is NOT in `sender_keys_idx_v26`.
 *
 * Two cases matter (same as the wa_contacts.username migration):
 *   (1) FRESH DB — base schema omits the column; the v1 ALTER adds it once and
 *       records v1.
 *   (2) UPGRADE — a pre-migration axolotl.db without the column gets the ALTER
 *       applied exactly once on open.
 */
import Database from 'better-sqlite3'
import { mkdtemp, rm } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { MultiDbSqliteStore, SignalTypedBackend } from '../../Utils/multi-db-sqlite'

describe('axolotl.db migration v1 — sender_keys.bucket_id', () => {
	let dir: string
	let store: MultiDbSqliteStore | undefined

	beforeEach(async () => {
		dir = await mkdtemp(join(tmpdir(), 'sender-keys-bucket-mig-'))
	})

	afterEach(async () => {
		if (store) {
			store.close()
			store = undefined
		}

		await rm(dir, { recursive: true, force: true })
	})

	it('fresh DB: bucket_id column exists after open, v1 recorded, defaults to empty', async () => {
		store = new MultiDbSqliteStore({ sessionDir: dir })
		await store.open()

		const db = store.handle('axolotl.db')
		const cols = db.prepare("PRAGMA table_info('sender_keys')").all() as Array<{ name: string }>
		expect(cols.map(c => c.name)).toContain('bucket_id')

		const applied = db.prepare('SELECT version FROM schema_migrations WHERE version = 1').all() as Array<{
			version: number
		}>
		expect(applied).toHaveLength(1)

		// The live crypto writer (SignalTypedBackend) never sets bucket_id — the
		// NOT NULL DEFAULT '' must keep the insert valid and leave it empty.
		const backend = new SignalTypedBackend(db)
		backend.putSenderKey(
			{ groupId: '120363409951247800@g.us', deviceId: 0, senderAccountId: '156041262186577', senderAccountType: 1 },
			Buffer.from([0x01]),
			1000
		)
		const row = db.prepare('SELECT bucket_id FROM sender_keys WHERE group_id = ?').get('120363409951247800@g.us') as {
			bucket_id: string
		}
		expect(row.bucket_id).toBe('')
	})

	it('upgrade path: a pre-migration DB without the column gets ALTER applied on open', async () => {
		const dbPath = join(dir, 'axolotl.db')
		const pre = new Database(dbPath)
		// Pre-migration shape: sender_keys WITHOUT bucket_id.
		pre.exec(`
			CREATE TABLE IF NOT EXISTS sender_keys (
				_id INTEGER PRIMARY KEY AUTOINCREMENT,
				group_id TEXT NOT NULL,
				device_id INTEGER NOT NULL DEFAULT 0,
				record BLOB NOT NULL,
				timestamp INTEGER,
				sender_account_id TEXT,
				sender_account_type INTEGER
			);
		`)
		const before = pre.prepare("PRAGMA table_info('sender_keys')").all() as Array<{ name: string }>
		expect(before.map(c => c.name)).not.toContain('bucket_id')
		pre.close()

		store = new MultiDbSqliteStore({ sessionDir: dir })
		await store.open()

		const db = store.handle('axolotl.db')
		const after = db.prepare("PRAGMA table_info('sender_keys')").all() as Array<{ name: string }>
		expect(after.map(c => c.name)).toContain('bucket_id')

		const applied = db.prepare('SELECT version, name FROM schema_migrations ORDER BY version').all() as Array<{
			version: number
			name: string
		}>
		expect(applied.some(r => r.version === 1 && /bucket_id/.test(r.name))).toBe(true)
	})

	it('re-open after migration: v1 stays recorded exactly once (ALTER not re-run)', async () => {
		store = new MultiDbSqliteStore({ sessionDir: dir })
		await store.open()
		store.close()

		store = new MultiDbSqliteStore({ sessionDir: dir })
		await store.open()

		const db = store.handle('axolotl.db')
		const rows = db.prepare('SELECT version FROM schema_migrations WHERE version = 1').all() as Array<{
			version: number
		}>
		expect(rows).toHaveLength(1)
	})
})
