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
 *     that observed behavior.
 *
 * `message_row_id` is resolved by `(chat_row_id, from_me, key_id)` — NOT
 * the full `message` natural key (which also includes `sender_jid_row_id`)
 * because a receipt targets a message by its (chat, direction, id) alone;
 * cross-referencing sender isn't needed and isn't always known at receipt
 * time.
 */
import {
	ANDROID_MESSAGE_STATUS,
	type ChatRowResolver,
	type JidResolver,
	shouldAdvanceAndroidMessageStatus
} from './message-store-backend'
import type { SqliteDbLike, SqliteStatementLike } from './types'

export type ReceiptKind = 'delivery' | 'read' | 'played'

const ORPHAN_DEVICE_STATUS = 0
const ORPHAN_USER_STATUS: Record<ReceiptKind, number> = { delivery: 1, read: 2, played: 3 }
export const RECEIPT_ORPHAN_REPLAY_LIMIT = 300
export const RECEIPT_ORPHAN_TTL_SECONDS = 60 * 24 * 60 * 60

const ANDROID_STATUS_BY_ORPHAN_STATUS: Partial<Record<number, number>> = {
	[ORPHAN_USER_STATUS.delivery]: ANDROID_MESSAGE_STATUS.DELIVERY_ACK,
	[ORPHAN_USER_STATUS.read]: ANDROID_MESSAGE_STATUS.READ,
	[ORPHAN_USER_STATUS.played]: ANDROID_MESSAGE_STATUS.PLAYED
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
		listUserReceipts: SqliteStatementLike
		listDeviceReceipts: SqliteStatementLike
	}

	private readonly db: SqliteDbLike
	private readonly jidMap: JidResolver
	private readonly chatResolver: ChatRowResolver

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
					'AND (status IS NULL OR status IN (0, 1, 2, 3)) ' +
					`ORDER BY _id ASC LIMIT ${RECEIPT_ORPHAN_REPLAY_LIMIT}`
			),
			deleteOrphaned: this.db.prepare('DELETE FROM receipt_orphaned WHERE _id = ?'),
			deleteExpiredOrphaned: this.db.prepare(
				'DELETE FROM receipt_orphaned WHERE timestamp IS NOT NULL AND timestamp > 0 AND timestamp < ?'
			),
			getMessageStatus: this.db.prepare('SELECT status FROM message WHERE _id = ?'),
			updateMessageStatus: this.db.prepare('UPDATE message SET status = ? WHERE _id = ?'),
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
					ORPHAN_USER_STATUS[input.kind],
					input.timestamp
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
					ORPHAN_DEVICE_STATUS,
					input.timestamp
				)
				return
			}

			this.stmts.upsertDeviceReceipt.run(messageRowId, receiptDeviceRowId, input.timestamp)
		})()
	}

	/** Replays receipts that arrived before their message row, then removes only rows successfully materialized. */
	replayOrphaned(chatJid: string, fromMe: boolean, keyId: string): number {
		return this.db.transaction(() => {
			this.pruneExpiredOrphaned(Math.floor(Date.now() / 1000))
			const chatRowId = this.chatResolver.resolveChatRowId(chatJid)
			const messageRowId = this.resolveMessageRowId(chatJid, fromMe, keyId)
			if (messageRowId === null) return 0
			let replayed = 0
			const messageStatusRow = this.stmts.getMessageStatus.get(messageRowId) as { status: number | null } | undefined
			let promotedStatus = messageStatusRow?.status ?? null

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
					if (row.status === null || row.status === ORPHAN_DEVICE_STATUS) {
						this.stmts.upsertDeviceReceipt.run(messageRowId, row.receipt_device_jid_row_id, row.timestamp)
					} else {
						const recipientRowId = row.receipt_recipient_jid_row_id ?? row.receipt_device_jid_row_id
						const stmt =
							row.status === ORPHAN_USER_STATUS.delivery
								? this.stmts.upsertUserReceiptDelivery
								: row.status === ORPHAN_USER_STATUS.read
									? this.stmts.upsertUserReceiptRead
									: row.status === ORPHAN_USER_STATUS.played
										? this.stmts.upsertUserReceiptPlayed
										: null
						if (!stmt) continue
						stmt.run(messageRowId, recipientRowId, row.timestamp)
						const receiptStatus = ANDROID_STATUS_BY_ORPHAN_STATUS[row.status]
						if (receiptStatus !== undefined && shouldAdvanceAndroidMessageStatus(promotedStatus, receiptStatus)) {
							promotedStatus = receiptStatus
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

			if (messageStatusRow && promotedStatus !== messageStatusRow.status) {
				this.stmts.updateMessageStatus.run(promotedStatus, messageRowId)
			}

			return replayed
		})()
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
