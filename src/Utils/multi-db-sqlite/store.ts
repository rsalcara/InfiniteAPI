/**
 * `MultiDbSqliteStore` — multi-handle SQLite store with one physical
 * `.db` file per concern (creds, axolotl, msgstore, wa, sync, media,
 * companion_devices, chatsettings, location, stickers, status — 11 files
 * total; see `MULTI_DB_FILES`).
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
import {
	normalizeLocationTimestampUnits,
	repairOpenEndedLocationSharerExpiry,
	restoreCanonicalLocationSharerSchema
} from './location-migrations'
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
		},
		{
			version: 2,
			name: 'complete identities verification columns',
			run: db => {
				addColumnIfMissing(db, 'identities', 'account_encryption_attestation_type', 'INTEGER NOT NULL DEFAULT 0')
				addColumnIfMissing(db, 'identities', 'mark_as_verified', 'INTEGER')
				addColumnIfMissing(db, 'identities', 'mark_as_verified_action_seq', 'INTEGER')
			}
		},
		{
			version: 3,
			name: 'drop legacy jid-row keyed identity mirrors',
			// Older InfiniteAPI builds used msgstore.jid._id as recipient_id
			// and stored BufferJSON text in public_key. Neither matches Android,
			// whose key is the numeric PN/LID and whose public_key is raw bytes.
			// signal_kv remains the complete compatibility copy; auth-state
			// initialization rehydrates corrected typed rows from it.
			sql: `DELETE FROM identities WHERE recipient_id <> -1;`
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
		},
		{
			version: 2,
			name: 'deduplicate poll selections, repair totals, and enforce natural key',
			sql: `
				DELETE FROM message_add_on_poll_vote_selected_option
				WHERE _id NOT IN (
					SELECT MIN(_id) FROM message_add_on_poll_vote_selected_option
					GROUP BY message_add_on_row_id, message_poll_option_id
				);
				UPDATE message_poll_option
				SET vote_total = (
					SELECT COUNT(*)
					FROM message_add_on_poll_vote_selected_option selected
					WHERE selected.message_poll_option_id = message_poll_option._id
				);
				CREATE UNIQUE INDEX IF NOT EXISTS message_add_on_poll_vote_selected_option_unique_idx
				ON message_add_on_poll_vote_selected_option (message_add_on_row_id, message_poll_option_id);
			`
		},
		{
			// Older mirror writers left message.status NULL. The official
			// Android history importer initializes received messages to 0 and
			// own-account history to at least server-ack (4). This conservative
			// repair makes legacy rows usable without claiming delivery/read;
			// later live receipts advance them through 5/13/8.
			version: 3,
			name: 'backfill missing Android message status values',
			sql: `
				UPDATE message
				SET status = CASE WHEN from_me = 1 THEN 4 ELSE 0 END
				WHERE status IS NULL;
			`
		},
		{
			version: 4,
			name: 'backfill provable Android message types from satellites',
			// Payload protos are intentionally not retained in msgstore.db, so
			// only repair rows whose relational satellites prove the exact type.
			// Ambiguous legacy UI rows remain NULL until a richer reprocess heals
			// them through the upsert; inventing 45/54/55 would not be 1:1.
			sql: `
					UPDATE message
					SET message_type = 66
					WHERE message_type IS NULL
					AND EXISTS (
						SELECT 1 FROM message_poll_option mpo
						WHERE mpo.message_row_id = message._id
					);
				`
		},
		{
			version: 5,
			name: 'add Android album root mirror',
			// Official WhatsApp Business 2.26.27.83 stores AlbumMessage roots
			// as message_type=99 and attaches their counters here. Existing
			// NULL rows cannot be backfilled safely because msgstore does not
			// retain the original protobuf; live/history reprocessing heals
			// them through the natural-key upsert.
			sql: `
				CREATE TABLE IF NOT EXISTS message_album (
					message_row_id INTEGER PRIMARY KEY,
					image_count INTEGER NOT NULL DEFAULT 0,
					video_count INTEGER NOT NULL DEFAULT 0,
					expected_image_count INTEGER,
					expected_video_count INTEGER
				);
			`
		},
		{
			version: 6,
			name: 'add Android sticker-pack message mirror',
			// Exact WhatsApp Business 2.26.27.83 msgstore tables and indexes.
			// Existing type-105 rows cannot be reconstructed: their protobuf
			// manifest was never retained. Live/history reprocessing fills the
			// tables through the natural-key upsert without guessing metadata.
			sql: `
				CREATE TABLE IF NOT EXISTS message_sticker_pack (
					message_row_id INTEGER PRIMARY KEY,
					sticker_pack_id TEXT NOT NULL,
					tray_icon_file_name TEXT NOT NULL,
					pack_name TEXT NOT NULL,
					pack_description TEXT,
					publisher TEXT,
					image_data_hash TEXT,
					sticker_pack_size INTEGER,
					sticker_pack_origin INTEGER
				);
				CREATE INDEX IF NOT EXISTS message_sticker_pack_name_index
					ON message_sticker_pack (pack_name);
				CREATE INDEX IF NOT EXISTS message_sticker_pack_publisher_index
					ON message_sticker_pack (publisher);
				CREATE TABLE IF NOT EXISTS message_sticker_pack_stickers (
					_id INTEGER PRIMARY KEY AUTOINCREMENT,
					message_row_id INTEGER NOT NULL,
					file_name TEXT NOT NULL,
					is_animated INTEGER NOT NULL DEFAULT 0,
					emojis TEXT,
					accessibility_label TEXT,
					is_lottie INTEGER NOT NULL DEFAULT 0,
					mimetype TEXT
				);
					CREATE INDEX IF NOT EXISTS sticker_pack_stickers_message_row_id_index
						ON message_sticker_pack_stickers (message_row_id);
				`
		},
		{
			version: 7,
			name: 'add final live-location columns to legacy message_location',
			run: db => {
				addColumnIfMissing(db, 'message_location', 'live_location_final_latitude', 'REAL')
				addColumnIfMissing(db, 'message_location', 'live_location_final_longitude', 'REAL')
				addColumnIfMissing(db, 'message_location', 'live_location_final_timestamp', 'INTEGER')
				addColumnIfMissing(db, 'message_location', 'map_download_status', 'INTEGER')
			}
		},
		{
			version: 8,
			name: 'index orphan receipt retention and backfill missing arrival timestamps',
			run: db => {
				const nowSeconds = Math.floor(Date.now() / 1000)
				db.prepare('UPDATE receipt_orphaned SET timestamp = ? WHERE timestamp IS NULL OR timestamp <= 0').run(
					nowSeconds
				)
				db.exec('CREATE INDEX IF NOT EXISTS receipt_orphaned_timestamp_idx ON receipt_orphaned (timestamp)')
			}
		},
		{
			version: 9,
			name: 'add Android view-once media state satellite',
			// Exact WhatsApp Business 2.26.27.83 table, index and delete
			// trigger. Live/history processing populates existing databases.
			sql: `
				CREATE TABLE IF NOT EXISTS message_view_once_media (
					message_row_id INTEGER PRIMARY KEY,
					state INTEGER NOT NULL
				);
				CREATE INDEX IF NOT EXISTS message_view_once_media_state_index
					ON message_view_once_media (state);
				CREATE TRIGGER IF NOT EXISTS message_bd_for_message_view_once_media_trigger
					BEFORE DELETE ON message
					BEGIN
						DELETE FROM message_view_once_media WHERE message_row_id = old._id;
					END;
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
			// received shares can be aged out by last-activity time. The PRAGMA
			// preflight keeps open() safe if the column already exists in
			// a drifted/partially migrated database.
			version: 1,
			name: 'add location_sharer.received_ts (received-share retention)',
			run: db => addColumnIfMissing(db, 'location_sharer', 'received_ts', 'INTEGER NOT NULL DEFAULT 0')
		},
		{
			// The receive path now consumes the official `<enc duration="…">`
			// metadata. Restore the canonical mobile table and remove the
			// obsolete last-activity heuristic without losing existing rows.
			version: 2,
			name: 'restore canonical location_sharer schema',
			run: restoreCanonicalLocationSharerSchema
		},
		{
			// Only sent open-ended rows use Android's Long.MAX_VALUE sentinel.
			// Received legacy rows were bounded by migration v2 using their
			// last-activity timestamp.
			version: 3,
			name: 'repair open-ended location_sharer expiry sentinel',
			run: repairOpenEndedLocationSharerExpiry
		},
		{
			// Develop historically stored location timestamps in unix seconds.
			// Canonical reads now use unix milliseconds. This also repairs
			// databases opened by an intermediate build whose unscoped v3
			// converted received legacy rows to Long.MAX_VALUE.
			version: 4,
			name: 'normalize location timestamps to milliseconds',
			run: normalizeLocationTimestampUnits
		}
	]
}

/**
 * Transient tables wiped once at {@link MultiDbSqliteStore.open} (i.e. on
 * process start). Each mirrors IN-FLIGHT state that is meaningless after the
 * process that owned it is gone — a live queue, a per-message ratchet anchor,
 * an in-progress upload/history-sync job. The owning backends already clear
 * these on a clean socket teardown, but a CRASH (or `kill -9`) skips teardown,
 * so the stale rows would otherwise survive into the next start and accumulate
 * across restarts (audit #627/#628/#633). None is a source of truth: the live
 * protocol flow re-drives all of them, so wiping on start is always safe.
 *
 *   - axolotl.db `message_base_key`      — per-message retry ratchet anchor;
 *                                          the in-memory cache is gone on start
 *   - axolotl.db `unordered_stanza_queue`— raw stanzas parked awaiting an
 *                                          earlier one; re-sent by the server
 *   - axolotl.db `preacks`               — pending pre-ack buffer (ptn)
 *   - media.db   `media_job`             — in-progress media upload jobs
 *   - sync.db    `history_sync_companion`— history-sync progress mirror
 */
const TRANSIENT_TABLES: Partial<Record<MultiDbFile, ReadonlyArray<string>>> = {
	'axolotl.db': ['message_base_key', 'unordered_stanza_queue', 'preacks'],
	'media.db': ['media_job'],
	'sync.db': ['history_sync_companion']
}

const SESSION_LOCK_FILE = '.multi-db-sqlite.lock'

type LockConnection = { pragma: (p: string) => unknown; exec: (sql: string) => unknown; close: () => void }

/**
 * Acquires an EXCLUSIVE, OS-held lock on the session directory and returns a
 * release function.
 *
 * Mechanism: a dedicated better-sqlite3 connection to a `.multi-db-sqlite.lock`
 * database that holds an open `BEGIN EXCLUSIVE` transaction for the store's
 * lifetime. This is a REAL kernel-held file lock (fcntl), not a pidfile whose
 * liveness has to be GUESSED:
 *   - A second opener — another process/container on the same volume, OR a
 *     second store in THIS process — hits `SQLITE_BUSY` and is refused. True
 *     mutual exclusion; a previous holder can never have its lock "stolen".
 *   - When the owning process dies (crash / kill -9 / OOM), the kernel closes
 *     its fds and releases the lock automatically — so a restarted container
 *     (always pid 1) recovers cleanly, WITHOUT the old pidfile's unrecoverable
 *     "already owned by process 1" brick.
 *
 * `busy_timeout = 0` makes contention fail FAST. Verified empirically
 * (cross-process + same-process exclusion + auto-release on SIGKILL) on overlay
 * and 9p volumes.
 *
 * Legacy upgrade: pre-upgrade builds wrote a JSON pidfile at this same path.
 * Opened as a SQLite db it raises `SQLITE_NOTADB`; we FAIL CLOSED (throw an
 * actionable error) rather than delete it — see the handler below.
 *
 * Caveat (inherent to any advisory lock): cross-process exclusion relies on the
 * filesystem honoring POSIX locks. The correct deployment is ONE sessionDir per
 * instance — never a session shared across processes.
 */
const acquireSessionLock = (
	Database: DatabaseConstructor,
	path: typeof import('node:path'),
	sessionDir: string
): (() => void) => {
	const lockPath = path.join(sessionDir, SESSION_LOCK_FILE)

	const tryAcquire = (): LockConnection => {
		const lockDb = new Database(lockPath) as unknown as LockConnection
		try {
			lockDb.pragma('busy_timeout = 0') // fail fast on contention
			lockDb.pragma('journal_mode = DELETE') // rollback journal (NOT wal): EXCLUSIVE then blocks all access
			lockDb.exec('BEGIN EXCLUSIVE') // acquire + HOLD the exclusive lock until close()
			return lockDb
		} catch (err) {
			try {
				lockDb.close()
			} catch {
				// ignore — surface the acquire error
			}

			throw err
		}
	}

	const busyError = () =>
		new Error(
			`MultiDbSqliteStore: sessionDir is locked by another live store — refusing to open a second one. ` +
				`If this is a reconnect, close() the previous store first; otherwise another process/container is ` +
				`using this session (use one sessionDir per instance): ${sessionDir}`
		)

	let lockDb: LockConnection
	try {
		lockDb = tryAcquire()
	} catch (err) {
		const code = (err as NodeJS.ErrnoException).code
		if (code === 'SQLITE_BUSY') throw busyError()

		if (code !== 'SQLITE_NOTADB') throw err

		// FAIL CLOSED on a lock file that is not a SQLite db — either a legacy JSON
		// pidfile (pre-upgrade builds wrote one at this same path) or a corrupted
		// file. We do NOT delete it automatically:
		//   - it may belong to an OLD version STILL RUNNING on this sessionDir, and a
		//     silent delete would drop that instance's mutual exclusion (both would
		//     then write the same DBs → corruption); and
		//   - two NEW processes hitting the stale file would race on delete→create
		//     and end up holding EXCLUSIVE on different inodes at the same path (an
		//     `unlink`+recreate is not an atomic ownership handoff).
		// A stale legacy JSON only lingers after an OLD version CRASHED (a clean
		// shutdown removes its own pidfile), so this is a one-time, operator-visible
		// upgrade step: stop old instances and remove the file. The new SQLite lock
		// then reuses this path.
		throw new Error(
			`MultiDbSqliteStore: the session lock file at ${lockPath} is not a SQLite database ` +
				`(a legacy JSON pidfile from a previous version, or a corrupted file). Stop any old ` +
				`instances still using this sessionDir and delete this file to recover — it is deliberately ` +
				`NOT removed automatically, to avoid dropping a lock a live old instance may still hold.`
		)
	}

	// close() rolls back the held EXCLUSIVE transaction and releases the OS lock
	// (and removes the leftover `-journal`). Not wrapped here: the sole caller,
	// `unlockSession()`, already try/catches and logs — swallowing the error in
	// this closure would just hide the real cause from that logger.
	return () => lockDb.close()
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
	// `-2000` (~2 MB de page cache por handle). Com 11 handles × N
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
	private releaseSessionLock?: () => void

	constructor(private readonly opts: MultiDbSqliteStoreOptions) {}

	async open(): Promise<void> {
		if (this.opened) return
		const requestedGeneration = this.openGeneration
		// Concurrency-safe open: if a second caller hits open() while the first
		// is still inside the async init below, return the in-flight promise so
		// both end up sharing the same set of handles rather than racing to
		// create duplicates.
		if (this.openInFlight) {
			await this.openInFlight
			// close() may have cancelled the promise we just joined. Only a caller
			// that started after that close (and therefore captured the current
			// generation) should retry; callers from the cancelled generation keep
			// the explicit close() postcondition and resolve with the store closed.
			if (!this.opened && this.openGeneration === requestedGeneration) return this.open()
			return
		}

		const inFlight = this.runOpen()
		this.openInFlight = inFlight
		try {
			await inFlight
		} finally {
			if (this.openInFlight === inFlight) this.openInFlight = undefined
		}
	}

	private async runOpen(): Promise<void> {
		// Capture this before the first await. A close() issued while the lazy
		// imports or optional driver load are pending must still cancel this open.
		const startGen = this.openGeneration
		const fs = await import('node:fs')
		const path = await import('node:path')
		if (this.openGeneration !== startGen) return

		fs.mkdirSync(this.opts.sessionDir, { recursive: true })

		const Database = await loadBetterSqlite3()
		if (this.openGeneration !== startGen) return
		this.releaseSessionLock = acquireSessionLock(Database, path, this.opts.sessionDir)
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
				// The bookkeeping table is created on every database, including
				// databases that do not yet have a migration list.
				const fileMigrations = MIGRATIONS[file]
				if (fileMigrations && fileMigrations.length > 0) {
					runMigrations(db as unknown as SqliteDbLike, fileMigrations)
				} else {
					// Still create the bookkeeping table so the first real
					// migration in a future PR doesn't have to special-case
					// "table doesn't exist yet" for already-deployed dbs.
					runMigrations(db as unknown as SqliteDbLike, [])
				}

				// Prune-on-open: wipe transient in-flight tables that a crash would
				// have left stale (see TRANSIENT_TABLES). The session lock is held
				// for this store's full lifetime, so no other store can be writing
				// this sessionDir while these deletes run. Best-effort per table — a
				// prune failure must not block opening the store.
				for (const table of TRANSIENT_TABLES[file] ?? []) {
					try {
						db.exec(`DELETE FROM ${table}`)
					} catch (pruneErr) {
						this.opts.logger?.warn?.({ file, table, err: pruneErr }, 'multi-db-sqlite: startup prune failed')
					}
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
					this.unlockSession()
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
			this.unlockSession()
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
			this.unlockSession()
			return
		}

		this.opened = true
	}

	private unlockSession(): void {
		const release = this.releaseSessionLock
		this.releaseSessionLock = undefined
		if (!release) return
		try {
			release()
		} catch (err) {
			this.opts.logger?.warn?.({ err }, 'multi-db-sqlite: session lock release failed')
		}
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
		const wasOpened = this.opened
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

		// If runOpen() has not completed, it owns lock release on its abort
		// checkpoint. An already-open store releases synchronously here.
		if (wasOpened) this.unlockSession()
	}
}
