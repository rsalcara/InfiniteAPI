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
 * pending migrations in order and records each successful version. The
 * bookkeeping table is also initialized for databases whose migration list
 * is currently empty, so later migrations need no first-run special case.
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

type MigrationMetadata = {
	/** Strictly monotonic per-DB version (1, 2, 3, …). */
	version: number
	/** Short human-readable name for logging. */
	name: string
}

/** A single migration entry. Exactly one of `sql` / `run` must be provided. */
export type Migration = MigrationMetadata &
	(
		| {
				/** SQL applied via `db.exec()` (can contain multiple statements). */
				sql: string
				run?: never
		  }
		| {
				sql?: never
				/**
				 * Imperative migration body — for logic pure SQL can't express, e.g. an
				 * idempotent `ADD COLUMN` that must first check `PRAGMA table_info`.
				 * Runs inside the same IMMEDIATE transaction as an `sql` body.
				 */
				run: (db: SqliteDbLike) => void
		  }
	)

const quoteIdentifier = (identifier: string, label: string): string => {
	if (!identifier) throw new Error(`${label} must not be empty`)
	return `"${identifier.replace(/"/g, '""')}"`
}

/** True if `table` already has a column named `column`. */
export function columnExists(db: SqliteDbLike, table: string, column: string): boolean {
	// PRAGMA identifiers cannot be bound as parameters. Quote them explicitly so
	// this exported helper stays safe even if a future caller passes an unusual
	// (or accidentally untrusted) identifier.
	const cols = db.prepare(`PRAGMA table_info(${quoteIdentifier(table, 'table')})`).all() as Array<{ name: string }>
	return cols.some(c => c.name === column)
}

/**
 * `ALTER TABLE ADD COLUMN`, but a no-op when the column already exists. SQLite
 * has no `ADD COLUMN IF NOT EXISTS`, so a plain ADD throws `duplicate column
 * name` on any DB where the column predates the migration — schema drift, a DB
 * whose base `CREATE TABLE` once carried the column, or a half-applied upgrade.
 * That thrown error rolls back the migration AND fails `open()`, bricking the
 * whole store. The PRAGMA preflight makes the ADD idempotent; the caller
 * migration is still recorded applied either way. (Audit #629.)
 */
export function addColumnIfMissing(db: SqliteDbLike, table: string, column: string, columnDef: string): void {
	if (columnExists(db, table, column)) return
	if (!columnDef.trim()) throw new Error('columnDef must not be empty')
	db.exec(`ALTER TABLE ${quoteIdentifier(table, 'table')} ADD COLUMN ${quoteIdentifier(column, 'column')} ${columnDef}`)
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

	// Runtime validation complements the exclusive TypeScript union. JavaScript
	// callers and casts can bypass the type system; without this guard a migration
	// with neither body would be recorded as applied without changing the schema,
	// while one with both would silently ignore its SQL body.
	for (let i = 0; i < migrations.length; i++) {
		const migration = migrations[i] as MigrationMetadata & { sql?: unknown; run?: unknown }
		const hasSql = typeof migration.sql === 'string'
		const hasRun = typeof migration.run === 'function'
		if (hasSql === hasRun) {
			throw new Error(
				`runMigrations: migration version ${migration.version} ("${migration.name}") must define exactly one of sql/run`
			)
		}

		if (!Number.isInteger(migration.version) || migration.version <= 0) {
			throw new Error(`runMigrations: migration version must be a positive integer — got ${migration.version}`)
		}

		if (i === 0) continue
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
	const selectAppliedVersion = db.prepare('SELECT version FROM schema_migrations WHERE version = ?')
	const appliedRows = selectApplied.all() as Array<{ version: number }>
	const appliedVersions = new Set(appliedRows.map(r => r.version))

	const insertApplied = db.prepare('INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)')

	for (const m of migrations) {
		if (appliedVersions.has(m.version)) continue
		const tx = db.transaction(() => {
			// The outer read is only a fast path. Another process can commit this
			// version while we wait for BEGIN IMMEDIATE, so re-check after acquiring
			// the writer lock before executing SQL or inserting the PK again.
			if (selectAppliedVersion.get(m.version)) return

			if (typeof m.run === 'function') {
				m.run(db)
			} else {
				db.exec(m.sql)
			}

			insertApplied.run(m.version, m.name, Date.now())
		})
		tx.immediate()
	}
}
