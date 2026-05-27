/**
 * `MultiDbSqliteStore` — multi-handle SQLite store with one physical
 * `.db` file per concern (creds, axolotl, msgstore, wa, sync, media,
 * companion_devices, chatsettings, location, payments, stickers, smb,
 * prometheus — 13 files total; see `MULTI_DB_FILES`).
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
import type BetterSqlite3Module from 'better-sqlite3'

import type { ILogger } from '../logger'
import { MULTI_DB_FILES, type MultiDbFile, SCHEMAS } from './schemas'
import type { SqliteDbLike } from './types'

type Database = BetterSqlite3Module.Database
type DatabaseConstructor = typeof import('better-sqlite3')

const DEFAULT_PRAGMAS: ReadonlyArray<string> = [
	'journal_mode = WAL',
	'synchronous = NORMAL',
	'busy_timeout = 5000',
	// Defensively enabled. The 13 schemas in this folder currently do NOT
	// define `FOREIGN KEY ... REFERENCES ...` clauses (they mirror the
	// canonical mobile layout, which also keeps FK enforcement off). This
	// pragma is set so that any future schema additions that DO add foreign
	// keys (e.g. `jid_map` → `jid`, `wa_trusted_contacts` → `wa_contacts`)
	// have their cascade semantics honored without a separate per-handle
	// fix. SQLite is per-connection here, so the pragma must be present on
	// every opened handle — DEFAULT_PRAGMAS is the right place.
	'foreign_keys = ON'
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
	private readonly handles = new Map<MultiDbFile, Database>()
	private opened = false
	private openInFlight?: Promise<void>

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

		// On partial-initialization failure (bad extraPragma entry, missing
		// directory permissions on one .db, schema error inside one of the
		// later SCHEMAS, etc.), close every handle opened so far so the file
		// descriptor / WAL lock does not leak. Throw the original error so the
		// caller still sees it.
		try {
			for (const file of MULTI_DB_FILES) {
				const fullPath = path.join(this.opts.sessionDir, file)
				const db = new Database(fullPath)
				for (const pragma of DEFAULT_PRAGMAS) db.pragma(pragma)
				for (const pragma of extra) db.pragma(pragma)
				db.exec(SCHEMAS[file])
				this.handles.set(file, db)
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
		if (!db) throw new Error(`MultiDbSqliteStore: handle for "${file}" not opened (call .open() first)`)
		return db as unknown as SqliteDbLike
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
		// Snapshot the current handles regardless of `opened` state — an
		// open() in flight may have populated the Map even though `opened`
		// is still false at this instant.
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
