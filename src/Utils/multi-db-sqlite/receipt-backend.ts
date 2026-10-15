/**
 * Typed receipt storage backed by `msgstore.db`'s `receipt_user` /
 * `receipt_device` / `receipt_orphaned` tables.
 *
 * Real Android capture (Frida, WhatsApp 2.26.22.8, 2026-07-09) confirms:
 *   - `receipt_user` tracks delivery/read/played per RECIPIENT (jid, no
 *     device suffix) — one row per (message, user), upserted as the
 *     receipt progresses (delivered → read → played for voice notes).
 *   - `receipt_device` tracks the same progression per DEVICE (device-
 *     suffixed jid) — a multi-device recipient has one `receipt_user` row
 *     but N `receipt_device` rows, one per linked device.
 *   - `receipt_orphaned` holds a receipt that arrived before its target
 *     `message` row existed locally (same holding-pen pattern as
 *     `message_orphaned_edit`/`status_orphan`) — this backend records into
 *     it whenever `getMessageRowId` can't resolve the target, matching
 *     that observed behavior. Its `status` column carries the app's own
 *     Android status integer (R6).
 *
 * Group message status follows MessageStatusStore.A02's multi-participant
 * path (X/C17C.java, 2.26.38.10): per-user max state in `receipt_user`,
 * aggregate against `message.recipient_count`, applied even on downgrade.
 *
 * `message_row_id` is resolved by `(chat_row_id, from_me, key_id)` — NOT
 * the full `message` natural key (which also includes `sender_jid_row_id`)
 * because a receipt targets a message by its (chat, direction, id) alone;
 * cross-referencing sender isn't needed and isn't always known at receipt
 * time.
 */
import { isJidGroup, isJidStatusBroadcast } from '../../WABinary'
import {
	ANDROID_MESSAGE_STATUS,
	type ChatRowResolver,
	type JidResolver,
	shouldAdvanceAndroidMessageStatus
} from './message-store-backend'
import type { SqliteDbLike, SqliteStatementLike } from './types'

export type ReceiptKind = 'delivery' | 'read' | 'played'

/**
 * `receipt_orphaned.status` stores the app's own Android status integer for
 * the receipt, exactly as MessageStatusUpdateHelper writes the row
 * (`put("status", Integer.valueOf(i4))`, X/C28106CSb.java — 2.26.38.10):
 * delivery 5, read 13, played 8, inactive 15, read-self 17, played-self 18.
 * A user-level orphan carries the recipient row; a device-level ack carries
 * a NULL recipient with status 5 — the same distinction as the app's
 * `C27813CEd(deviceJid, userJid|null, status, timestamp)`. Codes 0-3 were an
 * earlier engine invention removed by R6 (msgstore.db migration v10 rewrites
 * any rows still carrying them).
 */
const ORPHAN_KIND_STATUS: Record<ReceiptKind, number> = {
	delivery: ANDROID_MESSAGE_STATUS.DELIVERY_ACK,
	read: ANDROID_MESSAGE_STATUS.READ,
	played: ANDROID_MESSAGE_STATUS.PLAYED
}
export const RECEIPT_ORPHAN_REPLAY_LIMIT = 300
export const RECEIPT_ORPHAN_TTL_SECONDS = 60 * 24 * 60 * 60
export const RECEIPT_ORPHAN_PRUNE_INTERVAL_SECONDS = 60 * 60

/**
 * Receipt states the app keeps only as the message status, with no
 * receipt_user progression: read-self 17, played-self 18, inactive 15
 * (ReceiptStanzaHelper.A00, X/CSY.java:338-376 in 2.26.38.10). An orphan of
 * one of them stores that Android status itself.
 */
const STATUS_ONLY_ORPHAN_STATUSES = new Set<number>([
	ANDROID_MESSAGE_STATUS.INACTIVE,
	ANDROID_MESSAGE_STATUS.READ_SELF,
	ANDROID_MESSAGE_STATUS.PLAYED_SELF
])

export type RecordStatusOrphanInput = {
	chatJid: string
	fromMe: boolean
	keyId: string
	receiptDeviceJid: string
	androidStatus: number
	timestamp: number
}

export type RecordUserReceiptInput = {
	chatJid: string
	fromMe: boolean
	keyId: string
	receiptUserJid: string
	kind: ReceiptKind
	timestamp: number
}

export type RecordDeviceReceiptInput = {
	chatJid: string
	fromMe: boolean
	keyId: string
	receiptDeviceJid: string
	timestamp: number
}

export class ReceiptBackend {
	private readonly stmts: {
		getMessageRowId: SqliteStatementLike
		getAddOnRowId: SqliteStatementLike
		upsertUserReceiptDelivery: SqliteStatementLike
		upsertUserReceiptRead: SqliteStatementLike
		upsertUserReceiptPlayed: SqliteStatementLike
		upsertDeviceReceipt: SqliteStatementLike
		upsertAddOnDeviceReceipt: SqliteStatementLike
		insertOrphaned: SqliteStatementLike
		listOrphaned: SqliteStatementLike
		deleteOrphaned: SqliteStatementLike
		deleteExpiredOrphaned: SqliteStatementLike
		getMessageStatus: SqliteStatementLike
		updateMessageStatus: SqliteStatementLike
		getMessageAggregate: SqliteStatementLike
		listUserReceipts: SqliteStatementLike
		listDeviceReceipts: SqliteStatementLike
	}

	private readonly db: SqliteDbLike
	private readonly jidMap: JidResolver
	private readonly chatResolver: ChatRowResolver
	private lastOrphanPruneAtSeconds = 0

	constructor(db: SqliteDbLike, jidMap: JidResolver, chatResolver: ChatRowResolver) {
		this.db = db
		this.jidMap = jidMap
		this.chatResolver = chatResolver
		this.stmts = {
			getMessageRowId: this.db.prepare(
				'SELECT _id FROM message WHERE chat_row_id = ? AND from_me = ? AND key_id = ? ORDER BY _id DESC LIMIT 1'
			),
			// A receipt whose id matches a message_add_on (reaction / poll vote)
			// rather than a main message — its device acks live in
			// message_add_on_receipt_device, not receipt_device. Matched by
			// (chat, from_me, key_id) without sender: a receipt carries only the
			// target key_id, which is a globally-unique message id, so it already
			// identifies a single add-on. `ORDER BY _id DESC LIMIT 1` makes the
			// pick deterministic even in the degenerate case of a reused key_id.
			getAddOnRowId: this.db.prepare(
				'SELECT _id FROM message_add_on WHERE chat_row_id = ? AND from_me = ? AND key_id = ? ORDER BY _id DESC LIMIT 1'
			),
			upsertUserReceiptDelivery: this.db.prepare(
				'INSERT INTO receipt_user (message_row_id, receipt_user_jid_row_id, receipt_timestamp) VALUES (?, ?, ?) ' +
					'ON CONFLICT(message_row_id, receipt_user_jid_row_id) DO UPDATE SET receipt_timestamp = ' +
					'CASE WHEN receipt_user.receipt_timestamp IS NULL OR excluded.receipt_timestamp > receipt_user.receipt_timestamp ' +
					'THEN excluded.receipt_timestamp ELSE receipt_user.receipt_timestamp END'
			),
			upsertUserReceiptRead: this.db.prepare(
				'INSERT INTO receipt_user (message_row_id, receipt_user_jid_row_id, read_timestamp) VALUES (?, ?, ?) ' +
					'ON CONFLICT(message_row_id, receipt_user_jid_row_id) DO UPDATE SET read_timestamp = ' +
					'CASE WHEN receipt_user.read_timestamp IS NULL OR excluded.read_timestamp > receipt_user.read_timestamp ' +
					'THEN excluded.read_timestamp ELSE receipt_user.read_timestamp END'
			),
			upsertUserReceiptPlayed: this.db.prepare(
				'INSERT INTO receipt_user (message_row_id, receipt_user_jid_row_id, played_timestamp) VALUES (?, ?, ?) ' +
					'ON CONFLICT(message_row_id, receipt_user_jid_row_id) DO UPDATE SET played_timestamp = ' +
					'CASE WHEN receipt_user.played_timestamp IS NULL OR excluded.played_timestamp > receipt_user.played_timestamp ' +
					'THEN excluded.played_timestamp ELSE receipt_user.played_timestamp END'
			),
			upsertDeviceReceipt: this.db.prepare(
				'INSERT INTO receipt_device (message_row_id, receipt_device_jid_row_id, receipt_device_timestamp) VALUES (?, ?, ?) ' +
					'ON CONFLICT(message_row_id, receipt_device_jid_row_id) DO UPDATE SET receipt_device_timestamp = ' +
					'CASE WHEN receipt_device.receipt_device_timestamp IS NULL OR ' +
					'excluded.receipt_device_timestamp > receipt_device.receipt_device_timestamp ' +
					'THEN excluded.receipt_device_timestamp ELSE receipt_device.receipt_device_timestamp END'
			),
			upsertAddOnDeviceReceipt: this.db.prepare(
				'INSERT INTO message_add_on_receipt_device (message_add_on_row_id, receipt_device_jid_row_id, receipt_device_timestamp) ' +
					'VALUES (?, ?, ?) ON CONFLICT(message_add_on_row_id, receipt_device_jid_row_id) DO UPDATE SET ' +
					'receipt_device_timestamp = CASE WHEN message_add_on_receipt_device.receipt_device_timestamp IS NULL OR ' +
					'excluded.receipt_device_timestamp > message_add_on_receipt_device.receipt_device_timestamp ' +
					'THEN excluded.receipt_device_timestamp ELSE message_add_on_receipt_device.receipt_device_timestamp END'
			),
			insertOrphaned: this.db.prepare(
				'INSERT INTO receipt_orphaned (chat_row_id, from_me, key_id, receipt_device_jid_row_id, receipt_recipient_jid_row_id, status, timestamp) ' +
					'VALUES (?, ?, ?, ?, ?, ?, ?)'
			),
			listOrphaned: this.db.prepare(
				'SELECT _id, receipt_device_jid_row_id, receipt_recipient_jid_row_id, status, timestamp ' +
					'FROM receipt_orphaned WHERE chat_row_id = ? AND from_me = ? AND key_id = ? ' +
					'AND (status IS NULL OR status IN (5, 8, 13, 15, 17, 18)) ' +
					`ORDER BY _id ASC LIMIT ${RECEIPT_ORPHAN_REPLAY_LIMIT}`
			),
			deleteOrphaned: this.db.prepare('DELETE FROM receipt_orphaned WHERE _id = ?'),
			deleteExpiredOrphaned: this.db.prepare('DELETE FROM receipt_orphaned WHERE timestamp IS NULL OR timestamp < ?'),
			getMessageStatus: this.db.prepare('SELECT status FROM message WHERE _id = ?'),
			updateMessageStatus: this.db.prepare('UPDATE message SET status = ? WHERE _id = ?'),
			// Group aggregate inputs, exactly the counters MessageStatusStore.A02
			// derives from the per-user receipt map: a user's max status is
			// played(8) when played_timestamp is set, read(13) when read_timestamp
			// is set, delivered(5) when only receipt_timestamp is (X/C17C.java:823).
			getMessageAggregate: this.db.prepare(
				'SELECT status, recipient_count, ' +
					'(SELECT COUNT(*) FROM receipt_user ru WHERE ru.message_row_id = message._id AND ru.played_timestamp IS NOT NULL) AS played_count, ' +
					'(SELECT COUNT(*) FROM receipt_user ru WHERE ru.message_row_id = message._id ' +
					'AND (ru.played_timestamp IS NOT NULL OR ru.read_timestamp IS NOT NULL)) AS read_count, ' +
					'(SELECT COUNT(*) FROM receipt_user ru WHERE ru.message_row_id = message._id ' +
					'AND (ru.played_timestamp IS NOT NULL OR ru.read_timestamp IS NOT NULL OR ru.receipt_timestamp IS NOT NULL)) AS delivered_count ' +
					'FROM message WHERE _id = ?'
			),
			listUserReceipts: this.db.prepare(
				'SELECT _id, message_row_id, receipt_user_jid_row_id, receipt_timestamp, read_timestamp, played_timestamp ' +
					'FROM receipt_user WHERE message_row_id = ?'
			),
			listDeviceReceipts: this.db.prepare(
				'SELECT _id, message_row_id, receipt_device_jid_row_id, receipt_device_timestamp ' +
					'FROM receipt_device WHERE message_row_id = ?'
			)
		}
	}

	/**
	 * `chatResolver.resolveChatRowId`, NOT a bare `jidMap.resolveJidRowId` —
	 * `message.chat_row_id` is `chat._id`, a different autoincrement
	 * sequence than `jid._id`. Confirmed real bug in an earlier revision:
	 * every receipt resolved to the wrong (coincidentally matching only in
	 * single-row test scenarios) row and fell through to receipt_orphaned
	 * even when the target message existed. See ChatRowResolver's doc in
	 * message-store-backend.ts.
	 */
	private resolveMessageRowId(chatJid: string, fromMe: boolean, keyId: string): number | null {
		const chatRowId = this.chatResolver.resolveChatRowId(chatJid)
		const row = this.stmts.getMessageRowId.get(chatRowId, fromMe ? 1 : 0, keyId) as { _id: number } | undefined
		return row?._id ?? null
	}

	/** Resolves a receipt target to a `message_add_on` row (reaction/vote), or null. */
	private resolveAddOnRowId(chatJid: string, fromMe: boolean, keyId: string): number | null {
		const chatRowId = this.chatResolver.resolveChatRowId(chatJid)
		const row = this.stmts.getAddOnRowId.get(chatRowId, fromMe ? 1 : 0, keyId) as { _id: number } | undefined
		return row?._id ?? null
	}

	/**
	 * The protocol may omit the receipt timestamp. Orphans still need an
	 * arrival time so retention can eventually remove an unreplayable row;
	 * using the local receive time is conservative and never makes it expire
	 * earlier than a real server timestamp would have.
	 */
	private orphanTimestamp(timestamp: number): number {
		return Number.isFinite(timestamp) && timestamp > 0 ? timestamp : Math.floor(Date.now() / 1000)
	}

	/** Records a delivery/read/played receipt for a recipient (user-level, no device suffix). */
	recordUserReceipt(input: RecordUserReceiptInput): void {
		this.db.transaction(() => {
			const messageRowId = this.resolveMessageRowId(input.chatJid, input.fromMe, input.keyId)
			const receiptUserRowId = this.jidMap.resolveJidRowId(input.receiptUserJid)

			if (messageRowId === null) {
				// A receipt targeting a known add-on (reaction/vote) isn't orphaned:
				// there's no user-level add-on receipt table (only the per-device
				// one), so it's simply not stored here — matching the mobile schema.
				if (this.resolveAddOnRowId(input.chatJid, input.fromMe, input.keyId) !== null) return
				const chatRowId = this.chatResolver.resolveChatRowId(input.chatJid)
				this.stmts.insertOrphaned.run(
					chatRowId,
					input.fromMe ? 1 : 0,
					input.keyId,
					receiptUserRowId,
					receiptUserRowId,
					ORPHAN_KIND_STATUS[input.kind],
					this.orphanTimestamp(input.timestamp)
				)
				return
			}

			const stmt =
				input.kind === 'delivery'
					? this.stmts.upsertUserReceiptDelivery
					: input.kind === 'read'
						? this.stmts.upsertUserReceiptRead
						: this.stmts.upsertUserReceiptPlayed
			stmt.run(messageRowId, receiptUserRowId, input.timestamp)

			// Group receipts promote the message status through the recipient
			// aggregate (R6); 1:1 keeps the live handler's single-path advance.
			if (isJidGroup(input.chatJid)) {
				this.promoteGroupMessageStatus(messageRowId)
			}
		})()
	}

	/** Records a per-device delivery/read ack (multi-device fan-out of a single receipt). */
	recordDeviceReceipt(input: RecordDeviceReceiptInput): void {
		this.db.transaction(() => {
			const messageRowId = this.resolveMessageRowId(input.chatJid, input.fromMe, input.keyId)
			const receiptDeviceRowId = this.jidMap.resolveJidRowId(input.receiptDeviceJid)

			if (messageRowId === null) {
				// Target is an add-on (reaction/vote), not a main message → its
				// per-device ack belongs in message_add_on_receipt_device.
				const addOnRowId = this.resolveAddOnRowId(input.chatJid, input.fromMe, input.keyId)
				if (addOnRowId !== null) {
					this.stmts.upsertAddOnDeviceReceipt.run(addOnRowId, receiptDeviceRowId, input.timestamp)
					return
				}

				const chatRowId = this.chatResolver.resolveChatRowId(input.chatJid)
				this.stmts.insertOrphaned.run(
					chatRowId,
					input.fromMe ? 1 : 0,
					input.keyId,
					receiptDeviceRowId,
					null,
					ANDROID_MESSAGE_STATUS.DELIVERY_ACK,
					this.orphanTimestamp(input.timestamp)
				)
				return
			}

			this.stmts.upsertDeviceReceipt.run(messageRowId, receiptDeviceRowId, input.timestamp)
		})()
	}

	/**
	 * Holds a status-only receipt (read-self, played-self, inactive) whose
	 * target message row does not exist yet, so the exact Android status is
	 * applied when the message is mirrored (audit R-09).
	 */
	recordStatusOrphan(input: RecordStatusOrphanInput): void {
		if (!STATUS_ONLY_ORPHAN_STATUSES.has(input.androidStatus)) {
			throw new TypeError(`ReceiptBackend: ${input.androidStatus} is not a status-only receipt state`)
		}

		this.db.transaction(() => {
			if (this.resolveMessageRowId(input.chatJid, input.fromMe, input.keyId) !== null) return
			const chatRowId = this.chatResolver.resolveChatRowId(input.chatJid)
			this.stmts.insertOrphaned.run(
				chatRowId,
				input.fromMe ? 1 : 0,
				input.keyId,
				this.jidMap.resolveJidRowId(input.receiptDeviceJid),
				null,
				input.androidStatus,
				this.orphanTimestamp(input.timestamp)
			)
		})()
	}

	/**
	 * Group aggregate promotion — the multi-participant path of
	 * MessageStatusStore.A02 (X/C17C.java:823-891, WhatsApp 2.26.38.10):
	 *
	 *   played >= recipientCount → PLAYED 8
	 *   read    >= recipientCount → READ 13
	 *   delivered >= recipientCount → DELIVERY_ACK 5
	 *   otherwise → SERVER_ACK 4
	 *
	 * and, unlike the 1:1 single path, the aggregate is applied whenever it
	 * differs from the current status — DOWNGRADES INCLUDED. The app only
	 * emits "MessageStatusStore/statusDowngrade" telemetry on the way; the
	 * write still happens (which is why a group's ticks can only regress when
	 * the aggregate itself regresses, never from one member's stale receipt —
	 * the per-user map keeps each member's max state, mirroring our monotonic
	 * max-timestamp upserts).
	 *
	 * Deliberate deviation: a NULL or non-positive `recipient_count` (a send
	 * whose fan-out list this engine never saw, e.g. history-synced) skips
	 * promotion entirely. The app's add-msg preprocessor always sets the
	 * count, so its degenerate recipientCount=0 branch (0 counters >= 0 → 8)
	 * is unreachable on a real device; fabricating it here would invent a
	 * played state from nothing.
	 */
	private promoteGroupMessageStatus(messageRowId: number): number | null {
		const row = this.stmts.getMessageAggregate.get(messageRowId) as
			| {
					status: number | null
					recipient_count: number | null
					played_count: number
					read_count: number
					delivered_count: number
			  }
			| undefined
		if (!row || row.recipient_count === null || row.recipient_count <= 0) return null

		const aggregate =
			row.played_count >= row.recipient_count
				? ANDROID_MESSAGE_STATUS.PLAYED
				: row.read_count >= row.recipient_count
					? ANDROID_MESSAGE_STATUS.READ
					: row.delivered_count >= row.recipient_count
						? ANDROID_MESSAGE_STATUS.DELIVERY_ACK
						: ANDROID_MESSAGE_STATUS.SERVER_ACK

		if (aggregate === row.status) return null
		this.stmts.updateMessageStatus.run(aggregate, messageRowId)
		return aggregate
	}

	/** Replays receipts that arrived before their message row, then removes only rows successfully materialized. */
	replayOrphaned(chatJid: string, fromMe: boolean, keyId: string): number {
		return this.db.transaction(() => {
			this.maybePruneExpiredOrphaned(Math.floor(Date.now() / 1000))
			const chatRowId = this.chatResolver.resolveChatRowId(chatJid)
			const messageRowId = this.resolveMessageRowId(chatJid, fromMe, keyId)
			if (messageRowId === null) return 0
			let replayed = 0
			// Same three-way split as MessageStatusStore.A02: status broadcasts
			// never touch message status (status.db owns those receipts); 1:1
			// keeps the single path's advance-only promotion; groups promote
			// through the recipient aggregate once every row is materialized.
			const isGroup = isJidGroup(chatJid)
			const canPromoteMessageStatus = !isJidStatusBroadcast(chatJid)
			const messageStatusRow = canPromoteMessageStatus
				? (this.stmts.getMessageStatus.get(messageRowId) as { status: number | null } | undefined)
				: undefined
			let promotedStatus = messageStatusRow?.status ?? null
			let materializedUserReceipt = false

			for (;;) {
				const rows = this.stmts.listOrphaned.all(chatRowId, fromMe ? 1 : 0, keyId) as Array<{
					_id: number
					receipt_device_jid_row_id: number
					receipt_recipient_jid_row_id: number | null
					status: number | null
					timestamp: number | null
				}>
				if (rows.length === 0) break

				let replayedInBatch = 0
				for (const row of rows) {
					// Pre-hardening rows stored NULL for both receipt forms. They cannot
					// recover the user-level progression kind, but they did preserve the
					// target jid and timestamp; materialize that legacy shape as the
					// schema's generic per-device acknowledgement instead of leaking an
					// unreplayable orphan forever.
					if (row.status === null) {
						this.stmts.upsertDeviceReceipt.run(messageRowId, row.receipt_device_jid_row_id, row.timestamp)
					} else if (row.status === ANDROID_MESSAGE_STATUS.INACTIVE) {
						// inactive(15) never reaches message.status: the app drops it
						// as "statusunchanged" (X/C17C.java:400). The orphan row is
						// consumed so retention doesn't leak it — same end state.
					} else if (row.status === ANDROID_MESSAGE_STATUS.READ_SELF) {
						// read-self(17) replays verbatim (C17C.A03 keeps i3 = 17) and
						// only the non-group single path can apply it — the app's
						// receipt_user store rejects 17 outright (C9A.A01).
						if (!isGroup && shouldAdvanceAndroidMessageStatus(promotedStatus, row.status)) {
							promotedStatus = row.status
						}
					} else if (row.status === ANDROID_MESSAGE_STATUS.PLAYED_SELF) {
						// played-self(18) is normalized to PLAYED 8 at replay
						// ("applyingorphanedreceipt", X/C17C.java:124-129: i3 = 8).
						// In a group the app would also materialize a played
						// receipt_user row for the sending device's user; this
						// engine's orphan row keeps only the device jid row id, so
						// that corner degrades to consuming the row (documented R6
						// deviation — status-only orphans in groups are rare).
						if (!isGroup && shouldAdvanceAndroidMessageStatus(promotedStatus, ANDROID_MESSAGE_STATUS.PLAYED)) {
							promotedStatus = ANDROID_MESSAGE_STATUS.PLAYED
						}
					} else if (row.receipt_recipient_jid_row_id !== null) {
						const stmt =
							row.status === ANDROID_MESSAGE_STATUS.DELIVERY_ACK
								? this.stmts.upsertUserReceiptDelivery
								: row.status === ANDROID_MESSAGE_STATUS.READ
									? this.stmts.upsertUserReceiptRead
									: row.status === ANDROID_MESSAGE_STATUS.PLAYED
										? this.stmts.upsertUserReceiptPlayed
										: null
						if (!stmt) continue
						stmt.run(messageRowId, row.receipt_recipient_jid_row_id, row.timestamp)
						materializedUserReceipt = true
						if (!isGroup && shouldAdvanceAndroidMessageStatus(promotedStatus, row.status)) {
							promotedStatus = row.status
						}
					} else {
						// Device-level delivery ack (status 5, no recipient). The
						// app's replay feeds device acks back through A02, which keys
						// receipt_user by the DEVICE'S USER; group device orphans here
						// were written under the participant's bare jid, so the stored
						// row id already is the user's. Non-group device acks keep the
						// per-device row only (a 1:1 sender's jid may carry a device
						// suffix this schema can't reverse-map to its user).
						this.stmts.upsertDeviceReceipt.run(messageRowId, row.receipt_device_jid_row_id, row.timestamp)
						if (isGroup) {
							this.stmts.upsertUserReceiptDelivery.run(
								messageRowId,
								row.receipt_device_jid_row_id,
								row.timestamp
							)
							materializedUserReceipt = true
						}
					}

					this.stmts.deleteOrphaned.run(row._id)
					replayed += 1
					replayedInBatch += 1
				}

				// Unsupported future status values are excluded by the query and
				// remain available for diagnosis without blocking valid receipts.
				if (rows.length < RECEIPT_ORPHAN_REPLAY_LIMIT || replayedInBatch === 0) break
			}

			if (isGroup) {
				if (materializedUserReceipt) this.promoteGroupMessageStatus(messageRowId)
			} else if (messageStatusRow && promotedStatus !== messageStatusRow.status) {
				this.stmts.updateMessageStatus.run(promotedStatus, messageRowId)
			}

			return replayed
		})()
	}

	/** Avoid a table-wide retention DELETE on every persisted message. */
	private maybePruneExpiredOrphaned(nowSeconds: number): void {
		if (nowSeconds - this.lastOrphanPruneAtSeconds < RECEIPT_ORPHAN_PRUNE_INTERVAL_SECONDS) return
		this.pruneExpiredOrphaned(nowSeconds)
		this.lastOrphanPruneAtSeconds = nowSeconds
	}

	/** Deletes orphan receipts older than Android's 60-day retention window. */
	pruneExpiredOrphaned(nowSeconds: number = Math.floor(Date.now() / 1000)): number {
		const cutoff = nowSeconds - RECEIPT_ORPHAN_TTL_SECONDS
		return this.stmts.deleteExpiredOrphaned.run(cutoff).changes
	}

	listUserReceipts(messageRowId: number) {
		return this.stmts.listUserReceipts.all(messageRowId) as Array<{
			_id: number
			message_row_id: number
			receipt_user_jid_row_id: number
			receipt_timestamp: number | null
			read_timestamp: number | null
			played_timestamp: number | null
		}>
	}

	listDeviceReceipts(messageRowId: number) {
		return this.stmts.listDeviceReceipts.all(messageRowId) as Array<{
			_id: number
			message_row_id: number
			receipt_device_jid_row_id: number
			receipt_device_timestamp: number | null
		}>
	}
}
