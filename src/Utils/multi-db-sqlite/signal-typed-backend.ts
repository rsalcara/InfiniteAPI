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
import type { SqliteDbLike, SqliteStatementLike } from './types'

/**
 * Sentinel `device_id` for identities that arrive without an explicit
 * device. SQLite treats NULLs as distinct under UNIQUE, so storing NULL
 * in `device_id` would let multiple "no-device" identity rows for the
 * same recipient slip past the `identities_idx` constraint and surface
 * stale keys from `getIdentity`. Using 0 — the value the canonical
 * mobile schema also uses — keeps the conflict target meaningful.
 */
const IDENTITY_DEVICE_ID_SENTINEL = 0

/**
 * Sentinel `recipient_id` for a message-base-key row whose recipient jid row
 * id isn't resolved at the retry site. Same NULL-distinct-under-UNIQUE reason
 * as {@link IDENTITY_DEVICE_ID_SENTINEL}: the `message_base_key_idx` unique
 * index includes `recipient_id`, so `0` (not NULL) keeps the conflict target
 * meaningful and lets the upsert/delete dedupe by natural key.
 */
const MESSAGE_BASE_KEY_RECIPIENT_SENTINEL = 0

const toBuf = (v: Buffer | Uint8Array): Buffer => (Buffer.isBuffer(v) ? v : Buffer.from(v))

/**
 * A raw stanza held in `unordered_stanza_queue` because it could not be
 * processed in order yet. Keyed by `stanzaId` (the message id) — the UNIQUE
 * `stanza_key` BLOB is derived from it so enqueue and delete agree on the key
 * without the caller threading a second value.
 */
export type UnorderedStanzaRow = {
	stanzaId: string
	stanzaClass?: number
	stanzaType?: number
	stanzaPayload: Buffer | Uint8Array
	protobuf?: Buffer | Uint8Array | null
	decryptMetadata?: Buffer | Uint8Array | null
	chatType?: number | null
	chatJid?: string | null
	senderJid?: string | null
	timeSec?: number
	createTimeMs?: number
	processCount?: number
}

export type SignalMessageBaseKey = {
	remoteJid: string
	fromMe: boolean
	msgId: string
	recipientId?: number | null
	recipientType?: number
	deviceId?: number
}

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
		upsertSession: SqliteStatementLike
		selectSession: SqliteStatementLike
		deleteSession: SqliteStatementLike
		upsertPrekey: SqliteStatementLike
		selectPrekey: SqliteStatementLike
		deletePrekey: SqliteStatementLike
		upsertSignedPrekey: SqliteStatementLike
		selectSignedPrekey: SqliteStatementLike
		upsertKyberPrekey: SqliteStatementLike
		selectKyberPrekey: SqliteStatementLike
		upsertIdentity: SqliteStatementLike
		selectIdentity: SqliteStatementLike
		upsertSenderKey: SqliteStatementLike
		selectSenderKey: SqliteStatementLike
		deleteSenderKey: SqliteStatementLike
		deleteIdentity: SqliteStatementLike
		insertPrekeyUpload: SqliteStatementLike
		upsertMessageBaseKey: SqliteStatementLike
		deleteMessageBaseKey: SqliteStatementLike
		selectMessageBaseKey: SqliteStatementLike
		clearMessageBaseKeys: SqliteStatementLike
		enqueueUnorderedStanza: SqliteStatementLike
		deleteUnorderedStanza: SqliteStatementLike
		clearUnorderedStanzas: SqliteStatementLike
		insertPreack: SqliteStatementLike
		drainPreacksUpTo: SqliteStatementLike
		clearPreacks: SqliteStatementLike
	}

	private readonly db: SqliteDbLike

	constructor(db: SqliteDbLike) {
		this.db = db
		this.stmts = {
			// sessions: unique index on (device_id, recipient_account_id, recipient_account_type, session_type, session_scope)
			upsertSession: this.db.prepare(
				'INSERT INTO sessions (device_id, recipient_account_id, recipient_account_type, ' +
					'session_type, session_scope, record, timestamp) ' +
					'VALUES (?, ?, ?, ?, ?, ?, ?) ' +
					'ON CONFLICT(device_id, recipient_account_id, recipient_account_type, session_type, session_scope) ' +
					'DO UPDATE SET record = excluded.record, timestamp = excluded.timestamp'
			),
			selectSession: this.db.prepare(
				'SELECT record, timestamp FROM sessions ' +
					'WHERE device_id = ? AND recipient_account_id = ? AND recipient_account_type = ? ' +
					'AND session_type = ? AND session_scope = ?'
			),
			deleteSession: this.db.prepare(
				'DELETE FROM sessions ' +
					'WHERE device_id = ? AND recipient_account_id = ? AND recipient_account_type = ? ' +
					'AND session_type = ? AND session_scope = ?'
			),
			upsertPrekey: this.db.prepare(
				'INSERT INTO prekeys (prekey_id, record, key_type) VALUES (?, ?, ?) ' +
					'ON CONFLICT(prekey_id) DO UPDATE SET record = excluded.record'
			),
			selectPrekey: this.db.prepare('SELECT record FROM prekeys WHERE prekey_id = ?'),
			deletePrekey: this.db.prepare('DELETE FROM prekeys WHERE prekey_id = ?'),
			upsertSignedPrekey: this.db.prepare(
				'INSERT INTO signed_prekeys (prekey_id, record, timestamp, key_type) VALUES (?, ?, ?, ?) ' +
					'ON CONFLICT(prekey_id) DO UPDATE SET ' +
					'record = excluded.record, timestamp = excluded.timestamp, key_type = excluded.key_type'
			),
			selectSignedPrekey: this.db.prepare('SELECT record, timestamp FROM signed_prekeys WHERE prekey_id = ?'),
			upsertKyberPrekey: this.db.prepare(
				// Conflict update covers BOTH `record` AND `last_resort_key` so a
				// caller re-saving the same prekey id with a flipped flag (e.g.
				// promoting a one-time key into the last-resort slot) gets that
				// change reflected on the next `getKyberPrekey()` call. Earlier
				// versions only updated `record`, which let the stored flag
				// drift from the latest caller input.
				'INSERT INTO kyber_prekeys (prekey_id, record, last_resort_key) VALUES (?, ?, ?) ' +
					'ON CONFLICT(prekey_id) DO UPDATE SET ' +
					'  record = excluded.record, last_resort_key = excluded.last_resort_key'
			),
			selectKyberPrekey: this.db.prepare('SELECT record, last_resort_key FROM kyber_prekeys WHERE prekey_id = ?'),
			upsertIdentity: this.db.prepare(
				'INSERT INTO identities (recipient_id, recipient_type, device_id, public_key, timestamp) ' +
					'VALUES (?, ?, ?, ?, ?) ' +
					'ON CONFLICT(recipient_id, recipient_type, device_id) ' +
					'DO UPDATE SET public_key = excluded.public_key, timestamp = excluded.timestamp'
			),
			selectIdentity: this.db.prepare(
				// `device_id = ?` (not `IS ?`) because `putIdentity` coerces a
				// missing/null device id to the IDENTITY_DEVICE_ID_SENTINEL
				// (0) before insert. Keeping `IS ?` here together with the
				// coerced INSERT would mean a select with `deviceId: null`
				// never finds the row even though the row exists.
				'SELECT public_key, timestamp FROM identities ' +
					'WHERE recipient_id = ? AND recipient_type = ? AND device_id = ?'
			),
			upsertSenderKey: this.db.prepare(
				'INSERT INTO sender_keys (group_id, device_id, sender_account_id, sender_account_type, record, timestamp) ' +
					'VALUES (?, ?, ?, ?, ?, ?) ' +
					'ON CONFLICT(group_id, device_id, sender_account_id, sender_account_type) ' +
					'DO UPDATE SET record = excluded.record, timestamp = excluded.timestamp'
			),
			selectSenderKey: this.db.prepare(
				'SELECT record, timestamp FROM sender_keys ' +
					'WHERE group_id = ? AND device_id = ? AND sender_account_id = ? AND sender_account_type = ?'
			),
			deleteSenderKey: this.db.prepare(
				'DELETE FROM sender_keys ' +
					'WHERE group_id = ? AND device_id = ? AND sender_account_id = ? AND sender_account_type = ?'
			),
			deleteIdentity: this.db.prepare(
				'DELETE FROM identities WHERE recipient_id = ? AND recipient_type = ? AND device_id = ?'
			),
			// prekey_uploads: append-only log of pre-key upload batches to the
			// server (upload_timestamp + key_type), one row per upload.
			insertPrekeyUpload: this.db.prepare('INSERT INTO prekey_uploads (upload_timestamp, key_type) VALUES (?, ?)'),
			// message_base_key: per-message ratchet anchor for retry re-derivation.
			// Natural key matches the mobile unique index; DELETE-on-ack mirrors
			// the captured WhatsApp behavior.
			upsertMessageBaseKey: this.db.prepare(
				'INSERT INTO message_base_key (msg_key_remote_jid, msg_key_from_me, msg_key_id, recipient_id, ' +
					'recipient_type, device_id, last_alice_base_key, timestamp) VALUES (?, ?, ?, ?, ?, ?, ?, ?) ' +
					'ON CONFLICT(msg_key_remote_jid, msg_key_from_me, msg_key_id, recipient_id, recipient_type, device_id) ' +
					'DO UPDATE SET last_alice_base_key = excluded.last_alice_base_key, timestamp = excluded.timestamp'
			),
			deleteMessageBaseKey: this.db.prepare(
				'DELETE FROM message_base_key WHERE msg_key_remote_jid = ? AND msg_key_from_me = ? AND msg_key_id = ? ' +
					'AND recipient_id IS ? AND recipient_type = ? AND device_id = ?'
			),
			selectMessageBaseKey: this.db.prepare(
				'SELECT last_alice_base_key, timestamp FROM message_base_key WHERE msg_key_remote_jid = ? ' +
					'AND msg_key_from_me = ? AND msg_key_id = ? AND recipient_id IS ? AND recipient_type = ? AND device_id = ?'
			),
			clearMessageBaseKeys: this.db.prepare('DELETE FROM message_base_key'),
			// unordered_stanza_queue: raw stanza held because it could not be
			// processed/decrypted in order yet. `stanza_key` is the UNIQUE dedupe
			// key; re-enqueuing the same stanza bumps `process_count`, folding the
			// mobile INSERT-then-UPDATE(process_count) steps into one upsert.
			enqueueUnorderedStanza: this.db.prepare(
				'INSERT INTO unordered_stanza_queue (stanza_id, stanza_key, stanza_class, stanza_type, stanza_payload, ' +
					'protobuf, decrypt_metadata, chat_type, chat_jid, sender_jid, time_sec, create_time_ms, process_count) ' +
					'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ' +
					'ON CONFLICT(stanza_key) DO UPDATE SET process_count = process_count + 1'
			),
			deleteUnorderedStanza: this.db.prepare('DELETE FROM unordered_stanza_queue WHERE stanza_key = ?'),
			clearUnorderedStanzas: this.db.prepare('DELETE FROM unordered_stanza_queue'),
			// preacks: append-only buffer of pending pre-acknowledgements (`ptn`
			// blob). Drained by contiguous `_id` prefix, matching the mobile
			// `DELETE ... WHERE _id <= ?`.
			insertPreack: this.db.prepare('INSERT INTO preacks (ptn) VALUES (?)'),
			drainPreacksUpTo: this.db.prepare('DELETE FROM preacks WHERE _id <= ?'),
			clearPreacks: this.db.prepare('DELETE FROM preacks')
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

	putPrekey(prekeyId: number, record: Buffer | Uint8Array, keyType = 0): void {
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

	putSignedPrekey(prekeyId: number, record: Buffer | Uint8Array, timestamp: number = Date.now(), keyType = 0): void {
		this.stmts.upsertSignedPrekey.run(prekeyId, record, timestamp, keyType)
	}

	getSignedPrekey(prekeyId: number): { record: Buffer; timestamp: number } | null {
		const r = this.stmts.selectSignedPrekey.get(prekeyId) as { record: Buffer; timestamp: number } | undefined
		return r ?? null
	}

	// ============ kyber prekeys ============

	putKyberPrekey(prekeyId: number, record: Buffer | Uint8Array, lastResortKey = false): void {
		this.stmts.upsertKyberPrekey.run(prekeyId, record, lastResortKey ? 1 : 0)
	}

	getKyberPrekey(prekeyId: number): { record: Buffer; lastResortKey: boolean } | null {
		const r = this.stmts.selectKyberPrekey.get(prekeyId) as { record: Buffer; last_resort_key: number } | undefined
		if (!r) return null
		return { record: r.record, lastResortKey: r.last_resort_key === 1 }
	}

	// ============ identities (dual LID + PN) ============

	putIdentity(key: SignalIdentityKey, publicKey: Buffer | Uint8Array, timestamp: number = Date.now()): void {
		// Coerce missing/null deviceId to the IDENTITY_DEVICE_ID_SENTINEL so
		// ON CONFLICT(recipient_id, recipient_type, device_id) actually fires
		// for "no-device" identities. SQLite considers two NULLs distinct
		// under UNIQUE, so a NULL device_id would let repeated saves insert
		// duplicate rows instead of upserting — and `getIdentity` could then
		// return an older key for the same recipient.
		this.stmts.upsertIdentity.run(
			key.recipientId,
			key.recipientType,
			key.deviceId ?? IDENTITY_DEVICE_ID_SENTINEL,
			publicKey,
			timestamp
		)
	}

	getIdentity(key: SignalIdentityKey): { publicKey: Buffer; timestamp: number } | null {
		const r = this.stmts.selectIdentity.get(
			key.recipientId,
			key.recipientType,
			key.deviceId ?? IDENTITY_DEVICE_ID_SENTINEL
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
		const r = this.stmts.selectSenderKey.get(key.groupId, key.deviceId, key.senderAccountId, key.senderAccountType) as
			| { record: Buffer; timestamp: number }
			| undefined
		return r ?? null
	}

	deleteSenderKey(key: SignalSenderKeyKey): boolean {
		const r = this.stmts.deleteSenderKey.run(key.groupId, key.deviceId, key.senderAccountId, key.senderAccountType)
		return r.changes > 0
	}

	deleteIdentity(key: SignalIdentityKey): boolean {
		const r = this.stmts.deleteIdentity.run(
			key.recipientId,
			key.recipientType,
			key.deviceId ?? IDENTITY_DEVICE_ID_SENTINEL
		)
		return r.changes > 0
	}

	// ============ prekey_uploads ============

	/** Appends one pre-key upload-batch record (upload_timestamp + key_type). */
	recordPrekeyUpload(uploadTimestamp: number = Date.now(), keyType = 0): void {
		this.stmts.insertPrekeyUpload.run(uploadTimestamp, keyType)
	}

	// ============ message_base_key ============

	/**
	 * Records the per-message ratchet anchor (last Alice base key) for retry
	 * re-derivation. `recipientId` defaults to a `0` sentinel (not NULL) so the
	 * unique index — which includes it — dedupes properly (SQLite treats NULLs
	 * as distinct). Deleted on ack via {@link deleteMessageBaseKey}, matching
	 * the mobile client.
	 */
	putMessageBaseKey(key: SignalMessageBaseKey, baseKey: Buffer | Uint8Array, timestamp: number = Date.now()): void {
		this.stmts.upsertMessageBaseKey.run(
			key.remoteJid,
			key.fromMe ? 1 : 0,
			key.msgId,
			key.recipientId ?? MESSAGE_BASE_KEY_RECIPIENT_SENTINEL,
			key.recipientType ?? 0,
			key.deviceId ?? 0,
			Buffer.isBuffer(baseKey) ? baseKey : Buffer.from(baseKey),
			timestamp
		)
	}

	deleteMessageBaseKey(key: SignalMessageBaseKey): boolean {
		const r = this.stmts.deleteMessageBaseKey.run(
			key.remoteJid,
			key.fromMe ? 1 : 0,
			key.msgId,
			key.recipientId ?? MESSAGE_BASE_KEY_RECIPIENT_SENTINEL,
			key.recipientType ?? 0,
			key.deviceId ?? 0
		)
		return r.changes > 0
	}

	getMessageBaseKey(key: SignalMessageBaseKey): { baseKey: Buffer; timestamp: number } | null {
		const r = this.stmts.selectMessageBaseKey.get(
			key.remoteJid,
			key.fromMe ? 1 : 0,
			key.msgId,
			key.recipientId ?? MESSAGE_BASE_KEY_RECIPIENT_SENTINEL,
			key.recipientType ?? 0,
			key.deviceId ?? 0
		) as { last_alice_base_key: Buffer; timestamp: number } | undefined
		return r ? { baseKey: r.last_alice_base_key, timestamp: r.timestamp } : null
	}

	/** Wipes every message_base_key row (socket close — the in-memory cache is gone). */
	clearMessageBaseKeys(): void {
		this.stmts.clearMessageBaseKeys.run()
	}

	// ============ unordered_stanza_queue ============

	/**
	 * Records a stanza that could not be processed in order yet (best-effort
	 * mirror of the mobile out-of-order holding pen). Re-enqueuing the same
	 * `stanzaId` bumps `process_count` instead of inserting a duplicate — the
	 * `stanza_key` UNIQUE column is derived from `stanzaId`.
	 */
	enqueueUnorderedStanza(row: UnorderedStanzaRow): void {
		this.stmts.enqueueUnorderedStanza.run(
			row.stanzaId,
			Buffer.from(row.stanzaId),
			row.stanzaClass ?? 0,
			row.stanzaType ?? 0,
			toBuf(row.stanzaPayload),
			row.protobuf ? toBuf(row.protobuf) : null,
			row.decryptMetadata ? toBuf(row.decryptMetadata) : null,
			row.chatType ?? null,
			row.chatJid ?? null,
			row.senderJid ?? null,
			row.timeSec ?? Math.floor(Date.now() / 1000),
			row.createTimeMs ?? Date.now(),
			row.processCount ?? 1
		)
	}

	/** Drops a held stanza once it is finally processed (retry resolved/failed). */
	deleteUnorderedStanza(msgId: string): boolean {
		return this.stmts.deleteUnorderedStanza.run(Buffer.from(msgId)).changes > 0
	}

	/** Wipes every held stanza (socket close). */
	clearUnorderedStanzas(): void {
		this.stmts.clearUnorderedStanzas.run()
	}

	// ============ preacks ============

	/**
	 * Appends one pending pre-acknowledgement (`ptn` blob) before the ack is
	 * flushed to the server. Returns the row id so the caller can drain the
	 * contiguous prefix with {@link drainPreacksUpTo} once the ack is sent.
	 *
	 * Wired from `sendMessageAck` for message-class stanzas: INSERT before
	 * `sendNode`, drain after — mirroring the mobile pre-ack buffer and giving
	 * the same crash-safety (a pre-ack persisted but not yet sent survives a
	 * restart). Best-effort: a mirror failure never blocks the ack itself.
	 */
	enqueuePreack(ptn: Buffer | Uint8Array): number {
		return Number(this.stmts.insertPreack.run(toBuf(ptn)).lastInsertRowid)
	}

	/** Drains the contiguous prefix `_id <= id`, mirroring the mobile drain. */
	drainPreacksUpTo(id: number): number {
		return this.stmts.drainPreacksUpTo.run(id).changes
	}

	/** Wipes every buffered pre-ack (socket close). */
	clearPreacks(): void {
		this.stmts.clearPreacks.run()
	}
}
