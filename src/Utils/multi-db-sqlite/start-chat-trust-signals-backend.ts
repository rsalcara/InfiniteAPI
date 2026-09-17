import type { StartChatTrustSignalsRecord } from '../../Types/Auth'
import type { SqliteDbLike, SqliteStatementLike } from './types'

export type StoredStartChatTrustSignalsRecord = {
	jid: string
	isSenderSuspicious?: boolean
	isSenderNewAccount?: boolean
	observedAt: number
}

export type StartChatTrustSignalsBackendStats = {
	recordCount: number
}

/**
 * Durable store for Android's `start_chat_trust_signals`. Values are server
 * observations attached to a locally observed chat creation; they are not
 * attestations, privacy tokens, or proof that a future send will be accepted.
 */
export class StartChatTrustSignalsBackend {
	private readonly db: SqliteDbLike
	private readonly stmts: {
		upsert: SqliteStatementLike
		select: SqliteStatementLike
		del: SqliteStatementLike
		count: SqliteStatementLike
		clearAll: SqliteStatementLike
		listAll: SqliteStatementLike
	}

	constructor(db: SqliteDbLike) {
		this.db = db
		this.stmts = {
			upsert: this.db.prepare(
				'INSERT INTO start_chat_trust_signals (jid, is_sender_suspicious, is_sender_new_account, created_ts) ' +
					'VALUES (?, ?, ?, ?) ON CONFLICT(jid) DO UPDATE SET ' +
					'  is_sender_suspicious = excluded.is_sender_suspicious, ' +
					'  is_sender_new_account = excluded.is_sender_new_account, ' +
					'  created_ts = excluded.created_ts'
			),
			select: this.db.prepare(
				'SELECT jid, is_sender_suspicious, is_sender_new_account, created_ts ' +
					'FROM start_chat_trust_signals WHERE jid = ?'
			),
			del: this.db.prepare('DELETE FROM start_chat_trust_signals WHERE jid = ?'),
			count: this.db.prepare('SELECT COUNT(*) AS n FROM start_chat_trust_signals'),
			clearAll: this.db.prepare('DELETE FROM start_chat_trust_signals'),
			listAll: this.db.prepare(
				'SELECT jid, is_sender_suspicious, is_sender_new_account, created_ts ' +
					'FROM start_chat_trust_signals ORDER BY jid'
			)
		}
	}

	save(record: StartChatTrustSignalsRecord): void {
		this.stmts.upsert.run(
			record.jid,
			record.isSenderSuspicious === undefined ? null : record.isSenderSuspicious ? 1 : 0,
			record.isSenderNewAccount === undefined ? null : record.isSenderNewAccount ? 1 : 0,
			record.observedAt
		)
	}

	get(jid: string): StoredStartChatTrustSignalsRecord | null {
		const row = this.stmts.select.get(jid) as
			| {
					jid: string
					is_sender_suspicious: number | null
					is_sender_new_account: number | null
					created_ts: number
			  }
			| undefined

		if (!row) return null
		return {
			jid: row.jid,
			isSenderSuspicious: row.is_sender_suspicious === null ? undefined : row.is_sender_suspicious !== 0,
			isSenderNewAccount: row.is_sender_new_account === null ? undefined : row.is_sender_new_account !== 0,
			observedAt: row.created_ts
		}
	}

	list(): StoredStartChatTrustSignalsRecord[] {
		const rows = this.stmts.listAll.all() as Array<{
			jid: string
			is_sender_suspicious: number | null
			is_sender_new_account: number | null
			created_ts: number
		}>

		return rows.map(row => ({
			jid: row.jid,
			isSenderSuspicious: row.is_sender_suspicious === null ? undefined : row.is_sender_suspicious !== 0,
			isSenderNewAccount: row.is_sender_new_account === null ? undefined : row.is_sender_new_account !== 0,
			observedAt: row.created_ts
		}))
	}

	delete(jid: string): boolean {
		return this.stmts.del.run(jid).changes > 0
	}

	stats(): StartChatTrustSignalsBackendStats {
		const row = this.stmts.count.get() as { n: number }
		return { recordCount: row.n }
	}

	/** Clears all observations as part of the auth-state key reset. */
	clear(): void {
		this.stmts.clearAll.run()
	}
}
