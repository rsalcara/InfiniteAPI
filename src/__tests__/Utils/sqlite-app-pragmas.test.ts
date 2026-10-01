import { jest } from '@jest/globals'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { MULTI_DB_FILES } from '../../Utils/multi-db-sqlite/schemas'
import { MultiDbSqliteStore } from '../../Utils/multi-db-sqlite/store'
import { loadSqliteDriver } from '../../Utils/sqlite-driver'
import { sqliteDatabaseFile, useSqliteAuthState } from '../../Utils/use-sqlite-auth-state'

/**
 * Audit S-02 / S-05 / S-12: SQLite settings as the app runs them.
 * - secure_delete on, verified after open (MessagesDBHelper.onOpen);
 * - no index duplicating the (type, id) primary key of the key tables;
 * - page cache: 512 KiB per multi-db file (2000 KiB measured no faster),
 *   configurable per file; 2000 KiB (the app value) on the single-file store.
 */
const quietLogger = () => {
	const warn = jest.fn()
	const noop = () => {}

	return {
		warn,
		logger: { warn, info: noop, debug: noop, error: noop, trace: noop, level: 'warn', child: () => undefined } as never
	}
}

const indexNames = (db: { prepare(sql: string): { all(...p: unknown[]): unknown[] } }, table: string) =>
	(
		db.prepare(`SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = ?`).all(table) as Array<{
			name: string
		}>
	)
		.map(row => row.name)
		.sort()

describe('multi-db SQLite settings', () => {
	let sessionDir: string

	beforeEach(() => {
		sessionDir = mkdtempSync(join(tmpdir(), 'sqlite-app-pragmas-'))
	})

	afterEach(() => {
		rmSync(sessionDir, { recursive: true, force: true })
	})

	it('opens every database with secure_delete and the per-file page cache', async () => {
		const store = new MultiDbSqliteStore({ sessionDir })
		await store.open()
		try {
			for (const file of MULTI_DB_FILES) {
				const db = store.handle(file)
				expect([file, Number(db.pragma('secure_delete', { simple: true }))]).toEqual([file, 1])
				expect([file, db.pragma('cache_size', { simple: true })]).toEqual([file, -512])
			}
		} finally {
			store.close()
		}
	})

	it('lets the operator size the cache per file, and extraPragmas still win', async () => {
		const store = new MultiDbSqliteStore({
			sessionDir,
			cacheSizeKiB: { 'msgstore.db': 2000, 'wa.db': 1024 },
			extraPragmas: []
		})
		await store.open()
		try {
			expect(store.handle('msgstore.db').pragma('cache_size', { simple: true })).toBe(-2000)
			expect(store.handle('wa.db').pragma('cache_size', { simple: true })).toBe(-1024)
			expect(store.handle('axolotl.db').pragma('cache_size', { simple: true })).toBe(-512)
		} finally {
			store.close()
		}

		const overridden = new MultiDbSqliteStore({ sessionDir, extraPragmas: ['cache_size = -8000'] })
		await overridden.open()
		try {
			expect(overridden.handle('msgstore.db').pragma('cache_size', { simple: true })).toBe(-8000)
		} finally {
			overridden.close()
		}
	})

	it('rejects a cache size that is not a positive integer', async () => {
		for (const invalid of [0, -1, 1.5, Number.NaN]) {
			const store = new MultiDbSqliteStore({ sessionDir, cacheSizeKiB: { 'msgstore.db': invalid } })
			await expect(store.open()).rejects.toThrow(/cacheSizeKiB for msgstore.db must be a positive integer/)
		}
	})

	it('warns when secure_delete does not stay on', async () => {
		const { warn, logger } = quietLogger()
		const store = new MultiDbSqliteStore({ sessionDir, logger, extraPragmas: ['secure_delete = OFF'] })
		await store.open()
		try {
			const warned = warn.mock.calls.filter(call => /secure_delete is not active/.test(String(call[1])))
			expect(warned).toHaveLength(MULTI_DB_FILES.length)
		} finally {
			store.close()
		}
	})

	it('creates no signal_kv_by_type and drops it from an existing session', async () => {
		const fresh = new MultiDbSqliteStore({ sessionDir })
		await fresh.open()
		const axolotl = fresh.handle('axolotl.db')
		expect(indexNames(axolotl, 'signal_kv')).not.toContain('signal_kv_by_type')
		// A session created before this change: index present, migration 4 not recorded.
		axolotl.exec('CREATE INDEX signal_kv_by_type ON signal_kv(type)')
		axolotl.prepare('DELETE FROM schema_migrations WHERE version = 4').run()
		fresh.close()

		const upgraded = new MultiDbSqliteStore({ sessionDir })
		await upgraded.open()
		try {
			const db = upgraded.handle('axolotl.db')
			expect(indexNames(db, 'signal_kv')).not.toContain('signal_kv_by_type')
			// Lookups by type alone still use the primary key, not a table scan.
			const plan = (
				db.prepare('EXPLAIN QUERY PLAN SELECT id FROM signal_kv WHERE type = ?').all('session') as Array<{
					detail: string
				}>
			)
				.map(row => row.detail)
				.join(' ')
			expect(plan).toMatch(/USING (COVERING )?INDEX sqlite_autoindex_signal_kv_1/)
		} finally {
			upgraded.close()
		}
	})
})

describe('single-file SQLite auth state settings', () => {
	let base: string

	beforeEach(() => {
		base = mkdtempSync(join(tmpdir(), 'sqlite-app-pragmas-single-'))
	})

	afterEach(() => {
		rmSync(base, { recursive: true, force: true })
	})

	it('runs with secure_delete and the app page cache, and drops the duplicate signal_keys index', async () => {
		const dbPath = join(base, 'auth.db')
		// A database created by a previous version still carries the index.
		const driver = await loadSqliteDriver()
		const legacy = driver.open(dbPath)
		legacy.exec(
			'CREATE TABLE signal_keys (type TEXT NOT NULL, id TEXT NOT NULL, value TEXT NOT NULL, PRIMARY KEY (type, id));' +
				'CREATE INDEX signal_keys_type_idx ON signal_keys(type);'
		)
		legacy.close()

		const { close } = await useSqliteAuthState({ dbPath })
		close()

		const db = driver.open(dbPath)
		try {
			expect(indexNames(db, 'signal_keys')).not.toContain('signal_keys_type_idx')
			// secure_delete is per connection: check it on a handle the auth state configures.
			expect(Number(db.pragma('secure_delete', { simple: true }))).toBe(0)
			const external = await useSqliteAuthState({ dbPath, database: db })
			expect(Number(db.pragma('secure_delete', { simple: true }))).toBe(1)
			expect(db.pragma('cache_size', { simple: true })).toBe(-2000)
			external.close()
		} finally {
			db.close()
		}
	})

	it('warns when secure_delete does not stay on', async () => {
		const { warn, logger } = quietLogger()
		const { close } = await useSqliteAuthState({
			dbPath: join(base, 'auth.db'),
			logger,
			extraPragmas: ['secure_delete = OFF']
		})
		close()
		expect(warn.mock.calls.some(call => /secure_delete is not active/.test(String(call[1])))).toBe(true)
	})
})

describe('sqliteDatabaseFile with a remote authority', () => {
	it('has nothing to create for a host SQLite would reject', () => {
		expect(sqliteDatabaseFile('node:sqlite', 'file://otherhost/srv/auth.db')).toBeUndefined()
		expect(sqliteDatabaseFile('node:sqlite', 'file://LOCALHOST/srv/auth.db')).toEqual({
			file: '/srv/auth.db',
			create: true
		})
	})
})
