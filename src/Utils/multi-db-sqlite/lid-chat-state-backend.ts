/**
 * Typed storage for msgstore.db's `lid_chat_state` — per-jid LID/PN
 * coexistence state (whether the phone number has been shared in a LID
 * thread, when it was requested, and the duplicate-LID-thread flag).
 *
 * The `jid` table (via {@link JidMapBackend}) is the ultimate source of
 * identity; this table is a derived state-mirror. `is_pn_shared` is marked
 * whenever a LID→PN mapping is persisted (the PN for that LID identity is now
 * known/shared) — a defensible signal for the coexistence state, though the
 * mobile client's exact trigger (PN shared specifically inside a 1:1 LID
 * thread) isn't Frida-confirmed, so this is a best-effort approximation.
 */
import type { JidMapBackend } from './lid-mapping-backend'
import type { SqliteDbLike, SqliteStatementLike } from './types'

export type LidChatState = {
	isPnShared: boolean
	pnRequestedTs: number
	pnhDuplicateLidThread: boolean
}

export class LidChatStateBackend {
	private readonly stmts: {
		markPnShared: SqliteStatementLike
		markPnRequested: SqliteStatementLike
		markDuplicate: SqliteStatementLike
		getByRowId: SqliteStatementLike
	}

	private readonly jidMap: JidMapBackend

	constructor(db: SqliteDbLike, jidMap: JidMapBackend) {
		this.jidMap = jidMap
		this.stmts = {
			markPnShared: db.prepare(
				'INSERT INTO lid_chat_state (jid_row_id, is_pn_shared) VALUES (?, 1) ' +
					'ON CONFLICT(jid_row_id) DO UPDATE SET is_pn_shared = 1'
			),
			markPnRequested: db.prepare(
				'INSERT INTO lid_chat_state (jid_row_id, pn_requested_ts) VALUES (?, ?) ' +
					'ON CONFLICT(jid_row_id) DO UPDATE SET pn_requested_ts = excluded.pn_requested_ts'
			),
			markDuplicate: db.prepare(
				'INSERT INTO lid_chat_state (jid_row_id, pnh_duplicate_lid_thread) VALUES (?, 1) ' +
					'ON CONFLICT(jid_row_id) DO UPDATE SET pnh_duplicate_lid_thread = 1'
			),
			getByRowId: db.prepare(
				'SELECT is_pn_shared, pn_requested_ts, pnh_duplicate_lid_thread FROM lid_chat_state WHERE jid_row_id = ?'
			)
		}
	}

	/** Marks that the phone number for this LID identity is known/shared. */
	markPnShared(jid: string): void {
		this.stmts.markPnShared.run(this.jidMap.resolveJidRowId(jid))
	}

	/** Records when this LID's phone number was requested. */
	markPnRequested(jid: string, timestamp: number): void {
		this.stmts.markPnRequested.run(this.jidMap.resolveJidRowId(jid), timestamp)
	}

	/** Flags a duplicate LID thread for this jid. */
	markDuplicateLidThread(jid: string): void {
		this.stmts.markDuplicate.run(this.jidMap.resolveJidRowId(jid))
	}

	/** Reads the coexistence state for a jid (defaults when no row exists). */
	getState(jid: string): LidChatState {
		// Read-only: `lookupJidRowId` (never `resolveJidRowId`) so querying the
		// state of an unknown jid doesn't materialize a phantom `jid` row.
		const rowId = this.jidMap.lookupJidRowId(jid)
		const row =
			rowId === null
				? undefined
				: (this.stmts.getByRowId.get(rowId) as
						| { is_pn_shared: number; pn_requested_ts: number; pnh_duplicate_lid_thread: number }
						| undefined)
		return {
			isPnShared: !!row?.is_pn_shared,
			pnRequestedTs: row?.pn_requested_ts ?? 0,
			pnhDuplicateLidThread: !!row?.pnh_duplicate_lid_thread
		}
	}
}
