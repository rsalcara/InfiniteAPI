/**
 * Typed backend for `history_sync_companion` in `sync.db`.
 *
 * Mirrors — best-effort — the per-chunk tracking the mobile client keeps
 * while a companion (linked-device) history sync is in flight. The canonical
 * mobile lifecycle is:
 *
 *   1. INSERT (12 columns) when a history-sync-notification chunk arrives
 *   2. UPDATE `local_path` once the chunk media is downloaded to storage
 *   3. DELETE `WHERE message_id = ?` once the chunk is consumed/processed
 *
 * InfiniteAPI keeps its existing history-sync path authoritative (the
 * download+inflate in `history.ts` / `process-message.ts` — the "legacy"
 * flow). This table is a transient introspection mirror populated around
 * that flow; if any write throws it is swallowed by the caller so the
 * real history sync is never affected.
 *
 * Divergence note: InfiniteAPI inflates each chunk **in memory** and does
 * not persist it to a local file, so `local_path` has no 1:1 equivalent.
 * {@link HistorySyncCompanionBackend.markProcessed} updates it to a marker
 * (or leaves it null) purely to mirror the mobile UPDATE step; nothing in
 * InfiniteAPI reads it back.
 */
import type { SqliteDbLike, SqliteStatementLike } from './types'

export type HistorySyncCompanionRow = {
	messageId: string
	syncType?: number
	chunkOrder?: number
	mediaKey?: Buffer | Uint8Array | null
	mediaHash?: string
	mediaEncHash?: string
	fileSize?: number
	directPath?: string
	localPath?: string | null
	startTime?: number | null
	inlinePayload?: Buffer | Uint8Array | null
	encHandle?: string | null
}

export type StoredHistorySyncCompanionRow = {
	message_id: string
	sync_type: number
	chunk_order: number
	media_key: Buffer | null
	media_hash: string
	media_enc_hash: string
	file_size: number
	direct_path: string
	local_path: string | null
	start_time: number | null
	inline_payload: Buffer | null
	enc_handle: string | null
}

const toBuffer = (v: Buffer | Uint8Array | null | undefined): Buffer | null => {
	if (v === null || v === undefined) return null
	return Buffer.isBuffer(v) ? v : Buffer.from(v)
}

export class HistorySyncCompanionBackend {
	private readonly stmts: {
		upsert: SqliteStatementLike
		updateLocalPath: SqliteStatementLike
		delete: SqliteStatementLike
		select: SqliteStatementLike
		clear: SqliteStatementLike
	}

	private readonly db: SqliteDbLike

	constructor(db: SqliteDbLike) {
		this.db = db
		this.stmts = {
			// message_id is PRIMARY KEY — a re-delivered chunk notification
			// upserts rather than duplicating, matching the mobile INSERT that
			// replaces on the same message_id.
			upsert: this.db.prepare(
				'INSERT INTO history_sync_companion (message_id, sync_type, chunk_order, media_key, media_hash, ' +
					'media_enc_hash, file_size, direct_path, local_path, start_time, inline_payload, enc_handle) ' +
					'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ' +
					'ON CONFLICT(message_id) DO UPDATE SET ' +
					'sync_type = excluded.sync_type, chunk_order = excluded.chunk_order, media_key = excluded.media_key, ' +
					'media_hash = excluded.media_hash, media_enc_hash = excluded.media_enc_hash, ' +
					'file_size = excluded.file_size, direct_path = excluded.direct_path, ' +
					'start_time = excluded.start_time, inline_payload = excluded.inline_payload, ' +
					'enc_handle = excluded.enc_handle'
			),
			updateLocalPath: this.db.prepare('UPDATE history_sync_companion SET local_path = ? WHERE message_id = ?'),
			delete: this.db.prepare('DELETE FROM history_sync_companion WHERE message_id = ?'),
			select: this.db.prepare('SELECT * FROM history_sync_companion WHERE message_id = ?'),
			clear: this.db.prepare('DELETE FROM history_sync_companion')
		}
	}

	/** INSERT/upsert a chunk record when its history-sync notification arrives. */
	put(row: HistorySyncCompanionRow): void {
		this.stmts.upsert.run(
			row.messageId,
			row.syncType ?? 0,
			row.chunkOrder ?? 0,
			toBuffer(row.mediaKey),
			row.mediaHash ?? '',
			row.mediaEncHash ?? '',
			row.fileSize ?? 0,
			row.directPath ?? '',
			row.localPath ?? null,
			row.startTime ?? null,
			toBuffer(row.inlinePayload),
			row.encHandle ?? null
		)
	}

	/** UPDATE local_path — mirrors the mobile step after the chunk downloads. */
	markProcessed(messageId: string, localPath: string | null = null): boolean {
		return this.stmts.updateLocalPath.run(localPath, messageId).changes > 0
	}

	/** DELETE the chunk row once it is consumed. */
	delete(messageId: string): boolean {
		return this.stmts.delete.run(messageId).changes > 0
	}

	get(messageId: string): StoredHistorySyncCompanionRow | null {
		return (this.stmts.select.get(messageId) as StoredHistorySyncCompanionRow | undefined) ?? null
	}

	/** Wipes every row (socket close — an in-flight sync does not survive). */
	clear(): void {
		this.stmts.clear.run()
	}
}
