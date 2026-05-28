/**
 * Phase 9.4 — typed `message_quarantine` storage.
 *
 * Stanzas that fail to decrypt (typically Bad MAC errors) are quarantined
 * here so they survive a gateway restart and can be replayed forensically
 * or fed back into the recovery flow when a new session is established.
 *
 * Backed by `msgstore.db.message_quarantine` with a UNIQUE constraint on
 * `(key_id, from_me, chat_row_id, sender_jid_row_id)` so duplicate
 * quarantine attempts for the same message merge into a single row with
 * the `retry_count` incremented.
 *
 * Storage choices:
 *   - `original_protobuf` BLOB: the raw inner payload (e.g. the protobuf
 *     before encryption) when available — useful for offline analysis.
 *   - `serialized_stanza` BLOB: the wire-format XMPP stanza that the
 *     client received and failed to decrypt. Lets the recovery handler
 *     re-process the same stanza after the session is rebuilt.
 *   - `failure_reason` TEXT: free-form diagnostic ("Bad MAC", "Invalid
 *     SignedPreKey", etc.) for triage dashboards.
 *   - `quarantined_at` INTEGER: epoch ms — supports time-window queries
 *     ("everything quarantined in the last 5 minutes").
 *   - `retry_count` INTEGER: incremented on every quarantine attempt for
 *     the same natural key, mirroring the existing in-RAM ring buffer.
 */
import type { SqliteDbLike, SqliteStatementLike } from './types'

export type QuarantineRecord = {
	keyId: string
	fromMe: boolean
	chatRowId: number
	senderJidRowId?: number | null
	originalProtobuf?: Buffer | Uint8Array | null
	serializedStanza?: Buffer | Uint8Array | null
	failureReason?: string | null
	quarantinedAt?: number
}

export type StoredQuarantineRow = QuarantineRecord & {
	id: number
	quarantinedAt: number
	retryCount: number
}

export class MessageQuarantineBackend {
	private readonly stmts: {
		upsert: SqliteStatementLike
		selectByKey: SqliteStatementLike
		selectByChat: SqliteStatementLike
		selectSince: SqliteStatementLike
		delByKey: SqliteStatementLike
		pruneOlderThan: SqliteStatementLike
	}

	private readonly db: SqliteDbLike

	constructor(db: SqliteDbLike) {
		this.db = db
		this.stmts = {
			// Single atomic UPSERT with RETURNING. The previous design used a
			// transaction wrapping (UPDATE-then-INSERT-if-no-rows) but
			// `db.transaction()` defaults to DEFERRED mode, so two callers
			// across processes could both execute UPDATE → 0 changes, then
			// both attempt INSERT — the second hitting `SQLITE_CONSTRAINT_
			// UNIQUE` instead of falling through to a retry-count bump. The
			// `busy_timeout` pragma only smooths `SQLITE_BUSY`, not UNIQUE
			// violations. The conflict clause now does the increment in the
			// same statement and `RETURNING` gives us the row's _id and
			// final retry_count without a separate SELECT.
			upsert: this.db.prepare(
				'INSERT INTO message_quarantine ' +
					'(key_id, from_me, chat_row_id, sender_jid_row_id, original_protobuf, serialized_stanza, ' +
					'failure_reason, quarantined_at, retry_count) ' +
					'VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1) ' +
					'ON CONFLICT(key_id, from_me, chat_row_id, sender_jid_row_id) ' +
					'DO UPDATE SET ' +
					'  retry_count = retry_count + 1, ' +
					'  quarantined_at = excluded.quarantined_at, ' +
					'  failure_reason = excluded.failure_reason ' +
					'RETURNING _id, retry_count'
			),
			selectByKey: this.db.prepare(
				'SELECT _id, key_id, from_me, chat_row_id, sender_jid_row_id, original_protobuf, ' +
					'serialized_stanza, failure_reason, quarantined_at, retry_count ' +
					'FROM message_quarantine WHERE key_id = ? AND from_me = ? AND chat_row_id = ? AND sender_jid_row_id = ?'
			),
			selectByChat: this.db.prepare(
				'SELECT _id, key_id, from_me, chat_row_id, sender_jid_row_id, original_protobuf, ' +
					'serialized_stanza, failure_reason, quarantined_at, retry_count ' +
					'FROM message_quarantine WHERE chat_row_id = ? ORDER BY quarantined_at DESC'
			),
			selectSince: this.db.prepare(
				'SELECT _id, key_id, from_me, chat_row_id, sender_jid_row_id, original_protobuf, ' +
					'serialized_stanza, failure_reason, quarantined_at, retry_count ' +
					'FROM message_quarantine WHERE quarantined_at >= ? ORDER BY quarantined_at DESC'
			),
			delByKey: this.db.prepare(
				'DELETE FROM message_quarantine ' +
					'WHERE key_id = ? AND from_me = ? AND chat_row_id = ? AND sender_jid_row_id = ?'
			),
			pruneOlderThan: this.db.prepare('DELETE FROM message_quarantine WHERE quarantined_at < ?')
		}
	}

	/**
	 * Inserts a quarantine row, or increments `retry_count` on an existing
	 * row matching the natural key. Returns the resulting row's id +
	 * retry_count after the operation.
	 *
	 * Atomic via single UPSERT + RETURNING — no transaction wrapper needed
	 * and no race window between the conflict check and the row read.
	 */
	quarantine(record: QuarantineRecord): { id: number; retryCount: number } {
		const now = record.quarantinedAt ?? Date.now()
		// schema: sender_jid_row_id NOT NULL DEFAULT 0 — coerce nullish to 0 so
		// UNIQUE constraint sees consistent values (SQLite treats NULLs as
		// distinct under UNIQUE).
		const sender = record.senderJidRowId ?? 0

		const row = this.stmts.upsert.get(
			record.keyId,
			record.fromMe ? 1 : 0,
			record.chatRowId,
			sender,
			record.originalProtobuf ?? null,
			record.serializedStanza ?? null,
			record.failureReason ?? null,
			now
		) as { _id: number; retry_count: number }

		return { id: row._id, retryCount: row.retry_count }
	}

	/** Returns the quarantine row matching the natural key, or `null`. */
	findByKey(
		keyId: string,
		fromMe: boolean,
		chatRowId: number,
		senderJidRowId: number | null
	): StoredQuarantineRow | null {
		const row = this.stmts.selectByKey.get(keyId, fromMe ? 1 : 0, chatRowId, senderJidRowId ?? 0) as RawRow | undefined
		return row ? mapRow(row) : null
	}

	/** Returns every quarantine row for a chat ordered by most-recent first. */
	listByChat(chatRowId: number): StoredQuarantineRow[] {
		const rows = this.stmts.selectByChat.all(chatRowId) as RawRow[]
		return rows.map(mapRow)
	}

	/** Returns rows quarantined at or after `since` (epoch ms). */
	listSince(since: number): StoredQuarantineRow[] {
		const rows = this.stmts.selectSince.all(since) as RawRow[]
		return rows.map(mapRow)
	}

	/**
	 * Removes the row matching the natural key. Use after successful
	 * recovery so the row doesn't pile up forever.
	 */
	dismiss(keyId: string, fromMe: boolean, chatRowId: number, senderJidRowId: number | null): boolean {
		const r = this.stmts.delByKey.run(keyId, fromMe ? 1 : 0, chatRowId, senderJidRowId ?? 0)
		return r.changes > 0
	}

	/** Deletes every row older than the cutoff (epoch ms). Returns rows pruned. */
	pruneOlderThan(cutoff: number): number {
		const r = this.stmts.pruneOlderThan.run(cutoff)
		return r.changes
	}
}

type RawRow = {
	_id: number
	key_id: string
	from_me: number
	chat_row_id: number
	sender_jid_row_id: number | null
	original_protobuf: Buffer | null
	serialized_stanza: Buffer | null
	failure_reason: string | null
	quarantined_at: number
	retry_count: number
}

function mapRow(row: RawRow): StoredQuarantineRow {
	return {
		id: row._id,
		keyId: row.key_id,
		fromMe: row.from_me === 1,
		chatRowId: row.chat_row_id,
		senderJidRowId: row.sender_jid_row_id,
		originalProtobuf: row.original_protobuf,
		serializedStanza: row.serialized_stanza,
		failureReason: row.failure_reason,
		quarantinedAt: row.quarantined_at,
		retryCount: row.retry_count
	}
}
