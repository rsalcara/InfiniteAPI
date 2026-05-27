/**
 * Phase 9.3 — `NodeCache`-shaped adapter that persists message-retry
 * counters in `msgstore.db.message_orphaned_edit`.
 *
 * The existing call sites in `messages-recv.ts` use the cache as a
 * `Map<msgKeyId, number>` with a 1-hour TTL. With this adapter the
 * counter survives gateway restarts, which avoids two failure modes:
 *
 *   1. **Counter reset on restart**: a previously-retried message that
 *      hits the cap gets a fresh budget after the process bounces,
 *      defeating the back-off the upstream code put in place.
 *   2. **Cross-instance collision**: if two parallel processes share
 *      the same session (e.g. blue/green deploy mid-handoff), the
 *      in-memory cache misses the other process's increments. SQLite
 *      serializes both writers naturally via WAL.
 *
 * The adapter stores ONLY the retry counter — the natural-key columns
 * (`key_id`, `from_me`, `chat_row_id`, `sender_jid_row_id`) are not
 * populated here because the gateway addresses the counter by the same
 * single string key the upstream cache uses. The full typed schema with
 * the natural key remains available for callers that want to query by
 * (chat, sender) tuples.
 */
import type BetterSqlite3Module from 'better-sqlite3'

type Database = BetterSqlite3Module.Database

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
}

export class MsgRetryCounterSqliteAdapter implements CacheStoreShape {
	private readonly stmts: {
		select: BetterSqlite3Module.Statement
		upsert: BetterSqlite3Module.Statement
		del: BetterSqlite3Module.Statement
		prune: BetterSqlite3Module.Statement
	}

	private readonly defaultTtlMs: number
	private pruneTicker?: NodeJS.Timeout

	constructor(
		private readonly db: Database,
		opts: MsgRetryCounterAdapterOptions = {}
	) {
		this.defaultTtlMs = (opts.defaultTtlSeconds ?? 60 * 60) * 1000 // 1 hour default

		db.exec(CREATE_AUX_TABLE_SQL)
		this.stmts = {
			select: db.prepare('SELECT retry_count, expires_at FROM msg_retry_counter WHERE key_id = ?'),
			upsert: db.prepare(
				'INSERT INTO msg_retry_counter (key_id, retry_count, last_attempt, expires_at) VALUES (?, ?, ?, ?) ' +
					'ON CONFLICT(key_id) DO UPDATE SET ' +
					'  retry_count = excluded.retry_count, last_attempt = excluded.last_attempt, expires_at = excluded.expires_at'
			),
			del: db.prepare('DELETE FROM msg_retry_counter WHERE key_id = ?'),
			prune: db.prepare('DELETE FROM msg_retry_counter WHERE expires_at <= ?')
		}

		if (opts.runPruneTickerEverySeconds && opts.runPruneTickerEverySeconds > 0) {
			this.pruneTicker = setInterval(
				() => this.pruneExpired(),
				opts.runPruneTickerEverySeconds * 1000
			)
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
		const ttlMs = typeof ttl === 'number' ? ttl * 1000 : this.defaultTtlMs
		const now = Date.now()
		const count = Number(value)
		if (!Number.isFinite(count)) return false
		this.stmts.upsert.run(key, count, now, now + ttlMs)
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

	close(): void {
		if (this.pruneTicker) {
			clearInterval(this.pruneTicker)
			this.pruneTicker = undefined
		}
	}
}
