/**
 * Lightweight schema-migration helper for the multi-DB SQLite layer.
 *
 * Every `.db` file opened by `MultiDbSqliteStore` is initialised via
 * `CREATE TABLE IF NOT EXISTS …` against the schema strings in
 * `schemas/`. That is fine for FIRST opens and for subsequent opens
 * where the schema hasn't changed, but `CREATE TABLE IF NOT EXISTS`
 * cannot ALTER an existing table — so adding a column to a future
 * schema would silently leave older databases stuck on the previous
 * shape, and the new code would fail at runtime with
 * `no such column: <new_col>`.
 *
 * This helper introduces a per-DB `schema_migrations` bookkeeping
 * table and a `runMigrations(db, migrations)` function that applies
 * any pending migrations in order, idempotently. The Phase 9 PR ships
 * an EMPTY migration list per DB — the infrastructure is in place
 * so future PRs can append migrations without retrofitting the
 * bookkeeping at the point they need it.
 *
 * Conventions:
 *   - Versions are positive integers, strictly monotonic per DB.
 *   - Each migration is `{ version, name, sql }` where `sql` runs in
 *     a single `db.exec()` (multi-statement; SQLite executes them
 *     sequentially).
 *   - Each migration runs inside an `IMMEDIATE` transaction; if it
 *     throws, the transaction rolls back and the version is NOT
 *     recorded, so the next open retries it.
 *   - `applied_at` is epoch milliseconds.
 */
import type { SqliteDbLike } from './types'

/** A single migration entry. */
export interface Migration {
	/** Strictly monotonic per-DB version (1, 2, 3, …). */
	version: number
	/** Short human-readable name for logging. */
	name: string
	/** SQL applied via `db.exec()` (can contain multiple statements). */
	sql: string
}

const CREATE_BOOKKEEPING_SQL = `
CREATE TABLE IF NOT EXISTS schema_migrations (
  version INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  applied_at INTEGER NOT NULL
);
`

/**
 * Applies any pending migrations on `db`. Idempotent — safely re-callable
 * on every open. The bookkeeping table is created on the first call.
 *
 * The function asserts that `migrations` is sorted by `version` and that
 * versions are strictly increasing; violating that is a programmer error
 * (the migration list is hardcoded) and is surfaced as a thrown Error so
 * a typo in the migrations array fails fast rather than silently skipping
 * a step.
 */
export function runMigrations(db: SqliteDbLike, migrations: ReadonlyArray<Migration>): void {
	db.exec(CREATE_BOOKKEEPING_SQL)

	// Sanity-check the migration list once per open.
	for (let i = 1; i < migrations.length; i++) {
		const prev = migrations[i - 1]!
		const cur = migrations[i]!
		if (cur.version <= prev.version) {
			throw new Error(
				`runMigrations: migration list is not strictly monotonic — ` +
					`version ${prev.version} ("${prev.name}") is followed by ` +
					`version ${cur.version} ("${cur.name}")`
			)
		}
	}

	const selectApplied = db.prepare('SELECT version FROM schema_migrations ORDER BY version ASC')
	const appliedRows = selectApplied.all() as Array<{ version: number }>
	const appliedVersions = new Set(appliedRows.map(r => r.version))

	const insertApplied = db.prepare('INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)')

	for (const m of migrations) {
		if (appliedVersions.has(m.version)) continue
		const tx = db.transaction(() => {
			db.exec(m.sql)
			insertApplied.run(m.version, m.name, Date.now())
		})
		tx.immediate()
	}
}
