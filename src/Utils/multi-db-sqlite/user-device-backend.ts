/**
 * Phase 9.2 — typed `user_device` + `user_device_info` + `primary_device_version`
 * SQLite-backed storage for the device-list cache.
 *
 * Replaces the in-RAM `userDevicesCache` (Map<userJid, { devices, expiry }>)
 * with the canonical mobile schema. The native `expected_timestamp` column
 * in `user_device_info` gives us a TTL value without an application-level
 * eviction loop — call sites can read the column and decide whether to
 * refetch in the same query.
 *
 * Storage model:
 *   - `user_device`: one row per (user, device) pair, with the original
 *     `key_index` preserved (the index ADV uses to address the device key
 *     in the registration).
 *   - `user_device_info`: per-user metadata — `raw_id` (numeric WhatsApp
 *     device list version), `timestamp` (last refresh time), and
 *     `expected_timestamp` (the freshness target). When `now > expected_ts`
 *     the caller should refetch.
 *   - `primary_device_version`: short-circuit cache. If `version` matches
 *     the server-reported one we know the device list is still current and
 *     skip the refetch entirely.
 */
import type { SqliteDbLike, SqliteStatementLike } from './types'

/**
 * Resolved device record returned by lookups.
 *
 * `userJidRowId` and `deviceJidRowId` are the row IDs in the local `jid`
 * table. Caller-side resolution to raw JIDs (e.g. `user@s.whatsapp.net.X`)
 * happens via the `jid` table join (the {@link JidMapBackend.rowIdFor}
 * helper materializes rows on insert).
 */
export type StoredDeviceRow = {
	userJidRowId: number
	deviceJidRowId: number
	keyIndex: number
}

/**
 * Typed operations on `msgstore.db` user device tables.
 */
export class UserDeviceBackend {
	private readonly stmts: {
		insertDevice: SqliteStatementLike
		deleteByUser: SqliteStatementLike
		selectByUser: SqliteStatementLike
		upsertInfo: SqliteStatementLike
		selectInfo: SqliteStatementLike
		upsertPrimaryVersion: SqliteStatementLike
		selectPrimaryVersion: SqliteStatementLike
	}

	private readonly db: SqliteDbLike

	constructor(db: SqliteDbLike) {
		this.db = db
		this.stmts = {
			insertDevice: this.db.prepare(
				'INSERT INTO user_device (user_jid_row_id, device_jid_row_id, key_index) VALUES (?, ?, ?)'
			),
			deleteByUser: this.db.prepare('DELETE FROM user_device WHERE user_jid_row_id = ?'),
			selectByUser: this.db.prepare(
				'SELECT user_jid_row_id, device_jid_row_id, key_index FROM user_device WHERE user_jid_row_id = ?'
			),
			upsertInfo: this.db.prepare(
				'INSERT INTO user_device_info (user_jid_row_id, raw_id, timestamp, expected_timestamp) ' +
					'VALUES (?, ?, ?, ?) ' +
					'ON CONFLICT(user_jid_row_id) DO UPDATE SET ' +
					'  raw_id = excluded.raw_id, timestamp = excluded.timestamp, expected_timestamp = excluded.expected_timestamp'
			),
			selectInfo: this.db.prepare(
				'SELECT user_jid_row_id, raw_id, timestamp, expected_timestamp FROM user_device_info ' +
					'WHERE user_jid_row_id = ?'
			),
			upsertPrimaryVersion: this.db.prepare(
				'INSERT INTO primary_device_version (user_jid_row_id, version) VALUES (?, ?) ' +
					'ON CONFLICT(user_jid_row_id) DO UPDATE SET version = excluded.version'
			),
			selectPrimaryVersion: this.db.prepare('SELECT version FROM primary_device_version WHERE user_jid_row_id = ?')
		}
	}

	/**
	 * Replace the device set for a user. Atomic: deletes old rows + inserts
	 * the new set + updates info in a single transaction.
	 */
	replaceDevices(
		userJidRowId: number,
		devices: ReadonlyArray<{ deviceJidRowId: number; keyIndex?: number }>,
		info: { rawId: number; timestamp: number; expectedTimestamp: number }
	): void {
		this.db.transaction(() => {
			this.stmts.deleteByUser.run(userJidRowId)
			for (const d of devices) {
				this.stmts.insertDevice.run(userJidRowId, d.deviceJidRowId, d.keyIndex ?? 0)
			}

			this.stmts.upsertInfo.run(userJidRowId, info.rawId, info.timestamp, info.expectedTimestamp)
		})()
	}

	/** Returns all device rows for a user (empty array if none). */
	listDevices(userJidRowId: number): StoredDeviceRow[] {
		const rows = this.stmts.selectByUser.all(userJidRowId) as Array<{
			user_jid_row_id: number
			device_jid_row_id: number
			key_index: number
		}>
		return rows.map(r => ({
			userJidRowId: r.user_jid_row_id,
			deviceJidRowId: r.device_jid_row_id,
			keyIndex: r.key_index
		}))
	}

	/**
	 * Returns the info row for a user (timestamp + expected_timestamp +
	 * raw_id), or `null` if no entry exists. Callers compare `now` against
	 * `expected_timestamp` to decide whether to refetch.
	 */
	getInfo(userJidRowId: number): {
		rawId: number
		timestamp: number
		expectedTimestamp: number | null
	} | null {
		const row = this.stmts.selectInfo.get(userJidRowId) as
			| {
					raw_id: number
					timestamp: number
					expected_timestamp: number | null
			  }
			| undefined
		if (!row) return null
		return {
			rawId: row.raw_id,
			timestamp: row.timestamp,
			expectedTimestamp: row.expected_timestamp
		}
	}

	/**
	 * Returns `true` if the cached device list is still fresh by the
	 * `expected_timestamp` policy (i.e. `now <= expected_timestamp`). False
	 * if expired or absent.
	 */
	isFresh(userJidRowId: number, now: number = Date.now()): boolean {
		const info = this.getInfo(userJidRowId)
		if (info?.expectedTimestamp === null || info?.expectedTimestamp === undefined) return false
		return now <= info.expectedTimestamp
	}

	/**
	 * Bumps the per-user `primary_device_version` short-circuit. If the
	 * server reports the same version on the next sync, the caller can skip
	 * refetching the full device list.
	 */
	setPrimaryDeviceVersion(userJidRowId: number, version: number): void {
		this.stmts.upsertPrimaryVersion.run(userJidRowId, version)
	}

	/** Returns the cached primary device version, or `null` if unknown. */
	getPrimaryDeviceVersion(userJidRowId: number): number | null {
		const row = this.stmts.selectPrimaryVersion.get(userJidRowId) as { version: number } | undefined
		return row?.version ?? null
	}
}
