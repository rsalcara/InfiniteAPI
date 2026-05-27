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
 *   - 5-minute default TTL via the `expected_timestamp` column
 *   - `set` replaces previous entry atomically
 *   - `del` removes the entry
 *   - `mget` returns a `Record<user, devices>` for the requested users
 *
 * Behavior NOT preserved (intentional):
 *   - keyspace size limit / LRU eviction. SQLite WAL grows as needed;
 *     `pruneExpired` should be called periodically by the host process
 *     (an opt-in `runPruneTickerEverySeconds` constructor option does
 *     this automatically).
 */
import type BetterSqlite3Module from 'better-sqlite3'

type Database = BetterSqlite3Module.Database

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
		select: BetterSqlite3Module.Statement
		upsert: BetterSqlite3Module.Statement
		del: BetterSqlite3Module.Statement
		prune: BetterSqlite3Module.Statement
		flushAll: BetterSqlite3Module.Statement
	}

	private readonly defaultTtlMs: number
	private pruneTicker?: NodeJS.Timeout

	constructor(
		private readonly db: Database,
		opts: UserDeviceCacheAdapterOptions = {}
	) {
		this.defaultTtlMs = (opts.defaultTtlSeconds ?? 5 * 60) * 1000

		db.exec(CREATE_AUX_TABLE_SQL)
		this.stmts = {
			select: db.prepare('SELECT devices_json, expires_at FROM user_device_cache_json WHERE user_jid = ?'),
			upsert: db.prepare(
				'INSERT INTO user_device_cache_json (user_jid, devices_json, expires_at) VALUES (?, ?, ?) ' +
					'ON CONFLICT(user_jid) DO UPDATE SET devices_json = excluded.devices_json, expires_at = excluded.expires_at'
			),
			del: db.prepare('DELETE FROM user_device_cache_json WHERE user_jid = ?'),
			prune: db.prepare('DELETE FROM user_device_cache_json WHERE expires_at <= ?'),
			flushAll: db.prepare(FLUSH_ALL_SQL)
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
		const ttlMs = typeof ttl === 'number' ? ttl * 1000 : this.defaultTtlMs
		const expiresAt = Date.now() + ttlMs
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
		for (const k of keys) {
			const v = this.get<T>(k)
			if (v !== undefined) out[k] = v
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
