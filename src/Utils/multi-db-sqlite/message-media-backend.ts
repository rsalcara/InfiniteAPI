/**
 * Typed media storage backed by `msgstore.db`'s `message_media` /
 * `message_thumbnail` / `audio_data` / `transcription_segment` /
 * `mms_thumbnail_metadata` / `message_streaming_sidecar` tables.
 *
 * Populated from whichever media-message proto (`imageMessage`,
 * `videoMessage`, `audioMessage`, `documentMessage`, `stickerMessage`) is
 * present — Baileys already decodes these fields, this backend just
 * persists the subset with a confirmed column mapping (real Android
 * capture, Frida, WhatsApp 2.26.22.8, 2026-07-09).
 *
 * `file_path` is intentionally left `null`: Baileys doesn't download media
 * to a local path unless the consumer explicitly calls
 * `downloadMediaMessage`, so there is nothing to record there by default.
 */
import type { SqliteDbLike, SqliteStatementLike } from './types'

export type RecordMediaInput = {
	messageRowId: number
	mimeType?: string | null
	fileLength?: number | null
	mediaKey?: Buffer | null
	directPath?: string | null
	fileSha256?: Buffer | null
	fileEncSha256?: Buffer | null
	width?: number | null
	height?: number | null
	mediaDurationSeconds?: number | null
	caption?: string | null
	mediaName?: string | null
}

export type RecordThumbnailInput = {
	messageRowId: number
	thumbnail: Buffer
}

export type RecordAudioDataInput = {
	messageRowId: number
	waveform?: Buffer | null
}

export type RecordStreamingSidecarInput = {
	messageRowId: number
	sidecar: Buffer
	timestamp: number
}

/** base64 matches the canonical mobile schema's own encoding for these hash columns. */
const toBase64 = (buf: Buffer | null | undefined): string | null => (buf ? buf.toString('base64') : null)

export class MessageMediaBackend {
	private readonly stmts: {
		upsertMedia: SqliteStatementLike
		upsertThumbnail: SqliteStatementLike
		upsertAudioData: SqliteStatementLike
		upsertStreamingSidecar: SqliteStatementLike
	}

	private readonly db: SqliteDbLike

	constructor(db: SqliteDbLike) {
		this.db = db
		this.stmts = {
			upsertMedia: this.db.prepare(
				'INSERT INTO message_media (message_row_id, mime_type, file_length, media_key, direct_path, ' +
					'file_hash, enc_file_hash, width, height, media_duration, media_caption, media_name) ' +
					'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(message_row_id) DO UPDATE SET ' +
					'mime_type = excluded.mime_type, file_length = excluded.file_length, media_key = excluded.media_key, ' +
					'direct_path = excluded.direct_path, file_hash = excluded.file_hash, ' +
					'enc_file_hash = excluded.enc_file_hash, width = excluded.width, height = excluded.height, ' +
					'media_duration = excluded.media_duration, media_caption = excluded.media_caption, ' +
					'media_name = excluded.media_name'
			),
			upsertThumbnail: this.db.prepare(
				'INSERT INTO message_thumbnail (message_row_id, thumbnail) VALUES (?, ?) ' +
					'ON CONFLICT(message_row_id) DO UPDATE SET thumbnail = excluded.thumbnail'
			),
			upsertAudioData: this.db.prepare(
				'INSERT INTO audio_data (message_row_id, waveform) VALUES (?, ?) ' +
					'ON CONFLICT(message_row_id) DO UPDATE SET waveform = excluded.waveform'
			),
			upsertStreamingSidecar: this.db.prepare(
				'INSERT INTO message_streaming_sidecar (message_row_id, sidecar, timestamp) VALUES (?, ?, ?) ' +
					'ON CONFLICT(message_row_id) DO UPDATE SET sidecar = excluded.sidecar, timestamp = excluded.timestamp'
			)
		}
	}

	recordMedia(input: RecordMediaInput): void {
		this.stmts.upsertMedia.run(
			input.messageRowId,
			input.mimeType ?? null,
			input.fileLength ?? null,
			input.mediaKey ?? null,
			input.directPath ?? null,
			toBase64(input.fileSha256),
			toBase64(input.fileEncSha256),
			input.width ?? null,
			input.height ?? null,
			input.mediaDurationSeconds ?? null,
			input.caption ?? null,
			input.mediaName ?? null
		)
	}

	recordThumbnail(input: RecordThumbnailInput): void {
		this.stmts.upsertThumbnail.run(input.messageRowId, input.thumbnail)
	}

	recordAudioData(input: RecordAudioDataInput): void {
		if (!input.waveform) return
		this.stmts.upsertAudioData.run(input.messageRowId, input.waveform)
	}

	recordStreamingSidecar(input: RecordStreamingSidecarInput): void {
		this.stmts.upsertStreamingSidecar.run(input.messageRowId, input.sidecar, input.timestamp)
	}
}
