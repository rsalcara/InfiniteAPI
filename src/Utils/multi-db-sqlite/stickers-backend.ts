/**
 * Phase 9.16 — typed sticker library storage backed by `stickers.db`.
 *
 * A companion CAN populate two of the sticker tables, because WhatsApp syncs
 * them through **app-state** (confirmed: the E2E proto defines
 * `SyncActionValue.stickerAction` = 33 and `.removeRecentStickerAction` = 34,
 * and a real device's `starred_stickers` rows carry exactly the
 * `StickerAction` fields — url/directPath/mediaKey/fileEncSha256/mimetype/
 * dimensions/isLottie/isAvatarSticker):
 *
 *   - `starred_stickers` — the user's favourited stickers. Add/remove driven by
 *     `stickerAction` (isFavorite true/false) in `processSyncAction`.
 *   - `recent_stickers` — recently-used stickers. Removal driven by
 *     `removeRecentStickerAction` (by `lastStickerSentTs`); addition is done
 *     when we SEND a sticker (recent = recently used).
 *
 * The other tables (downloadable/installed/new/unseen pack catalog,
 * pack order, avatar search, 3rd-party) are device-local store/UI state with no
 * companion-reachable source — left schema-only. See STICKERS_DB.md.
 *
 * `plaintext_hash` (the sticker's plaintext SHA-256, base64) is the PK on both
 * tables, taken from the app-state mutation index. Column names match the
 * canonical mobile schema verbatim. Bytes (`media_key`/`enc_hash`) are stored
 * base64, matching the mobile's TEXT columns.
 */
import type { SqliteDbLike, SqliteStatementLike } from './types'

export type StarredStickerInput = {
	plaintextHash: string
	timestamp?: number | null
	url?: string | null
	encHash?: string | null
	directPath?: string | null
	mimetype?: string | null
	mediaKey?: string | null
	fileSize?: number | null
	width?: number | null
	height?: number | null
	hashOfImagePart?: string | null
	isLottie?: number | null
	isAvatar?: number | null
}

export type RecentStickerInput = StarredStickerInput & {
	entryWeight?: number | null
	lastStickerSentTs?: number | null
}

export type StoredStarredStickerRow = {
	plaintext_hash: string
	timestamp: number | null
	url: string | null
	enc_hash: string | null
	direct_path: string | null
	mimetype: string | null
	media_key: string | null
	file_size: number | null
	width: number | null
	height: number | null
	hash_of_image_part: string | null
	is_lottie: number | null
	is_avatar: number
}

export type StoredRecentStickerRow = StoredStarredStickerRow & {
	entry_weight: number
	last_sticker_sent_ts: number
}

export class StickersBackend {
	private readonly stmts: {
		upsertStarred: SqliteStatementLike
		removeStarred: SqliteStatementLike
		getStarred: SqliteStatementLike
		listStarred: SqliteStatementLike
		upsertRecent: SqliteStatementLike
		removeRecentByTs: SqliteStatementLike
		listRecent: SqliteStatementLike
	}

	private readonly db: SqliteDbLike

	constructor(db: SqliteDbLike) {
		this.db = db
		this.stmts = {
			upsertStarred: this.db.prepare(
				'INSERT INTO starred_stickers (plaintext_hash, timestamp, url, enc_hash, direct_path, mimetype, ' +
					'media_key, file_size, width, height, hash_of_image_part, is_lottie, is_avatar) ' +
					'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ' +
					'ON CONFLICT(plaintext_hash) DO UPDATE SET ' +
					'  timestamp = excluded.timestamp, url = excluded.url, enc_hash = excluded.enc_hash, ' +
					'  direct_path = excluded.direct_path, mimetype = excluded.mimetype, media_key = excluded.media_key, ' +
					'  file_size = excluded.file_size, width = excluded.width, height = excluded.height, ' +
					'  hash_of_image_part = excluded.hash_of_image_part, is_lottie = excluded.is_lottie, ' +
					'  is_avatar = excluded.is_avatar'
			),
			removeStarred: this.db.prepare('DELETE FROM starred_stickers WHERE plaintext_hash = ?'),
			getStarred: this.db.prepare('SELECT * FROM starred_stickers WHERE plaintext_hash = ?'),
			listStarred: this.db.prepare('SELECT * FROM starred_stickers ORDER BY timestamp DESC'),
			upsertRecent: this.db.prepare(
				'INSERT INTO recent_stickers (plaintext_hash, entry_weight, last_sticker_sent_ts, url, enc_hash, ' +
					'direct_path, mimetype, media_key, file_size, width, height, hash_of_image_part, is_lottie) ' +
					'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ' +
					'ON CONFLICT(plaintext_hash) DO UPDATE SET ' +
					'  entry_weight = excluded.entry_weight, last_sticker_sent_ts = excluded.last_sticker_sent_ts, ' +
					'  url = excluded.url, enc_hash = excluded.enc_hash, direct_path = excluded.direct_path, ' +
					'  mimetype = excluded.mimetype, media_key = excluded.media_key, file_size = excluded.file_size, ' +
					'  width = excluded.width, height = excluded.height, hash_of_image_part = excluded.hash_of_image_part, ' +
					'  is_lottie = excluded.is_lottie'
			),
			// removeRecentStickerAction identifies the row by its lastStickerSentTs.
			removeRecentByTs: this.db.prepare('DELETE FROM recent_stickers WHERE last_sticker_sent_ts = ?'),
			listRecent: this.db.prepare('SELECT * FROM recent_stickers ORDER BY entry_weight DESC, last_sticker_sent_ts DESC')
		}
	}

	/** Upsert a favourited sticker (from an app-state `stickerAction`, isFavorite=true). */
	upsertStarred(s: StarredStickerInput): void {
		this.stmts.upsertStarred.run(
			s.plaintextHash,
			s.timestamp ?? null,
			s.url ?? null,
			s.encHash ?? null,
			s.directPath ?? null,
			s.mimetype ?? null,
			s.mediaKey ?? null,
			s.fileSize ?? null,
			s.width ?? null,
			s.height ?? null,
			s.hashOfImagePart ?? null,
			s.isLottie ?? null,
			s.isAvatar ?? 0
		)
	}

	/** Un-favourite (from an app-state `stickerAction`, isFavorite=false). */
	removeStarred(plaintextHash: string): boolean {
		return this.stmts.removeStarred.run(plaintextHash).changes > 0
	}

	getStarred(plaintextHash: string): StoredStarredStickerRow | null {
		return (this.stmts.getStarred.get(plaintextHash) as StoredStarredStickerRow | undefined) ?? null
	}

	listStarred(): StoredStarredStickerRow[] {
		return this.stmts.listStarred.all() as StoredStarredStickerRow[]
	}

	/** Upsert a recently-used sticker (when we send one). */
	upsertRecent(s: RecentStickerInput): void {
		this.stmts.upsertRecent.run(
			s.plaintextHash,
			s.entryWeight ?? 0,
			s.lastStickerSentTs ?? 0,
			s.url ?? null,
			s.encHash ?? null,
			s.directPath ?? null,
			s.mimetype ?? null,
			s.mediaKey ?? null,
			s.fileSize ?? null,
			s.width ?? null,
			s.height ?? null,
			s.hashOfImagePart ?? null,
			s.isLottie ?? null
		)
	}

	/** Remove a recent sticker by its lastStickerSentTs (app-state removeRecentStickerAction). */
	removeRecentByTs(lastStickerSentTs: number): boolean {
		return this.stmts.removeRecentByTs.run(lastStickerSentTs).changes > 0
	}

	listRecent(): StoredRecentStickerRow[] {
		return this.stmts.listRecent.all() as StoredRecentStickerRow[]
	}
}
