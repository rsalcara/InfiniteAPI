import type { SqliteDbLike } from './types'

type TableInfoRow = {
	name: string
}

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
		SELECT _id, remote_jid, from_me, remote_resource, expires, message_id
		FROM location_sharer;

		DROP TABLE location_sharer;
		ALTER TABLE location_sharer_canonical RENAME TO location_sharer;

		CREATE UNIQUE INDEX location_sharer_index
			ON location_sharer (remote_jid, from_me, remote_resource, message_id);
	`)
}

/**
 * The removed retention workaround wrote `expires=0` for open-ended shares.
 * Android represents the same state with Java's Long.MAX_VALUE. Repairing the
 * sentinel keeps upgraded rows visible to the canonical active-window query.
 */
export const repairOpenEndedLocationSharerExpiry = (db: SqliteDbLike): void => {
	db.prepare("UPDATE location_sharer SET expires = CAST('9223372036854775807' AS INTEGER) WHERE expires = 0").run()
}
