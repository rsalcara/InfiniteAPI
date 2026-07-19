/**
 * Typed `wa_trusted_contacts` + `wa_trusted_contacts_send`
 * SQLite-backed storage for Trusted Contact (TC) tokens.
 *
 * TC tokens drive the biz `quality_control` envelope: the gateway sends
 * `<quality_control decision_id="..."><decision_source value="df"/>` on
 * outbound business messages, where `decision_id` is derived from the
 * recipient's TC token state. Persisting tokens here lets the gateway:
 *
 *   - Survive restart without losing token state (the legacy in-RAM
 *     store would forget on every boot).
 *   - Carry forward the `sent_tc_token_timestamp` so we don't re-issue
 *     a token to the same recipient inside the cool-down window.
 *   - Track the `real_issue_timestamp` for the outbound side, which is
 *     used to detect token re-issuance loops.
 *
 * Column names match the canonical mobile schema verbatim — backups,
 * forensic dumps, and migration scripts work without renames.
 */
import type { SqliteDbLike, SqliteStatementLike } from './types'

export type TrustedContactsBackendStats = {
	incomingCount: number
	sentCount: number
}

export type TrustedContactReplacement = {
	incoming: { token: Buffer | Uint8Array; timestamp: number } | null
	sent: { sentTimestamp: number; realIssueTimestamp: number } | null
}

const CLEAR_MARKER_KEY = 'auth_keys_clear_in_progress'
// #671 used this narrower name while the marker only guaranteed tctoken
// recovery. Treat it as the same global-clear intent during upgrades: that
// version wrote the marker before attempting the remaining key-store deletes.
const LEGACY_CLEAR_MARKER_KEY = 'tctoken_clear_in_progress'

export class TrustedContactsBackend {
	private readonly stmts: {
		upsertIncoming: SqliteStatementLike
		selectIncoming: SqliteStatementLike
		delIncoming: SqliteStatementLike
		listIncoming: SqliteStatementLike
		upsertSent: SqliteStatementLike
		selectSent: SqliteStatementLike
		delSent: SqliteStatementLike
		listSentJids: SqliteStatementLike
		countIncoming: SqliteStatementLike
		countSent: SqliteStatementLike
		clearIncoming: SqliteStatementLike
		clearSent: SqliteStatementLike
		upsertMetadata: SqliteStatementLike
		selectMetadata: SqliteStatementLike
		deleteMetadata: SqliteStatementLike
	}

	private readonly db: SqliteDbLike
	private readonly replaceTx: (jid: string, replacement: TrustedContactReplacement) => void
	private readonly replaceManyTx: (entries: ReadonlyArray<readonly [string, TrustedContactReplacement]>) => void
	private readonly beginClearTx: () => void
	private readonly finishClearTx: () => void

	constructor(db: SqliteDbLike) {
		this.db = db
		this.stmts = {
			upsertIncoming: this.db.prepare(
				'INSERT INTO wa_trusted_contacts (jid, incoming_tc_token, incoming_tc_token_timestamp) VALUES (?, ?, ?) ' +
					'ON CONFLICT(jid) DO UPDATE SET ' +
					'  incoming_tc_token = excluded.incoming_tc_token, ' +
					'  incoming_tc_token_timestamp = excluded.incoming_tc_token_timestamp'
			),
			selectIncoming: this.db.prepare(
				'SELECT incoming_tc_token, incoming_tc_token_timestamp FROM wa_trusted_contacts WHERE jid = ?'
			),
			delIncoming: this.db.prepare('DELETE FROM wa_trusted_contacts WHERE jid = ?'),
			// Enumeration = the table itself (PK jid). This is what replaces the
			// opaque `__index` list the legacy signal_kv path kept (whose
			// read-merge-write had a lost-update race): here every contact is its
			// own row, so listing is a plain SELECT with no shared list to clobber.
			listIncoming: this.db.prepare(
				'SELECT jid, incoming_tc_token_timestamp FROM wa_trusted_contacts WHERE length(incoming_tc_token) > 0'
			),
			upsertSent: this.db.prepare(
				'INSERT INTO wa_trusted_contacts_send (jid, sent_tc_token_timestamp, real_issue_timestamp) VALUES (?, ?, ?) ' +
					'ON CONFLICT(jid) DO UPDATE SET ' +
					'  sent_tc_token_timestamp = excluded.sent_tc_token_timestamp, ' +
					'  real_issue_timestamp = excluded.real_issue_timestamp'
			),
			selectSent: this.db.prepare(
				'SELECT sent_tc_token_timestamp, real_issue_timestamp FROM wa_trusted_contacts_send WHERE jid = ?'
			),
			delSent: this.db.prepare('DELETE FROM wa_trusted_contacts_send WHERE jid = ?'),
			listSentJids: this.db.prepare('SELECT jid FROM wa_trusted_contacts_send'),
			countIncoming: this.db.prepare('SELECT COUNT(*) AS n FROM wa_trusted_contacts'),
			countSent: this.db.prepare('SELECT COUNT(*) AS n FROM wa_trusted_contacts_send'),
			clearIncoming: this.db.prepare('DELETE FROM wa_trusted_contacts'),
			clearSent: this.db.prepare('DELETE FROM wa_trusted_contacts_send'),
			upsertMetadata: this.db.prepare(
				'INSERT INTO infiniteapi_metadata (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
			),
			selectMetadata: this.db.prepare('SELECT value FROM infiniteapi_metadata WHERE key = ?'),
			deleteMetadata: this.db.prepare('DELETE FROM infiniteapi_metadata WHERE key = ?')
		}

		const applyReplacement = (jid: string, replacement: TrustedContactReplacement): void => {
			if (replacement.incoming) {
				this.stmts.upsertIncoming.run(jid, replacement.incoming.token, replacement.incoming.timestamp)
			} else {
				this.stmts.delIncoming.run(jid)
			}

			if (replacement.sent) {
				this.stmts.upsertSent.run(jid, replacement.sent.sentTimestamp, replacement.sent.realIssueTimestamp)
			} else {
				this.stmts.delSent.run(jid)
			}
		}

		this.replaceTx = this.db.transaction(applyReplacement).immediate
		this.replaceManyTx = this.db.transaction((entries: ReadonlyArray<readonly [string, TrustedContactReplacement]>) => {
			for (const [jid, replacement] of entries) applyReplacement(jid, replacement)
		}).immediate

		this.beginClearTx = this.db.transaction(() => {
			this.stmts.upsertMetadata.run(CLEAR_MARKER_KEY, String(Date.now()))
			this.stmts.deleteMetadata.run(LEGACY_CLEAR_MARKER_KEY)
			this.stmts.clearIncoming.run()
			this.stmts.clearSent.run()
		}).immediate

		this.finishClearTx = this.db.transaction(() => {
			this.stmts.deleteMetadata.run(CLEAR_MARKER_KEY)
			this.stmts.deleteMetadata.run(LEGACY_CLEAR_MARKER_KEY)
		}).immediate
	}

	/** Atomically replaces both halves of one bundled tctoken inside wa.db. */
	replace(jid: string, replacement: TrustedContactReplacement): void {
		this.replaceTx(jid, replacement)
	}

	/** Atomically replaces both halves for every JID in one wa.db transaction. */
	replaceMany(entries: ReadonlyArray<readonly [string, TrustedContactReplacement]>): void {
		if (entries.length === 0) return
		this.replaceManyTx(entries)
	}

	/** Stores (or updates) the incoming TC token for a contact JID. */
	setIncoming(jid: string, token: Buffer | Uint8Array, timestamp: number = Date.now()): void {
		this.stmts.upsertIncoming.run(jid, token, timestamp)
	}

	/** Returns the incoming TC token + timestamp for a JID, or null. */
	getIncoming(jid: string): { token: Buffer; timestamp: number } | null {
		const row = this.stmts.selectIncoming.get(jid) as
			| { incoming_tc_token: Buffer; incoming_tc_token_timestamp: number }
			| undefined
		if (!row) return null
		return { token: row.incoming_tc_token, timestamp: row.incoming_tc_token_timestamp }
	}

	/** Removes the incoming TC token for a JID. Returns true if a row was removed. */
	deleteIncoming(jid: string): boolean {
		return this.stmts.delIncoming.run(jid).changes > 0
	}

	/** Stores (or updates) the outbound TC token timestamps for a recipient. */
	setSent(jid: string, sentTimestamp: number, realIssueTimestamp: number): void {
		this.stmts.upsertSent.run(jid, sentTimestamp, realIssueTimestamp)
	}

	/** Returns the outbound TC token timestamps for a JID, or null. */
	getSent(jid: string): { sentTimestamp: number; realIssueTimestamp: number } | null {
		const row = this.stmts.selectSent.get(jid) as
			| { sent_tc_token_timestamp: number; real_issue_timestamp: number }
			| undefined
		if (!row) return null
		return {
			sentTimestamp: row.sent_tc_token_timestamp,
			realIssueTimestamp: row.real_issue_timestamp
		}
	}

	/** Removes the outbound TC token row for a JID. */
	deleteSent(jid: string): boolean {
		return this.stmts.delSent.run(jid).changes > 0
	}

	/**
	 * Enumerates every stored incoming-token contact as `{ jid, timestamp }`.
	 * Replaces the legacy `__index` jid-list (which the prune path read, merged
	 * and rewrote — a lost-update race). The prune can filter by `timestamp`
	 * without an extra point-read per jid.
	 */
	listIncoming(): Array<{ jid: string; timestamp: number }> {
		const rows = this.stmts.listIncoming.all() as Array<{ jid: string; incoming_tc_token_timestamp: number }>
		return rows.map(r => ({ jid: r.jid, timestamp: r.incoming_tc_token_timestamp }))
	}

	/** Every jid that has an incoming TC token (PK enumeration). */
	listIncomingJids(): string[] {
		return (this.stmts.listIncoming.all() as Array<{ jid: string }>).map(r => r.jid)
	}

	/** Every jid that has an outbound (sent/scheduled) TC token row. */
	listSentJids(): string[] {
		return (this.stmts.listSentJids.all() as Array<{ jid: string }>).map(r => r.jid)
	}

	/** Diagnostic stats for ops visibility. */
	stats(): TrustedContactsBackendStats {
		const inc = this.stmts.countIncoming.get() as { n: number }
		const sent = this.stmts.countSent.get() as { n: number }
		return { incomingCount: inc.n, sentCount: sent.n }
	}

	/** Records a global key-clear intent and wipes both wa.db token tables atomically. */
	beginClear(): void {
		this.beginClearTx()
	}

	hasPendingClear(): boolean {
		return (
			this.stmts.selectMetadata.get(CLEAR_MARKER_KEY) !== undefined ||
			this.stmts.selectMetadata.get(LEGACY_CLEAR_MARKER_KEY) !== undefined
		)
	}

	finishClear(): void {
		this.finishClearTx()
	}
}
