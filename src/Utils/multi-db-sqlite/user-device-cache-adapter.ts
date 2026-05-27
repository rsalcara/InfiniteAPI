/**
 * Phase 9.2 — `NodeCache`-shaped adapter backed by `user_device(_info)` so
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
 * as JSON in `user_device_cache_json` — a small auxiliary table on
 * `msgstore.db` that keeps the typed `user_device` tables free for the
 * eventual full typed split (phase 9.2.1).
 *
 * Behavior preserved:
 *   - 5-minute default TTL via the auxiliary table's `expires_at` column
 *     (the typed `user_device_info.expected_timestamp` column stays
 *     reserved for the typed split in phase 9.2.1)
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
import type { SqliteDbLike, SqliteStatementLike } from './types'

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
	mget<T = NodeCacheCompatibleEntry>(keys: string[]): { [key: string]: T }
	flushAll(): void
}

const CREATE_AUX_TABLE_SQL = `
CREATE TABLE IF NOT EXISTS user_device_cache_json (
  user_jid TEXT PRIMARY KEY,
  devices_json TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS user_device_cache_json_expires_idx
  ON user_device_cache_json (expires_at);
`

const FLUSH_ALL_SQL = 'DELETE FROM user_device_cache_json'

/**
 * Parses a NodeCache-style TTL string ("35m", "1h", "30s", "1d") into
 * milliseconds. Returns `null` if the input is not a recognized shape so
 * the caller can fall back to the default TTL.
 */
function parseTtlString(ttl: string): number | null {
	const m = /^(\d+)\s*([smhd])?$/i.exec(ttl.trim())
	if (!m) return null
	const n = Number(m[1])
	if (!Number.isFinite(n)) return null
	const unit = (m[2] ?? 's').toLowerCase()
	switch (unit) {
		case 's':
			return n * 1000
		case 'm':
			return n * 60_000
		case 'h':
			return n * 3_600_000
		case 'd':
			return n * 86_400_000
		default:
			return null
	}
}

// Year-9999 in epoch milliseconds. Used as `expires_at` for entries
// written with `ttl=0` (NodeCache convention for "never expire"). Picking
// a fixed huge value keeps the column NOT NULL and the read path simple:
// `expires_at <= Date.now()` returns false until well past any realistic
// runtime, while bookkeeping (pruneExpired) still treats it as live.
const NO_EXPIRY_SENTINEL = 253_402_300_799_000

export type UserDeviceCacheAdapterOptions = {
	/** Default TTL applied to entries written without an explicit TTL (seconds). */
	defaultTtlSeconds?: number
	/**
	 * If set, schedules a background ticker that calls `pruneExpired` at
	 * the given interval (seconds). Defaults to OFF — callers may prefer
	 * to control eviction explicitly.
	 */
	runPruneTickerEverySeconds?: number
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
	}

	private readonly defaultTtlMs: number
	private pruneTicker?: NodeJS.Timeout

	private readonly db: SqliteDbLike

	constructor(db: SqliteDbLike, opts: UserDeviceCacheAdapterOptions = {}) {
		this.db = db
		this.defaultTtlMs = (opts.defaultTtlSeconds ?? 5 * 60) * 1000

		this.db.exec(CREATE_AUX_TABLE_SQL)
		this.stmts = {
			select: this.db.prepare('SELECT devices_json, expires_at FROM user_device_cache_json WHERE user_jid = ?'),
			upsert: this.db.prepare(
				'INSERT INTO user_device_cache_json (user_jid, devices_json, expires_at) VALUES (?, ?, ?) ' +
					'ON CONFLICT(user_jid) DO UPDATE SET devices_json = excluded.devices_json, expires_at = excluded.expires_at'
			),
			del: this.db.prepare('DELETE FROM user_device_cache_json WHERE user_jid = ?'),
			prune: this.db.prepare('DELETE FROM user_device_cache_json WHERE expires_at <= ?'),
			flushAll: this.db.prepare(FLUSH_ALL_SQL)
		}

		if (opts.runPruneTickerEverySeconds && opts.runPruneTickerEverySeconds > 0) {
			this.pruneTicker = setInterval(
				() => this.pruneExpired(),
				opts.runPruneTickerEverySeconds * 1000
			)
			if (typeof this.pruneTicker.unref === 'function') this.pruneTicker.unref()
		}
	}

	get<T = NodeCacheCompatibleEntry>(key: string): T | undefined {
		const row = this.stmts.select.get(key) as { devices_json: string; expires_at: number } | undefined
		if (!row) return undefined
		if (row.expires_at <= Date.now()) {
			// Expired: delete and report miss to mimic NodeCache's TTL.
			this.stmts.del.run(key)
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
		let expiresAt: number
		if (typeof ttl === 'number') {
			// NodeCache compat: ttl === 0 means "never expire". Encode that
			// as a far-future timestamp so we don't need a nullable column
			// and a NULL-aware check on every get/mget hot-path read.
			expiresAt = ttl === 0 ? NO_EXPIRY_SENTINEL : Date.now() + ttl * 1000
		} else if (typeof ttl === 'string') {
			// NodeCache also accepts string-formatted TTLs like "35m", "1h",
			// "30s". Parse explicitly; fall back to the default if the
			// string is malformed (mirrors NodeCache's defensive behavior).
			const parsed = parseTtlString(ttl)
			expiresAt = parsed === null ? Date.now() + this.defaultTtlMs : Date.now() + parsed
		} else {
			expiresAt = Date.now() + this.defaultTtlMs
		}

		this.stmts.upsert.run(key, JSON.stringify(value), expiresAt)
		return true
	}

	del(key: string | string[]): number {
		const keys = Array.isArray(key) ? key : [key]
		let n = 0
		const tx = this.db.transaction((keys: string[]) => {
			for (const k of keys) {
				const r = this.stmts.del.run(k)
				n += r.changes
			}
		})
		tx(keys)
		return n
	}

	mget<T = NodeCacheCompatibleEntry>(keys: string[]): { [key: string]: T } {
		const out: { [key: string]: T } = {}
		if (keys.length === 0) return out

		// Batched SELECT replaces N point selects on the hot path
		// (`messages-send.ts` calls `mget` with every recipient of a fan-out
		// at once). SQLite's default `SQLITE_LIMIT_VARIABLE_NUMBER` is 999;
		// large fan-outs would otherwise hit "too many SQL variables". We
		// chunk `keys` into safe batches and stitch the results in memory.
		// 500 leaves headroom for any DELETE-side IN list reused below.
		const CHUNK = 500
		const now = Date.now()
		const staleKeys: string[] = []
		for (let i = 0; i < keys.length; i += CHUNK) {
			const chunk = keys.slice(i, i + CHUNK)
			const placeholders = chunk.map(() => '?').join(',')
			const rows = this.db
				.prepare(
					`SELECT user_jid, devices_json, expires_at FROM user_device_cache_json WHERE user_jid IN (${placeholders})`
				)
				.all(...chunk) as Array<{ user_jid: string; devices_json: string; expires_at: number }>
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
		}

		// Delete stale/corrupt rows in the same chunked manner so the
		// cleanup statement never exceeds the variable limit either.
		for (let i = 0; i < staleKeys.length; i += CHUNK) {
			const chunk = staleKeys.slice(i, i + CHUNK)
			const stalePlaceholders = chunk.map(() => '?').join(',')
			this.db
				.prepare(`DELETE FROM user_device_cache_json WHERE user_jid IN (${stalePlaceholders})`)
				.run(...chunk)
		}

		return out
	}

	/** Removes every entry whose `expires_at` has passed. Returns rows pruned. */
	pruneExpired(now: number = Date.now()): number {
		const r = this.stmts.prune.run(now)
		return r.changes
	}

	/**
	 * Required by `SocketConfig.userDevicesCache` (which is typed
	 * `PossiblyExtendedCacheStore` and extends `CacheStore`). Wipes every
	 * cached entry — used on socket close so a fresh reconnect starts with
	 * no stale device assumptions.
	 */
	flushAll(): void {
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
