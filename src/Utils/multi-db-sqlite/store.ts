/**
 * `MultiDbSqliteStore` — multi-handle SQLite store with one physical
 * `.db` file per concern (creds, axolotl, msgstore, wa, sync, media,
 * companion_devices, chatsettings, location, payments, stickers, smb,
 * status, prometheus — 14 files total; see `MULTI_DB_FILES`).
 *
 * Why multiple files instead of one consolidated DB?
 *
 *   - Lock isolation: a heavy write burst on routing tables does not block
 *     point reads on session storage (message-send hot path).
 *   - Corruption blast radius: a single WAL checkpoint corruption only
 *     compromises one concern. Auth creds in `creds.db` survive a hostile
 *     write on `msgstore.db`.
 *   - Maintenance: tools like `sqlite3 axolotl.db .schema` work without
 *     needing to know table prefixes.
 *
 * Trade-off: cross-file transactions are not ACID. The only logical
 * atomicity boundary in baileys is "save N signal data types in one call",
 * and those all live inside `axolotl.db`, so the trade-off is fine.
 */
import type { ILogger } from '../logger'
import { STATUS_LAST_TIMESTAMP_TRIGGER_NAME, STATUS_LAST_TIMESTAMP_TRIGGER_SQL } from './schemas/status'
import { addColumnIfMissing, type Migration, runMigrations } from './schema-migrations'
import { MULTI_DB_FILES, type MultiDbFile, SCHEMAS } from './schemas'
import type { SqliteDbLike } from './types'

/**
 * Per-DB migration lists. Each key in this record corresponds to a
 * `MultiDbFile`. Versions are strictly monotonic per file.
 *
 * Authoring rules:
 *   - Append; never re-number, never edit a shipped migration.
 *   - To add a nullable column use the `run` form with
 *     `addColumnIfMissing(db, table, col, def)`, NOT a raw `ALTER TABLE
 *     ADD COLUMN` in `sql`. SQLite has no `ADD COLUMN IF NOT EXISTS`, so a
 *     raw ADD throws "duplicate column name" — and fails `open()` — on any
 *     DB where the column already exists (schema drift / half-applied
 *     upgrade). The `schema_migrations` bookkeeping stops a re-run in the
 *     common case, but the PRAGMA preflight is what keeps the migration
 *     safe when the column predates the bookkeeping. (Audit #629.)
 *   - **Do NOT also add the column to the `_SCHEMA` `CREATE TABLE`.**
 *     Tempting (it'd let fresh DBs skip the migration) but breaks the
 *     contract: `runMigrations` runs v1 unconditionally on the first
 *     open because `schema_migrations` is empty — so fresh DBs would
 *     hit the column twice (`CREATE TABLE` plants it, then `ALTER`
 *     errors). Likewise: a `CREATE INDEX` that references the new
 *     column belongs INSIDE the migration body — not in the base
 *     schema — or you get "no such column" on upgrade (where the
 *     `CREATE TABLE IF NOT EXISTS` is a no-op and the column does
 *     not exist yet). The migration body is the SINGLE source of
 *     truth for additions; the base `_SCHEMA` only carries the
 *     ORIGINAL columns of the table.
 */
/**
 * Recomputes `status_info.last_status_timestamp` for every row to its correct
 * newest-remaining status (same expression the AFTER DELETE trigger uses). Used
 * by the status.db v1 migration to REPAIR rows the old order-dependent trigger
 * may have left stale. Idempotent — rows already correct are recomputed to the
 * same value; a `status_info` with no live statuses gets NULL. Exported so the
 * repair is unit-testable without duplicating the SQL. (Audit #637.)
 */
export const STATUS_BACKFILL_LAST_TIMESTAMP_SQL = `
UPDATE status_info
  SET last_status_timestamp = (SELECT
    CASE WHEN COALESCE(s.server_receipt_timestamp, 0) > 0 THEN s.server_receipt_timestamp ELSE s.timestamp END
    FROM status s
    WHERE s.status_info_row_id = status_info.row_id
    AND s.type <> 8 AND s.type <> 2 AND s.is_archived = 0
    ORDER BY s.sort_id DESC LIMIT 1);
`

const MIGRATIONS: Partial<Record<MultiDbFile, ReadonlyArray<Migration>>> = {
	'wa.db': [
		{
			version: 1,
			name: 'add wa_contacts.username + index',
			// Idempotent ADD COLUMN (audit #629): a plain `ALTER TABLE ADD COLUMN`
			// throws "duplicate column name" — and fails open() — on any DB where
			// `username` already exists (schema drift / half-applied upgrade). The
			// preflight makes it a no-op in that case; the index is already
			// idempotent via IF NOT EXISTS.
			run: db => {
				addColumnIfMissing(db, 'wa_contacts', 'username', 'TEXT')
				db.exec('CREATE INDEX IF NOT EXISTS wa_contacts_username_idx ON wa_contacts (username)')
			}
		},
		{
			// The contact mirror upserts by jid (ON CONFLICT(jid)); the base
			// schema only ships a NON-unique jid index, so add a UNIQUE one. jid
			// is unique per row on mobile too (a contact's LID row and PN row have
			// distinct jids). Safe: wa_contacts had no writer before this, so no
			// pre-existing duplicate jids can break the unique build.
			version: 2,
			name: 'add wa_contacts unique jid index (contact upsert)',
			sql: `CREATE UNIQUE INDEX IF NOT EXISTS wa_contacts_jid_unique_idx ON wa_contacts (jid);`
		}
	],
	'axolotl.db': [
		{
			// Schema-fidelity only: the canonical mobile `sender_keys` carries a
			// `bucket_id` column (part of its natural key alongside group/device/
			// sender). InfiniteAPI keys sender-keys by the 4-tuple (Baileys'
			// SenderKeyName has no bucket concept), so this column stays empty and
			// is deliberately NOT added to `sender_keys_idx_v26` — adding it would
			// change the live crypto key. Present purely so introspection/dumps
			// match the mobile layout.
			version: 1,
			name: 'add sender_keys.bucket_id (schema fidelity)',
			// Idempotent ADD COLUMN (audit #629) — see wa_contacts.username above.
			run: db => addColumnIfMissing(db, 'sender_keys', 'bucket_id', "TEXT NOT NULL DEFAULT ''")
		}
	],
	'msgstore.db': [
		{
			// Existing jid_map rows predate the lid_chat_state mirror. The live
			// wrapper only marks mappings that flow through a later set(), and the
			// mapping store skips unchanged pairs, so those rows would otherwise
			// remain permanently absent. Backfill every known LID idempotently while
			// preserving the other coexistence-state columns.
			version: 1,
			name: 'backfill lid_chat_state from existing jid_map rows',
			sql: `
				INSERT OR IGNORE INTO lid_chat_state (jid_row_id, is_pn_shared)
				SELECT lid_row_id, 1 FROM jid_map;
				UPDATE lid_chat_state
				SET is_pn_shared = 1
				WHERE jid_row_id IN (SELECT lid_row_id FROM jid_map);
			`
		}
	],
	'status.db': [
		{
			// Audit #637: the AFTER DELETE `...last_status_timestamp_trigger` guarded
			// on `last_status_sort_id = old.sort_id`, a column the sibling
			// `...last_status_sort_id_trigger` overwrites — and SQLite doesn't define
			// a fire order between them, so the timestamp could be left stale. The
			// base schema now ships an order-independent body (guard on
			// `last_status_timestamp`), but `CREATE TRIGGER IF NOT EXISTS` won't
			// replace an already-created trigger on existing status.db files. DROP +
			// recreate here so upgraded DBs pick up the fixed body. Body kept
			// byte-identical to the base schema's (single logical definition).
			//
			// Swapping the trigger only prevents FUTURE staleness — a DB that already
			// ran the buggy trigger may hold a `last_status_timestamp` still pointing
			// at an already-deleted status. So we also BACKFILL every `status_info`
			// row to the correct newest-remaining status in the same (IMMEDIATE)
			// migration transaction (audit follow-up: repair, not just prevent).
			version: 1,
			name: 'fix last_status_timestamp trigger order-dependency + backfill stale aggregates',
			sql: `
				DROP TRIGGER IF EXISTS ${STATUS_LAST_TIMESTAMP_TRIGGER_NAME};
				${STATUS_LAST_TIMESTAMP_TRIGGER_SQL}
				${STATUS_BACKFILL_LAST_TIMESTAMP_SQL}
			`
		}
	],
	'location.db': [
		{
			// Audit #636: a RECEIVED live-location sharer (from_me=0) carries
			// `expires=0` — the companion never gets the share duration, correct
			// parity — so `listActiveLocationSharers` treated it as perpetually
			// active and the rows accumulated unbounded (a share that ended hours
			// ago still showed up). Add a gateway-only `received_ts` bookkeeping
			// column (orthogonal to `expires`, which keeps its parity meaning) so
			// received shares can be aged out by last-activity time. Brand-new
			// column — no DB can already have it, so a plain ADD is drift-safe.
			version: 1,
			name: 'add location_sharer.received_ts (received-share retention)',
			sql: `ALTER TABLE location_sharer ADD COLUMN received_ts INTEGER NOT NULL DEFAULT 0;`
		}
	]
}

type DatabaseConstructor = typeof import('better-sqlite3')

const DEFAULT_PRAGMAS: ReadonlyArray<string> = [
	'journal_mode = WAL',
	'synchronous = NORMAL',
	'busy_timeout = 5000',
	// Defensively enabled. The 14 schemas in this folder currently do NOT
	// define `FOREIGN KEY ... REFERENCES ...` clauses (they mirror the
	// canonical mobile layout, which also keeps FK enforcement off). This
	// pragma is set so that any future schema additions that DO add foreign
	// keys (e.g. `jid_map` → `jid`, `wa_trusted_contacts` → `wa_contacts`)
	// have their cascade semantics honored without a separate per-handle
	// fix. SQLite is per-connection here, so the pragma must be present on
	// every opened handle — DEFAULT_PRAGMAS is the right place.
	'foreign_keys = ON',
	// Audit memory MEM-001 — sem esta pragma, SQLite cai no default de
	// `-2000` (~2 MB de page cache por handle). Com 14 handles × N
	// sessões, isso vira pressão de RSS desnecessária pro workload da
	// lib (point reads em signal_kv/jid_map, sem joins grandes). `-512`
	// = 512 KiB por handle → ~7 MB por sessão em vez de ~28 MB.
	// Quem precisa de mais cache pode override via `extraPragmas`.
	'cache_size = -512',
	// Audit memory MEM-002 — `mmap_size = 0` desabilita explicitamente o
	// memory-mapped I/O. better-sqlite3 já usa 0 por default em builds
	// padrão, mas algumas distros Linux compilam com `SQLITE_DEFAULT_
	// MMAP_SIZE` ≠ 0 e o VSZ infla sem refletir consumo real, dificultando
	// diagnóstico de leak. Defensivo.
	'mmap_size = 0'
]

async function loadBetterSqlite3(): Promise<DatabaseConstructor> {
	try {
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		const mod = (await import('better-sqlite3')) as any
		return mod.default ?? mod
	} catch (err) {
		const e = new Error(
			'`better-sqlite3` is required for `MultiDbSqliteStore`. Install it: `npm install better-sqlite3`.'
		)
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		;(e as any).cause = err
		throw e
	}
}

export type MultiDbSqliteStoreOptions = {
	/**
	 * Directory where the per-concern `.db` files are written. Created if
	 * missing. Each session typically gets its own directory.
	 */
	sessionDir: string
	/**
	 * Extra `PRAGMA` statements applied to every opened handle after the
	 * defaults. Useful for ops tuning (e.g. `'cache_size = -8000'`).
	 */
	extraPragmas?: ReadonlyArray<string>
	/**
	 * Optional logger for init / migration visibility.
	 */
	logger?: ILogger
}

/**
 * Holds the open handles for all multi-DB files in a single session. The
 * handles are opened by {@link open} and closed together via {@link close}.
 */
export class MultiDbSqliteStore {
	// Typed as `SqliteDbLike` (the local structural interface) so the
	// emitted `.d.ts` does not leak `better-sqlite3` types into the public
	// declaration surface — TypeScript includes private members in the
	// generated declarations, and this Map's value type would otherwise
	// pull `BetterSqlite3Module.Database` into every consumer that imports
	// from `baileys/Utils`.
	private readonly handles = new Map<MultiDbFile, SqliteDbLike>()
	private opened = false
	private openInFlight?: Promise<void>
	// Monotonic counter incremented on every close(). `runOpen()` captures
	// the generation at start and aborts (closing its own newly-opened
	// handles) if the generation changed mid-flight — this is the abort
	// mechanism close() uses to interrupt a concurrent open() without
	// leaking handles or leaving `opened=true` after teardown.
	private openGeneration = 0

	constructor(private readonly opts: MultiDbSqliteStoreOptions) {}

	async open(): Promise<void> {
		if (this.opened) return
		// Concurrency-safe open: if a second caller hits open() while the first
		// is still inside the async init below, return the in-flight promise so
		// both end up sharing the same set of handles rather than racing to
		// create duplicates.
		if (this.openInFlight) return this.openInFlight

		this.openInFlight = this.runOpen()
		try {
			await this.openInFlight
		} finally {
			this.openInFlight = undefined
		}
	}

	private async runOpen(): Promise<void> {
		const fs = await import('node:fs')
		const path = await import('node:path')

		fs.mkdirSync(this.opts.sessionDir, { recursive: true })

		const Database = await loadBetterSqlite3()
		const extra = this.opts.extraPragmas ?? []

		// Capture the generation at the start. If close() runs while we
		// are still here, it will increment this counter — we then know
		// the caller has explicitly torn the store down and we must abort
		// (closing the just-opened db) instead of stashing it.
		const startGen = this.openGeneration

		// On partial-initialization failure (bad extraPragma entry, missing
		// directory permissions on one .db, schema error inside one of the
		// later SCHEMAS, etc.), close every handle opened so far so the file
		// descriptor / WAL lock does not leak. Throw the original error so the
		// caller still sees it.
		try {
			for (const file of MULTI_DB_FILES) {
				const fullPath = path.join(this.opts.sessionDir, file)
				const db = new Database(fullPath)
				// Register the handle in the map IMMEDIATELY after construction,
				// before any pragma/schema work that could throw. The outer
				// catch below closes every handle currently in the map, so if
				// `db.pragma()` or `db.exec(SCHEMAS[file])` blows up for THIS
				// file we still close it (otherwise the brand-new handle
				// would never have made it into the map and would leak its
				// fd / WAL lock).
				//
				// Boundary cast: the Map is typed `SqliteDbLike` so the
				// emitted `.d.ts` does not pull `better-sqlite3` types. At
				// runtime the value IS a `better-sqlite3` `Database`; the
				// `SqliteDbLike` interface matches the methods we use.
				this.handles.set(file, db as unknown as SqliteDbLike)

				for (const pragma of DEFAULT_PRAGMAS) db.pragma(pragma)
				for (const pragma of extra) db.pragma(pragma)
				db.exec(SCHEMAS[file])
				// Apply per-DB migrations after the base schema is in place.
				// Empty list today, but the bookkeeping table is created on
				// the first call so future migrations have somewhere to
				// record their applied state.
				const fileMigrations = MIGRATIONS[file]
				if (fileMigrations && fileMigrations.length > 0) {
					runMigrations(db as unknown as SqliteDbLike, fileMigrations)
				} else {
					// Still create the bookkeeping table so the first real
					// migration in a future PR doesn't have to special-case
					// "table doesn't exist yet" for already-deployed dbs.
					runMigrations(db as unknown as SqliteDbLike, [])
				}

				// Abort check: if close() bumped the generation while we were
				// in here, close this brand-new handle and stop. close() has
				// already cleared `this.handles` and reset `opened=false`;
				// we must not re-populate the map.
				if (this.openGeneration !== startGen) {
					try {
						db.close()
					} catch {
						// Best effort — the store is being torn down anyway.
					}

					this.handles.delete(file)
					return
				}

				this.opts.logger?.info?.({ file, path: fullPath }, 'multi-db-sqlite: opened')
			}
		} catch (err) {
			for (const [file, db] of this.handles) {
				try {
					db.close()
				} catch (closeErr) {
					this.opts.logger?.warn?.({ file, err: closeErr }, 'multi-db-sqlite: cleanup close failed')
				}
			}

			this.handles.clear()
			throw err
		}

		// Final generation check before flipping `opened=true`: if close()
		// ran AFTER the loop but BEFORE we get here, do not resurrect the
		// store. The handles we just opened are now in `this.handles` —
		// close them and clear the map so the postcondition matches what
		// close() established.
		if (this.openGeneration !== startGen) {
			for (const [file, db] of this.handles) {
				try {
					db.close()
				} catch (closeErr) {
					this.opts.logger?.warn?.({ file, err: closeErr }, 'multi-db-sqlite: post-close cleanup failed')
				}
			}

			this.handles.clear()
			return
		}

		this.opened = true
	}

	/**
	 * Returns the opened handle for the given DB file. Throws if the store
	 * has not been opened yet — callers should always {@link open} first.
	 *
	 * The return type is the local {@link SqliteDbLike} structural
	 * interface (NOT `better-sqlite3.Database`), so the generated `.d.ts`
	 * does not force every TypeScript consumer of `baileys/Utils` to
	 * resolve `better-sqlite3`'s typings — preserving the optional
	 * peer-dependency contract. The runtime value is an actual
	 * `better-sqlite3` `Database` instance; internal callers cast at the
	 * boundary when they need the typed API.
	 */
	handle(file: MultiDbFile): SqliteDbLike {
		const db = this.handles.get(file)
		if (!db) {
			// Distinguish "never opened" from "already closed" so callers
			// don't spend time chasing a missing `await store.open()` call
			// when the real cause is a teardown that happened earlier.
			const state = this.opened ? 'closed' : 'not yet opened (call .open() first)'
			throw new Error(`MultiDbSqliteStore: handle for "${file}" is ${state}`)
		}

		return db
	}

	/**
	 * Closes every opened handle. Safe to call multiple times; subsequent
	 * calls are no-ops. After close, the same `sessionDir` can be re-opened
	 * via a fresh store instance.
	 *
	 * If `close()` is invoked while an `open()` is still in flight, the
	 * `openInFlight` promise has already added handles to `this.handles`
	 * one by one — we still walk the map and close whatever is there. Then
	 * `opened` is set false so the still-pending open() resolves into a
	 * closed store: subsequent `handle()` lookups will throw with the
	 * "not opened" message, which is the correct postcondition for a
	 * caller that explicitly tore the store down.
	 */
	close(): void {
		// Bump the generation FIRST so a concurrent runOpen() observes the
		// change on its next checkpoint and aborts cleanly. Then snapshot
		// the handles currently in the map and close them — runOpen() may
		// have added some between its last checkpoint and this point, but
		// the generation bump guarantees it will not add MORE after this.
		this.openGeneration++
		const handlesToClose = Array.from(this.handles.entries())
		this.handles.clear()
		this.opened = false
		for (const [file, db] of handlesToClose) {
			try {
				db.close()
			} catch (err) {
				this.opts.logger?.warn?.({ file, err }, 'multi-db-sqlite: close failed')
			}
		}
	}
}
