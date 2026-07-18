/**
 * Typed Signal Protocol backend that migrates the opaque
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
 *   The wrapper pattern worked for LID mapping because it is a
 *   simple key->value relation; the typed Signal tables need first-class
 *   structured operations.
 *
 * For the mirrored Signal types, the auth-state integration uses these tables
 * as its primary read/write surface and atomically keeps `signal_kv` as a
 * compatibility fallback for pre-migration rows. Other Signal data types
 * continue to use `signal_kv` directly.
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

/** Keep every statement below SQLite's default 999-variable ceiling. */
const SQLITE_VARIABLE_LIMIT = 999

const queryTupleChunks = <Key, Row>(
	db: SqliteDbLike,
	statementCache: Map<number, SqliteStatementLike>,
	keys: ReadonlyArray<Key>,
	tupleWidth: number,
	sqlBeforeValues: string,
	valuesForKey: (key: Key) => ReadonlyArray<unknown>
): Row[] => {
	if (keys.length === 0) return []
	const chunkSize = Math.floor(SQLITE_VARIABLE_LIMIT / tupleWidth)
	const rows: Row[] = []

	for (let offset = 0; offset < keys.length; offset += chunkSize) {
		const chunk = keys.slice(offset, offset + chunkSize)
		let statement = statementCache.get(chunk.length)
		if (!statement) {
			const tuple = `(${new Array(tupleWidth).fill('?').join(', ')})`
			statement = db.prepare(`${sqlBeforeValues}${new Array(chunk.length).fill(tuple).join(', ')})`)
			statementCache.set(chunk.length, statement)
		}

		const params: unknown[] = []
		for (const key of chunk) params.push(...valuesForKey(key))
		rows.push(...(statement.all(...params) as Row[]))
	}

	return rows
}

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
		markPrekeysUploaded: SqliteStatementLike
		reservePrekeyUploadRange: SqliteStatementLike
		markPrekeyDirectDistribution: SqliteStatementLike
		selectPrekeyDirectDistribution: SqliteStatementLike
		countUnsentPrekeys: SqliteStatementLike
		firstUnsentPrekeyId: SqliteStatementLike
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
		deletePreack: SqliteStatementLike
		drainPreacksUpTo: SqliteStatementLike
		clearPreacks: SqliteStatementLike
	}

	private readonly db: SqliteDbLike
	private readonly manySessionStmts = new Map<number, SqliteStatementLike>()
	private readonly manyPrekeyStmts = new Map<number, SqliteStatementLike>()
	private readonly manyIdentityStmts = new Map<number, SqliteStatementLike>()
	private readonly manySenderKeyStmts = new Map<number, SqliteStatementLike>()

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
				// `sent_to_server = 0` + `direct_distribution = 0` on INSERT mirror
				// WhatsApp Android's SignalPreKeyStore exactly: a freshly generated
				// one-time prekey is "not yet uploaded" until the server acks the
				// batch (then `markPrekeysUploaded` flips sent_to_server to 1). The
				// real store selects the upload batch with
				// `WHERE sent_to_server = 0 AND direct_distribution = 0`, so both
				// columns must be a concrete 0 (not NULL) for that predicate to hold.
				// InfiniteAPI never produces direct-distribution prekeys, so it is
				// always 0. The ON CONFLICT clause deliberately updates ONLY `record`
				// — re-putting an existing id must NOT reset an uploaded key to 0.
				'INSERT INTO prekeys (prekey_id, record, key_type, sent_to_server, direct_distribution) ' +
					'VALUES (?, ?, ?, 0, 0) ON CONFLICT(prekey_id) DO UPDATE SET record = excluded.record'
			),
			selectPrekey: this.db.prepare('SELECT record FROM prekeys WHERE prekey_id = ?'),
			deletePrekey: this.db.prepare('DELETE FROM prekeys WHERE prekey_id = ?'),
			// Flip the just-uploaded batch to sent_to_server=1 + upload_timestamp,
			// mirroring WhatsApp Android's per-key upload flag. Range is the
			// half-open [fromId, toId) that the upload IQ carried. Guarded on
			// `sent_to_server = 0` so a re-run (retry that re-uploads the same
			// range) is idempotent and never disturbs already-acked keys.
			markPrekeysUploaded: this.db.prepare(
				'UPDATE prekeys SET sent_to_server = 1, upload_timestamp = ? ' +
					'WHERE prekey_id >= ? AND prekey_id < ? AND (sent_to_server IS NULL OR sent_to_server = 0)'
			),
			// Stamp every key before the upload IQ leaves the process. A non-null
			// timestamp is a durable reservation: after a crash we cannot know whether
			// the server accepted the IQ, so that key must stay on the server-upload
			// path and must never be handed directly to a peer.
			reservePrekeyUploadRange: this.db.prepare(
				'UPDATE prekeys SET upload_timestamp = COALESCE(upload_timestamp, ?) ' +
					'WHERE prekey_id >= ? AND prekey_id < ? ' +
					'AND COALESCE(sent_to_server, 0) = 0 AND COALESCE(direct_distribution, 0) = 0'
			),
			// Direct-distribution path (retry receipt): the real SignalPreKeyStore
			// takes ONE unsent key, flags it `direct_distribution = 1` + stamps
			// `upload_timestamp`, then hands it straight to the peer inline. The flag
			// excludes it from the normal stock/upload queries (which filter
			// `direct_distribution = 0`) so it is never also uploaded to the server
			// pool. `sent_to_server` is intentionally left untouched (the key was
			// delivered peer-to-peer, not acked by the server pool upload IQ).
			markPrekeyDirectDistribution: this.db.prepare(
				'UPDATE prekeys SET direct_distribution = 1, upload_timestamp = ? ' +
					'WHERE prekey_id = ? AND COALESCE(sent_to_server, 0) = 0 ' +
					'AND COALESCE(direct_distribution, 0) = 0 AND upload_timestamp IS NULL'
			),
			selectPrekeyDirectDistribution: this.db.prepare('SELECT direct_distribution FROM prekeys WHERE prekey_id = ?'),
			// A00 / A01 of the real SignalPreKeyStore: the unsent-prekey set IS the
			// upload queue. The mobile store uses `sent_to_server = 0 AND
			// direct_distribution = 0`; we wrap both columns in COALESCE so rows
			// generated BEFORE per-key tracking existed (NULL columns) are treated
			// as unsent instead of vanishing — in SQL `NULL = 0` is not true, which
			// would otherwise hide every legacy orphan from the self-heal. The
			// conservative choice is deliberate: a NULL row is indistinguishable
			// from an orphan, so we re-send it (the server dedups by prekey_id)
			// rather than trust a possibly-drifted cursor and risk hiding a key the
			// server never received.
			countUnsentPrekeys: this.db.prepare(
				'SELECT COUNT(*) AS count FROM prekeys WHERE COALESCE(sent_to_server, 0) = 0 AND COALESCE(direct_distribution, 0) = 0'
			),
			firstUnsentPrekeyId: this.db.prepare(
				'SELECT MIN(prekey_id) AS id FROM prekeys WHERE COALESCE(sent_to_server, 0) = 0 AND COALESCE(direct_distribution, 0) = 0'
			),
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
			// blob). Each ack drops its OWN row by exact `_id` once sent
			// (`deletePreack`); `drainPreacksUpTo` keeps the mobile prefix-drain
			// (`DELETE ... WHERE _id <= ?`) for a future startup/batch drain.
			insertPreack: this.db.prepare('INSERT INTO preacks (ptn) VALUES (?)'),
			deletePreack: this.db.prepare('DELETE FROM preacks WHERE _id = ?'),
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

	/**
	 * Batched {@link getSession}: one row-value `IN` query for N keys instead of
	 * N point lookups. Returns each hit with its key columns so the caller can
	 * map rows back to its original ids; misses are simply absent. The
	 * (session_type, session_scope) pair is matched per-key exactly like the
	 * single get.
	 */
	getManySessions(keys: ReadonlyArray<SignalSessionKey>): Array<{
		device_id: number
		recipient_account_id: string
		recipient_account_type: number
		record: Buffer
	}> {
		return queryTupleChunks<
			SignalSessionKey,
			{
				device_id: number
				recipient_account_id: string
				recipient_account_type: number
				record: Buffer
			}
		>(
			this.db,
			this.manySessionStmts,
			keys,
			5,
			'SELECT device_id, recipient_account_id, recipient_account_type, record FROM sessions ' +
				'WHERE (device_id, recipient_account_id, recipient_account_type, session_type, session_scope) IN (VALUES ',
			key => [
				key.deviceId,
				key.recipientAccountId,
				key.recipientAccountType,
				key.sessionType ?? 0,
				key.sessionScope ?? 0
			]
		)
	}

	// ============ prekeys ============

	putPrekey(prekeyId: number, record: Buffer | Uint8Array, keyType = 0): void {
		this.stmts.upsertPrekey.run(prekeyId, record, keyType)
	}

	/**
	 * Marks the one-time prekeys in the half-open range `[fromId, toId)` as
	 * uploaded (sent_to_server = 1) with the given `upload_timestamp`, mirroring
	 * WhatsApp Android's per-key upload flag. Called only AFTER the server acks
	 * the upload IQ, so a permanently-failed upload leaves the keys at 0 and they
	 * get re-uploaded on the next attempt — impossible to orphan, unlike a
	 * monotonic "first unuploaded" counter. Idempotent (guarded on `= 0`).
	 */
	markPrekeysUploaded(fromId: number, toId: number, uploadTimestampSec: number = Math.floor(Date.now() / 1000)): void {
		if (!(toId > fromId)) return
		this.stmts.markPrekeysUploaded.run(uploadTimestampSec, fromId, toId)
	}

	/**
	 * Durably reserves an eligible half-open range for a normal server upload.
	 * Returns the number of eligible typed rows covered by the reservation.
	 */
	reservePrekeyUploadRange(fromId: number, toId: number, uploadTimestampSec: number): number {
		if (!(toId > fromId)) return 0
		return this.stmts.reservePrekeyUploadRange.run(uploadTimestampSec, fromId, toId).changes
	}

	/**
	 * Flags a single one-time prekey as direct-distributed (`direct_distribution
	 * = 1`) with its `upload_timestamp`, mirroring what the real SignalPreKeyStore
	 * does when a key is handed to a peer inline in a retry receipt instead of
	 * being uploaded to the server pool. The flag removes it from the unsent-stock
	 * / upload queries (`countUnsentPrekeys` / `firstUnsentPrekeyId`), so it is not
	 * also re-sent to the server. Returns true only when exactly one durable row
	 * was marked; retry-receipt callers use that result fail-closed before handing
	 * the one-time key to a peer. A row whose `upload_timestamp` is already set
	 * has entered the normal upload path and is intentionally ineligible even
	 * when its server ACK has not been recorded yet.
	 */
	markPrekeyDirectDistribution(prekeyId: number, uploadTimestampSec: number = Math.floor(Date.now() / 1000)): boolean {
		return this.stmts.markPrekeyDirectDistribution.run(uploadTimestampSec, prekeyId).changes === 1
	}

	/** True only when the durable typed row is present and direct-distributed. */
	isPrekeyDirectDistribution(prekeyId: number): boolean {
		const row = this.stmts.selectPrekeyDirectDistribution.get(prekeyId) as
			| { direct_distribution: number | null }
			| undefined
		return row?.direct_distribution === 1
	}

	/**
	 * A00 of the real SignalPreKeyStore — how many one-time prekeys are still
	 * owed to the server (`sent_to_server = 0 AND direct_distribution = 0`).
	 */
	countUnsentPrekeys(): number {
		const r = this.stmts.countUnsentPrekeys.get() as { count: number } | undefined
		return Number(r?.count ?? 0)
	}

	/**
	 * Lowest prekey id that still needs uploading, or `null` when the server has
	 * every generated key. This is the table-authoritative equivalent of the
	 * `firstUnuploadedPreKeyId` creds counter: whenever it points BELOW the
	 * counter, the counter drifted (e.g. a pre-#665 orphan) and the caller
	 * rewinds it so those keys get re-sent. Never used to raise the counter, so
	 * it can only recover keys, never skip an un-acked one.
	 */
	firstUnsentPrekeyId(): number | null {
		const r = this.stmts.firstUnsentPrekeyId.get() as { id: number | null } | undefined
		return r?.id ?? null
	}

	/**
	 * A03 of the real SignalPreKeyStore, atomically: on server ack, flip the
	 * uploaded ids to `sent_to_server = 1` + `upload_timestamp` in chunks of 200,
	 * THEN append one `prekey_uploads` log row — all inside a single transaction,
	 * committed only if every step succeeds (order + chunk size confirmed from the
	 * deobfuscated store). This makes the two writes atomic: a mid-way failure
	 * rolls back, so the DB never claims an upload that didn't fully land. Range
	 * is the half-open `[fromId, toId)` the IQ carried; `uploadTimestampSec` is
	 * epoch SECONDS (WhatsApp Android stores seconds, not millis).
	 */
	commitPrekeyUpload(fromId: number, toId: number, uploadTimestampSec: number): void {
		// Guard the public contract: an empty/invalid range must NOT append a
		// prekey_uploads row (that would log an upload that flipped zero keys).
		if (!(toId > fromId)) return
		const CHUNK = 200
		this.db.exec('BEGIN IMMEDIATE')
		try {
			for (let start = fromId; start < toId; start += CHUNK) {
				const end = Math.min(start + CHUNK, toId)
				this.stmts.markPrekeysUploaded.run(uploadTimestampSec, start, end)
			}

			this.stmts.insertPrekeyUpload.run(uploadTimestampSec, 0)
			this.db.exec('COMMIT')
		} catch (err) {
			try {
				this.db.exec('ROLLBACK')
			} catch {}

			throw err
		}
	}

	getPrekey(prekeyId: number): Buffer | null {
		const r = this.stmts.selectPrekey.get(prekeyId) as { record: Buffer } | undefined
		return r?.record ?? null
	}

	/** Batched {@link getPrekey}: one `IN` query for N prekey ids. */
	getManyPrekeys(prekeyIds: ReadonlyArray<number>): Array<{ prekey_id: number; record: Buffer }> {
		return queryTupleChunks<number, { prekey_id: number; record: Buffer }>(
			this.db,
			this.manyPrekeyStmts,
			prekeyIds,
			1,
			'SELECT prekey_id, record FROM prekeys WHERE prekey_id IN (VALUES ',
			prekeyId => [prekeyId]
		)
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

	/**
	 * Batched {@link getIdentity}: one row-value `IN` query. `device_id` is
	 * coerced to the sentinel exactly like the single get so a null-device key
	 * still matches its stored row.
	 */
	getManyIdentities(keys: ReadonlyArray<SignalIdentityKey>): Array<{
		recipient_id: number
		recipient_type: number
		device_id: number
		public_key: Buffer
	}> {
		return queryTupleChunks<
			SignalIdentityKey,
			{ recipient_id: number; recipient_type: number; device_id: number; public_key: Buffer }
		>(
			this.db,
			this.manyIdentityStmts,
			keys,
			3,
			'SELECT recipient_id, recipient_type, device_id, public_key FROM identities ' +
				'WHERE (recipient_id, recipient_type, device_id) IN (VALUES ',
			key => [key.recipientId, key.recipientType, key.deviceId ?? IDENTITY_DEVICE_ID_SENTINEL]
		)
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

	/** Batched {@link getSenderKey}: one row-value `IN` query for N keys. */
	getManySenderKeys(keys: ReadonlyArray<SignalSenderKeyKey>): Array<{
		group_id: string
		device_id: number
		sender_account_id: string
		sender_account_type: number
		record: Buffer
	}> {
		return queryTupleChunks<
			SignalSenderKeyKey,
			{
				group_id: string
				device_id: number
				sender_account_id: string
				sender_account_type: number
				record: Buffer
			}
		>(
			this.db,
			this.manySenderKeyStmts,
			keys,
			4,
			'SELECT group_id, device_id, sender_account_id, sender_account_type, record FROM sender_keys ' +
				'WHERE (group_id, device_id, sender_account_id, sender_account_type) IN (VALUES ',
			key => [key.groupId, key.deviceId, key.senderAccountId, key.senderAccountType]
		)
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
	 * flushed to the server. Returns the row id so the caller can drop THIS
	 * ack's row with {@link deletePreack} once it is sent.
	 *
	 * Wired from `sendMessageAck` for message-class stanzas: INSERT before
	 * `sendNode`, {@link deletePreack} after — mirroring the mobile pre-ack
	 * buffer and giving the same crash-safety (a pre-ack persisted but not yet
	 * sent survives a restart). Best-effort: a mirror failure never blocks the
	 * ack itself.
	 */
	enqueuePreack(ptn: Buffer | Uint8Array): number {
		return Number(this.stmts.insertPreack.run(toBuf(ptn)).lastInsertRowid)
	}

	/**
	 * Drops a single sent pre-ack by exact `_id`. Preferred over
	 * {@link drainPreacksUpTo} on the concurrent ack hot path: a prefix drain
	 * could delete another ack's row that was enqueued but not yet sent.
	 */
	deletePreack(id: number): boolean {
		return this.stmts.deletePreack.run(id).changes > 0
	}

	/** Drains the contiguous prefix `_id <= id`, mirroring the mobile batch drain. */
	drainPreacksUpTo(id: number): number {
		return this.stmts.drainPreacksUpTo.run(id).changes
	}

	/** Wipes every buffered pre-ack (socket close). */
	clearPreacks(): void {
		this.stmts.clearPreacks.run()
	}
}
