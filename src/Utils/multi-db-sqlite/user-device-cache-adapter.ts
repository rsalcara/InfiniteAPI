/**
 * `NodeCache`-shaped adapter backed by `user_device(_info)` so
 * the existing `userDevicesCache` plumbing in `messages-send.ts` /
 * `messages-recv.ts` keeps working unchanged when the multi-DB SQLite
 * store is wired up via `SocketConfig.multiDbStore`.
 *
 * Why a NodeCache-shaped wrapper instead of swapping every call site to
 * the typed {@link UserDeviceBackend}? The existing code threads
 * `userDevicesCache` through 12+ files (cache.del, cache.set, cache.get,
 * cache.mget). Rewriting all of them to a typed API is a much bigger
 * change than this PR can absorb without risk. The adapter preserves the
 * exact shape (incl. async-or-sync return contract) and stores devices
 * in the typed `user_device` family first, with `user_device_cache_json`
 * retained as a byte-for-byte recovery fallback.
 *
 * Behavior preserved:
 *   - 5-minute default TTL in both `expires_at` and the typed
 *     `user_device_info.expected_timestamp`
 *   - `set` replaces previous entry atomically
 *   - `del` removes the entry
 *   - `mget` returns a `Record<user, devices>` for the requested users
 *     using a single batched `SELECT ... WHERE user_jid IN (...)`
 *
 * Behavior NOT preserved (intentional):
 *   - keyspace size limit / LRU eviction. SQLite WAL grows as needed;
 *     `pruneExpired` should be called periodically by the host process
 *     (an opt-in `runPruneTickerEverySeconds` constructor option does
 *     this automatically).
 */
import { type FullJid, jidDecode, jidEncode } from '../../WABinary'
import { type InClauseQuery, prepareInClause } from './in-statement-cache'
import { JidMapBackend } from './lid-mapping-backend'
import { resolveExpiresAt } from './ttl-utils'
import type { SqliteDbLike, SqliteStatementLike } from './types'
import { UserDeviceBackend } from './user-device-backend'

/** Minimal structural logger — only `.debug` is used, and only when present. */
type DebugLogger = { debug?: (obj: unknown, msg: string) => void }

/**
 * The device cache is keyed by a bare `user` string (no server), but the
 * typed `user_device` tables key by a `jid` row (which needs `user@server`).
 * A given bare user belongs to exactly one server, so on read we probe the
 * two real device-bearing domains; whichever has a fresh typed row wins, and
 * anything exotic (hosted, etc.) simply falls back to the JSON mirror.
 */
const CANDIDATE_SERVERS = ['s.whatsapp.net', 'lid', 'hosted', 'hosted.lid'] as const

/**
 * primary_device_version value written per user. The real msgstore.db capture
 * shows this uniformly at 1 (the ADV primary-device version) for every user,
 * so 1 is the faithful default until the true USync device-list version is
 * plumbed through to this cache boundary.
 */
const PRIMARY_DEVICE_VERSION_DEFAULT = 1

/**
 * Type guard: a cached value usable by the typed path — a non-empty array of
 * `{ user, server }`-shaped device records. Anything else (unexpected shape,
 * empty list) is written to the JSON mirror only.
 */
const asDeviceList = (value: unknown): FullJid[] | null => {
	if (!Array.isArray(value) || value.length === 0) return null
	for (const d of value) {
		if (!d || typeof (d as FullJid).user !== 'string' || typeof (d as FullJid).server !== 'string') return null
	}

	return value as FullJid[]
}

export type NodeCacheCompatibleEntry = unknown

/**
 * Minimal subset of `node-cache`'s API that the InfiniteAPI message
 * pipeline calls. The cache used in `messages-send.ts` accesses:
 *   - `get<T>(key)`     — read one entry
 *   - `set(key, value)` — write one entry
 *   - `del(key)`        — delete one entry
 *   - `mget(keys)`      — bulk read
 *
 * All methods are sync in `node-cache`; the existing call sites
 * `await` the return value, which is harmless for sync values.
 */
export interface NodeCacheLike {
	get<T = NodeCacheCompatibleEntry>(key: string): T | undefined
	set(key: string, value: NodeCacheCompatibleEntry, ttl?: number | string): boolean
	del(key: string | string[]): number
	/**
	 * `mget` returns a Promise to be assignable to
	 * `PossiblyExtendedCacheStore.mget` (which is async). The implementation
	 * stays synchronous internally — we just wrap the resolved value in
	 * `Promise.resolve()` at the boundary so TypeScript is happy when a
	 * consumer writes `userDevicesCache: new UserDeviceCacheSqliteAdapter(...)`
	 * against `SocketConfig`.
	 */
	mget<T = NodeCacheCompatibleEntry>(keys: string[]): Promise<Record<string, T | undefined>>
	flushAll(): void
}

// `user_device_cache_json` is owned by `schemas/msgstore.ts` so it goes
// through the same migration bookkeeping as the rest of the multi-DB
// store. The adapter assumes the table already exists (MultiDbSqliteStore
// has opened msgstore.db and run its schema by the time this adapter is
// constructed).

const FLUSH_ALL_SQL = 'DELETE FROM user_device_cache_json'

export type UserDeviceCacheAdapterOptions = {
	/** Default TTL applied to entries written without an explicit TTL (seconds). */
	defaultTtlSeconds?: number
	/**
	 * If set, schedules a background ticker that calls `pruneExpired` at
	 * the given interval (seconds). Defaults to OFF — callers may prefer
	 * to control eviction explicitly.
	 */
	runPruneTickerEverySeconds?: number
	/**
	 * Make the typed `user_device`/`user_device_info`/`primary_device_version`
	 * tables the authoritative read/write surface (the mobile schema), with
	 * the JSON mirror kept as a byte-for-byte fallback — the same pattern as
	 * `signalSourceOfTruth`. **Default `true`.**
	 *
	 * On write the device list is persisted to BOTH the typed tables and the
	 * JSON mirror in one transaction (same `msgstore.db` file → atomic, can't
	 * diverge). On read the typed tables are consulted first; a miss, a stale
	 * `expected_timestamp`, or an unusable shape falls back to the JSON mirror.
	 * `false` is a kill switch reverting to JSON-only (the pre-typed behavior).
	 */
	sourceOfTruth?: boolean
	/** Optional logger — only used to `.debug` real typed→JSON fallbacks. */
	logger?: DebugLogger
}

/**
 * SQLite-backed `userDevicesCache`. Drop-in replacement for the NodeCache
 * the gateway uses by default; activate by passing
 * `SocketConfig.userDevicesCache = new UserDeviceCacheSqliteAdapter(...)`.
 */
export class UserDeviceCacheSqliteAdapter implements NodeCacheLike {
	private readonly stmts: {
		select: SqliteStatementLike
		upsert: SqliteStatementLike
		del: SqliteStatementLike
		prune: SqliteStatementLike
		flushAll: SqliteStatementLike
		selectExpiredTyped: SqliteStatementLike
	}

	private readonly defaultTtlMs: number
	private pruneTicker?: NodeJS.Timeout

	private readonly db: SqliteDbLike
	/** Cached `IN (…)` queries for `mget` (and its companion bulk delete). */
	private readonly mgetQuery: InClauseQuery
	private readonly mDelQuery: InClauseQuery

	/** Typed source-of-truth plumbing (null when the kill switch is off). */
	private readonly sourceOfTruth: boolean
	private readonly jidMap: JidMapBackend | null
	private readonly deviceBackend: UserDeviceBackend | null
	private readonly logger?: DebugLogger
	/**
	 * Observability for the typed→JSON fallback. `total` counts reads the
	 * typed tables couldn't serve but the JSON mirror could (real fallbacks,
	 * not plain misses). Climbs while pre-typed entries migrate, then should
	 * plateau near 0 — a sustained climb means the typed path is failing.
	 */
	readonly fallbackStats = { total: 0 }

	constructor(db: SqliteDbLike, opts: UserDeviceCacheAdapterOptions = {}) {
		this.db = db
		this.defaultTtlMs = (opts.defaultTtlSeconds ?? 5 * 60) * 1000
		this.sourceOfTruth = opts.sourceOfTruth !== false
		this.logger = opts.logger
		this.jidMap = this.sourceOfTruth ? new JidMapBackend(db) : null
		this.deviceBackend = this.sourceOfTruth ? new UserDeviceBackend(db) : null

		this.stmts = {
			select: this.db.prepare('SELECT devices_json, expires_at FROM user_device_cache_json WHERE user_jid = ?'),
			upsert: this.db.prepare(
				'INSERT INTO user_device_cache_json (user_jid, devices_json, expires_at) VALUES (?, ?, ?) ' +
					'ON CONFLICT(user_jid) DO UPDATE SET devices_json = excluded.devices_json, expires_at = excluded.expires_at'
			),
			del: this.db.prepare('DELETE FROM user_device_cache_json WHERE user_jid = ?'),
			prune: this.db.prepare('DELETE FROM user_device_cache_json WHERE expires_at <= ?'),
			flushAll: this.db.prepare(FLUSH_ALL_SQL),
			selectExpiredTyped: this.db.prepare(
				'SELECT user_jid_row_id FROM user_device_info WHERE expected_timestamp IS NOT NULL AND expected_timestamp <= ?'
			)
		}

		this.mgetQuery = prepareInClause(
			this.db,
			'SELECT user_jid, devices_json, expires_at FROM user_device_cache_json WHERE user_jid IN (',
			')'
		)
		this.mDelQuery = prepareInClause(this.db, 'DELETE FROM user_device_cache_json WHERE user_jid IN (', ')')

		if (opts.runPruneTickerEverySeconds && opts.runPruneTickerEverySeconds > 0) {
			// The try/catch is not paranoia: when the host process calls
			// `MultiDbSqliteStore.close()` BEFORE the adapter's own `close()`,
			// the underlying db handle is gone but this interval may already be
			// armed for its next fire. The synchronous `stmt.run` then throws
			// `"The database connection is not open"` from inside the timer
			// callback, where there is no caller to catch it — Node surfaces
			// it as an unhandled exception and the process crashes on
			// teardown. Swallowing it here is correct because by the time the
			// db is closed there is nothing meaningful to prune anyway.
			this.pruneTicker = setInterval(() => {
				try {
					this.pruneExpired()
				} catch {
					/* db handle already closed by host shutdown — nothing to prune */
				}
			}, opts.runPruneTickerEverySeconds * 1000)
			if (typeof this.pruneTicker.unref === 'function') this.pruneTicker.unref()
		}
	}

	/**
	 * Resolves the `jid` row id for a bare user key WITHOUT creating a row
	 * (read-only), probing the two device-bearing domains. Returns the row id
	 * and the matched server, or null if neither is known.
	 */
	private lookupUserRow(key: string): { rowId: number; server: string } | null {
		if (!this.jidMap) return null
		for (const server of CANDIDATE_SERVERS) {
			const rowId = this.jidMap.lookupJidRowId(`${key}@${server}`)
			if (rowId !== null) return { rowId, server }
		}

		return null
	}

	/**
	 * Typed-first read: returns the reconstructed device list if a fresh typed
	 * row exists, else null (caller falls back to the JSON mirror). Rebuilds
	 * each FullJid from the device row's `raw_string` — a byte-exact inverse of
	 * the `jidEncode` used on write.
	 */
	private typedGet(key: string): FullJid[] | null {
		if (!this.sourceOfTruth || !this.deviceBackend) return null
		const found = this.lookupUserRow(key)
		if (!found) return null
		// Stale (or no info row) → treat as a miss so the caller refetches via
		// USync, exactly as a TTL-expired JSON row would.
		if (!this.deviceBackend.isFresh(found.rowId)) return null
		const jids = this.deviceBackend.listDeviceJids(found.rowId)
		if (jids.length === 0) return null
		const devices: FullJid[] = []
		for (const { rawJid } of jids) {
			const decoded = jidDecode(rawJid)
			// A row we can't decode means the typed table is inconsistent — bail
			// to the JSON mirror rather than serve a partial device list.
			if (!decoded) return null
			// Rebuild the exact FullJid shape the JSON mirror / USync stores
			// (`extractDeviceJids`: user + device + domainType + server). Two
			// normalizations are required so the typed read is value-identical to
			// the JSON mirror (the invariant this dual-write relies on):
			//   - `device`: `jidEncode` drops a `0` suffix, so `jidDecode` returns
			//     `undefined` for the primary — the JSON path stores `0`.
			//   - `domainType`: present on every cached device, re-derived by
			//     `jidDecode` from the server, so carry it through.
			devices.push({
				user: decoded.user,
				device: decoded.device ?? 0,
				domainType: decoded.domainType,
				server: decoded.server
			})
		}

		return devices
	}

	/** Writes the device list to the typed tables (best-effort, never throws). */
	private typedSet(key: string, devices: FullJid[], expiresAt: number): void {
		if (!this.sourceOfTruth || !this.jidMap || !this.deviceBackend) return
		const server = devices[0]!.server
		const userRowId = this.jidMap.resolveJidRowId(jidEncode(key, server))
		const deviceRows = devices.map(d => ({
			deviceJidRowId: this.jidMap!.resolveJidRowId(jidEncode(d.user, d.server, d.device)),
			keyIndex: 0
		}))
		// `raw_id` (the mobile device-list version) isn't exposed at this cache
		// boundary; 0 is a benign placeholder. `expected_timestamp` mirrors the
		// JSON row's TTL so the typed freshness check matches JSON expiry.
		const existingInfo = this.deviceBackend.getInfo(userRowId)
		this.deviceBackend.replaceDevices(userRowId, deviceRows, {
			rawId: existingInfo?.rawId ?? 0,
			timestamp: Date.now(),
			expectedTimestamp: expiresAt
		})
		// primary_device_version: one row per user, the ADV primary-device
		// version. The real msgstore.db capture shows this uniformly at 1 for
		// every user (6085 rows), so 1 is the faithful value; the true version
		// isn't exposed at this cache boundary (would need the USync device-list
		// version plumbed through). Populated here to match the mobile schema.
		if (this.deviceBackend.getPrimaryDeviceVersion(userRowId) === null) {
			this.deviceBackend.setPrimaryDeviceVersion(userRowId, PRIMARY_DEVICE_VERSION_DEFAULT)
		}
	}

	/** Removes the typed rows for a bare user key (both candidate domains). */
	private typedDelete(key: string): void {
		if (!this.sourceOfTruth || !this.deviceBackend || !this.jidMap) return
		for (const server of CANDIDATE_SERVERS) {
			const rowId = this.jidMap.lookupJidRowId(`${key}@${server}`)
			if (rowId !== null) this.deviceBackend.deleteDevices(rowId)
		}
	}

	get<T = NodeCacheCompatibleEntry>(key: string): T | undefined {
		if (this.sourceOfTruth) {
			const typed = this.typedGet(key)
			if (typed) return typed as unknown as T
			const json = this.jsonGet<T>(key)
			if (json !== undefined) this.noteFallback(key)
			return json
		}

		return this.jsonGet(key)
	}

	/** Records + logs a real typed→JSON fallback (typed missed, JSON served). */
	private noteFallback(key: string): void {
		this.fallbackStats.total++
		this.logger?.debug?.(
			{ key, cumulativeFallbacks: this.fallbackStats.total },
			'multi-db-sqlite: typed user_device read fell back to JSON mirror'
		)
	}

	private jsonGet<T = NodeCacheCompatibleEntry>(key: string): T | undefined {
		const row = this.stmts.select.get(key) as { devices_json: string; expires_at: number } | undefined
		if (!row) return undefined
		if (row.expires_at <= Date.now()) {
			// Lazy expiry — swallow SQLITE_BUSY so the lookup still reports a
			// clean miss to the caller. NodeCache's `get()` never throws and
			// this adapter is a drop-in replacement; surfacing a busy-error
			// here breaks `messages-recv.ts`'s `incrementRetryAndGet` path
			// which expects `undefined | number`, not an exception.
			try {
				this.stmts.del.run(key)
				this.typedDelete(key)
			} catch {
				/* lazy expiry only — leave the stale row for the prune ticker */
			}

			return undefined
		}

		// Robustness: a corrupted/tampered devices_json row must not crash the
		// message pipeline. NodeCache returns `undefined` for missing entries
		// and we mirror that here — drop the bad row and report a cache miss
		// so the caller falls back to its refetch path naturally.
		try {
			return JSON.parse(row.devices_json) as T
		} catch {
			this.stmts.del.run(key)
			return undefined
		}
	}

	set(key: string, value: NodeCacheCompatibleEntry, ttl?: number | string): boolean {
		const expiresAt = resolveExpiresAt(ttl, this.defaultTtlMs)
		const json = JSON.stringify(value)
		const devices = this.sourceOfTruth ? asDeviceList(value) : null
		if (devices) {
			// Atomic dual-write: JSON mirror + typed tables in ONE transaction on
			// the same msgstore.db file, so the two can never diverge. If the
			// typed write throws, the JSON write rolls back with it — the caller's
			// `safeCacheSet` swallows the failure and the next read refetches via
			// USync, exactly like a plain cache miss.
			this.db.transaction(() => {
				this.stmts.upsert.run(key, json, expiresAt)
				this.typedSet(key, devices, expiresAt)
			})()
		} else if (this.sourceOfTruth) {
			// Non-device value (or an empty list) in source-of-truth mode: the
			// JSON mirror is updated AND any prior typed row is cleared in the
			// same transaction. Without the clear, a stale typed row would shadow
			// the fresh JSON value on the next typed-first read — the divergence
			// the dual-write exists to prevent.
			this.db.transaction(() => {
				this.stmts.upsert.run(key, json, expiresAt)
				this.typedDelete(key)
			})()
		} else {
			this.stmts.upsert.run(key, json, expiresAt)
		}

		return true
	}

	del(key: string | string[]): number {
		const keys = Array.isArray(key) ? key : [key]
		// Fast path for the common single-key case (every NodeCache caller in
		// messages-recv.ts passes one key) — avoids a BEGIN IMMEDIATE /
		// COMMIT round-trip and the closure allocation for a single DELETE.
		if (!this.sourceOfTruth && keys.length === 1) return this.stmts.del.run(keys[0]!).changes
		// Reducer-based counter — see msg-retry-counter-adapter.ts for the
		// rationale (closure-mutation would double-count under a future
		// retry-wrapped transaction). In source-of-truth mode the typed rows are
		// removed in the same transaction so a delete can't leave a typed row
		// that a later typed-first read would resurrect.
		const tx = this.db.transaction((batch: string[]) =>
			batch.reduce((acc, k) => {
				const changes = this.stmts.del.run(k).changes
				this.typedDelete(k)
				return acc + changes
			}, 0)
		)
		return tx(keys)
	}

	async mget<T = NodeCacheCompatibleEntry>(keys: string[]): Promise<Record<string, T | undefined>> {
		if (keys.length === 0) return {}
		if (!this.sourceOfTruth) return this.jsonMget<T>(keys)

		// Typed-first per key; whatever the typed tables can't serve is batched
		// into a single JSON mirror read so the fallback still costs one query.
		const out: Record<string, T | undefined> = {}
		const jsonKeys: string[] = []
		for (const key of keys) {
			const typed = this.typedGet(key)
			if (typed) out[key] = typed as unknown as T
			else jsonKeys.push(key)
		}

		if (jsonKeys.length > 0) {
			const jsonResult = await this.jsonMget<T>(jsonKeys)
			for (const k of jsonKeys) {
				if (jsonResult[k] !== undefined) {
					out[k] = jsonResult[k]
					this.noteFallback(k)
				}
			}
		}

		return out
	}

	private async jsonMget<T = NodeCacheCompatibleEntry>(keys: string[]): Promise<Record<string, T | undefined>> {
		const out: Record<string, T | undefined> = {}
		if (keys.length === 0) return out

		// Cached IN-clause statements (`mgetQuery` + `mDelQuery`) replace
		// what previously was ad-hoc `db.prepare()` per chunk. `prepareInClause`
		// caches by placeholder count, so the hot path pays at most one
		// compilation per unique chunk size (default chunk 500 → 1 cache
		// entry covers 99% of calls). Stops the gradual native-memory
		// growth that the per-call prepare pattern caused.
		const now = Date.now()
		const staleKeys: string[] = []
		const rows = this.mgetQuery.all([], keys) as Array<{
			user_jid: string
			devices_json: string
			expires_at: number
		}>
		for (const r of rows) {
			if (r.expires_at <= now) {
				staleKeys.push(r.user_jid)
				continue
			}

			try {
				out[r.user_jid] = JSON.parse(r.devices_json) as T
			} catch {
				// Corrupted JSON — drop the row, report a miss for this key.
				staleKeys.push(r.user_jid)
			}
		}

		// Use `.run()` (not `.all()`) — the previous `.all()` worked at runtime
		// but discarded the changes count and was semantically wrong for a
		// DELETE statement. The change is invisible to callers (mget()'s
		// return type doesn't expose deletion stats) but matches the SQLite
		// statement-type contract.
		if (staleKeys.length > 0) this.mDelQuery.run([], staleKeys)

		return out
	}

	/** Removes every entry whose `expires_at` has passed. Returns rows pruned. */
	pruneExpired(now: number = Date.now()): number {
		return this.db.transaction(() => {
			if (this.sourceOfTruth && this.deviceBackend) {
				const rows = this.stmts.selectExpiredTyped.all(now) as Array<{ user_jid_row_id: number }>
				for (const row of rows) this.deviceBackend.deleteDevices(row.user_jid_row_id)
			}
			return this.stmts.prune.run(now).changes
		})()
	}

	/**
	 * Required by `SocketConfig.userDevicesCache` (which is typed
	 * `PossiblyExtendedCacheStore` and extends `CacheStore`). Wipes every
	 * cached entry — used on socket close so a fresh reconnect starts with
	 * no stale device assumptions.
	 */
	flushAll(): void {
		if (this.sourceOfTruth) {
			// Wipe the JSON mirror AND the typed tables together — a surviving
			// typed row would otherwise shadow the cleared JSON entry on the next
			// typed-first read.
			this.db.exec(
				'DELETE FROM user_device_cache_json; DELETE FROM user_device; ' +
					'DELETE FROM user_device_info; DELETE FROM primary_device_version'
			)
			return
		}

		this.stmts.flushAll.run()
	}

	/** Stops the background prune ticker, if one was scheduled. */
	close(): void {
		if (this.pruneTicker) {
			clearInterval(this.pruneTicker)
			this.pruneTicker = undefined
		}
	}
}
