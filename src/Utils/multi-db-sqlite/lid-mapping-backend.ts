/**
 * Phase 9.1 — typed `jid_map`-backed storage for LID↔PN mappings.
 *
 * Stores both addressing forms as rows in the `jid` table (one row per
 * unique `raw_string`) and links them via `jid_map`. The mapping table
 * uses the LID's `_id` as primary key, so a given LID always points to
 * exactly one PN; conversely a PN may be referenced by many LIDs (a single
 * phone number can be linked to several device-LIDs over time).
 *
 * The InfiniteAPI `LIDMappingStore` (in `src/Signal/lid-mapping.ts`) speaks
 * to persistence via a `SignalKeyStoreWithTransaction` interface using the
 * `'lid-mapping'` type and key conventions:
 *   - `pnUser` → `lidUser`        (PN-to-LID lookup)
 *   - `${lidUser}_reverse` → `pnUser`   (LID-to-PN lookup)
 *
 * The {@link wrapKeysWithJidMap} helper plugs this typed backend into that
 * key-store interface without changing the LIDMappingStore at all.
 */
import { type InClauseQuery, prepareInClause } from './in-statement-cache'
import type { SqliteDbLike, SqliteStatementLike } from './types'

const REVERSE_SUFFIX = '_reverse'

/**
 * Lower-level operations on `msgstore.db` (`jid` + `jid_map`) for the
 * LID↔PN mapping use case. Designed so consumers other than the legacy
 * `LIDMappingStore` can also call directly (e.g. introspection, migration,
 * device-list refresh tooling).
 */
export class JidMapBackend {
	private readonly stmts: {
		insertJid: SqliteStatementLike
		selectJidIdByRaw: SqliteStatementLike
		upsertMap: SqliteStatementLike
		selectPnByLid: SqliteStatementLike
		selectLidByPn: SqliteStatementLike
	}

	private readonly db: SqliteDbLike

	/**
	 * Cached `IN (…)` queries for the batch lookups. `prepareInClause`
	 * holds at most two prepared statements per query (full chunk + one
	 * trailing chunk) so the hot path doesn't pay `db.prepare()` per call.
	 * Without this, every `LIDMappingStore.batchResolvePn()` call (~100
	 * recipients) compiled a brand-new statement that leaked native memory
	 * until V8 collected the JS wrapper.
	 *
	 * Uses SQLite window functions (`ROW_NUMBER() OVER PARTITION BY`) for
	 * the PN→LID "most recent" pick — eliminates the correlated subquery
	 * the previous version had (which scanned the table per row).
	 */
	private readonly batchLidForPnQuery: InClauseQuery
	private readonly batchPnForLidQuery: InClauseQuery

	constructor(db: SqliteDbLike) {
		// Both the field and the parameter use the local structural
		// `SqliteDbLike` so TypeScript emits the local interface into the
		// `.d.ts` instead of `BetterSqlite3Module.Database` (private members
		// ARE included in declaration output, so they would otherwise leak
		// the optional peer-dep through the published types).
		this.db = db
		// `jid_map.lid_row_id` is the PRIMARY KEY (one PN per LID) so we
		// upsert on conflict to support a LID being re-targeted at a new PN.
		this.stmts = {
			insertJid: this.db.prepare(
				'INSERT INTO jid (raw_string, user, server, type) VALUES (?, ?, ?, ?) ' + 'ON CONFLICT(raw_string) DO NOTHING'
			),
			selectJidIdByRaw: this.db.prepare('SELECT _id FROM jid WHERE raw_string = ?'),
			upsertMap: this.db.prepare(
				// `sort_id` is set to the current epoch ms on every insert
				// AND every conflict update so it tracks "last write wins"
				// across rotations — important when a PN gets re-mapped
				// back to an OLDER LID (lower `lid_row_id`): without this,
				// `selectLidByPn ORDER BY lid_row_id DESC` would surface the
				// most-recently-ALLOCATED LID even though the most-recently-
				// WRITTEN mapping points elsewhere. The legacy opaque
				// key-value store overwrote the PN key directly; we mirror
				// the same "last write wins" semantics by ordering on
				// `sort_id` instead of `lid_row_id` for the PN→LID lookup.
				'INSERT INTO jid_map (lid_row_id, jid_row_id, sort_id) VALUES (?, ?, ?) ' +
					'ON CONFLICT(lid_row_id) DO UPDATE SET ' +
					'  jid_row_id = excluded.jid_row_id, sort_id = excluded.sort_id'
			),
			selectPnByLid: this.db.prepare(
				'SELECT j.raw_string AS raw FROM jid_map m ' +
					'JOIN jid j_lid ON j_lid._id = m.lid_row_id ' +
					'JOIN jid j ON j._id = m.jid_row_id ' +
					'WHERE j_lid.raw_string = ?'
			),
			selectLidByPn: this.db.prepare(
				// May return multiple rows (one PN can have several LIDs); the
				// LIDMappingStore expects a single value, so we ORDER BY
				// `sort_id DESC` to surface the LAST WRITTEN mapping (the
				// legacy opaque key-value store's overwrite semantics).
				// `lid_row_id DESC` was wrong for the case where a PN is
				// re-mapped back to an OLDER LID — `lid_row_id` reflects
				// allocation order, not write order. `sort_id` is now a
				// monotonic epoch-ms tick written on every insert/upsert by
				// `upsertMap`, so `ORDER BY sort_id DESC` always wins for
				// the latest write. Callers that need the full set should
				// query the table directly.
				'SELECT j.raw_string AS raw FROM jid_map m ' +
					'JOIN jid j ON j._id = m.lid_row_id ' +
					'JOIN jid j_pn ON j_pn._id = m.jid_row_id ' +
					'WHERE j_pn.raw_string = ? ORDER BY m.sort_id DESC LIMIT 1'
			)
		}

		// Window-function variant of the "most recent LID per PN" pick.
		// `ROW_NUMBER() OVER PARTITION BY jid_row_id ORDER BY sort_id DESC`
		// runs in a single pass, avoiding the correlated subquery that
		// scanned `jid_map` once per result row.
		this.batchLidForPnQuery = prepareInClause(
			this.db,
			'WITH ranked AS ( ' +
				'  SELECT m.lid_row_id, m.jid_row_id, ' +
				'         ROW_NUMBER() OVER (PARTITION BY m.jid_row_id ORDER BY m.sort_id DESC) AS rn ' +
				'  FROM jid_map m ' +
				'  JOIN jid j_pn ON j_pn._id = m.jid_row_id ' +
				'  WHERE j_pn.raw_string IN (',
			') ) ' +
				'SELECT j_pn.raw_string AS pn, j.raw_string AS lid ' +
				'FROM ranked r ' +
				'JOIN jid j ON j._id = r.lid_row_id ' +
				'JOIN jid j_pn ON j_pn._id = r.jid_row_id ' +
				'WHERE r.rn = 1'
		)
		this.batchPnForLidQuery = prepareInClause(
			this.db,
			'SELECT j_lid.raw_string AS lid, j_pn.raw_string AS pn FROM jid_map m ' +
				'JOIN jid j_lid ON j_lid._id = m.lid_row_id ' +
				'JOIN jid j_pn ON j_pn._id = m.jid_row_id ' +
				'WHERE j_lid.raw_string IN (',
			')'
		)
	}

	/**
	 * Upserts the JID row and returns its `_id`.
	 *
	 * Wrapped in a transaction so the `INSERT ... ON CONFLICT DO NOTHING` +
	 * subsequent `SELECT _id` are atomic against any concurrent writer.
	 * Without the transaction, a deletion landing between the two
	 * statements would surface the row as "not materialized" and the
	 * caller would see a misleading `failed to materialize jid row` error.
	 * The `jid` table is not deleted by today's code paths, so this is
	 * defensive — but cheap enough to keep the invariant explicit.
	 */
	private rowIdFor(jid: string): number {
		const decoded = decodeJid(jid)
		return this.db.transaction((rawString: string): number => {
			this.stmts.insertJid.run(rawString, decoded.user, decoded.server, decoded.typeHint)
			const row = this.stmts.selectJidIdByRaw.get(rawString) as { _id: number } | undefined
			if (!row) throw new Error(`JidMapBackend: failed to materialize jid row for "${rawString}"`)
			return row._id
		})(jid)
	}

	/**
	 * Stores a single PN↔LID mapping. Idempotent.
	 *
	 * Wrapped in a transaction so the three operations (materialise LID row,
	 * materialise PN row, upsert the map row) commit or roll back together.
	 * Without the outer transaction a crash between `rowIdFor(lidUser)` and
	 * `upsertMap.run()` would leave a freshly-inserted `jid` row with no
	 * matching `jid_map` entry — silently orphaned and never garbage-
	 * collected (nothing in the code path deletes orphan jid rows). When
	 * called from `storeMappingsBatch` the outer wrapper is nested with
	 * this one, which better-sqlite3 promotes to a SAVEPOINT — still safe.
	 */
	storeMapping(pnUser: string, lidUser: string): void {
		this.db.transaction(() => {
			const lidRowId = this.rowIdFor(lidUser)
			const pnRowId = this.rowIdFor(pnUser)
			// `Date.now()` as sort_id so the latest write wins on PN→LID lookups
			// even if the mapping points back to an older LID (lower lid_row_id).
			this.stmts.upsertMap.run(lidRowId, pnRowId, Date.now())
		})()
	}

	/** Stores N mappings atomically (single transaction). */
	storeMappingsBatch(pairs: Array<{ pnUser: string; lidUser: string }>): void {
		this.db.transaction(() => {
			for (const { pnUser, lidUser } of pairs) {
				this.storeMapping(pnUser, lidUser)
			}
		})()
	}

	/** Returns the LID for a PN, or `null` if no mapping exists. */
	getLidForPn(pnUser: string): string | null {
		const row = this.stmts.selectLidByPn.get(pnUser) as { raw: string } | undefined
		return row?.raw ?? null
	}

	/** Returns the PN for a LID, or `null` if no mapping exists. */
	getPnForLid(lidUser: string): string | null {
		const row = this.stmts.selectPnByLid.get(lidUser) as { raw: string } | undefined
		return row?.raw ?? null
	}

	/**
	 * Batch lookup: input list of PNs → record of those that resolved. Uses
	 * a single `IN (?, ?, ...)` SELECT per chunk so the LIDMappingStore's
	 * default batchSize=100 call from `keys.get('lid-mapping', batch)` lands
	 * as one DB round-trip instead of N. Chunked at 500 to stay well below
	 * SQLite's default 999-variable limit.
	 */
	batchGetLidForPn(pnUsers: string[]): Record<string, string> {
		const out: Record<string, string> = {}
		const rows = this.batchLidForPnQuery.all([], pnUsers) as Array<{ pn: string; lid: string }>
		for (const r of rows) out[r.pn] = r.lid
		return out
	}

	/** Batch lookup: input list of LIDs → record of those that resolved. */
	batchGetPnForLid(lidUsers: string[]): Record<string, string> {
		const out: Record<string, string> = {}
		const rows = this.batchPnForLidQuery.all([], lidUsers) as Array<{ lid: string; pn: string }>
		for (const r of rows) out[r.lid] = r.pn
		return out
	}
}

/**
 * Minimal JID parser — extracts `user`, `server`, and a coarse type code
 * matching the LID/PN distinction WA's own schema records.
 *
 * Type code values are aligned with the existing schema's `type` column:
 *   - `0`  = plain phone-number JID (`user@s.whatsapp.net`)
 *   - `17` = device-suffixed JID (`user.deviceId@...`)
 *   - `18` = LID JID (`user@lid`)
 */
function decodeJid(jid: string): { user: string; server: string; typeHint: number } {
	const at = jid.indexOf('@')
	if (at === -1) return { user: jid, server: '', typeHint: 0 }
	const user = jid.slice(0, at)
	const server = jid.slice(at + 1)
	let typeHint = 0
	if (server === 'lid') typeHint = 18
	else if (user.includes('.')) typeHint = 17
	return { user, server, typeHint }
}

/**
 * Returns the raw LID (strips trailing `_reverse` suffix used by
 * LIDMappingStore as a lookup key convention).
 */
export function stripReverse(key: string): { lidUser: string; isReverse: boolean } {
	if (key.endsWith(REVERSE_SUFFIX)) {
		return { lidUser: key.slice(0, -REVERSE_SUFFIX.length), isReverse: true }
	}

	return { lidUser: key, isReverse: false }
}

export { REVERSE_SUFFIX }
