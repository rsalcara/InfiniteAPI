/**
 * Phase 9.8 — typed live/static location storage backed by `location.db`.
 *
 * Live-location parity was reverse-engineered end-to-end against a real paired
 * companion (raw decrypted-plaintext capture + delivery-receipt testing). The
 * decisive finding: **WhatsApp live location is a PRIMARY-DEVICE-ONLY feature.**
 * A linked/companion client (which every Baileys socket is) participates only
 * partially, and that shapes what these tables can hold:
 *
 *   - `location_cache` — latest known position per jid. UNIQUE(jid) on the real
 *     schema — one row per contact, always the newest report — so
 *     `upsertLocationCache` is an upsert. Populated from each received
 *     `liveLocationMessage` (lat/lng) and from our own `sendLiveLocation`.
 *   - `location_sharer` — one row per active "share my live location" session,
 *     keyed by (remote_jid, from_me, remote_resource, message_id).
 *     `expires` is asymmetric by direction, and this is CORRECT parity, not a
 *     gap:
 *       • RECEIVED (from_me=0): `expires` stays 0. Proven by decoding the raw
 *         plaintext bytes of a real received share — the wire carries ONLY
 *         `degreesLatitude`, `degreesLongitude`, `sequenceNumber`,
 *         `jpegThumbnail`. There is NO duration/expiry field anywhere in the
 *         E2E proto (`LiveLocationMessage` = fields 1-8,16,17; `LocationMessage`
 *         = 1-9,11,16,17), and WA Web/Desktop confirm it (they show "live
 *         location unavailable", `expiredTimestamp=null`). The share duration is
 *         a primary-device datum never delivered to a companion — a real
 *         `expires` here is simply unobtainable.
 *       • SENT (from_me=1): `expires` is real. We originate the share in
 *         `sendLiveLocation`, so we know the chosen `durationSecs` and write
 *         `expires = now + durationSecs`.
 *   - `location_key_distribution` — group-live-location sender-key ACK tracking.
 *     NOT wired: Baileys exposes no group-live-location key distribution concept
 *     today, so there's no confident write path — left as schema-only.
 *
 * Note on sending: a companion cannot originate a NATIVE live-location card.
 * Empirically, the server accepts a relayed `liveLocationMessage` (server ack)
 * but does NOT fan it out to the recipient (zero delivery receipt) — the live
 * session it needs is registered only by the primary device. `sendLiveLocation`
 * is kept complete for schema parity + consumer↔consumer rendering; see its doc
 * in messages-send.ts. A plain `locationMessage` IS delivered (static map).
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
	/**
	 * Gateway-only last-activity time (unix seconds) for RECEIVED shares, which
	 * carry no `expires` (companion never gets the duration). Used purely for
	 * retention — a received share with no update within the retention window is
	 * aged out. Orthogonal to `expires`, which keeps its parity meaning. Optional
	 * on write; defaults to 0 (sent rows don't need it — they use `expires`).
	 */
	receivedTs?: number
}

/**
 * Max WhatsApp live-location duration is 8h, so a RECEIVED share whose last
 * update is older than this is definitely over. Used to age out received rows.
 */
const LOCATION_SHARER_RECEIVED_RETENTION_SECS = 8 * 60 * 60
/** Throttle for the opportunistic received-share prune (amortized, from writes). */
const LOCATION_PRUNE_INTERVAL_MS = 60 * 60 * 1000

export class LocationBackend {
	private readonly stmts: {
		upsertLocationCache: SqliteStatementLike
		getLocationCache: SqliteStatementLike
		upsertLocationSharer: SqliteStatementLike
		getLocationSharer: SqliteStatementLike
		listLocationSharers: SqliteStatementLike
		listActiveLocationSharers: SqliteStatementLike
		endLocationSharer: SqliteStatementLike
		pruneStaleReceivedSharers: SqliteStatementLike
	}

	private readonly db: SqliteDbLike
	private readonly retentionSecs: number
	private readonly pruneIntervalMs: number
	private lastPruneAtMs = 0

	constructor(db: SqliteDbLike, opts?: { retentionSecs?: number; pruneIntervalMs?: number }) {
		this.db = db
		this.retentionSecs = opts?.retentionSecs ?? LOCATION_SHARER_RECEIVED_RETENTION_SECS
		this.pruneIntervalMs = opts?.pruneIntervalMs ?? LOCATION_PRUNE_INTERVAL_MS
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
			// `CASE WHEN excluded.expires = 0 …` preserves a real `expires`: a
			// SENT share writes the true expiry (from_me=1), but the own-event
			// replay (emitOwnEvents → upsertMessage → processMessage re-enters the
			// receive mirror) re-upserts the SAME key with `expires=0`. An
			// unconditional overwrite would wipe the duration almost immediately —
			// the whole point of the send path. A received update legitimately
			// only ever carries `expires=0`, so keeping the existing value is safe.
			upsertLocationSharer: this.db.prepare(
				'INSERT INTO location_sharer (remote_jid, from_me, remote_resource, expires, message_id, received_ts) ' +
					'VALUES (?, ?, ?, ?, ?, ?) ' +
					'ON CONFLICT(remote_jid, from_me, remote_resource, message_id) DO UPDATE SET ' +
					'  expires = CASE WHEN excluded.expires = 0 THEN location_sharer.expires ELSE excluded.expires END, ' +
					// Keep the NEWEST activity time — an out-of-order older update must
					// not roll the retention window backwards.
					'  received_ts = MAX(location_sharer.received_ts, excluded.received_ts)'
			),
			getLocationSharer: this.db.prepare(
				'SELECT remote_jid, from_me, remote_resource, expires, message_id FROM location_sharer ' +
					'WHERE remote_jid = ? AND from_me = ? AND remote_resource = ? AND message_id = ?'
			),
			listLocationSharers: this.db.prepare(
				'SELECT remote_jid, from_me, remote_resource, expires, message_id FROM location_sharer'
			),
			// Active = a timed share not yet expired, a SENT open-ended share, OR a
			// RECEIVED open-ended share whose last activity is within the retention
			// window. The retention cutoff applies only to received rows and
			// stops a received share that ended hours ago from showing as active
			// forever (audit #636). Params: (nowSecs, retentionCutoffSecs).
			listActiveLocationSharers: this.db.prepare(
				'SELECT remote_jid, from_me, remote_resource, expires, message_id, received_ts FROM location_sharer ' +
					'WHERE (expires > 0 AND expires > ?) ' +
					'OR (expires = 0 AND from_me = 1) ' +
					'OR (expires = 0 AND from_me = 0 AND received_ts > ?)'
			),
			endLocationSharer: this.db.prepare(
				'DELETE FROM location_sharer WHERE remote_jid = ? AND from_me = ? AND remote_resource = ? AND message_id = ?'
			),
			// Hard-delete received/open-ended shares older than the retention
			// window, so the table stays bounded (received rows never get an
			// explicit end from the companion wire).
			pruneStaleReceivedSharers: this.db.prepare(
				'DELETE FROM location_sharer WHERE from_me = 0 AND expires = 0 AND received_ts <= ?'
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
		this.stmts.upsertLocationSharer.run(
			row.remoteJid,
			row.fromMe,
			row.remoteResource,
			row.expires,
			row.messageId,
			row.receivedTs ?? (row.fromMe === 0 ? Math.floor(Date.now() / 1000) : 0)
		)
		// Opportunistic, throttled retention sweep — keeps received/open-ended
		// shares bounded without a timer. Never throws into the caller.
		this.maybePrune()
	}

	/** Deletes RECEIVED open-ended shares whose last activity is at or before `cutoffSecs`. Returns rows removed. */
	pruneStaleReceivedSharers(cutoffSecs: number): number {
		return this.stmts.pruneStaleReceivedSharers.run(cutoffSecs).changes
	}

	private maybePrune(): void {
		const now = Date.now()
		if (now - this.lastPruneAtMs < this.pruneIntervalMs) {
			return
		}

		try {
			this.pruneStaleReceivedSharers(Math.floor(now / 1000) - this.retentionSecs)
			this.lastPruneAtMs = now
		} catch {
			// Best-effort: a prune failure must never break location recording. Do
			// not advance the throttle so a later write can retry the transient fault.
		}
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

	/**
	 * Sharers still active at `nowSecs` (unix seconds): a timed share not yet
	 * expired, a SENT open-ended share, or a received/open-ended share whose last
	 * activity is within the retention window. Backs `getActiveLiveLocations()`
	 * so it never hands back a share that expired OR (for received shares, which
	 * have no `expires`) ended hours ago (audit #636).
	 */
	listActiveLocationSharers(nowSecs: number): LocationSharerRow[] {
		const cutoff = nowSecs - this.retentionSecs
		const rows = this.stmts.listActiveLocationSharers.all(nowSecs, cutoff) as Array<{
			remote_jid: string
			from_me: number
			remote_resource: string
			expires: number
			message_id: string
			received_ts: number
		}>
		return rows.map(r => ({
			remoteJid: r.remote_jid,
			fromMe: r.from_me,
			remoteResource: r.remote_resource,
			expires: r.expires,
			messageId: r.message_id,
			receivedTs: r.received_ts
		}))
	}

	endLocationSharer(remoteJid: string, fromMe: number, remoteResource: string, messageId: string): boolean {
		const r = this.stmts.endLocationSharer.run(remoteJid, fromMe, remoteResource, messageId)
		return r.changes > 0
	}
}
