/**
 * Helper that caches prepared statements with `IN (?, ?, …)` clauses per
 * chunk size. `better-sqlite3` does NOT cache prepared statements, and
 * unfinalized statements pin native memory until the V8 GC reaps the JS
 * wrapper — calling `db.prepare(sql)` on every batch lookup leaks memory
 * progressively on hot paths.
 *
 * The cache keys on the number of placeholders. In practice we always
 * chunk to a fixed size (default 500) and the cache holds at most two
 * entries: the "full chunk" statement (used 99% of the time) and one
 * "tail chunk" statement of the remainder size.
 *
 * Usage:
 *   const inQuery = prepareInClause(
 *     db,
 *     'SELECT id, value FROM signal_kv WHERE type = ? AND id IN (',
 *     ') ORDER BY id',
 *     500
 *   )
 *   const rows = inQuery.run(['session'], [id1, id2, …]) // first arg = leading params before IN
 */
import type { SqliteDbLike, SqliteStatementLike } from './types'

/** SQLite default `SQLITE_LIMIT_VARIABLE_NUMBER` is 999. We chunk well below it. */
export const DEFAULT_IN_CHUNK = 500

export interface InClauseQuery {
	/**
	 * Executes the query over `inValues`, chunking at `chunkSize` (default
	 * 500). `leadingParams` are bound BEFORE the IN-list placeholders for
	 * every chunk. The returned rows are concatenated in chunk order.
	 */
	all(leadingParams: ReadonlyArray<unknown>, inValues: ReadonlyArray<unknown>): unknown[]
	/**
	 * Same as `all()` but uses `stmt.run()` and returns the total `changes`
	 * across every chunk. For INSERT/UPDATE/DELETE statements — calling
	 * `.all()` works at runtime but is semantically wrong (DELETE has no
	 * rows to "iterate") and discards the `changes` count callers might
	 * want for metrics or assertions.
	 */
	run(leadingParams: ReadonlyArray<unknown>, inValues: ReadonlyArray<unknown>): number
}

export function prepareInClause(
	db: SqliteDbLike,
	sqlBeforeIn: string,
	sqlAfterIn: string,
	chunkSize: number = DEFAULT_IN_CHUNK
): InClauseQuery {
	// Cache of prepared statements keyed by exact placeholder count. Holding
	// `Map<number, SqliteStatementLike>` lets us reuse the chunk-sized
	// statement across calls and only prepare a second one for the (at most
	// one) trailing chunk per call.
	const cache = new Map<number, SqliteStatementLike>()

	function getStmt(placeholderCount: number): SqliteStatementLike {
		let stmt = cache.get(placeholderCount)
		if (!stmt) {
			const placeholders = new Array(placeholderCount).fill('?').join(',')
			stmt = db.prepare(`${sqlBeforeIn}${placeholders}${sqlAfterIn}`)
			cache.set(placeholderCount, stmt)
		}

		return stmt
	}

	return {
		all(leadingParams, inValues) {
			if (inValues.length === 0) return []
			const out: unknown[] = []
			for (let i = 0; i < inValues.length; i += chunkSize) {
				const chunk = inValues.slice(i, i + chunkSize)
				const stmt = getStmt(chunk.length)
				const rows = stmt.all(...leadingParams, ...chunk)
				if (rows.length > 0) out.push(...rows)
			}

			return out
		},
		run(leadingParams, inValues) {
			if (inValues.length === 0) return 0
			let total = 0
			for (let i = 0; i < inValues.length; i += chunkSize) {
				const chunk = inValues.slice(i, i + chunkSize)
				const stmt = getStmt(chunk.length)
				const result = stmt.run(...leadingParams, ...chunk)
				total += result.changes
			}

			return total
		}
	}
}
