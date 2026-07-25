/**
 * Typed static/live-location storage backed by WhatsApp's `location.db`
 * schema.
 *
 * Mobile parity details:
 *   - timestamps and `expires` are unix milliseconds;
 *   - the live share duration is carried by `<enc duration="…">`, outside
 *     `LiveLocationMessage`;
 *   - a received duration of zero uses Java's `Long.MAX_VALUE` sentinel;
 *   - `remote_resource` is the sender/recipient user jid, never an invented
 *     gateway placeholder;
 *   - the canonical table has no gateway-only retention columns.
 */
import type { SqliteDbLike, SqliteStatementLike } from './types'

const SQLITE_LONG_MAX_TEXT = '9223372036854775807'

/**
 * JSON-safe representation exposed to JS callers for SQLite/Java Long.MAX.
 * The backend stores the exact signed-64-bit value in SQLite.
 */
export const LOCATION_OPEN_ENDED_EXPIRES_MS = Number.MAX_SAFE_INTEGER

export type LocationCacheRow = {
	jid: string
	latitude: number
	longitude: number
	accuracy: number
	speed: number
	bearing: number
	/** Unix milliseconds. */
	locationTs: number
}

export type LocationSharerRow = {
	remoteJid: string
	fromMe: number
	remoteResource: string
	/** Unix milliseconds, or {@link LOCATION_OPEN_ENDED_EXPIRES_MS}. */
	expires: number
	messageId: string
	/**
	 * @deprecated Compatibility-only input from the former retention
	 * heuristic. It is ignored and is never persisted.
	 */
	receivedTs?: number
}

const toDbExpires = (expires: number): number | string =>
	expires >= LOCATION_OPEN_ENDED_EXPIRES_MS ? SQLITE_LONG_MAX_TEXT : expires

const fromDbExpires = (expires: number): number =>
	expires >= LOCATION_OPEN_ENDED_EXPIRES_MS ? LOCATION_OPEN_ENDED_EXPIRES_MS : expires

export class LocationBackend {
	private readonly stmts: {
		replaceLocationCache: SqliteStatementLike
		getLocationCache: SqliteStatementLike
		replaceLocationSharer: SqliteStatementLike
		getLocationSharer: SqliteStatementLike
		listLocationSharers: SqliteStatementLike
		listActiveLocationSharers: SqliteStatementLike
		endLocationSharer: SqliteStatementLike
		endLocationSharersForMessage: SqliteStatementLike
	}

	/**
	 * `opts` is retained for source compatibility with older callers. The old
	 * received-share retention heuristic is intentionally no longer applied.
	 */
	constructor(
		private readonly db: SqliteDbLike,
		_opts?: { retentionSecs?: number; pruneIntervalMs?: number }
	) {
		this.stmts = {
			replaceLocationCache: this.db.prepare(
				'INSERT OR REPLACE INTO location_cache ' +
					'(jid, latitude, longitude, accuracy, speed, bearing, location_ts) VALUES (?, ?, ?, ?, ?, ?, ?)'
			),
			getLocationCache: this.db.prepare(
				'SELECT jid, latitude, longitude, accuracy, speed, bearing, location_ts FROM location_cache WHERE jid = ?'
			),
			replaceLocationSharer: this.db.prepare(
				'INSERT OR REPLACE INTO location_sharer ' +
					'(remote_jid, from_me, remote_resource, expires, message_id) VALUES (?, ?, ?, ?, ?)'
			),
			getLocationSharer: this.db.prepare(
				'SELECT remote_jid, from_me, remote_resource, expires, message_id FROM location_sharer ' +
					'WHERE remote_jid = ? AND from_me = ? AND remote_resource = ? AND message_id = ?'
			),
			listLocationSharers: this.db.prepare(
				'SELECT remote_jid, from_me, remote_resource, expires, message_id FROM location_sharer ORDER BY _id'
			),
			listActiveLocationSharers: this.db.prepare(
				'SELECT remote_jid, from_me, remote_resource, expires, message_id FROM location_sharer ' +
					'WHERE expires >= ? ORDER BY _id DESC'
			),
			endLocationSharer: this.db.prepare(
				'DELETE FROM location_sharer WHERE remote_jid = ? AND from_me = ? AND remote_resource = ? AND message_id = ?'
			),
			endLocationSharersForMessage: this.db.prepare(
				'DELETE FROM location_sharer WHERE remote_jid = ? AND from_me = ? AND message_id = ?'
			)
		}
	}

	upsertLocationCache(row: LocationCacheRow): void {
		this.stmts.replaceLocationCache.run(
			row.jid,
			row.latitude,
			row.longitude,
			row.accuracy,
			row.speed,
			row.bearing,
			row.locationTs
		)
	}

	getLocationCache(jid: string): LocationCacheRow | null {
		const r = this.stmts.getLocationCache.get(jid) as
			| {
					jid: string
					latitude: number
					longitude: number
					accuracy: number
					speed: number
					bearing: number
					location_ts: number
			  }
			| undefined
		if (!r) return null
		return {
			jid: r.jid,
			latitude: r.latitude,
			longitude: r.longitude,
			accuracy: r.accuracy,
			speed: r.speed,
			bearing: r.bearing,
			locationTs: r.location_ts
		}
	}

	upsertLocationSharer(row: LocationSharerRow): void {
		this.stmts.replaceLocationSharer.run(
			row.remoteJid,
			row.fromMe,
			row.remoteResource,
			toDbExpires(row.expires),
			row.messageId
		)
	}

	getLocationSharer(
		remoteJid: string,
		fromMe: number,
		remoteResource: string,
		messageId: string
	): LocationSharerRow | null {
		const r = this.stmts.getLocationSharer.get(remoteJid, fromMe, remoteResource, messageId) as
			| { remote_jid: string; from_me: number; remote_resource: string; expires: number; message_id: string }
			| undefined
		return r ? this.mapSharer(r) : null
	}

	listLocationSharers(): LocationSharerRow[] {
		const rows = this.stmts.listLocationSharers.all() as Array<{
			remote_jid: string
			from_me: number
			remote_resource: string
			expires: number
			message_id: string
		}>
		return rows.map(row => this.mapSharer(row))
	}

	/** Returns rows whose official millisecond expiry has not elapsed. */
	listActiveLocationSharers(nowMs: number): LocationSharerRow[] {
		const rows = this.stmts.listActiveLocationSharers.all(nowMs) as Array<{
			remote_jid: string
			from_me: number
			remote_resource: string
			expires: number
			message_id: string
		}>
		return rows.map(row => this.mapSharer(row))
	}

	endLocationSharer(remoteJid: string, fromMe: number, remoteResource: string, messageId: string): boolean {
		return this.stmts.endLocationSharer.run(remoteJid, fromMe, remoteResource, messageId).changes > 0
	}

	endLocationSharersForMessage(remoteJid: string, fromMe: number, messageId: string): number {
		return this.stmts.endLocationSharersForMessage.run(remoteJid, fromMe, messageId).changes
	}

	/**
	 * @deprecated The official client uses duration/final-location state, not
	 * a received-activity timeout. Kept as a harmless no-op for compatibility.
	 */
	pruneStaleReceivedSharers(_cutoff: number): number {
		return 0
	}

	private mapSharer(row: {
		remote_jid: string
		from_me: number
		remote_resource: string
		expires: number
		message_id: string
	}): LocationSharerRow {
		return {
			remoteJid: row.remote_jid,
			fromMe: row.from_me,
			remoteResource: row.remote_resource,
			expires: fromDbExpires(row.expires),
			messageId: row.message_id
		}
	}
}
