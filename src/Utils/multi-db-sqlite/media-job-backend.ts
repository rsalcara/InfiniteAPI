/**
 * Typed backend for `media_job` in `media.db` — the transient media-transfer
 * job tracker.
 *
 * `media_job` in the canonical mobile schema is a TRANSIENT transfer tracker:
 * the client INSERTs a row when a media transfer starts (a client-generated
 * `uuid`, `job_type=1` for upload, start timestamps, `transferred_bytes=0`),
 * UPDATEs it as bytes move / a reupload is attempted, and DELETEs it —
 * `WHERE uuid=? AND job_type=?` — once the transfer completes. It is empty in
 * steady state and populated only while a transfer is in flight (so it reads as
 * "gap" to snapshot-only analysis, but it is genuinely used mid-transfer).
 *
 * InfiniteAPI uploads media inline (`waUploadToServer`), so it mirrors the same
 * lifecycle around that upload: INSERT on start, DELETE on completion
 * (success OR failure), best-effort. It does not thread the uuid into
 * `msgstore.message_media.media_job_uuid` (that durable link would require
 * cross-cutting the send pipeline) — see MEDIA_DB.md.
 *
 * Only `job_type=1` (upload) is mirrored — the only transfer flow InfiniteAPI
 * drives. The other 4 media.db tables (express_path_download_data,
 * draft_voice_note_metadata, recent_searches, shared_media_ids) are device-local
 * UI/state with no wire-level source.
 */
import type { SqliteDbLike, SqliteStatementLike } from './types'

export const MEDIA_JOB_TYPE_UPLOAD = 1

export type MediaUploadJob = {
	uuid: string
	createTime?: number
	transferStartTime?: number
}

export type StoredMediaJobRow = {
	uuid: string
	job_type: number
	create_time: number | null
	transfer_start_time: number | null
	transferred_bytes: number | null
	reupload_attempt_count: number | null
}

export class MediaJobBackend {
	private readonly stmts: {
		insert: SqliteStatementLike
		delete: SqliteStatementLike
		select: SqliteStatementLike
		listInProgress: SqliteStatementLike
		clear: SqliteStatementLike
	}

	private readonly db: SqliteDbLike

	constructor(db: SqliteDbLike) {
		this.db = db
		this.stmts = {
			// Mirrors the mobile INSERT verbatim (same columns set to 0 at start).
			insert: this.db.prepare(
				'INSERT INTO media_job (uuid, job_type, create_time, transfer_start_time, last_update_time, ' +
					'transferred_bytes, reupload_attempt_count, user_initiated_attempt_count, overall_cumulative_time, ' +
					'overall_cumulative_user_visible_time, streaming_playback_count, media_key_reuse_type, ' +
					'last_reupload_attempt_timestamp, last_reupload_success_timestamp) ' +
					'VALUES (?, ?, ?, ?, ?, 0, 0, 0, 0, 0, 0, 0, 0, 0)'
			),
			// Same natural key as mobile: (uuid, job_type).
			delete: this.db.prepare('DELETE FROM media_job WHERE uuid = ? AND job_type = ?'),
			// job_type is part of the natural key (a uuid can in principle recur
			// across a different job_type); scope both reads to uploads — the only
			// flow this backend drives — so we never hand back a foreign job.
			select: this.db.prepare(
				'SELECT uuid, job_type, create_time, transfer_start_time, transferred_bytes, reupload_attempt_count ' +
					'FROM media_job WHERE uuid = ? AND job_type = ?'
			),
			listInProgress: this.db.prepare(
				'SELECT uuid, job_type, create_time, transfer_start_time, transferred_bytes, reupload_attempt_count ' +
					'FROM media_job WHERE job_type = ? ORDER BY transfer_start_time'
			),
			clear: this.db.prepare('DELETE FROM media_job')
		}
	}

	/** INSERT a media_job row when an upload transfer starts (job_type=1). */
	insertUpload(job: MediaUploadJob): void {
		const now = Date.now()
		this.stmts.insert.run(job.uuid, MEDIA_JOB_TYPE_UPLOAD, job.createTime ?? now, job.transferStartTime ?? now, now)
	}

	/** DELETE the upload job once the transfer completes (success or failure). */
	deleteUpload(uuid: string): boolean {
		return this.stmts.delete.run(uuid, MEDIA_JOB_TYPE_UPLOAD).changes > 0
	}

	getJob(uuid: string): StoredMediaJobRow | null {
		return (this.stmts.select.get(uuid, MEDIA_JOB_TYPE_UPLOAD) as StoredMediaJobRow | undefined) ?? null
	}

	/** Lists the upload transfers currently in flight (media_job is transient). */
	listInProgress(): StoredMediaJobRow[] {
		return this.stmts.listInProgress.all(MEDIA_JOB_TYPE_UPLOAD) as StoredMediaJobRow[]
	}

	/** Wipes every row (e.g. socket close — an in-flight transfer does not survive). */
	clear(): void {
		this.stmts.clear.run()
	}
}
