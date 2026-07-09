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
 * just routing an existing event). `status_row_id` is looked up by `uuid`
 * and will be `null` when the referenced status isn't one this gateway has
 * recorded locally (e.g. a receipt for the user's OWN posted status, which
 * `recordReceivedStatus` never captures today since that only tracks
 * statuses received FROM others) — the row is still inserted with a null
 * FK rather than dropped, matching this file's "best-effort, never blocks
 * on missing context" convention elsewhere.
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

export class StatusBackend {
	private readonly stmts: {
		upsertStatusInfo: SqliteStatementLike
		getStatusInfoRowId: SqliteStatementLike
		incrementCounts: SqliteStatementLike
		nextSortId: SqliteStatementLike
		insertStatus: SqliteStatementLike
		listStatusesForSender: SqliteStatementLike
		getStatusRowIdByUuid: SqliteStatementLike
		upsertSeenReceipt: SqliteStatementLike
		listSeenReceiptsForStatus: SqliteStatementLike
	}

	private readonly db: SqliteDbLike

	constructor(db: SqliteDbLike) {
		this.db = db
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
			getStatusRowIdByUuid: this.db.prepare('SELECT row_id FROM status WHERE uuid = ?'),
			upsertSeenReceipt: this.db.prepare(
				'INSERT INTO status_seen_receipt (status_row_id, receipt_user_jid, seen_timestamp) VALUES (?, ?, ?) ' +
					'ON CONFLICT(status_row_id, receipt_user_jid) DO UPDATE SET seen_timestamp = excluded.seen_timestamp'
			),
			listSeenReceiptsForStatus: this.db.prepare(
				'SELECT row_id, status_row_id, receipt_user_jid, received_timestamp, seen_timestamp ' +
					'FROM status_seen_receipt WHERE status_row_id = ?'
			)
		}
	}

	/**
	 * Records one received status update, upserting its sender's status_info
	 * aggregate row first. Wrapped in a transaction (audit finding, Phase 9
	 * self-review): this is 4 dependent statements — a crash between
	 * insertStatus and incrementCounts would leave status_info's counters
	 * permanently out of sync with the actual status rows.
	 */
	recordReceivedStatus(input: ReceivedStatusInput): void {
		const run = this.db.transaction(() => {
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
		})
		run()
	}

	listStatusesForSender(senderUserJid: string) {
		return this.stmts.listStatusesForSender.all(senderUserJid) as Array<{
			row_id: number
			sort_id: number
			uuid: string
			sender_user_jid: string
			status_info_row_id: number
			type: number
			timestamp: number
			text_data: string | null
			state: number
		}>
	}

	/**
	 * Records that `receiptUserJid` has seen the status identified by
	 * `statusUuid`. `status_row_id` is resolved by uuid lookup — left `null`
	 * when this gateway has no local `status` row for that uuid (see class
	 * doc). Upsert keyed on (status_row_id, receipt_user_jid) so a repeated
	 * receipt for the same viewer just refreshes `seen_timestamp`.
	 */
	recordSeenReceipt(input: SeenReceiptInput): void {
		const statusRow = this.stmts.getStatusRowIdByUuid.get(input.statusUuid) as { row_id: number } | undefined
		this.stmts.upsertSeenReceipt.run(statusRow?.row_id ?? null, input.receiptUserJid, input.seenTimestamp)
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
