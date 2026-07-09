/**
 * Phase 9.8 — typed live/static location storage backed by `location.db`.
 *
 * Real Android capture (2026-05/06 Frida dump) confirms the schema below but
 * — unlike sync.db/axolotl.db/wa.db — location.db was "gap total" in every
 * available capture (byte-identical snapshots across the whole session, zero
 * write activity observed). Schema fidelity is confirmed; write-trigger
 * *timing* here is a reasonable inference from Baileys' own decoded message
 * shape (`ILocationMessage`/`ILiveLocationMessage`), not reverse-engineered
 * from a real sequence the way Phase 9.7's sync.db was.
 *
 *   - `location_cache` — latest known position per jid. UNIQUE(jid) on the
 *     real schema — one row per contact, always the newest report — so
 *     `upsertLocationCache` is an upsert.
 *   - `location_sharer` — one row per active "share my live location"
 *     session, keyed by (remote_jid, from_me, remote_resource, message_id).
 *     `expires` is intentionally left at the schema default (0/unknown)
 *     here: WhatsApp's "share for 15min/1h/8h" duration is chosen by the
 *     SENDING client and isn't part of `ILiveLocationMessage`'s decoded
 *     fields (no `shareDuration`/expiry field exists on it) — computing a
 *     fake expiry would be fabricating data with no confirmed source. Real
 *     Android's own `expires` column is itself state the app *queries*, not
 *     a SQL-enforced TTL (confirmed: no DELETE trigger on it).
 *   - `location_key_distribution` — group-live-location sender-key ACK
 *     tracking. NOT wired: Baileys exposes no group-live-location key
 *     distribution concept today, so there's no confident write path —
 *     left as schema-only rather than guessed at.
 *
 * Column names match the canonical schema verbatim.
 */
import type { SqliteDbLike, SqliteStatementLike } from './types'

export type LocationCacheRow = {
	jid: string
	latitude: number
	longitude: number
	accuracy: number
	speed: number
	bearing: number
	locationTs: number
}

export type LocationSharerRow = {
	remoteJid: string
	fromMe: number
	remoteResource: string
	expires: number
	messageId: string
}

export class LocationBackend {
	private readonly stmts: {
		upsertLocationCache: SqliteStatementLike
		getLocationCache: SqliteStatementLike
		upsertLocationSharer: SqliteStatementLike
		getLocationSharer: SqliteStatementLike
		listLocationSharers: SqliteStatementLike
		endLocationSharer: SqliteStatementLike
	}

	private readonly db: SqliteDbLike

	constructor(db: SqliteDbLike) {
		this.db = db
		this.stmts = {
			// `WHERE excluded.location_ts >= location_cache.location_ts` guards
			// against out-of-order delivery: a live-location update that
			// arrives late (common over unreliable delivery) must not
			// overwrite a newer position with a stale one. Confirmed real bug
			// in an earlier revision (unconditional overwrite).
			upsertLocationCache: this.db.prepare(
				'INSERT INTO location_cache (jid, latitude, longitude, accuracy, speed, bearing, location_ts) ' +
					'VALUES (?, ?, ?, ?, ?, ?, ?) ' +
					'ON CONFLICT(jid) DO UPDATE SET ' +
					'  latitude = excluded.latitude, longitude = excluded.longitude, accuracy = excluded.accuracy, ' +
					'  speed = excluded.speed, bearing = excluded.bearing, location_ts = excluded.location_ts ' +
					'WHERE excluded.location_ts >= location_cache.location_ts'
			),
			getLocationCache: this.db.prepare(
				'SELECT jid, latitude, longitude, accuracy, speed, bearing, location_ts FROM location_cache WHERE jid = ?'
			),
			upsertLocationSharer: this.db.prepare(
				'INSERT INTO location_sharer (remote_jid, from_me, remote_resource, expires, message_id) ' +
					'VALUES (?, ?, ?, ?, ?) ' +
					'ON CONFLICT(remote_jid, from_me, remote_resource, message_id) DO UPDATE SET ' +
					'  expires = excluded.expires'
			),
			getLocationSharer: this.db.prepare(
				'SELECT remote_jid, from_me, remote_resource, expires, message_id FROM location_sharer ' +
					'WHERE remote_jid = ? AND from_me = ? AND remote_resource = ? AND message_id = ?'
			),
			listLocationSharers: this.db.prepare(
				'SELECT remote_jid, from_me, remote_resource, expires, message_id FROM location_sharer'
			),
			endLocationSharer: this.db.prepare(
				'DELETE FROM location_sharer WHERE remote_jid = ? AND from_me = ? AND remote_resource = ? AND message_id = ?'
			)
		}
	}

	upsertLocationCache(row: LocationCacheRow): void {
		this.stmts.upsertLocationCache.run(
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
		this.stmts.upsertLocationSharer.run(row.remoteJid, row.fromMe, row.remoteResource, row.expires, row.messageId)
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
		if (!r) return null
		return {
			remoteJid: r.remote_jid,
			fromMe: r.from_me,
			remoteResource: r.remote_resource,
			expires: r.expires,
			messageId: r.message_id
		}
	}

	listLocationSharers(): LocationSharerRow[] {
		const rows = this.stmts.listLocationSharers.all() as Array<{
			remote_jid: string
			from_me: number
			remote_resource: string
			expires: number
			message_id: string
		}>
		return rows.map(r => ({
			remoteJid: r.remote_jid,
			fromMe: r.from_me,
			remoteResource: r.remote_resource,
			expires: r.expires,
			messageId: r.message_id
		}))
	}

	endLocationSharer(remoteJid: string, fromMe: number, remoteResource: string, messageId: string): boolean {
		const r = this.stmts.endLocationSharer.run(remoteJid, fromMe, remoteResource, messageId)
		return r.changes > 0
	}
}
