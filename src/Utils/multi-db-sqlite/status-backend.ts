/**
 * Phase 9.15 — typed status/stories feed storage backed by `status.db`.
 *
 * Real Android capture (WA Business 2.26.21.75, Frida) confirms this is a
 * "rica" (rich-evidence) database with a real empirical state machine — see
 * schemas/status.ts's header for the full note. This backend wires only the
 * two tables with a confident, direct Baileys mapping:
 *
 *   - `status_info` — one row per sender jid, aggregate counters
 *     (total_count/unread_count) for that sender's status feed.
 *   - `status` — one row per received status update, FK'd to its sender's
 *     `status_info.row_id`.
 *
 * `status_seen_receipt` — who has viewed a status, and when — IS also wired
 * (`recordSeenReceipt`), confirmed reachable via live Frida capture
 * (2026-07-09): a real Android primary device writes this same table off
 * the ordinary `<receipt>` stanza for `status@broadcast`, which Baileys
 * ALREADY parses and emits as `message-receipt.update` (see
 * `messages-recv.ts`'s `handleReceipt` — no new wire-level decoding needed,
 * just routing an existing event). `status_row_id` is looked up by `uuid`;
 * a receipt whose status isn't recorded locally (e.g. the user's OWN posted
 * status, which `recordReceivedStatus` only captures if it flowed through
 * processMessage while connected) is SKIPPED rather than stored with a null FK
 * — a null-FK row is unretrievable by uuid, escapes the delete-cascade (so it
 * would grow unbounded), and can't dedupe. Own-status view info still arrives
 * live via `message-receipt.update`. See `recordSeenReceipt`.
 *
 * The remaining 6 tables in status.ts (`status_attribution`/
 * `status_crossposting_v3` for channel-crosspost, `status_text` for
 * rich-link metadata, `status_media_link`/`status_thumbnail` for media,
 * `status_privacy_custom_list` for the separate privacy-list feature) are
 * intentionally NOT wired here — they need data Baileys doesn't decode/
 * expose confidently today (crosspost session state, WA's own
 * media-content-row indirection, a full privacy-list management feature).
 * Left schema-only rather than guessed at.
 *
 * Confirmed values used here (from the schema's own empirical header):
 *   - `type = 4` — dominant/standard status type.
 *   - `state = 3` — server-confirmed receipt (accurate from a VIEWER's
 *     perspective: by the time this gateway decodes an inbound status, the
 *     server has already delivered it — the 0/1 "creating/queued" states
 *     only apply to the ORIGINAL POSTER's own local lifecycle, which this
 *     gateway is never in a position to observe).
 * `origin`/`flags`/`audience_type`/`secret`/`content_proto`/`fp_proto`/
 * `stanza_xml` have no confirmed source and are left at the schema's own
 * defaults (0/null) rather than fabricated. `sort_id` has no confirmed
 * assignment algorithm either — this backend assigns a simple
 * per-status_info_row_id incrementing counter (satisfies the real schema's
 * own UNIQUE(status_info_row_id, sort_id) constraint without asserting it
 * matches WhatsApp's real ordering logic).
 *
 * Column names match the canonical schema verbatim.
 */
import type { SqliteDbLike, SqliteStatementLike } from './types'

export const STATUS_TYPE_STANDARD = 4
export const STATUS_STATE_SERVER_CONFIRMED = 3

/** Status feed is a 24h window on the mobile — mirror the same retention. */
export const STATUS_RETENTION_SECS_DEFAULT = 24 * 60 * 60
/** Prune at most this often (amortized, from the write path) — no timer needed. */
export const STATUS_PRUNE_INTERVAL_MS_DEFAULT = 60 * 60 * 1000

export type ReceivedStatusInput = {
	senderUserJid: string
	uuid: string
	timestamp: number
	textData?: string | null
}

export type SeenReceiptInput = {
	statusUuid: string
	receiptUserJid: string
	seenTimestamp: number
}

export type StoredStatusRow = {
	row_id: number
	sort_id: number
	uuid: string
	sender_user_jid: string
	status_info_row_id: number
	type: number
	timestamp: number
	text_data: string | null
	state: number
}

export class StatusBackend {
	private readonly stmts: {
		upsertStatusInfo: SqliteStatementLike
		getStatusInfoRowId: SqliteStatementLike
		incrementCounts: SqliteStatementLike
		nextSortId: SqliteStatementLike
		insertStatus: SqliteStatementLike
		listStatusesForSender: SqliteStatementLike
		listStatusesForSenderSince: SqliteStatementLike
		getStatusRowIdByUuid: SqliteStatementLike
		upsertSeenReceipt: SqliteStatementLike
		listSeenReceiptsForStatus: SqliteStatementLike
		pruneExpired: SqliteStatementLike
	}

	private readonly db: SqliteDbLike
	private readonly retentionSecs: number
	private readonly pruneIntervalMs: number
	private lastPruneAtMs = 0

	constructor(db: SqliteDbLike, opts?: { retentionSecs?: number; pruneIntervalMs?: number }) {
		this.db = db
		this.retentionSecs = opts?.retentionSecs ?? STATUS_RETENTION_SECS_DEFAULT
		this.pruneIntervalMs = opts?.pruneIntervalMs ?? STATUS_PRUNE_INTERVAL_MS_DEFAULT
		this.stmts = {
			upsertStatusInfo: this.db.prepare(
				'INSERT INTO status_info (chat_jid, total_count, unread_count, is_muted, type) VALUES (?, 0, 0, 0, 0) ' +
					'ON CONFLICT(chat_jid) DO NOTHING'
			),
			getStatusInfoRowId: this.db.prepare('SELECT row_id FROM status_info WHERE chat_jid = ?'),
			incrementCounts: this.db.prepare(
				'UPDATE status_info SET total_count = total_count + 1, unread_count = unread_count + 1, ' +
					'last_status_sort_id = ?, last_status_timestamp = ? WHERE row_id = ?'
			),
			nextSortId: this.db.prepare(
				'SELECT COALESCE(MAX(sort_id), 0) + 1 AS next FROM status WHERE status_info_row_id = ?'
			),
			insertStatus: this.db.prepare(
				'INSERT INTO status (sort_id, uuid, sender_user_jid, status_info_row_id, type, timestamp, text_data, ' +
					'state, origin, flags, audience_type, is_archived) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, 0, 0, 0)'
			),
			listStatusesForSender: this.db.prepare(
				'SELECT row_id, sort_id, uuid, sender_user_jid, status_info_row_id, type, timestamp, text_data, state ' +
					'FROM status WHERE sender_user_jid = ? ORDER BY sort_id ASC'
			),
			listStatusesForSenderSince: this.db.prepare(
				'SELECT row_id, sort_id, uuid, sender_user_jid, status_info_row_id, type, timestamp, text_data, state ' +
					'FROM status WHERE sender_user_jid = ? AND timestamp >= ? ORDER BY sort_id ASC'
			),
			getStatusRowIdByUuid: this.db.prepare('SELECT row_id FROM status WHERE uuid = ?'),
			upsertSeenReceipt: this.db.prepare(
				'INSERT INTO status_seen_receipt (status_row_id, receipt_user_jid, seen_timestamp) VALUES (?, ?, ?) ' +
					'ON CONFLICT(status_row_id, receipt_user_jid) DO UPDATE SET seen_timestamp = excluded.seen_timestamp'
			),
			listSeenReceiptsForStatus: this.db.prepare(
				'SELECT row_id, status_row_id, receipt_user_jid, received_timestamp, seen_timestamp ' +
					'FROM status_seen_receipt WHERE status_row_id = ?'
			),
			// Hard-delete expired statuses (24h window, mirroring the mobile). The
			// canonical `AFTER DELETE`/`BEFORE DELETE` triggers (see status.ts) fire
			// per row to keep `status_info` aggregates consistent and cascade to
			// `status_seen_receipt` — exactly like the real app, so this is a plain
			// bulk DELETE. `timestamp` is unix SECONDS here (recordReceivedStatus
			// stores `message.messageTimestamp`), so the cutoff is in seconds too.
			pruneExpired: this.db.prepare('DELETE FROM status WHERE timestamp < ?')
		}
	}

	/**
	 * Records one received status update, upserting its sender's status_info
	 * aggregate row first. Wrapped in a transaction (audit finding, Phase 9
	 * self-review): this is 4 dependent statements — a crash between
	 * insertStatus and incrementCounts would leave status_info's counters
	 * permanently out of sync with the actual status rows.
	 *
	 * IDEMPOTENT by `uuid` (audit #637): the same status is legitimately
	 * delivered more than once — history-sync catch-up overlapping the live
	 * stream, a retry/re-decrypt, an app-state replay. `uuid` == the status
	 * message id is stable across those, so a second call for the same uuid MUST
	 * NOT insert a duplicate `status` row (and double-count total_count/
	 * unread_count, which have no de-dup of their own). The existence check runs
	 * INSIDE the transaction so a concurrent writer can't slip a duplicate in
	 * between the check and the insert. Returns `true` when a new row was
	 * inserted, `false` when skipped as a duplicate.
	 */
	recordReceivedStatus(input: ReceivedStatusInput): boolean {
		let inserted = false
		const run = this.db.transaction(() => {
			if (this.stmts.getStatusRowIdByUuid.get(input.uuid)) {
				return // already recorded — skip insert + count to stay idempotent
			}

			this.stmts.upsertStatusInfo.run(input.senderUserJid)
			const infoRow = this.stmts.getStatusInfoRowId.get(input.senderUserJid) as { row_id: number } | undefined
			if (!infoRow) return // upsert+immediate select on the same PK — should never miss

			const { next: sortId } = this.stmts.nextSortId.get(infoRow.row_id) as { next: number }
			this.stmts.insertStatus.run(
				sortId,
				input.uuid,
				input.senderUserJid,
				infoRow.row_id,
				STATUS_TYPE_STANDARD,
				input.timestamp,
				input.textData ?? null,
				STATUS_STATE_SERVER_CONFIRMED
			)
			this.stmts.incrementCounts.run(sortId, input.timestamp, infoRow.row_id)
			inserted = true
		})
		run()
		// Opportunistic, throttled expiry — keeps status.db bounded (24h feed)
		// without a timer/socket wiring. Never throws into the caller.
		this.maybePrune()
		return inserted
	}

	/**
	 * Hard-deletes statuses older than `cutoffTimestamp` (unix seconds). Returns
	 * the number of `status` rows removed. The ported mobile triggers keep
	 * `status_info` aggregates consistent and cascade to `status_seen_receipt`.
	 */
	pruneExpired(cutoffTimestamp: number): number {
		return this.stmts.pruneExpired.run(cutoffTimestamp).changes as number
	}

	/** Throttled prune driven from the write path (default: hourly, 24h TTL). */
	private maybePrune(): void {
		const now = Date.now()
		if (now - this.lastPruneAtMs < this.pruneIntervalMs) {
			return
		}

		this.lastPruneAtMs = now
		try {
			this.pruneExpired(Math.floor(now / 1000) - this.retentionSecs)
		} catch {
			// best-effort: a prune failure must never break status recording.
		}
	}

	/** All recorded statuses for a sender, oldest→newest, WITHOUT the 24h filter. */
	listStatusesForSender(senderUserJid: string): StoredStatusRow[] {
		return this.stmts.listStatusesForSender.all(senderUserJid) as StoredStatusRow[]
	}

	/**
	 * Like `listStatusesForSender` but drops rows past the 24h retention window
	 * at READ time (audit #637). The write-path prune is throttled (hourly) and
	 * best-effort, so a just-expired status can still be on disk between prunes —
	 * filtering on read guarantees the consumer never sees a stale (>24h) status,
	 * matching the mobile feed which only ever shows the live 24h window. Uses the
	 * backend's own configured `retentionSecs` (same TTL as the prune). `nowSecs`
	 * defaults to the current time in unix seconds; injectable for tests.
	 */
	listActiveStatusesForSender(
		senderUserJid: string,
		nowSecs: number = Math.floor(Date.now() / 1000)
	): StoredStatusRow[] {
		const cutoff = nowSecs - this.retentionSecs
		return this.stmts.listStatusesForSenderSince.all(senderUserJid, cutoff) as StoredStatusRow[]
	}

	/**
	 * Records that `receiptUserJid` has seen the status identified by
	 * `statusUuid`. Returns `true` if stored, `false` if skipped.
	 *
	 * SKIPS (returns false) when no local `status` row matches the uuid — e.g. a
	 * receipt for the user's OWN posted status that this gateway never recorded.
	 * We used to insert a null-FK row, but that was a trap: it's unretrievable by
	 * uuid (so `getStatusViewers` returns [] anyway), it's never reached by the
	 * delete-cascade trigger (so it would accumulate UNBOUNDED), and it can't
	 * dedupe (NULLs are distinct under the UNIQUE index → repeated views pile
	 * up). Skipping keeps the schema mobile-identical (no synthetic `status_uuid`
	 * column) — the real app never hits this because it records every status, so
	 * its FK is always resolvable. Own-status view info is still delivered live
	 * via `message-receipt.update`. Upsert keyed on (status_row_id,
	 * receipt_user_jid) so a repeated view just refreshes `seen_timestamp`.
	 */
	recordSeenReceipt(input: SeenReceiptInput): boolean {
		const statusRow = this.stmts.getStatusRowIdByUuid.get(input.statusUuid) as { row_id: number } | undefined
		if (!statusRow) {
			return false
		}

		this.stmts.upsertSeenReceipt.run(statusRow.row_id, input.receiptUserJid, input.seenTimestamp)
		return true
	}

	listSeenReceiptsForStatus(statusUuid: string) {
		const statusRow = this.stmts.getStatusRowIdByUuid.get(statusUuid) as { row_id: number } | undefined
		if (!statusRow) return []
		return this.stmts.listSeenReceiptsForStatus.all(statusRow.row_id) as Array<{
			row_id: number
			status_row_id: number
			receipt_user_jid: string
			received_timestamp: number | null
			seen_timestamp: number | null
		}>
	}
}
