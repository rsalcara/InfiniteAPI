import { existsSync } from 'fs'
import { dirname } from 'path'
import { proto } from '../../WAProto/index.js'
import type { AuthenticationCreds, AuthenticationState, SignalDataSet, SignalDataTypeMap } from '../Types'
import { prepareInClause } from './multi-db-sqlite/in-statement-cache'
import { StartChatTrustSignalsBackend } from './multi-db-sqlite/start-chat-trust-signals-backend'
import type { SqliteDbLike } from './multi-db-sqlite/types'
import { SqliteAppStateSyncKeyStore } from './app-state-sync-key-store'
import { initAuthCreds } from './auth-utils'
import { BufferJSON } from './generics'
import { SqliteHistorySyncStore } from './history-sync-store'
import type { ILogger } from './logger'
import { ensurePrivateFileSync, restrictFileSync } from './private-fs'
import type { SqliteDatabase, SqliteDriverName } from './sqlite-driver'
import { loadSqliteDriver } from './sqlite-driver'

const SIDECAR_SUFFIXES = ['-wal', '-shm', '-journal']

/**
 * The file `driver` opens for `dbPath`, or undefined for an in-memory
 * database. better-sqlite3 takes a `file:` path as a literal name; node:sqlite
 * reads it as an SQLite URI (`file:[//localhost]path[?query]`). `create` is
 * false when the URI asks SQLite not to create the file (mode=ro/rw).
 *
 * @internal exported for tests
 */
export const sqliteDatabaseFile = (
	driver: SqliteDriverName,
	dbPath: string
): { file: string; create: boolean } | undefined => {
	const trimmed = dbPath.trim()
	if (trimmed === '' || trimmed === ':memory:') return undefined
	if (driver !== 'node:sqlite' || !trimmed.startsWith('file:')) return { file: dbPath, create: true }

	const uri = trimmed.slice('file:'.length).split('#')[0]!
	const queryStart = uri.indexOf('?')
	let file = queryStart === -1 ? uri : uri.slice(0, queryStart)
	// immutable=1 is NOT a no-create flag: SQLite still creates a missing file
	// (empty, umask mode) and only rejects writes, so it is pre-created 0600.
	const mode = new URLSearchParams(queryStart === -1 ? '' : uri.slice(queryStart + 1)).get('mode')
	if (mode === 'memory') return undefined
	if (file.startsWith('//')) {
		// SQLite accepts only an empty or `localhost` authority and rejects any
		// other host, so there is nothing to create for it.
		const pathStart = file.indexOf('/', 2)
		const authority = pathStart === -1 ? file.slice(2) : file.slice(2, pathStart)
		if (authority !== '' && authority.toLowerCase() !== 'localhost') return undefined
		file = pathStart === -1 ? '' : file.slice(pathStart)
	}

	try {
		file = decodeURIComponent(file)
	} catch {
		return undefined
	}

	if (process.platform === 'win32' && /^\/[A-Za-z]:/.test(file)) file = file.slice(1)
	if (file === '' || file === ':memory:') return undefined
	return { file, create: mode !== 'ro' && mode !== 'rw' }
}

/**
 * Before SQLite opens it: creates the database 0600 (SQLite would use the
 * umask default; -wal/-shm inherit its mode) and restricts sidecars left by a
 * previous version or crash (audit S-01). A missing directory is left to the
 * driver, which reports it with its own error.
 */
const securePrivateDatabase = (file: string, create: boolean) => {
	if (!existsSync(dirname(file))) return
	if (create) ensurePrivateFileSync(file)
	else restrictFileSync(file)
	for (const suffix of SIDECAR_SUFFIXES) restrictFileSync(`${file}${suffix}`)
}

/**
 * Restricts the file SQLite really opened (and its sidecars) to 0600, in case
 * the path resolved differently from {@link sqliteDatabaseFile}. In-memory
 * databases report an empty file.
 */
const restrictOpenedDatabase = (db: SqliteDatabase) => {
	const rows = db.pragma('database_list') as Array<{ name?: string; file?: string }>
	const file = rows.find(row => row.name === 'main')?.file
	if (!file) return
	restrictFileSync(file)
	for (const suffix of SIDECAR_SUFFIXES) restrictFileSync(`${file}${suffix}`)
}

const CREDS_ROW_KEY = '__creds__'

const CREATE_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS creds (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS signal_keys (
  type TEXT NOT NULL,
  id TEXT NOT NULL,
  value TEXT NOT NULL,
  PRIMARY KEY (type, id)
);
-- Audit S-05: PRIMARY KEY (type, id) already serves lookups by type.
DROP INDEX IF EXISTS signal_keys_type_idx;
CREATE TABLE IF NOT EXISTS start_chat_trust_signals (
  jid TEXT PRIMARY KEY NOT NULL,
  is_sender_suspicious INTEGER,
  is_sender_new_account INTEGER,
  created_ts REAL
);
`

/**
 * PRAGMA defaults aligned with WhatsApp's own mobile pattern:
 *   - `journal_mode = WAL`   — concurrent reads alongside a single writer
 *   - `synchronous = NORMAL` — fsync at checkpoint boundaries only (sufficient
 *     for auth state; data loss window is <= 1 WAL checkpoint)
 *   - `busy_timeout = 5000`  — InfiniteAPI addition: lets the engine wait up to
 *     5 s on a contended write before returning SQLITE_BUSY. Combined with the
 *     `set()` retry wrapper below this absorbs short cross-process contention
 *     bursts (e.g. concurrent migrations or sidecar processes touching the same
 *     db) without escalating to the caller.
 */
// busy_timeout must precede WAL negotiation so a briefly contended database
// waits for the other connection instead of failing journal-mode setup.
// journal_size_limit bounds the -wal residue left by a large transaction
// (64 MiB); without it the file keeps its peak size (SQLite default -1).
const DEFAULT_PRAGMAS: ReadonlyArray<string> = [
	'busy_timeout = 5000',
	'journal_mode = WAL',
	'synchronous = NORMAL',
	'journal_size_limit = 67108864',
	// Audit S-02: deleted keys are overwritten, not left in free pages (the
	// app runs its databases with secure_delete on).
	'secure_delete = ON',
	// Audit S-12: the app runs its key store with the SQLite default page
	// cache (2000 KiB). Both drivers otherwise open with 16000 KiB; measured
	// with 50k keys (`scripts/bench/sqlite-app-pragmas.ts`) that only adds
	// ~13 MiB per session without faster reads or writes.
	'cache_size = -2000'
]

/**
 * Total attempts (NOT additional retries) for SQLITE_BUSY on the per-call
 * BEGIN IMMEDIATE write. A value of `5` means up to 5 calls into
 * `applySetTx.immediate(...)` before propagating the error.
 *
 * Copilot fix: previous name was `MAX_BUSY_RETRIES` paired with
 * `attempt <= MAX_BUSY_RETRIES`, which gave 6 total attempts when the
 * caller intuition was 5. Renamed to `MAX_BUSY_ATTEMPTS` + `attempt < ...`
 * so the loop bound matches the constant's meaning and the
 * `attempts: attempt + 1` log field reads consistently.
 */
const MAX_BUSY_ATTEMPTS = 5
/** Backoff floor between retry attempts (jittered 0.5× – 1.5×). */
const BUSY_RETRY_BASE_MS = 25

/**
 * Public configuration shape for {@link useSqliteAuthState}.
 *
 * Codex P1 fix (round-3): `database` is typed `unknown` rather than the
 * internal `Database` alias so this exported type does NOT carry a hard
 * dependency on a concrete SQLite driver's declarations. Consumers who never use
 * SQLite can import baileys' public types without needing
 * `@types/better-sqlite3` resolvable in their project. The runtime
 * expectation is unchanged for existing callers; a compatible handle from
 * `loadSqliteDriver` is also accepted.
 */
export type SqliteAuthStateOptions = {
	/**
	 * Filesystem path to the SQLite database file. The file will be created if
	 * it does not exist. Use `':memory:'` for an in-process ephemeral store
	 * (useful in tests).
	 */
	dbPath: string
	/**
	 * If supplied, overrides the default driver loader — primarily
	 * for tests / advanced consumers that want to inject a pre-opened
	 * handle.
	 *
	 * **Runtime contract**: must be a compatible SQLite `Database` handle.
	 * Typed as `unknown` here so consumers who don't use SQLite never need
	 * to resolve `better-sqlite3` types (the field is cast at the boundary
	 * inside the implementation).
	 */
	database?: unknown
	/**
	 * Additional `PRAGMA` statements to apply after the defaults. Use this for
	 * ops tuning (e.g. `'cache_size = -8000'`, `'mmap_size = 268435456'`)
	 * without re-implementing the whole init path. Each entry is passed
	 * verbatim to `db.pragma(...)`.
	 */
	extraPragmas?: ReadonlyArray<string>
	/**
	 * Optional logger for visibility into init / contention / migration paths.
	 * If omitted, the store runs silently.
	 */
	logger?: ILogger
}

function sleep(ms: number) {
	return new Promise<void>(resolve => setTimeout(resolve, ms))
}

/**
 * SQLite-backed authentication state for Baileys.
 *
 * Adapted from upstream WhiskeySockets/Baileys #2575 (Stage 5) with InfiniteAPI
 * additions:
 *   - `busy_timeout` PRAGMA + retry wrapper around the per-call BEGIN IMMEDIATE
 *     so transient SQLITE_BUSY under cross-process contention is absorbed
 *     rather than propagated to the caller as an error;
 *   - optional `extraPragmas` for ops tuning without forking;
 *   - optional `logger` for init / migration / contention observability.
 *
 * Why this and not `useMultiFileAuthState`?
 *   - cross-process safe (SQLite handles file locking);
 *   - true per-call atomicity via `BEGIN IMMEDIATE; ...; COMMIT` — a multi-type
 *     `set({ session, 'identity-key' })` either commits both types or rolls
 *     back the whole call (closes the cross-file gap that the multi-file
 *     adapter can only approximate);
 *   - constant-time point reads under arbitrarily large state;
 *   - efficient `list`/`listIds` enumeration for bulk operations and migration.
 *   - WhatsApp's mobile clients use SQLite + WAL for `msgstore.db` /
 *     `axolotl.db` — this adapter mirrors that pattern.
 *
 * Concurrency contract:
 *   - point reads via prepared statements (constant-time, no transaction);
 *   - each `set()` runs as a single `BEGIN IMMEDIATE` ... `COMMIT` so the
 *     entire multi-type payload commits atomically or rolls back; under
 *     SQLITE_BUSY the call retries up to `MAX_BUSY_ATTEMPTS` times with
 *     jittered backoff before propagating;
 *   - `clear()` is a single statement and serializes naturally;
 *   - `list`/`listIds` use streaming iterators — readers do not block the
 *     single writer under WAL mode.
 *
 * Lifecycle:
 *   - the returned `close()` closes the underlying SQLite handle;
 *   - the same `dbPath` can be reopened after `close()` to resume.
 *
 * For migrating an existing on-disk `useMultiFileAuthState` folder to this
 * store, see {@link migrateAuthState}.
 */
export async function useSqliteAuthState(opts: SqliteAuthStateOptions): Promise<{
	state: AuthenticationState
	saveCreds: () => Promise<void>
	close: () => void
}> {
	// Track whether this function created the handle. If we did and any
	// subsequent init step (pragma / exec / prepare / loadCreds) throws, we
	// need to close the native handle ourselves — otherwise the caller never
	// sees a `close()` to call and the file descriptor / WAL lock leaks on
	// the startup failure path.
	let db: SqliteDatabase | undefined
	const ownsDb = !opts.database
	try {
		if (opts.database) {
			// Boundary cast: public type is `unknown` to avoid leaking
			// Concrete driver types stay internal so the emitted .d.ts remains
			// optional-peer-dependency friendly.
			db = opts.database as SqliteDatabase
		} else {
			const driver = await loadSqliteDriver(opts.logger)
			const target = opts.dbPath ? sqliteDatabaseFile(driver.name, opts.dbPath) : undefined
			if (target) securePrivateDatabase(target.file, target.create)

			db = driver.open(opts.dbPath)
			opts.logger?.debug({ dbPath: opts.dbPath }, 'sqlite auth state opened')
		}

		for (const pragma of DEFAULT_PRAGMAS) {
			db.pragma(pragma)
		}

		if (ownsDb) restrictOpenedDatabase(db)

		if (opts.extraPragmas?.length) {
			for (const pragma of opts.extraPragmas) {
				db.pragma(pragma)
			}

			opts.logger?.debug({ extraPragmas: opts.extraPragmas }, 'applied extra pragmas')
		}

		if (Number(db.pragma('secure_delete', { simple: true })) !== 1) {
			opts.logger?.warn({}, 'sqlite auth state: secure_delete is not active on this database')
		}

		db.exec(CREATE_SCHEMA_SQL)
		const historySync = new SqliteHistorySyncStore(db as unknown as SqliteDbLike)
		const appStateSyncKeys = new SqliteAppStateSyncKeyStore(db as unknown as SqliteDbLike)
		const startChatTrustSignalsBackend = new StartChatTrustSignalsBackend(db as unknown as SqliteDbLike)

		const stmts = {
			credsSelect: db.prepare('SELECT value FROM creds WHERE key = ?'),
			credsUpsert: db.prepare(
				'INSERT INTO creds (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
			),
			keySelect: db.prepare('SELECT value FROM signal_keys WHERE type = ? AND id = ?'),
			keyUpsert: db.prepare(
				'INSERT INTO signal_keys (type, id, value) VALUES (?, ?, ?) ON CONFLICT(type, id) DO UPDATE SET value = excluded.value'
			),
			keyDelete: db.prepare('DELETE FROM signal_keys WHERE type = ? AND id = ?'),
			keyListIds: db.prepare('SELECT id FROM signal_keys WHERE type = ?'),
			keyList: db.prepare('SELECT id, value FROM signal_keys WHERE type = ?'),
			clearKeys: db.prepare('DELETE FROM signal_keys')
		}
		// Cached batched `IN (…)` SELECT so a multi-id `keys.get(type, [a, b, c])`
		// lands as one round-trip instead of N point selects. The legacy loop
		// over `stmts.keySelect.get(type, id)` was a real fan-out cost on
		// group sends with ≥10 recipients.
		const keySelectIn = prepareInClause(
			db as unknown as Parameters<typeof prepareInClause>[0],
			'SELECT id, value FROM signal_keys WHERE type = ? AND id IN (',
			')'
		)
		const clearAuthKeysAndHistory = db.transaction(() => {
			stmts.clearKeys.run()
			startChatTrustSignalsBackend.clear()
			db!.exec(
				'DELETE FROM history_sync_jobs; DELETE FROM history_sync_checkpoints; DELETE FROM history_sync_metadata; ' +
					'DELETE FROM missing_keys; DELETE FROM peer_messages WHERE message_type IN (38, 39);'
			)
		})

		const loadCreds = (): AuthenticationCreds => {
			const row = stmts.credsSelect.get(CREDS_ROW_KEY) as { value: string } | undefined
			if (!row) return initAuthCreds()
			try {
				return JSON.parse(row.value, BufferJSON.reviver) as AuthenticationCreds
			} catch (cause) {
				// Copilot round-6 fix: wrap the raw `SyntaxError` so operators
				// get the same diagnostic context as the multi-file adapter's
				// `AuthFileCorruptError`. Without this, a torn write to the
				// SQLite `creds` row surfaces as a bare "Unexpected token ..."
				// stack with no indication of WHICH database / row failed.
				// `cause` preserves the original parse exception so any
				// existing handler chain still sees it.
				//
				// SEC fix: `dbPath` is logged INTERNALLY via the logger (which
				// goes to the operator's own structured logs) but NOT included
				// in the thrown Error's `message`. Session paths often encode
				// user identifiers (`/sessions/<userId>/creds.db`), and
				// external aggregators (Sentry, DataDog) routinely capture
				// `error.message` — keeping the path out of that string keeps
				// the identifier out of third-party logging surfaces.
				opts.logger?.error(
					{ dbPath: opts.dbPath, rowKey: CREDS_ROW_KEY, cause },
					'sqlite-auth-state: creds row corrupt or unreadable'
				)
				const error = new Error(`Auth state SQLite creds row is corrupt or unreadable (key=${CREDS_ROW_KEY})`)
				// eslint-disable-next-line @typescript-eslint/no-explicit-any
				;(error as any).cause = cause
				// `dbPath` intentionally NOT attached to the Error object —
				// see the logger.error() above. Operators inspecting the
				// thrown Error get the row key without leaking session paths
				// into external structured logs.
				// eslint-disable-next-line @typescript-eslint/no-explicit-any
				;(error as any).rowKey = CREDS_ROW_KEY
				throw error
			}
		}

		const persistCreds = (creds: AuthenticationCreds): void => {
			stmts.credsUpsert.run(CREDS_ROW_KEY, JSON.stringify(creds, BufferJSON.replacer))
		}

		const creds = loadCreds()

		// One BEGIN IMMEDIATE transaction per `set` call covers every type +
		// every id at once. better-sqlite3's `transaction()` defaults to
		// DEFERRED — the write lock is only acquired on the first writing
		// statement, which under concurrency can produce `SQLITE_BUSY` if
		// two callers race to upgrade their readers to writers. We invoke
		// via the `.immediate(...)` flavour below so the write lock is
		// taken up front and the whole call either gets the lock or fails
		// fast, without leaving the caller mid-write.
		const applySetTx = db.transaction((data: SignalDataSet) => {
			for (const category in data) {
				const type = category as keyof SignalDataTypeMap
				const bucket = data[type]
				if (!bucket) continue
				for (const id in bucket) {
					const value = bucket[id]
					// Copilot round-6 fix: treat BOTH `null` and `undefined` as the
					// delete sentinel, matching the multi-file adapter and the
					// cache layer (`makeCacheableSignalKeyStore`). The previous
					// `if (value === null)` would fall through to upsert when
					// `value === undefined`; `JSON.stringify(undefined, ...)`
					// returns the literal `undefined` (not a string), which
					// better-sqlite3 binds as NULL, violating the schema's
					// `value TEXT NOT NULL` constraint and surfacing as a
					// confusing SQLITE_CONSTRAINT_NOTNULL error to the caller.
					if (value === null || value === undefined) {
						stmts.keyDelete.run(type, id)
					} else {
						stmts.keyUpsert.run(type, id, JSON.stringify(value, BufferJSON.replacer))
					}
				}
			}
		})

		/**
		 * InfiniteAPI addition: retry `applySetTx.immediate(...)` on SQLITE_BUSY
		 * with jittered backoff. The `busy_timeout` pragma absorbs most
		 * contention internally, but if the timer expires under sustained
		 * contention the call still throws SQLITE_BUSY. This wrapper smooths
		 * that out for the multi-process case (sidecar inspectors, parallel
		 * migrations) without changing single-process behaviour.
		 *
		 * Only SQLITE_BUSY / SQLITE_BUSY_SNAPSHOT are retried. Other errors
		 * (SQLITE_CORRUPT, type errors, schema mismatch) propagate immediately.
		 */
		const runSetWithBusyRetry = async (data: SignalDataSet) => {
			let lastError: unknown
			for (let attempt = 0; attempt < MAX_BUSY_ATTEMPTS; attempt++) {
				try {
					applySetTx.immediate(data)
					if (attempt > 0) {
						opts.logger?.debug({ attempts: attempt + 1 }, 'sqlite set succeeded after retries')
					}

					return
				} catch (err: unknown) {
					lastError = err
					// eslint-disable-next-line @typescript-eslint/no-explicit-any
					const code = (err as any)?.code as string | undefined
					const isBusy = code === 'SQLITE_BUSY' || code === 'SQLITE_BUSY_SNAPSHOT'
					if (!isBusy || attempt === MAX_BUSY_ATTEMPTS - 1) {
						throw err
					}

					const jitter = 0.5 + Math.random()
					const delay = Math.round(BUSY_RETRY_BASE_MS * Math.pow(2, attempt) * jitter)
					opts.logger?.debug({ attempt: attempt + 1, delay, code }, 'sqlite set busy, retrying')
					await sleep(delay)
				}
			}

			// Defensive — loop above always either returns or throws when
			// MAX_BUSY_ATTEMPTS >= 1. The fallback `Error` covers the
			// impossible-today MAX_BUSY_ATTEMPTS=0 path so handlers that
			// look at `err.message`/`err.stack` never see `undefined`.
			throw lastError ?? new Error('runSetWithBusyRetry: no attempts were made (MAX_BUSY_ATTEMPTS=0?)')
		}

		// `db` is captured by `close` below; the non-null narrowing inside this
		// successful-init branch is local.
		const handle = db
		// Cubic/Codex P2 fix: close() must NOT tear down a caller-owned
		// `opts.database` handle. The caller passed an already-open instance
		// and may be reusing it elsewhere (e.g. shared connection pool,
		// inspector sidecar). Capture ownership at init time so `close()`
		// only acts on handles we opened ourselves.
		const closeOwnsDb = ownsDb
		const stateRef: { creds: AuthenticationCreds } = { creds }
		return {
			state: {
				get creds() {
					return stateRef.creds
				},
				set creds(value: AuthenticationCreds) {
					stateRef.creds = value
				},
				historySync,
				appStateSyncKeys,
				startChatTrustSignals: {
					get: jid => startChatTrustSignalsBackend.get(jid),
					save: record => startChatTrustSignalsBackend.save(record),
					exportState: async () => ({ records: startChatTrustSignalsBackend.list() }),
					importState: async snapshot => {
						for (const record of snapshot.records) startChatTrustSignalsBackend.save(record)
						return { records: snapshot.records.length }
					}
				},
				storage: {
					backend: 'sqlite' as const,
					historySyncDurable: true,
					tcTokenDurable: true
				},
				keys: {
					get: async (type, ids) => {
						const out: Record<string, SignalDataTypeMap[typeof type]> = {}
						if (ids.length === 0) return out
						const rows = keySelectIn.all([type], ids) as Array<{ id: string; value: string }>
						for (const row of rows) {
							// eslint-disable-next-line @typescript-eslint/no-explicit-any
							let value: any = JSON.parse(row.value, BufferJSON.reviver)
							if (type === 'app-state-sync-key' && value) {
								value = proto.Message.AppStateSyncKeyData.fromObject(value)
							}

							out[row.id] = value as SignalDataTypeMap[typeof type]
						}

						return out
					},
					set: async data => {
						await runSetWithBusyRetry(data)
					},
					clear: async () => {
						clearAuthKeysAndHistory.immediate()
					},
					list: async function* <T extends keyof SignalDataTypeMap>(
						type: T
					): AsyncIterable<readonly [string, SignalDataTypeMap[T]]> {
						for (const row of stmts.keyList.iterate(type) as Iterable<{ id: string; value: string }>) {
							// eslint-disable-next-line @typescript-eslint/no-explicit-any
							let value: any = JSON.parse(row.value, BufferJSON.reviver)
							if (type === 'app-state-sync-key' && value) {
								value = proto.Message.AppStateSyncKeyData.fromObject(value)
							}

							yield [row.id, value as SignalDataTypeMap[T]] as const
						}
					},
					listIds: async function* <T extends keyof SignalDataTypeMap>(type: T): AsyncIterable<string> {
						for (const row of stmts.keyListIds.iterate(type) as Iterable<{ id: string }>) {
							yield row.id
						}
					}
				}
			},
			saveCreds: async () => {
				// Read through the stateRef so a caller that REASSIGNS
				// `state.creds = newObj` (instead of mutating in place) is
				// honored — without this, the original `creds` captured in
				// the closure would silently shadow the new object and
				// `persistCreds(creds)` would serialize stale credentials.
				persistCreds(stateRef.creds)
			},
			close: () => {
				if (closeOwnsDb) {
					// Keep planner statistics current for the next session
					// (bounded by SQLite's automatic analysis limit). Best-effort.
					try {
						handle.exec('PRAGMA optimize')
					} catch (err) {
						opts.logger?.debug({ dbPath: opts.dbPath, err }, 'sqlite auth state: PRAGMA optimize before close failed')
					}

					handle.close()
					opts.logger?.debug({ dbPath: opts.dbPath }, 'sqlite auth state closed')
				} else {
					// Caller injected the handle — lifecycle belongs to them.
					opts.logger?.debug({ dbPath: opts.dbPath }, 'sqlite auth state released (injected handle, not closed)')
				}
			}
		}
	} catch (err) {
		// Init failed AFTER we opened the handle (or while opening it). If we
		// own the handle, close it so the file descriptor / WAL lock doesn't
		// leak — the caller never received a `close()` to call. If the caller
		// passed an existing `opts.database`, leave it alone; lifecycle is
		// theirs.
		if (ownsDb && db) {
			try {
				db.close()
			} catch {
				// best-effort — original error wins.
			}
		}

		opts.logger?.error({ err }, 'sqlite auth state init failed')
		throw err
	}
}
