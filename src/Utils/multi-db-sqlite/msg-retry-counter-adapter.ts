/**
 * Phase 9.3 — `NodeCache`-shaped adapter that persists message-retry
 * counters in a dedicated `msg_retry_counter` auxiliary table on
 * `msgstore.db`.
 *
 * **Why an auxiliary table instead of `message_orphaned_edit`?**
 *
 * `message_orphaned_edit` carries the full natural key
 * (`key_id`, `from_me`, `chat_row_id`, `sender_jid_row_id`) that the
 * mobile client uses for retry dedup. The existing InfiniteAPI call sites
 * in `messages-recv.ts` address the counter by a single string key
 * (the upstream `NodeCache<number>` shape), so storing it in the typed
 * table would force a parser at the boundary. The auxiliary table keeps
 * the adapter call-compatible while leaving `message_orphaned_edit` free
 * for the eventual fully-typed integration (phase 9.3.1).
 *
 * With this adapter the counter survives gateway restarts, which avoids
 * two failure modes:
 *
 *   1. **Counter reset on restart**: a previously-retried message that
 *      hits the cap gets a fresh budget after the process bounces,
 *      defeating the back-off the upstream code put in place.
 *   2. **Cross-instance collision (partial fix)**: if two parallel
 *      processes share the same session (e.g. blue/green deploy mid-
 *      handoff), the in-memory cache misses the other process's
 *      increments. SQLite serializes the WRITES naturally via WAL, but
 *      the existing `messages-recv.ts` callers do `get()` then `set(n+1)`
 *      — a non-atomic read-modify-write that can still undercount when
 *      both processes read the same value before either writes. The
 *      InfiniteAPI deployment topology is single-process (PM2), so this
 *      undercount is not exercised today; a fully race-free counter
 *      would require an atomic `INSERT ... ON CONFLICT DO UPDATE SET
 *      retry_count = retry_count + 1` and is tracked for phase 9.3.1.
 */
import type { SqliteDbLike, SqliteStatementLike } from './types'

// Year-9999 epoch ms — NodeCache `ttl=0` means "never expire", which we
// encode as a fixed far-future `expires_at` so the read path stays NULL-
// free and the column stays NOT NULL.
const NO_EXPIRY_SENTINEL = 253_402_300_799_000

/**
 * Parses a NodeCache-style TTL string ("35m", "1h", etc.) into ms.
 * Returns `null` if the input is malformed.
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

const CREATE_AUX_TABLE_SQL = `
CREATE TABLE IF NOT EXISTS msg_retry_counter (
  key_id TEXT PRIMARY KEY,
  retry_count INTEGER NOT NULL DEFAULT 0,
  last_attempt INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS msg_retry_counter_expires_idx
  ON msg_retry_counter (expires_at);
`

export type MsgRetryCounterAdapterOptions = {
	defaultTtlSeconds?: number
	runPruneTickerEverySeconds?: number
}

export interface CacheStoreShape {
	get<T = unknown>(key: string): T | undefined
	set(key: string, value: unknown, ttl?: number | string): boolean
	del(key: string | string[]): number
	flushAll(): void
}

export class MsgRetryCounterSqliteAdapter implements CacheStoreShape {
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

	constructor(db: SqliteDbLike, opts: MsgRetryCounterAdapterOptions = {}) {
		this.db = db
		this.defaultTtlMs = (opts.defaultTtlSeconds ?? 60 * 60) * 1000 // 1 hour default

		this.db.exec(CREATE_AUX_TABLE_SQL)
		this.stmts = {
			select: this.db.prepare('SELECT retry_count, expires_at FROM msg_retry_counter WHERE key_id = ?'),
			upsert: this.db.prepare(
				'INSERT INTO msg_retry_counter (key_id, retry_count, last_attempt, expires_at) VALUES (?, ?, ?, ?) ' +
					'ON CONFLICT(key_id) DO UPDATE SET ' +
					'  retry_count = excluded.retry_count, last_attempt = excluded.last_attempt, expires_at = excluded.expires_at'
			),
			del: this.db.prepare('DELETE FROM msg_retry_counter WHERE key_id = ?'),
			prune: this.db.prepare('DELETE FROM msg_retry_counter WHERE expires_at <= ?'),
			flushAll: this.db.prepare('DELETE FROM msg_retry_counter')
		}

		if (opts.runPruneTickerEverySeconds && opts.runPruneTickerEverySeconds > 0) {
			this.pruneTicker = setInterval(() => this.pruneExpired(), opts.runPruneTickerEverySeconds * 1000)
			if (typeof this.pruneTicker.unref === 'function') this.pruneTicker.unref()
		}
	}

	get<T = unknown>(key: string): T | undefined {
		const row = this.stmts.select.get(key) as { retry_count: number; expires_at: number } | undefined
		if (!row) return undefined
		if (row.expires_at <= Date.now()) {
			this.stmts.del.run(key)
			return undefined
		}

		return row.retry_count as unknown as T
	}

	set(key: string, value: unknown, ttl?: number | string): boolean {
		const now = Date.now()
		const count = Number(value)
		if (!Number.isFinite(count)) return false
		let expiresAt: number
		if (typeof ttl === 'number') {
			// NodeCache compat: ttl === 0 means "never expire".
			expiresAt = ttl === 0 ? NO_EXPIRY_SENTINEL : now + ttl * 1000
		} else if (typeof ttl === 'string') {
			// NodeCache also accepts strings like "35m", "1h", "30s".
			const parsed = parseTtlString(ttl)
			expiresAt = parsed === null ? now + this.defaultTtlMs : now + parsed
		} else {
			expiresAt = now + this.defaultTtlMs
		}

		this.stmts.upsert.run(key, count, now, expiresAt)
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

	pruneExpired(now: number = Date.now()): number {
		const r = this.stmts.prune.run(now)
		return r.changes
	}

	/**
	 * Required by `SocketConfig.msgRetryCounterCache` (typed `CacheStore`).
	 * Wipes every counter — used on socket close so a reconnect does not
	 * inherit stale retry budgets from the previous session lifetime.
	 */
	flushAll(): void {
		this.stmts.flushAll.run()
	}

	close(): void {
		if (this.pruneTicker) {
			clearInterval(this.pruneTicker)
			this.pruneTicker = undefined
		}
	}
}
