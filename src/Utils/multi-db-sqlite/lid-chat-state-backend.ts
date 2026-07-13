/**
 * Typed storage for msgstore.db's `lid_chat_state` — per-jid LID/PN
 * coexistence state. Only `is_pn_shared` is mirrored: it is marked whenever a
 * LID→PN mapping is persisted (the PN for that LID identity becomes known/
 * shared). The `jid` table (via {@link JidMapBackend}) is the source of
 * identity; this table is a derived state-mirror.
 *
 * Write-only by design: the mobile client's exact trigger (PN shared inside a
 * 1:1 LID thread) isn't reverse-engineering-confirmed, so `is_pn_shared` is a
 * best-effort approximation kept for schema/inspection parity. No read-back
 * accessor is exposed — nothing in the gateway consumes coexistence state
 * today, and dead read methods were dropped rather than shipped unused. The
 * marking is driven from the single choke point every mapping-store path funnels
 * through (`wrapKeysWithJidMap.set`), so it covers all callers automatically.
 */
import type { JidMapBackend } from './lid-mapping-backend'
import type { SqliteDbLike, SqliteStatementLike } from './types'

export class LidChatStateBackend {
	private readonly stmts: {
		markPnShared: SqliteStatementLike
	}

	private readonly jidMap: JidMapBackend

	constructor(db: SqliteDbLike, jidMap: JidMapBackend) {
		this.jidMap = jidMap
		this.stmts = {
			markPnShared: db.prepare(
				'INSERT INTO lid_chat_state (jid_row_id, is_pn_shared) VALUES (?, 1) ' +
					'ON CONFLICT(jid_row_id) DO UPDATE SET is_pn_shared = 1'
			)
		}
	}

	/**
	 * Marks that the phone number for this LID identity is known/shared.
	 * `lidUser` is the same value {@link JidMapBackend.storeMapping} resolves for
	 * the LID side, so both land on one shared `jid` row. Idempotent.
	 */
	markPnShared(lidUser: string): void {
		this.stmts.markPnShared.run(this.jidMap.resolveJidRowId(lidUser))
	}
}
