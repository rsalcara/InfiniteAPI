/**
 * Typed `wa_contact_refresh_pending` + `wa_contact_refresh_patch_log`
 * SQLite-backed storage for the Contact Refresh flow (peer data operation
 * type 14, CONTACT_REFRESH_REQUEST).
 *
 * The flow is 1:1 with the app's companion side:
 *
 *   1. The companion sends a bare type-14 peer data operation request whose
 *      request id travels in `protocolMessage.key.id`
 *      (generateContactRefreshRequestId). `recordRequestSent` persists the
 *      pending row.
 *   2. The primary answers with a PeerDataOperationRequestResponseMessage
 *      carrying ContactRefreshResponse facts (covered request ids, target
 *      collection version, primary duration, unique contact count).
 *      `captureReplyFacts` fills those columns — contact DATA never travels
 *      in the reply; it arrives as syncd contact mutations later.
 *   3. When the local `critical_unblock_low` collection reaches the target
 *      version AND the patch log shows the version arrived, reconcile
 *      deletes the pending row and prunes the patch log
 *      (`deletePatchesAtOrBelow`).
 *
 * `last_contact_auto_heal_timestamp` (infiniteapi_metadata) is the
 * CompanionContactAutoHealer window marker — same key semantics as the
 * app's heal-window timestamp.
 */
import type { SqliteDbLike, SqliteStatementLike } from './types'

export type ContactRefreshPendingRow = {
	refreshId: string
	requestStartMs: number
	targetVersion: number | null
	primaryDurationMs: number | null
	contactUploadedCount: number | null
}

export type ContactRefreshPatchRow = {
	version: number
	appliedTimestampMs: number
	applyDurationMs: number | null
	addedCount: number
	editedCount: number
}

export type ContactRefreshReplyFacts = {
	targetVersion: number | null
	primaryDurationMs: number | null
	contactUploadedCount: number | null
}

/** InfiniteAPI metadata key for the auto-heal window marker. */
export const LAST_CONTACT_AUTO_HEAL_TIMESTAMP_KEY = 'last_contact_auto_heal_timestamp'

type PendingRowRaw = {
	refresh_id: string
	request_start_ms: number
	target_version: number | null
	primary_duration_ms: number | null
	contact_uploaded_count: number | null
}

type PatchRowRaw = {
	version: number
	applied_timestamp_ms: number
	apply_duration_ms: number | null
	added_count: number
	edited_count: number
}

const mapPendingRow = (row: PendingRowRaw): ContactRefreshPendingRow => ({
	refreshId: row.refresh_id,
	requestStartMs: row.request_start_ms,
	targetVersion: row.target_version,
	primaryDurationMs: row.primary_duration_ms,
	contactUploadedCount: row.contact_uploaded_count
})

const mapPatchRow = (row: PatchRowRaw): ContactRefreshPatchRow => ({
	version: row.version,
	appliedTimestampMs: row.applied_timestamp_ms,
	applyDurationMs: row.apply_duration_ms,
	addedCount: row.added_count,
	editedCount: row.edited_count
})

export class ContactRefreshBackend {
	private readonly stmts: {
		insertPending: SqliteStatementLike
		captureFacts: SqliteStatementLike
		selectPending: SqliteStatementLike
		listPending: SqliteStatementLike
		deletePending: SqliteStatementLike
		upsertPatch: SqliteStatementLike
		selectPatch: SqliteStatementLike
		hasPatchAtOrAbove: SqliteStatementLike
		deletePatchesAtOrBelow: SqliteStatementLike
		selectMeta: SqliteStatementLike
		upsertMeta: SqliteStatementLike
	}

	constructor(db: SqliteDbLike) {
		this.stmts = {
			insertPending: db.prepare(
				'INSERT INTO wa_contact_refresh_pending (refresh_id, request_start_ms) VALUES (?, ?) ' +
					'ON CONFLICT(refresh_id) DO UPDATE SET request_start_ms = excluded.request_start_ms'
			),
			captureFacts: db.prepare(
				'UPDATE wa_contact_refresh_pending SET ' +
					'  target_version = ?, primary_duration_ms = ?, contact_uploaded_count = ? ' +
					'WHERE refresh_id = ?'
			),
			selectPending: db.prepare('SELECT * FROM wa_contact_refresh_pending WHERE refresh_id = ?'),
			listPending: db.prepare('SELECT * FROM wa_contact_refresh_pending ORDER BY request_start_ms ASC'),
			deletePending: db.prepare('DELETE FROM wa_contact_refresh_pending WHERE refresh_id = ?'),
			upsertPatch: db.prepare(
				'INSERT INTO wa_contact_refresh_patch_log ' +
					'  (version, applied_timestamp_ms, apply_duration_ms, added_count, edited_count) ' +
					'VALUES (?, ?, ?, ?, ?) ' +
					'ON CONFLICT(version) DO UPDATE SET ' +
					'  applied_timestamp_ms = excluded.applied_timestamp_ms, ' +
					'  apply_duration_ms = COALESCE(excluded.apply_duration_ms, apply_duration_ms), ' +
					'  added_count = added_count + excluded.added_count, ' +
					'  edited_count = edited_count + excluded.edited_count'
			),
			selectPatch: db.prepare('SELECT * FROM wa_contact_refresh_patch_log WHERE version = ?'),
			hasPatchAtOrAbove: db.prepare('SELECT 1 AS found FROM wa_contact_refresh_patch_log WHERE version >= ? LIMIT 1'),
			deletePatchesAtOrBelow: db.prepare('DELETE FROM wa_contact_refresh_patch_log WHERE version <= ?'),
			selectMeta: db.prepare('SELECT value FROM infiniteapi_metadata WHERE key = ?'),
			upsertMeta: db.prepare(
				'INSERT INTO infiniteapi_metadata (key, value) VALUES (?, ?) ' +
					'ON CONFLICT(key) DO UPDATE SET value = excluded.value'
			)
		}
	}

	recordRequestSent(refreshId: string, requestStartMs: number): void {
		this.stmts.insertPending.run(refreshId, requestStartMs)
	}

	captureReplyFacts(refreshId: string, facts: ContactRefreshReplyFacts): void {
		this.stmts.captureFacts.run(facts.targetVersion, facts.primaryDurationMs, facts.contactUploadedCount, refreshId)
	}

	getPending(refreshId: string): ContactRefreshPendingRow | null {
		const row = this.stmts.selectPending.get(refreshId) as PendingRowRaw | undefined
		return row ? mapPendingRow(row) : null
	}

	listPending(): ContactRefreshPendingRow[] {
		return (this.stmts.listPending.all() as PendingRowRaw[]).map(mapPendingRow)
	}

	deletePending(refreshId: string): void {
		this.stmts.deletePending.run(refreshId)
	}

	/**
	 * Records that a contact/lid_contact mutation version was ingested and
	 * applied locally. Repeated calls accumulate added/edited counts (the
	 * engine mirrors one mutation per call; the app aggregates per patch).
	 */
	recordPatchApplied(patch: {
		version: number
		appliedTimestampMs: number
		applyDurationMs?: number | null
		addedCount?: number
		editedCount?: number
	}): void {
		this.stmts.upsertPatch.run(
			patch.version,
			patch.appliedTimestampMs,
			patch.applyDurationMs ?? null,
			patch.addedCount ?? 0,
			patch.editedCount ?? 0
		)
	}

	getPatchByVersion(version: number): ContactRefreshPatchRow | null {
		const row = this.stmts.selectPatch.get(version) as PatchRowRaw | undefined
		return row ? mapPatchRow(row) : null
	}

	/** "Has local ingestion reached at least `version`?" — reconcile's probe. */
	hasPatchAtOrAbove(version: number): boolean {
		return !!this.stmts.hasPatchAtOrAbove.get(version)
	}

	/** Prunes the patch log at or below `version` (the app's deleteAtOrBelow). */
	deletePatchesAtOrBelow(version: number): void {
		this.stmts.deletePatchesAtOrBelow.run(version)
	}

	getLastContactAutoHealTimestamp(): number | null {
		const row = this.stmts.selectMeta.get(LAST_CONTACT_AUTO_HEAL_TIMESTAMP_KEY) as { value: string } | undefined
		if (!row) return null
		const parsed = Number(row.value)
		return Number.isFinite(parsed) ? parsed : null
	}

	setLastContactAutoHealTimestamp(timestampMs: number): void {
		this.stmts.upsertMeta.run(LAST_CONTACT_AUTO_HEAL_TIMESTAMP_KEY, String(timestampMs))
	}
}
