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
import type { ChatRowResolver, JidResolver } from './message-store-backend'
import type { SqliteDbLike, SqliteStatementLike } from './types'

export type ReceiptKind = 'delivery' | 'read' | 'played'

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
			getMessageRowId: this.db.prepare('SELECT _id FROM message WHERE chat_row_id = ? AND from_me = ? AND key_id = ?'),
			// A receipt whose id matches a message_add_on (reaction / poll vote)
			// rather than a main message — its device acks live in
			// message_add_on_receipt_device, not receipt_device.
			getAddOnRowId: this.db.prepare(
				'SELECT _id FROM message_add_on WHERE chat_row_id = ? AND from_me = ? AND key_id = ?'
			),
			upsertUserReceiptDelivery: this.db.prepare(
				'INSERT INTO receipt_user (message_row_id, receipt_user_jid_row_id, receipt_timestamp) VALUES (?, ?, ?) ' +
					'ON CONFLICT(message_row_id, receipt_user_jid_row_id) DO UPDATE SET receipt_timestamp = excluded.receipt_timestamp'
			),
			upsertUserReceiptRead: this.db.prepare(
				'INSERT INTO receipt_user (message_row_id, receipt_user_jid_row_id, read_timestamp) VALUES (?, ?, ?) ' +
					'ON CONFLICT(message_row_id, receipt_user_jid_row_id) DO UPDATE SET read_timestamp = excluded.read_timestamp'
			),
			upsertUserReceiptPlayed: this.db.prepare(
				'INSERT INTO receipt_user (message_row_id, receipt_user_jid_row_id, played_timestamp) VALUES (?, ?, ?) ' +
					'ON CONFLICT(message_row_id, receipt_user_jid_row_id) DO UPDATE SET played_timestamp = excluded.played_timestamp'
			),
			upsertDeviceReceipt: this.db.prepare(
				'INSERT INTO receipt_device (message_row_id, receipt_device_jid_row_id, receipt_device_timestamp) VALUES (?, ?, ?) ' +
					'ON CONFLICT(message_row_id, receipt_device_jid_row_id) DO UPDATE SET receipt_device_timestamp = excluded.receipt_device_timestamp'
			),
			upsertAddOnDeviceReceipt: this.db.prepare(
				'INSERT INTO message_add_on_receipt_device (message_add_on_row_id, receipt_device_jid_row_id, receipt_device_timestamp) ' +
					'VALUES (?, ?, ?) ON CONFLICT(message_add_on_row_id, receipt_device_jid_row_id) DO UPDATE SET ' +
					'receipt_device_timestamp = excluded.receipt_device_timestamp'
			),
			insertOrphaned: this.db.prepare(
				'INSERT INTO receipt_orphaned (chat_row_id, from_me, key_id, receipt_device_jid_row_id, status, timestamp) ' +
					'VALUES (?, ?, ?, ?, ?, ?)'
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
					null,
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
					input.timestamp
				)
				return
			}

			this.stmts.upsertDeviceReceipt.run(messageRowId, receiptDeviceRowId, input.timestamp)
		})()
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
