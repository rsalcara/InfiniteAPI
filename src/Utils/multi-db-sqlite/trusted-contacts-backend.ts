/**
 * Phase 9.6 — typed `wa_trusted_contacts` + `wa_trusted_contacts_send`
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

export class TrustedContactsBackend {
	private readonly stmts: {
		upsertIncoming: SqliteStatementLike
		selectIncoming: SqliteStatementLike
		delIncoming: SqliteStatementLike
		upsertSent: SqliteStatementLike
		selectSent: SqliteStatementLike
		delSent: SqliteStatementLike
		countIncoming: SqliteStatementLike
		countSent: SqliteStatementLike
	}

	private readonly db: SqliteDbLike

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
			countIncoming: this.db.prepare('SELECT COUNT(*) AS n FROM wa_trusted_contacts'),
			countSent: this.db.prepare('SELECT COUNT(*) AS n FROM wa_trusted_contacts_send')
		}
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

	/** Diagnostic stats for ops visibility. */
	stats(): TrustedContactsBackendStats {
		const inc = this.stmts.countIncoming.get() as { n: number }
		const sent = this.stmts.countSent.get() as { n: number }
		return { incomingCount: inc.n, sentCount: sent.n }
	}
}
