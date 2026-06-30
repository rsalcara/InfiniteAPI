/**
 * Schema migration v1 — `wa.db` adds `wa_contacts.username` + index.
 *
 * Two cases matter:
 *   (1) FRESH DB — `CREATE TABLE IF NOT EXISTS` adds the column from
 *       the start; the migration runner records v1 as applied without
 *       re-running the ALTER (which would fail with "duplicate
 *       column name").
 *   (2) UPGRADE — pre-PR `wa.db` files have `wa_contacts` WITHOUT
 *       `username`; the next open MUST `ALTER TABLE ADD COLUMN`
 *       exactly once and then record v1 so re-opens stay quiet.
 *
 * Failure modes worth pinning:
 *   - migration silently no-ops on fresh DBs (test 1 asserts column
 *     exists AND the bookkeeping recorded v1)
 *   - re-open on a migrated DB does NOT re-run the ALTER (test 4)
 *   - the new index is actually picked by EXPLAIN QUERY PLAN for the
 *     lookup the future contact-by-username code will use (test 3)
 */
import Database from 'better-sqlite3'
import { mkdtemp, rm } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { MultiDbSqliteStore } from '../../Utils/multi-db-sqlite'

describe('wa.db migration v1 — wa_contacts.username', () => {
	let dir: string
	let store: MultiDbSqliteStore | undefined

	beforeEach(async () => {
		dir = await mkdtemp(join(tmpdir(), 'wa-username-mig-'))
	})

	afterEach(async () => {
		if (store) {
			store.close()
			store = undefined
		}

		await rm(dir, { recursive: true, force: true })
	})

	it('fresh DB: username column + index exist after open, v1 recorded', async () => {
		store = new MultiDbSqliteStore({ sessionDir: dir })
		await store.open()

		const db = store.handle('wa.db')
		const cols = db.prepare("PRAGMA table_info('wa_contacts')").all() as Array<{ name: string }>
		expect(cols.map(c => c.name)).toContain('username')

		const indexes = db.prepare("PRAGMA index_list('wa_contacts')").all() as Array<{ name: string }>
		expect(indexes.map(i => i.name)).toContain('wa_contacts_username_idx')

		// Bookkeeping: v1 must be marked applied even though the schema
		// already had the column (the ALTER inside the migration would
		// fail with "duplicate column" if it re-ran on the next open;
		// recording it as applied is what prevents that).
		const applied = db.prepare('SELECT version FROM schema_migrations WHERE version = 1').all() as Array<{
			version: number
		}>
		expect(applied).toHaveLength(1)
	})

	it('upgrade path: a pre-PR DB without the column gets ALTER applied on open', async () => {
		// Hand-roll a `wa.db` shaped like the pre-PR layout: wa_contacts
		// exists but has no `username`, AND no `schema_migrations` table
		// yet (so the runner sees v1 as unapplied).
		const walPath = join(dir, 'wa.db')
		const pre = new Database(walPath)
		pre.exec(`
			CREATE TABLE IF NOT EXISTS wa_contacts (
				_id INTEGER PRIMARY KEY AUTOINCREMENT,
				jid TEXT NOT NULL,
				is_whatsapp_user BOOLEAN NOT NULL
			);
		`)
		// Sanity: confirm column is NOT there
		const colsBefore = pre.prepare("PRAGMA table_info('wa_contacts')").all() as Array<{ name: string }>
		expect(colsBefore.map(c => c.name)).not.toContain('username')
		pre.close()

		// Open through the store — fires `CREATE TABLE IF NOT EXISTS`
		// (no-op for existing table) AND runs the v1 migration.
		store = new MultiDbSqliteStore({ sessionDir: dir })
		await store.open()

		const db = store.handle('wa.db')
		const colsAfter = db.prepare("PRAGMA table_info('wa_contacts')").all() as Array<{ name: string }>
		expect(colsAfter.map(c => c.name)).toContain('username')

		const indexes = db.prepare("PRAGMA index_list('wa_contacts')").all() as Array<{ name: string }>
		expect(indexes.map(i => i.name)).toContain('wa_contacts_username_idx')

		const applied = db.prepare('SELECT version, name FROM schema_migrations ORDER BY version').all() as Array<{
			version: number
			name: string
		}>
		expect(applied.some(r => r.version === 1 && r.name === 'add wa_contacts.username + index')).toBe(true)
	})

	it('column accepts NULL + values; index serves the lookup', async () => {
		store = new MultiDbSqliteStore({ sessionDir: dir })
		await store.open()

		const db = store.handle('wa.db')
		db.prepare('INSERT INTO wa_contacts (jid, is_whatsapp_user, username) VALUES (?, ?, ?)').run(
			'5511999999991@s.whatsapp.net',
			1,
			'tuoli'
		)
		db.prepare('INSERT INTO wa_contacts (jid, is_whatsapp_user, username) VALUES (?, ?, ?)').run(
			'5511777777777@s.whatsapp.net',
			1,
			null
		)

		const byUsername = db.prepare('SELECT jid FROM wa_contacts WHERE username = ?').get('tuoli') as
			| { jid: string }
			| undefined
		expect(byUsername?.jid).toBe('5511999999991@s.whatsapp.net')

		const nullRow = db.prepare('SELECT jid, username FROM wa_contacts WHERE jid = ?').get(
			'5511777777777@s.whatsapp.net'
		) as { jid: string; username: string | null }
		expect(nullRow.username).toBeNull()

		const plan = db.prepare("EXPLAIN QUERY PLAN SELECT jid FROM wa_contacts WHERE username = 'x'").all() as Array<{
			detail: string
		}>
		expect(plan.some(r => /wa_contacts_username_idx/i.test(r.detail))).toBe(true)
	})

	it('re-open after migration: no error, v1 stays recorded exactly once', async () => {
		store = new MultiDbSqliteStore({ sessionDir: dir })
		await store.open()
		store.close()

		store = new MultiDbSqliteStore({ sessionDir: dir })
		await store.open()

		const db = store.handle('wa.db')
		const rows = db.prepare('SELECT version FROM schema_migrations WHERE version = 1').all() as Array<{
			version: number
		}>
		expect(rows).toHaveLength(1)
	})
})
