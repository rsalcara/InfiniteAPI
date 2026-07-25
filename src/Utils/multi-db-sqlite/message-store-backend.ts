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
 *   5 = location, 9 = document, 15 = revoked, 16 = live location,
 *   20 = sticker, 66 = poll, 81 = PTV and 99 = album root.
 * Values are added only after the protobuf shape has been correlated with
 * the official Android row or a type-specific satellite table.
 *
 * `message_revoked`: real Android DELETEs the original row and re-INSERTs
 * a tombstone at the SAME `_id`. This backend achieves the same
 * observable end state — `message_type=15`, `text_data=null` on the
 * existing row, linked via `message_revoked.revoked_key_id` — without
 * literally replaying the delete-then-reinsert sequence, which is an
 * Android-internal `_id`-reuse detail with no externally observable
 * difference for a gateway that doesn't render a UI.
 */
import type { proto } from '../../../WAProto/index.js'
import type { SqliteDbLike, SqliteStatementLike } from './types'

/**
 * Android msgstore `message.message_type` values confirmed by joining real
 * WhatsApp Business rows to their typed satellite tables, or by correlating
 * the exact captured protobuf shape with the resulting row. Add-on payloads
 * (reactions, poll votes and keep-in-chat) deliberately are not listed here:
 * Android persists them in `message_add_on*`, not as a new base-message type.
 */
export const ANDROID_MESSAGE_TYPE = {
	TEXT: 0,
	IMAGE: 1,
	AUDIO: 2,
	VIDEO: 3,
	CONTACT: 4,
	LOCATION: 5,
	DOCUMENT: 9,
	GIF: 13,
	LIVE_LOCATION: 16,
	REVOKED: 15,
	STICKER: 20,
	PRODUCT: 23,
	TEMPLATE_IMAGE: 25,
	TEMPLATE_DOCUMENT: 26,
	TEMPLATE_TEXT: 27,
	BUTTON_REPLY: 32,
	VIEW_ONCE_IMAGE: 42,
	VIEW_ONCE_VIDEO: 43,
	BUTTONS: 45,
	LIST: 46,
	INTERACTIVE_RESPONSE: 49,
	INTERACTIVE: 55,
	INTERACTIVE_IMAGE: 57,
	INTERACTIVE_DOCUMENT: 63,
	POLL: 66,
	PTV: 81,
	VIEW_ONCE_AUDIO: 82,
	EVENT: 92,
	NEWSLETTER_ADMIN_INVITE: 94,
	ALBUM: 99,
	STICKER_PACK: 105,
	NEWSLETTER_FOLLOWER_INVITE: 124
} as const

/**
 * Android msgstore status values confirmed against the official app:
 *   0 pending/new, 4 server ack, 5 delivered, 13 read, 8 played.
 *
 * These are not numerically identical to WebMessageInfo.Status after PENDING,
 * so storing the protobuf enum directly would corrupt msgstore semantics.
 */
export const ANDROID_MESSAGE_STATUS = {
	PENDING: 0,
	SERVER_ACK: 4,
	DELIVERY_ACK: 5,
	READ: 13,
	PLAYED: 8
} as const

export const mapWebMessageStatusToAndroid = (status: number | null | undefined): number | null => {
	switch (status) {
		case 1:
			return ANDROID_MESSAGE_STATUS.PENDING
		case 2:
			return ANDROID_MESSAGE_STATUS.SERVER_ACK
		case 3:
			return ANDROID_MESSAGE_STATUS.DELIVERY_ACK
		case 4:
			return ANDROID_MESSAGE_STATUS.READ
		case 5:
			return ANDROID_MESSAGE_STATUS.PLAYED
		default:
			// Web ERROR=0 does not identify which Android terminal failure
			// state applies, so do not fabricate one.
			return null
	}
}

const ANDROID_MESSAGE_STATUS_ORDER = [
	ANDROID_MESSAGE_STATUS.PENDING,
	ANDROID_MESSAGE_STATUS.SERVER_ACK,
	ANDROID_MESSAGE_STATUS.DELIVERY_ACK,
	ANDROID_MESSAGE_STATUS.READ,
	ANDROID_MESSAGE_STATUS.PLAYED
] as const

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
		case 'stickerMessage':
			return ANDROID_MESSAGE_TYPE.STICKER
		case 'productMessage':
			return ANDROID_MESSAGE_TYPE.PRODUCT
		case 'buttonsMessage':
			return ANDROID_MESSAGE_TYPE.BUTTONS
		case 'listMessage':
			return ANDROID_MESSAGE_TYPE.LIST
		case 'interactiveMessage':
			return ANDROID_MESSAGE_TYPE.INTERACTIVE
		case 'templateButtonReplyMessage':
		case 'buttonsResponseMessage':
			return ANDROID_MESSAGE_TYPE.BUTTON_REPLY
		case 'interactiveResponseMessage':
			return ANDROID_MESSAGE_TYPE.INTERACTIVE_RESPONSE
		case 'pollCreationMessage':
		case 'pollCreationMessageV2':
		case 'pollCreationMessageV3':
		case 'pollCreationMessageV5':
		case 'pollCreationMessageV6':
			return ANDROID_MESSAGE_TYPE.POLL
		case 'eventMessage':
			return ANDROID_MESSAGE_TYPE.EVENT
		case 'albumMessage':
			return ANDROID_MESSAGE_TYPE.ALBUM
		case 'ptvMessage':
			return ANDROID_MESSAGE_TYPE.PTV
		case 'stickerPackMessage':
			return ANDROID_MESSAGE_TYPE.STICKER_PACK
		case 'newsletterAdminInviteMessage':
			return ANDROID_MESSAGE_TYPE.NEWSLETTER_ADMIN_INVITE
		case 'newsletterFollowerInviteMessageV2':
			return ANDROID_MESSAGE_TYPE.NEWSLETTER_FOLLOWER_INVITE
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

/**
 * Shape-aware Android message type mapping. This preserves distinctions that
 * getContentType alone cannot express (GIF/video, view-once media, template
 * header type and interactive media header).
 */
export const mapMessageToAndroidType = (message: proto.IMessage | null | undefined): number | null => {
	if (!message) return null

	let content = message
	let viewOnce = false
	for (let depth = 0; depth < 5; depth++) {
		const wrapped =
			content.ephemeralMessage ||
			content.documentWithCaptionMessage ||
			content.editedMessage ||
			content.associatedChildMessage ||
			content.groupStatusMessage ||
			content.groupStatusMessageV2 ||
			content.lottieStickerMessage
		const viewOnceWrapped = content.viewOnceMessage || content.viewOnceMessageV2 || content.viewOnceMessageV2Extension
		if (viewOnceWrapped) {
			viewOnce = true
			content = viewOnceWrapped.message || {}
			continue
		}

		if (!wrapped) break
		content = wrapped.message || {}
	}

	if (content.imageMessage) {
		return viewOnce || content.imageMessage.viewOnce ? ANDROID_MESSAGE_TYPE.VIEW_ONCE_IMAGE : ANDROID_MESSAGE_TYPE.IMAGE
	}

	if (content.audioMessage) {
		return viewOnce || content.audioMessage.viewOnce ? ANDROID_MESSAGE_TYPE.VIEW_ONCE_AUDIO : ANDROID_MESSAGE_TYPE.AUDIO
	}

	if (content.ptvMessage) return ANDROID_MESSAGE_TYPE.PTV
	if (content.videoMessage) {
		if (viewOnce || content.videoMessage.viewOnce) return ANDROID_MESSAGE_TYPE.VIEW_ONCE_VIDEO
		if (content.videoMessage.gifPlayback) return ANDROID_MESSAGE_TYPE.GIF
		return ANDROID_MESSAGE_TYPE.VIDEO
	}

	if (content.templateMessage) {
		const template =
			content.templateMessage.hydratedFourRowTemplate ||
			content.templateMessage.hydratedTemplate ||
			content.templateMessage.fourRowTemplate
		if (template?.imageMessage) return ANDROID_MESSAGE_TYPE.TEMPLATE_IMAGE
		if (template?.documentMessage) return ANDROID_MESSAGE_TYPE.TEMPLATE_DOCUMENT
		return ANDROID_MESSAGE_TYPE.TEMPLATE_TEXT
	}

	if (content.interactiveMessage) {
		const header = content.interactiveMessage.header
		if (header?.imageMessage) return ANDROID_MESSAGE_TYPE.INTERACTIVE_IMAGE
		if (header?.documentMessage) return ANDROID_MESSAGE_TYPE.INTERACTIVE_DOCUMENT
		return ANDROID_MESSAGE_TYPE.INTERACTIVE
	}

	const contentType = Object.keys(content).find(
		key => (key === 'conversation' || key.includes('Message')) && key !== 'senderKeyDistributionMessage'
	)
	return mapContentTypeToMessageType(contentType)
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
	album?: {
		expectedImageCount: number
		expectedVideoCount: number
	} | null
	stickerPack?: {
		stickerPackId: string
		trayIconFileName: string
		packName: string
		packDescription: string | null
		publisher: string | null
		imageDataHash: string | null
		stickerPackSize: number | null
		stickerPackOrigin: number | null
		fileLength: number | null
		mediaKey: Buffer | null
		mediaKeyTimestamp: number | null
		directPath: string | null
		fileSha256: Buffer | null
		fileEncSha256: Buffer | null
		stickers: Array<{
			fileName: string
			isAnimated: boolean
			emojis: string
			accessibilityLabel: string | null
			isLottie: boolean
			mimetype: string | null
		}>
	} | null
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
	/** Read-only lookup: the existing `jid` row id, or null — never creates a row. */
	lookupJidRowId(jid: string): number | null
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
		updateMessageStatusByKey: SqliteStatementLike
		upsertMessageDetails: SqliteStatementLike
		upsertMessageSecret: SqliteStatementLike
		upsertMessageAlbum: SqliteStatementLike
		upsertMessageStickerPack: SqliteStatementLike
		deleteMessageStickerPackStickers: SqliteStatementLike
		insertMessageStickerPackSticker: SqliteStatementLike
		upsertMessageStickerPackMedia: SqliteStatementLike
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
				'UPDATE chat SET ' +
					'last_message_row_id = CASE WHEN ? >= COALESCE(sort_timestamp, -1) THEN ? ELSE last_message_row_id END, ' +
					'sort_timestamp = MAX(COALESCE(sort_timestamp, 0), ?), ' +
					'last_message_sort_id = CASE WHEN ? >= COALESCE(sort_timestamp, -1) THEN ? ELSE last_message_sort_id END, ' +
					'unseen_message_count = COALESCE(unseen_message_count, 0) + ? WHERE _id = ?'
			),
			upsertMessage: this.db.prepare(
				'INSERT INTO message (chat_row_id, from_me, key_id, sender_jid_row_id, status, timestamp, ' +
					'received_timestamp, message_type, text_data, sort_id) ' +
					'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ' +
					'ON CONFLICT(chat_row_id, from_me, key_id, sender_jid_row_id) DO UPDATE SET ' +
					'status = CASE ' +
					'WHEN excluded.status IS NULL THEN message.status ' +
					'WHEN message.status IS NULL THEN excluded.status ' +
					'WHEN (CASE excluded.status WHEN 0 THEN 0 WHEN 4 THEN 1 WHEN 5 THEN 2 WHEN 13 THEN 3 WHEN 8 THEN 4 ELSE -1 END) ' +
					'>= (CASE message.status WHEN 0 THEN 0 WHEN 4 THEN 1 WHEN 5 THEN 2 WHEN 13 THEN 3 WHEN 8 THEN 4 ELSE 99 END) ' +
					'THEN excluded.status ELSE message.status END, ' +
					'received_timestamp = COALESCE(excluded.received_timestamp, message.received_timestamp), ' +
					'message_type = COALESCE(excluded.message_type, message.message_type), ' +
					'text_data = COALESCE(excluded.text_data, message.text_data)'
			),
			getMessageByNaturalKey: this.db.prepare(
				'SELECT * FROM message WHERE chat_row_id = ? AND from_me = ? AND key_id = ? AND sender_jid_row_id IS ?'
			),
			getMessageByKeyId: this.db.prepare('SELECT * FROM message WHERE chat_row_id = ? AND from_me = ? AND key_id = ?'),
			updateMessageStatusByKey: this.db.prepare(
				'UPDATE message SET status = ? WHERE chat_row_id = ? AND from_me = ? AND key_id = ?'
			),
			upsertMessageDetails: this.db.prepare(
				'INSERT INTO message_details (message_row_id, author_device_jid) VALUES (?, ?) ' +
					'ON CONFLICT(message_row_id) DO UPDATE SET author_device_jid = excluded.author_device_jid'
			),
			upsertMessageSecret: this.db.prepare(
				'INSERT INTO message_secret (message_row_id, message_secret) VALUES (?, ?) ' +
					'ON CONFLICT(message_row_id) DO UPDATE SET message_secret = excluded.message_secret'
			),
			upsertMessageAlbum: this.db.prepare(
				'INSERT INTO message_album ' +
					'(message_row_id, image_count, video_count, expected_image_count, expected_video_count) ' +
					'VALUES (?, 0, 0, ?, ?) ON CONFLICT(message_row_id) DO UPDATE SET ' +
					'expected_image_count = excluded.expected_image_count, ' +
					'expected_video_count = excluded.expected_video_count'
			),
			upsertMessageStickerPack: this.db.prepare(
				'INSERT INTO message_sticker_pack ' +
					'(message_row_id, sticker_pack_id, tray_icon_file_name, pack_name, pack_description, publisher, ' +
					'image_data_hash, sticker_pack_size, sticker_pack_origin) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ' +
					'ON CONFLICT(message_row_id) DO UPDATE SET sticker_pack_id = excluded.sticker_pack_id, ' +
					'tray_icon_file_name = excluded.tray_icon_file_name, pack_name = excluded.pack_name, ' +
					'pack_description = excluded.pack_description, publisher = excluded.publisher, ' +
					'image_data_hash = excluded.image_data_hash, sticker_pack_size = excluded.sticker_pack_size, ' +
					'sticker_pack_origin = excluded.sticker_pack_origin'
			),
			deleteMessageStickerPackStickers: this.db.prepare(
				'DELETE FROM message_sticker_pack_stickers WHERE message_row_id = ?'
			),
			insertMessageStickerPackSticker: this.db.prepare(
				'INSERT INTO message_sticker_pack_stickers ' +
					'(message_row_id, file_name, is_animated, emojis, accessibility_label, is_lottie, mimetype) ' +
					'VALUES (?, ?, ?, ?, ?, ?, ?)'
			),
			upsertMessageStickerPackMedia: this.db.prepare(
				'INSERT INTO message_media ' +
					'(message_row_id, mime_type, file_length, media_key, media_key_timestamp, direct_path, file_hash, enc_file_hash) ' +
					'VALUES (?, NULL, ?, ?, ?, ?, ?, ?) ON CONFLICT(message_row_id) DO UPDATE SET ' +
					'mime_type = NULL, file_length = excluded.file_length, media_key = excluded.media_key, ' +
					'media_key_timestamp = excluded.media_key_timestamp, direct_path = excluded.direct_path, ' +
					'file_hash = excluded.file_hash, enc_file_hash = excluded.enc_file_hash'
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
		// `lookupJidRowId` (read-only), NOT `resolveJidRowId` — a pure read like
		// `getMessageByKeyId` must not materialize a phantom `jid` row for an
		// unknown contact (which would mutate msgstore.db on a read and bloat the
		// table). No jid row → no chat row either → null.
		const jidRowId = this.jidMap.lookupJidRowId(jid)
		if (jidRowId === null) return null
		const row = this.stmts.getChatRowIdByJidRowId.get(jidRowId) as { _id: number } | undefined
		return row?._id ?? null
	}

	/**
	 * Records one message, upserting its chat's aggregate counters.
	 * Returns the message's `_id` for satellite-table wiring (media, add-ons).
	 */
	recordMessage(input: RecordMessageInput): number {
		return this.db.transaction((): number => {
			return this.recordMessageInsideTransaction(input)
		})()
	}

	/**
	 * Records a bounded group under one outer transaction. Nested resolver
	 * transactions become SQLite savepoints, so an individual row still keeps
	 * its existing invariants while the batch performs only one durable commit.
	 *
	 * History sync deliberately calls this method in pages and yields between
	 * pages; keeping the transaction bounded prevents both thousands of fsyncs
	 * and one uninterruptibly large write transaction.
	 */
	recordMessages(inputs: readonly RecordMessageInput[]): number[] {
		if (inputs.length === 0) return []
		return this.db.transaction(() => inputs.map(input => this.recordMessageInsideTransaction(input)))()
	}

	private recordMessageInsideTransaction(input: RecordMessageInput): number {
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

		if (input.album) {
			this.stmts.upsertMessageAlbum.run(row._id, input.album.expectedImageCount, input.album.expectedVideoCount)
		}

		if (input.stickerPack) {
			const pack = input.stickerPack
			this.stmts.upsertMessageStickerPack.run(
				row._id,
				pack.stickerPackId,
				pack.trayIconFileName,
				pack.packName,
				pack.packDescription,
				pack.publisher,
				pack.imageDataHash,
				pack.stickerPackSize,
				pack.stickerPackOrigin
			)
			this.stmts.upsertMessageStickerPackMedia.run(
				row._id,
				pack.fileLength,
				pack.mediaKey,
				pack.mediaKeyTimestamp,
				pack.directPath,
				pack.fileSha256?.toString('base64') ?? null,
				pack.fileEncSha256?.toString('base64') ?? null
			)
			this.stmts.deleteMessageStickerPackStickers.run(row._id)
			for (const sticker of pack.stickers) {
				this.stmts.insertMessageStickerPackSticker.run(
					row._id,
					sticker.fileName,
					sticker.isAnimated ? 1 : 0,
					sticker.emojis,
					sticker.accessibilityLabel,
					sticker.isLottie ? 1 : 0,
					sticker.mimetype
				)
			}
		}

		this.stmts.updateChatAggregate.run(
			input.timestamp ?? 0,
			row._id,
			input.timestamp ?? 0,
			input.timestamp ?? 0,
			input.timestamp ?? 0,
			isNewMessage && input.incrementUnread ? 1 : 0,
			chatRowId
		)

		return row._id
	}

	/** Looks up a message by its natural (chat, direction, key) identity, ignoring sender. Pure read — never creates a `chat` row. */
	getMessageByKeyId(chatJid: string, fromMe: boolean, keyId: string): MessageRow | null {
		const chatRowId = this.tryGetChatRowId(chatJid)
		if (chatRowId === null) return null
		const row = this.stmts.getMessageByKeyId.get(chatRowId, fromMe ? 1 : 0, keyId) as MessageRow | undefined
		return row ?? null
	}

	/**
	 * Advances the Android delivery state for an existing message. Receipt
	 * states are ordered by the app's own lifecycle, not by their numeric value
	 * (`READ=13`, `PLAYED=8`), so compare through the explicit order above.
	 */
	updateMessageStatus(chatJid: string, fromMe: boolean, keyId: string, status: number): boolean {
		const chatRowId = this.tryGetChatRowId(chatJid)
		if (chatRowId === null) return false
		const row = this.stmts.getMessageByKeyId.get(chatRowId, fromMe ? 1 : 0, keyId) as MessageRow | undefined
		if (!row) return false

		const currentOrder = row.status === null ? -1 : ANDROID_MESSAGE_STATUS_ORDER.indexOf(row.status as never)
		const nextOrder = ANDROID_MESSAGE_STATUS_ORDER.indexOf(status as never)
		// The official app has additional status values for special/system
		// messages. Do not reinterpret or overwrite an unknown Android state
		// with the ordinary delivery lifecycle.
		if (nextOrder < 0 || (row.status !== null && currentOrder < 0) || currentOrder >= nextOrder) return false

		this.stmts.updateMessageStatusByKey.run(status, chatRowId, fromMe ? 1 : 0, keyId)
		return true
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
