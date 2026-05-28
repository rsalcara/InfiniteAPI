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
import { resolveExpiresAt } from './ttl-utils'
import type { SqliteDbLike, SqliteStatementLike } from './types'

// `msg_retry_counter` is owned by `schemas/msgstore.ts` so it goes through
// the same migration bookkeeping as the rest of the multi-DB store. The
// adapter assumes the table already exists (MultiDbSqliteStore has opened
// msgstore.db and run its schema by the time this adapter is constructed).

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
			// Guard the timer body — see user-device-cache-adapter.ts for the
			// full rationale. Short version: if the host process closes the
			// underlying db handle before this adapter's own close() runs, the
			// next tick throws "database connection is not open" from inside
			// the timer (no surrounding caller). Catching it keeps shutdown
			// noise-free; there is nothing to prune on a closed handle.
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

	get<T = unknown>(key: string): T | undefined {
		const row = this.stmts.select.get(key) as { retry_count: number; expires_at: number } | undefined
		if (!row) return undefined
		if (row.expires_at <= Date.now()) {
			// Lazy expiry — must not throw. NodeCache's contract is that
			// `.get()` returns `undefined` for miss; surfacing SQLITE_BUSY
			// here breaks the retry-counter increment path in messages-recv.ts.
			try {
				this.stmts.del.run(key)
			} catch {
				/* lazy expiry only — leave the stale row for the prune ticker */
			}

			return undefined
		}

		return row.retry_count as unknown as T
	}

	set(key: string, value: unknown, ttl?: number | string): boolean {
		const now = Date.now()
		const count = Number(value)
		if (!Number.isFinite(count)) return false
		const expiresAt = resolveExpiresAt(ttl, this.defaultTtlMs, now)
		this.stmts.upsert.run(key, count, now, expiresAt)
		return true
	}

	del(key: string | string[]): number {
		const keys = Array.isArray(key) ? key : [key]
		// Fast path for the single-key case (the only one exercised by
		// messages-recv.ts today) — skips BEGIN IMMEDIATE / COMMIT and the
		// closure allocation. Keeps the multi-key reducer path for callers
		// that bulk-delete multiple counters at once.
		if (keys.length === 1) return this.stmts.del.run(keys[0]!).changes
		// Reducer keeps the per-call accumulator local to the transaction
		// instead of leaking it into the closure. better-sqlite3 does NOT
		// retry the transaction body automatically, but the previous
		// closure-mutation pattern would have double-counted on a future
		// caller that wrapped tx() in a retry loop.
		const tx = this.db.transaction((batch: string[]) =>
			batch.reduce((acc, k) => acc + this.stmts.del.run(k).changes, 0)
		)
		return tx(keys)
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
