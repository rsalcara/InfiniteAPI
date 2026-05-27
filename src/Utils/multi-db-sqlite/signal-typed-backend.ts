/**
 * Phase 9.5 — typed Signal Protocol backend that migrates the opaque
 * `signal_kv(type, id, value)` rows in `axolotl.db` into their typed
 * counterparts (`sessions`, `prekeys`, `signed_prekeys`,
 * `kyber_prekeys`, `identities`, `sender_keys`).
 *
 * The opaque `signal_kv` table stays in place — it acts as a staging
 * surface for any signal data type whose libsignal-side integration
 * has not yet been migrated. The typed tables are addressable directly
 * by callers that have rewired their persistence layer; everything
 * else continues to use the staging area.
 *
 * Why a backend instead of a wrapper around the existing key store?
 *   The typed tables have natural keys that don't fit a `(type, id)`
 *   tuple cleanly:
 *     - `sessions` is keyed by `(device_id, recipient_account_id,
 *       recipient_account_type, session_type, session_scope)` — a 5-tuple
 *       that needs structured access, not a single opaque id string.
 *     - `sender_keys` is keyed by `(group_id, device_id, sender_account_id,
 *       sender_account_type)` — 4 fields.
 *     - `identities` is dual-stored by `(recipient_id, recipient_type,
 *       device_id)` — 3 fields with the LID/PN type column meaningful.
 *   The wrapper pattern from phase 9.1 worked because LID mapping is a
 *   simple key->value relation; the typed Signal tables need first-class
 *   structured operations.
 *
 * Migration sequencing:
 *   - Skeleton (this commit) — typed backend ships with insert + select
 *     primitives; opaque signal_kv stays primary.
 *   - Phase 9.5.1 (follow-up) — libsignal-side integration calls these
 *     primitives directly. The opaque signal_kv rows are migrated row by
 *     row into the typed tables, gated behind a version flag in the
 *     creds row so a partial migration is detectable on restart.
 */
import type BetterSqlite3Module from 'better-sqlite3'

type Database = BetterSqlite3Module.Database

export type SignalSessionKey = {
	deviceId: number
	recipientAccountId: string
	recipientAccountType: number
	sessionType?: number
	sessionScope?: number
}

export type SignalIdentityKey = {
	recipientId: number
	recipientType: number
	deviceId?: number | null
}

export type SignalSenderKeyKey = {
	groupId: string
	deviceId: number
	senderAccountId: string
	senderAccountType: number
}

export class SignalTypedBackend {
	private readonly stmts: {
		upsertSession: BetterSqlite3Module.Statement
		selectSession: BetterSqlite3Module.Statement
		deleteSession: BetterSqlite3Module.Statement
		upsertPrekey: BetterSqlite3Module.Statement
		selectPrekey: BetterSqlite3Module.Statement
		deletePrekey: BetterSqlite3Module.Statement
		upsertSignedPrekey: BetterSqlite3Module.Statement
		selectSignedPrekey: BetterSqlite3Module.Statement
		upsertKyberPrekey: BetterSqlite3Module.Statement
		selectKyberPrekey: BetterSqlite3Module.Statement
		upsertIdentity: BetterSqlite3Module.Statement
		selectIdentity: BetterSqlite3Module.Statement
		upsertSenderKey: BetterSqlite3Module.Statement
		selectSenderKey: BetterSqlite3Module.Statement
	}

	constructor(private readonly db: Database) {
		this.stmts = {
			// sessions: unique index on (device_id, recipient_account_id, recipient_account_type, session_type, session_scope)
			upsertSession: db.prepare(
				'INSERT INTO sessions (device_id, recipient_account_id, recipient_account_type, ' +
					'session_type, session_scope, record, timestamp) ' +
					'VALUES (?, ?, ?, ?, ?, ?, ?) ' +
					'ON CONFLICT(device_id, recipient_account_id, recipient_account_type, session_type, session_scope) ' +
					'DO UPDATE SET record = excluded.record, timestamp = excluded.timestamp'
			),
			selectSession: db.prepare(
				'SELECT record, timestamp FROM sessions ' +
					'WHERE device_id = ? AND recipient_account_id = ? AND recipient_account_type = ? ' +
					'AND session_type = ? AND session_scope = ?'
			),
			deleteSession: db.prepare(
				'DELETE FROM sessions ' +
					'WHERE device_id = ? AND recipient_account_id = ? AND recipient_account_type = ? ' +
					'AND session_type = ? AND session_scope = ?'
			),
			upsertPrekey: db.prepare(
				'INSERT INTO prekeys (prekey_id, record, key_type) VALUES (?, ?, ?) ' +
					'ON CONFLICT(prekey_id) DO UPDATE SET record = excluded.record'
			),
			selectPrekey: db.prepare('SELECT record FROM prekeys WHERE prekey_id = ?'),
			deletePrekey: db.prepare('DELETE FROM prekeys WHERE prekey_id = ?'),
			upsertSignedPrekey: db.prepare(
				'INSERT INTO signed_prekeys (prekey_id, record, timestamp, key_type) VALUES (?, ?, ?, ?) ' +
					'ON CONFLICT(prekey_id) DO UPDATE SET record = excluded.record, timestamp = excluded.timestamp'
			),
			selectSignedPrekey: db.prepare('SELECT record, timestamp FROM signed_prekeys WHERE prekey_id = ?'),
			upsertKyberPrekey: db.prepare(
				'INSERT INTO kyber_prekeys (prekey_id, record, last_resort_key) VALUES (?, ?, ?) ' +
					'ON CONFLICT(prekey_id) DO UPDATE SET record = excluded.record'
			),
			selectKyberPrekey: db.prepare('SELECT record, last_resort_key FROM kyber_prekeys WHERE prekey_id = ?'),
			upsertIdentity: db.prepare(
				'INSERT INTO identities (recipient_id, recipient_type, device_id, public_key, timestamp) ' +
					'VALUES (?, ?, ?, ?, ?) ' +
					'ON CONFLICT(recipient_id, recipient_type, device_id) ' +
					'DO UPDATE SET public_key = excluded.public_key, timestamp = excluded.timestamp'
			),
			selectIdentity: db.prepare(
				'SELECT public_key, timestamp FROM identities ' +
					'WHERE recipient_id = ? AND recipient_type = ? AND device_id IS ?'
			),
			upsertSenderKey: db.prepare(
				'INSERT INTO sender_keys (group_id, device_id, sender_account_id, sender_account_type, record, timestamp) ' +
					'VALUES (?, ?, ?, ?, ?, ?) ' +
					'ON CONFLICT(group_id, device_id, sender_account_id, sender_account_type) ' +
					'DO UPDATE SET record = excluded.record, timestamp = excluded.timestamp'
			),
			selectSenderKey: db.prepare(
				'SELECT record, timestamp FROM sender_keys ' +
					'WHERE group_id = ? AND device_id = ? AND sender_account_id = ? AND sender_account_type = ?'
			)
		}
	}

	// ============ sessions ============

	putSession(key: SignalSessionKey, record: Buffer | Uint8Array, timestamp: number = Date.now()): void {
		this.stmts.upsertSession.run(
			key.deviceId,
			key.recipientAccountId,
			key.recipientAccountType,
			key.sessionType ?? 0,
			key.sessionScope ?? 0,
			record,
			timestamp
		)
	}

	getSession(key: SignalSessionKey): { record: Buffer; timestamp: number } | null {
		const row = this.stmts.selectSession.get(
			key.deviceId,
			key.recipientAccountId,
			key.recipientAccountType,
			key.sessionType ?? 0,
			key.sessionScope ?? 0
		) as { record: Buffer; timestamp: number } | undefined
		return row ?? null
	}

	deleteSession(key: SignalSessionKey): boolean {
		const r = this.stmts.deleteSession.run(
			key.deviceId,
			key.recipientAccountId,
			key.recipientAccountType,
			key.sessionType ?? 0,
			key.sessionScope ?? 0
		)
		return r.changes > 0
	}

	// ============ prekeys ============

	putPrekey(prekeyId: number, record: Buffer | Uint8Array, keyType: number = 0): void {
		this.stmts.upsertPrekey.run(prekeyId, record, keyType)
	}

	getPrekey(prekeyId: number): Buffer | null {
		const r = this.stmts.selectPrekey.get(prekeyId) as { record: Buffer } | undefined
		return r?.record ?? null
	}

	deletePrekey(prekeyId: number): boolean {
		return this.stmts.deletePrekey.run(prekeyId).changes > 0
	}

	// ============ signed prekeys ============

	putSignedPrekey(prekeyId: number, record: Buffer | Uint8Array, timestamp: number = Date.now(), keyType: number = 0): void {
		this.stmts.upsertSignedPrekey.run(prekeyId, record, timestamp, keyType)
	}

	getSignedPrekey(prekeyId: number): { record: Buffer; timestamp: number } | null {
		const r = this.stmts.selectSignedPrekey.get(prekeyId) as
			| { record: Buffer; timestamp: number }
			| undefined
		return r ?? null
	}

	// ============ kyber prekeys ============

	putKyberPrekey(prekeyId: number, record: Buffer | Uint8Array, lastResortKey: boolean = false): void {
		this.stmts.upsertKyberPrekey.run(prekeyId, record, lastResortKey ? 1 : 0)
	}

	getKyberPrekey(prekeyId: number): { record: Buffer; lastResortKey: boolean } | null {
		const r = this.stmts.selectKyberPrekey.get(prekeyId) as
			| { record: Buffer; last_resort_key: number }
			| undefined
		if (!r) return null
		return { record: r.record, lastResortKey: r.last_resort_key === 1 }
	}

	// ============ identities (dual LID + PN) ============

	putIdentity(key: SignalIdentityKey, publicKey: Buffer | Uint8Array, timestamp: number = Date.now()): void {
		this.stmts.upsertIdentity.run(
			key.recipientId,
			key.recipientType,
			key.deviceId ?? null,
			publicKey,
			timestamp
		)
	}

	getIdentity(key: SignalIdentityKey): { publicKey: Buffer; timestamp: number } | null {
		const r = this.stmts.selectIdentity.get(
			key.recipientId,
			key.recipientType,
			key.deviceId ?? null
		) as { public_key: Buffer; timestamp: number } | undefined
		if (!r) return null
		return { publicKey: r.public_key, timestamp: r.timestamp }
	}

	// ============ sender keys ============

	putSenderKey(key: SignalSenderKeyKey, record: Buffer | Uint8Array, timestamp: number = Date.now()): void {
		this.stmts.upsertSenderKey.run(
			key.groupId,
			key.deviceId,
			key.senderAccountId,
			key.senderAccountType,
			record,
			timestamp
		)
	}

	getSenderKey(key: SignalSenderKeyKey): { record: Buffer; timestamp: number } | null {
		const r = this.stmts.selectSenderKey.get(
			key.groupId,
			key.deviceId,
			key.senderAccountId,
			key.senderAccountType
		) as { record: Buffer; timestamp: number } | undefined
		return r ?? null
	}
}
