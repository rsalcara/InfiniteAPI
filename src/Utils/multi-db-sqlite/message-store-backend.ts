/**
 * Typed message-store storage backed by `msgstore.db`'s `message`/`chat`
 * tables (plus the `message_details`/`message_secret`/`message_revoked`/
 * `message_send_count` satellites).
 *
 * Real Android capture (Frida, WhatsApp 2.26.22.8, 2026-07-09) confirms the
 * natural key for `message` is `(chat_row_id, from_me, key_id,
 * sender_jid_row_id)` — this backend upserts on that key so a retried
 * decrypt/decode never creates a duplicate row.
 *
 * `chat_row_id` and `sender_jid_row_id` are resolved via `JidMapBackend`
 * (shared with the LID↔PN mapping use case — same `jid` table, same row
 * for the same contact). `chat` rows are created lazily on first message
 * (matches the "lazy creation" pattern already established for
 * `ChatSettingsBackend`'s `settings` table).
 *
 * `message_type` is Android's own numeric content-type enum. The values
 * below are the ones directly observed in the capture; anything not in
 * this list is left `null` rather than guessed:
 *   0 = text, 1 = image, 2 = audio, 3 = video, 4 = vcard/contact,
 *   5 = location, 9 = document, 16 = live location, 15 = revoked
 *   (delete-for-everyone tombstone — confirmed).
 * `13`/`20`/`54`/`66`/`81` also appeared in the capture but couldn't be
 * pinned to a single content type with confidence (some of those senders
 * were sending in quick succession, ambiguous ordering) — left unmapped
 * here rather than asserting an unconfirmed guess.
 *
 * `message_revoked`: real Android DELETEs the original row and re-INSERTs
 * a tombstone at the SAME `_id`. This backend achieves the same
 * observable end state — `message_type=15`, `text_data=null` on the
 * existing row, linked via `message_revoked.revoked_key_id` — without
 * literally replaying the delete-then-reinsert sequence, which is an
 * Android-internal `_id`-reuse detail with no externally observable
 * difference for a gateway that doesn't render a UI.
 */
import type { SqliteDbLike, SqliteStatementLike } from './types'

/** Values directly confirmed against a live capture; anything else, leave `null`. */
export const ANDROID_MESSAGE_TYPE = {
	TEXT: 0,
	IMAGE: 1,
	AUDIO: 2,
	VIDEO: 3,
	CONTACT: 4,
	LOCATION: 5,
	DOCUMENT: 9,
	LIVE_LOCATION: 16,
	REVOKED: 15
} as const

/**
 * Maps Baileys' own content-type key (from `getContentType`) to the
 * confirmed Android `message_type` int. Returns `null` for anything not
 * directly confirmed against the capture (see class doc) rather than
 * guessing.
 */
export const mapContentTypeToMessageType = (contentType: string | undefined): number | null => {
	switch (contentType) {
		case 'conversation':
		case 'extendedTextMessage':
			return ANDROID_MESSAGE_TYPE.TEXT
		case 'imageMessage':
			return ANDROID_MESSAGE_TYPE.IMAGE
		case 'audioMessage':
			return ANDROID_MESSAGE_TYPE.AUDIO
		case 'videoMessage':
			return ANDROID_MESSAGE_TYPE.VIDEO
		case 'contactMessage':
		case 'contactsArrayMessage':
			return ANDROID_MESSAGE_TYPE.CONTACT
		case 'locationMessage':
			return ANDROID_MESSAGE_TYPE.LOCATION
		case 'documentMessage':
			return ANDROID_MESSAGE_TYPE.DOCUMENT
		case 'liveLocationMessage':
			return ANDROID_MESSAGE_TYPE.LIVE_LOCATION
		default:
			return null
	}
}

export type RecordMessageInput = {
	chatJid: string
	fromMe: boolean
	keyId: string
	senderJid?: string | null
	status?: number | null
	timestamp?: number | null
	receivedTimestamp?: number | null
	messageType?: number | null
	textData?: string | null
	authorDeviceJid?: string | null
	messageSecret?: Buffer | null
	/** When true, `chat.unseen_message_count` is incremented (mirrors real
	 * Android's own increment-on-inbound behavior). Callers pass this only
	 * for genuinely new, unread inbound messages — never on upsert-retry
	 * of an already-seen message. */
	incrementUnread?: boolean
}

export type MessageRow = {
	_id: number
	chat_row_id: number
	from_me: number
	key_id: string
	sender_jid_row_id: number | null
	status: number | null
	timestamp: number | null
	received_timestamp: number | null
	message_type: number | null
	text_data: string | null
	sort_id: number
}

export type RecordRevokeInput = {
	chatJid: string
	fromMe: boolean
	revokedKeyId: string
	revokeTimestamp: number
	adminJid?: string | null
}

export interface JidResolver {
	resolveJidRowId(jid: string): number
}

/**
 * Resolves a chat jid to its `chat._id` — NOT the same value as
 * `JidResolver.resolveJidRowId`'s `jid._id` (a separate autoincrement
 * sequence; confirmed real bug in an earlier revision of this file where
 * `ReceiptBackend`/`MessageAddOnBackend` used a bare `jidMap.resolveJidRowId`
 * result as if it were `message.chat_row_id`). Any backend that needs to
 * look up or create rows keyed by `chat_row_id` must go through this, not
 * `JidResolver` directly.
 */
export interface ChatRowResolver {
	resolveChatRowId(jid: string): number
}

/** `jid._id` is a 1-based autoincrement, so 0 is safe as a "no sender known"
 * sentinel — SQLite's UNIQUE index treats NULL as distinct from every other
 * NULL, so a nullable sender column silently defeats `ON CONFLICT` upserts
 * (confirmed real bug: retried decode of a fromMe/no-sender message inserted
 * a duplicate `message`/`message_add_on` row every time instead of
 * upserting). Same sentinel convention as `quarantine-backend.ts`. */
const NO_SENDER_SENTINEL = 0

export class MessageStoreBackend implements ChatRowResolver {
	private readonly stmts: {
		upsertChatStub: SqliteStatementLike
		getChatRowIdByJidRowId: SqliteStatementLike
		updateChatAggregate: SqliteStatementLike
		upsertMessage: SqliteStatementLike
		getMessageByNaturalKey: SqliteStatementLike
		getMessageByKeyId: SqliteStatementLike
		upsertMessageDetails: SqliteStatementLike
		upsertMessageSecret: SqliteStatementLike
		updateMessageForRevoke: SqliteStatementLike
		upsertMessageRevoked: SqliteStatementLike
		getMessageSecret: SqliteStatementLike
		upsertMessageSendCount: SqliteStatementLike
		incrementMessageSendCount: SqliteStatementLike
	}

	private readonly db: SqliteDbLike
	private readonly jidMap: JidResolver

	constructor(db: SqliteDbLike, jidMap: JidResolver) {
		this.db = db
		this.jidMap = jidMap
		this.stmts = {
			// `unseen_message_count` starts NULL (the real Android schema has no
			// DEFAULT on it either — a real chat row only exists there once WA
			// itself writes a full ~48-column row on first contact, something
			// this gateway's lazy stub can't replicate). Seeded to 0 here so
			// updateChatAggregate's `+= ?` below never hits SQL's
			// NULL + number = NULL trap.
			upsertChatStub: this.db.prepare(
				'INSERT INTO chat (jid_row_id, unseen_message_count) VALUES (?, 0) ON CONFLICT(jid_row_id) DO NOTHING'
			),
			getChatRowIdByJidRowId: this.db.prepare('SELECT _id FROM chat WHERE jid_row_id = ?'),
			updateChatAggregate: this.db.prepare(
				'UPDATE chat SET last_message_row_id = ?, sort_timestamp = ?, last_message_sort_id = ?, ' +
					'unseen_message_count = COALESCE(unseen_message_count, 0) + ? WHERE _id = ?'
			),
			upsertMessage: this.db.prepare(
				'INSERT INTO message (chat_row_id, from_me, key_id, sender_jid_row_id, status, timestamp, ' +
					'received_timestamp, message_type, text_data, sort_id) ' +
					'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ' +
					'ON CONFLICT(chat_row_id, from_me, key_id, sender_jid_row_id) DO UPDATE SET ' +
					'status = excluded.status, received_timestamp = excluded.received_timestamp'
			),
			getMessageByNaturalKey: this.db.prepare(
				'SELECT * FROM message WHERE chat_row_id = ? AND from_me = ? AND key_id = ? AND sender_jid_row_id IS ?'
			),
			getMessageByKeyId: this.db.prepare('SELECT * FROM message WHERE chat_row_id = ? AND from_me = ? AND key_id = ?'),
			upsertMessageDetails: this.db.prepare(
				'INSERT INTO message_details (message_row_id, author_device_jid) VALUES (?, ?) ' +
					'ON CONFLICT(message_row_id) DO UPDATE SET author_device_jid = excluded.author_device_jid'
			),
			upsertMessageSecret: this.db.prepare(
				'INSERT INTO message_secret (message_row_id, message_secret) VALUES (?, ?) ' +
					'ON CONFLICT(message_row_id) DO UPDATE SET message_secret = excluded.message_secret'
			),
			updateMessageForRevoke: this.db.prepare('UPDATE message SET message_type = ?, text_data = NULL WHERE _id = ?'),
			upsertMessageRevoked: this.db.prepare(
				'INSERT INTO message_revoked (message_row_id, revoked_key_id, admin_jid_row_id, revoke_timestamp) ' +
					'VALUES (?, ?, ?, ?) ON CONFLICT(message_row_id) DO UPDATE SET ' +
					'revoked_key_id = excluded.revoked_key_id, revoke_timestamp = excluded.revoke_timestamp'
			),
			upsertMessageSendCount: this.db.prepare(
				'INSERT INTO message_send_count (message_row_id, send_count) VALUES (?, 0) ' +
					'ON CONFLICT(message_row_id) DO NOTHING'
			),
			incrementMessageSendCount: this.db.prepare(
				'UPDATE message_send_count SET send_count = send_count + 1 WHERE message_row_id = ?'
			),
			getMessageSecret: this.db.prepare('SELECT message_secret FROM message_secret WHERE message_row_id = ?')
		}
	}

	/**
	 * Returns the `messageSecret` stored for a message row (e.g. a poll
	 * creation message), or `null` if none. Used by the poll-vote mirror to
	 * decrypt votes in-house, without a consumer `getMessage`.
	 */
	getMessageSecret(messageRowId: number): Buffer | null {
		const row = this.stmts.getMessageSecret.get(messageRowId) as { message_secret: Buffer | null } | undefined
		return row?.message_secret ?? null
	}

	/** Resolves (creating if needed) the `chat._id` for a jid. */
	resolveChatRowId(jid: string): number {
		const jidRowId = this.jidMap.resolveJidRowId(jid)
		return this.db.transaction((rowId: number): number => {
			this.stmts.upsertChatStub.run(rowId)
			const row = this.stmts.getChatRowIdByJidRowId.get(rowId) as { _id: number } | undefined
			if (!row) throw new Error(`MessageStoreBackend: failed to materialize chat row for jid_row_id ${rowId}`)
			return row._id
		})(jidRowId)
	}

	/**
	 * Read-only counterpart to `resolveChatRowId` — does NOT create a `chat`
	 * row as a side effect. Used by lookups (`getMessageByKeyId`) that should
	 * behave as pure reads: without this, e.g. `recordRevoke` on an unknown
	 * message materialized a phantom `chat` row for a jid we've never
	 * actually messaged (confirmed real bug).
	 */
	private tryGetChatRowId(jid: string): number | null {
		const jidRowId = this.jidMap.resolveJidRowId(jid)
		const row = this.stmts.getChatRowIdByJidRowId.get(jidRowId) as { _id: number } | undefined
		return row?._id ?? null
	}

	/**
	 * Records one message, upserting its chat's aggregate counters.
	 * Returns the message's `_id` for satellite-table wiring (media, add-ons).
	 */
	recordMessage(input: RecordMessageInput): number {
		return this.db.transaction((): number => {
			const chatRowId = this.resolveChatRowId(input.chatJid)
			// `jid._id` is 1-based, so 0 is a safe "no sender" sentinel — see
			// NO_SENDER_SENTINEL doc. Using `null` here defeated the natural-key
			// ON CONFLICT upsert (confirmed real bug: every retry of a fromMe/
			// no-sender message inserted a fresh duplicate row).
			const senderRowId = input.senderJid ? this.jidMap.resolveJidRowId(input.senderJid) : NO_SENDER_SENTINEL

			// Existence check BEFORE the upsert — `incrementUnread` must only
			// apply the first time this natural key is recorded. Without this,
			// a retried decode of the same message (same key_id) re-ran
			// updateChatAggregate's increment on every call and inflated
			// unseen_message_count on every reprocess (confirmed real bug).
			const existing = this.stmts.getMessageByNaturalKey.get(
				chatRowId,
				input.fromMe ? 1 : 0,
				input.keyId,
				senderRowId
			) as MessageRow | undefined
			const isNewMessage = !existing

			this.stmts.upsertMessage.run(
				chatRowId,
				input.fromMe ? 1 : 0,
				input.keyId,
				senderRowId,
				input.status ?? null,
				input.timestamp ?? null,
				input.receivedTimestamp ?? null,
				input.messageType ?? null,
				input.textData ?? null,
				input.timestamp ?? 0
			)

			const row = this.stmts.getMessageByNaturalKey.get(chatRowId, input.fromMe ? 1 : 0, input.keyId, senderRowId) as
				| MessageRow
				| undefined
			if (!row) throw new Error(`MessageStoreBackend: failed to materialize message row for key_id ${input.keyId}`)

			if (input.authorDeviceJid) {
				const deviceRowId = this.jidMap.resolveJidRowId(input.authorDeviceJid)
				this.stmts.upsertMessageDetails.run(row._id, deviceRowId)
			}

			if (input.messageSecret) {
				this.stmts.upsertMessageSecret.run(row._id, input.messageSecret)
			}

			this.stmts.updateChatAggregate.run(
				row._id,
				input.timestamp ?? 0,
				input.timestamp ?? 0,
				isNewMessage && input.incrementUnread ? 1 : 0,
				chatRowId
			)

			return row._id
		})()
	}

	/** Looks up a message by its natural (chat, direction, key) identity, ignoring sender. Pure read — never creates a `chat` row. */
	getMessageByKeyId(chatJid: string, fromMe: boolean, keyId: string): MessageRow | null {
		const chatRowId = this.tryGetChatRowId(chatJid)
		if (chatRowId === null) return null
		const row = this.stmts.getMessageByKeyId.get(chatRowId, fromMe ? 1 : 0, keyId) as MessageRow | undefined
		return row ?? null
	}

	/**
	 * Mirrors "delete for everyone" onto the existing message row (see class
	 * doc for why this UPDATEs in place instead of replaying Android's own
	 * delete-then-reinsert-at-same-id sequence). No-ops (does not throw) when
	 * the revoked message isn't locally known — matches this file's
	 * best-effort mirroring convention elsewhere.
	 */
	recordRevoke(input: RecordRevokeInput): void {
		const target = this.getMessageByKeyId(input.chatJid, input.fromMe, input.revokedKeyId)
		if (!target) return

		this.db.transaction(() => {
			this.stmts.updateMessageForRevoke.run(ANDROID_MESSAGE_TYPE.REVOKED, target._id)
			const adminRowId = input.adminJid ? this.jidMap.resolveJidRowId(input.adminJid) : null
			this.stmts.upsertMessageRevoked.run(target._id, input.revokedKeyId, adminRowId, input.revokeTimestamp)
		})()
	}

	/** Increments (creating on first call) the outbound retry counter for a message. */
	recordSendAttempt(messageRowId: number): void {
		this.db.transaction(() => {
			this.stmts.upsertMessageSendCount.run(messageRowId)
			this.stmts.incrementMessageSendCount.run(messageRowId)
		})()
	}
}
