import type { SqliteDbLike } from './types'

type TableInfoRow = {
	name: string
}

const LOCATION_RECEIVED_RETENTION_MS = 8 * 60 * 60 * 1000
const SQLITE_LONG_MAX_TEXT = '9223372036854775807'
const SECONDS_TO_MILLISECONDS_THRESHOLD = 100_000_000_000

/**
 * Restores WhatsApp's canonical `location_sharer` shape.
 *
 * An older InfiniteAPI migration appended a gateway-only `received_ts`
 * column because the receive path had dropped the live-location duration
 * carried by the encrypted node. Duration is now decoded correctly, so the
 * heuristic column is both unnecessary and schema-incompatible with the
 * mobile database. The migration runner already wraps this function in one
 * IMMEDIATE transaction.
 */
export const restoreCanonicalLocationSharerSchema = (db: SqliteDbLike): void => {
	const columns = db.prepare('PRAGMA table_info(location_sharer)').all() as TableInfoRow[]
	if (!columns.some(column => column.name === 'received_ts')) {
		return
	}

	db.exec(`
		CREATE TABLE location_sharer_canonical (
			_id INTEGER PRIMARY KEY AUTOINCREMENT,
			remote_jid TEXT NOT NULL DEFAULT '',
			from_me BOOLEAN NOT NULL DEFAULT 0,
			remote_resource TEXT NOT NULL DEFAULT '',
			expires INTEGER NOT NULL DEFAULT 0,
			message_id TEXT NOT NULL DEFAULT ''
		);

		INSERT INTO location_sharer_canonical
			(_id, remote_jid, from_me, remote_resource, expires, message_id)
		SELECT
			_id,
			remote_jid,
			from_me,
			remote_resource,
			CASE
				WHEN from_me = 0 AND expires = 0
					THEN (received_ts * 1000) + ${LOCATION_RECEIVED_RETENTION_MS}
				WHEN expires > 0 AND expires < ${SECONDS_TO_MILLISECONDS_THRESHOLD}
					THEN expires * 1000
				ELSE expires
			END,
			message_id
		FROM location_sharer;

		DROP TABLE location_sharer;
		ALTER TABLE location_sharer_canonical RENAME TO location_sharer;

		CREATE UNIQUE INDEX location_sharer_index
			ON location_sharer (remote_jid, from_me, remote_resource, message_id);
	`)
}

/**
 * A zero expiry is canonical only for an open-ended share originated by this
 * account. Legacy received rows used zero because companions did not know the
 * duration; migration v2 converts those to a bounded eight-hour window before
 * removing `received_ts`.
 */
export const repairOpenEndedLocationSharerExpiry = (db: SqliteDbLike): void => {
	db.prepare(
		`UPDATE location_sharer SET expires = CAST('${SQLITE_LONG_MAX_TEXT}' AS INTEGER) WHERE expires = 0 AND from_me = 1`
	).run()
}

/**
 * Repairs databases opened by older builds and normalizes the historical
 * seconds-based timestamps before active-window reads compare against unix ms.
 *
 * Received Long.MAX rows can only have been produced by the former unscoped v3
 * migration. Deleting them is fail-closed: a subsequent live update recreates
 * a genuinely active row, while ended historical shares are not resurrected.
 */
export const normalizeLocationTimestampUnits = (db: SqliteDbLike): void => {
	db.prepare(
		`UPDATE location_cache SET location_ts = location_ts * 1000
		 WHERE location_ts > 0 AND location_ts < ${SECONDS_TO_MILLISECONDS_THRESHOLD}`
	).run()
	db.prepare(
		`UPDATE location_sharer SET expires = expires * 1000
		 WHERE expires > 0 AND expires < ${SECONDS_TO_MILLISECONDS_THRESHOLD}`
	).run()
	db.prepare(
		`DELETE FROM location_sharer
		 WHERE from_me = 0 AND expires = CAST('${SQLITE_LONG_MAX_TEXT}' AS INTEGER)`
	).run()
}
