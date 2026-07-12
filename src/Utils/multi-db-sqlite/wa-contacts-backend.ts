/**
 * Typed backend for `wa_contacts` in `wa.db` — the canonical mobile contact
 * table. On the mobile client every contact is stored as TWO rows (its LID jid
 * and its PN jid), updated atomically; `wa_contacts` is the central table that
 * message-receive (`wa_name`), picture notifications, and history sync all
 * write into.
 *
 * This backend is intentionally mapping-agnostic: it does plain row CRUD keyed
 * by `jid`. The LID↔PN pairing (writing both rows, backfilling when a mapping
 * resolves) and the PN-transparent read live in the socket wiring, which has
 * the `signalRepository.lidMapping` resolver.
 *
 * Populate + consume, both best-effort with fallback: writes are wrapped at the
 * call site so a mirror failure never blocks the contact event flow, and the
 * read returns `null` on miss so the caller falls back to the legacy
 * event-driven contact handling. The consumer always receives PN — the read
 * side is keyed by the PN jid (the wiring resolves LID→PN first).
 *
 * `wa_contacts` is PERSISTENT (contacts survive a reconnect), so — unlike the
 * transient mirrors — there is no socket-close wipe.
 */
import type { SqliteDbLike, SqliteStatementLike } from './types'

export type WaContactRow = {
	jid: string
	/** notify / pushName — the name the contact set for themselves (mobile `wa_name`). */
	waName?: string | null
	/** the name saved locally (mobile `display_name`). */
	displayName?: string | null
	status?: string | null
	/**
	 * @username (column added by wa.db migration v1). Distinct tri-state:
	 * `undefined` = keep the stored value, `null` = explicit clear (the
	 * username-delete signal), string = set.
	 */
	username?: string | null
}

export type StoredWaContactRow = {
	jid: string
	is_whatsapp_user: number
	wa_name: string | null
	display_name: string | null
	status: string | null
	username: string | null
}

const nz = <T>(v: T | undefined): T | null => (v === undefined ? null : v)

export class WaContactsBackend {
	private readonly stmts: {
		upsert: SqliteStatementLike
		select: SqliteStatementLike
		clear: SqliteStatementLike
	}

	private readonly db: SqliteDbLike

	constructor(db: SqliteDbLike) {
		this.db = db
		this.stmts = {
			// Partial-update semantics: for wa_name/display_name/status a value of
			// NULL/undefined means "not provided, keep what's there"
			// (COALESCE(excluded, existing)) — a pushName-only update never clobbers
			// a stored status. `username` is different: it supports an EXPLICIT
			// clear (the username-delete notification emits `username: null` as the
			// signal). So it is driven by a separate "provided" flag —
			// `CASE WHEN <provided> THEN excluded.username ELSE username END` — where
			// `undefined` → keep, `null` → clear, string → set. is_whatsapp_user is
			// always 1. Requires the UNIQUE jid index (wa.db mig v2).
			upsert: this.db.prepare(
				'INSERT INTO wa_contacts (jid, is_whatsapp_user, wa_name, display_name, status, username) ' +
					'VALUES (?, 1, ?, ?, ?, ?) ' +
					'ON CONFLICT(jid) DO UPDATE SET ' +
					'  is_whatsapp_user = 1, ' +
					'  wa_name = COALESCE(excluded.wa_name, wa_name), ' +
					'  display_name = COALESCE(excluded.display_name, display_name), ' +
					'  status = COALESCE(excluded.status, status), ' +
					'  username = CASE WHEN ? = 1 THEN excluded.username ELSE username END'
			),
			select: this.db.prepare(
				'SELECT jid, is_whatsapp_user, wa_name, display_name, status, username FROM wa_contacts WHERE jid = ?'
			),
			clear: this.db.prepare('DELETE FROM wa_contacts')
		}
	}

	/**
	 * Upsert one contact row by jid. For wa_name/display_name/status, an omitted
	 * (undefined) OR null field is left untouched. For `username`, `undefined`
	 * leaves it untouched while an explicit `null` CLEARS it (the username-delete
	 * signal) — distinguished by the `username_provided` flag.
	 */
	upsertRow(row: WaContactRow): void {
		const usernameProvided = row.username !== undefined ? 1 : 0
		this.stmts.upsert.run(
			row.jid,
			nz(row.waName),
			nz(row.displayName),
			nz(row.status),
			nz(row.username),
			usernameProvided
		)
	}

	/** Reads a single row by exact jid. Returns null on miss (→ legacy fallback). */
	getByJid(jid: string): StoredWaContactRow | null {
		return (this.stmts.select.get(jid) as StoredWaContactRow | undefined) ?? null
	}

	/**
	 * Merges the stored fields of `fromJid` onto `toJid` to backfill the LID↔PN
	 * pair once a mapping resolves. This is a MERGE, not a strict copy: it goes
	 * through {@link upsertRow}, so a NULL field on the source leaves the target's
	 * value intact (it never overwrites with NULL). No-op if `fromJid` has no row
	 * yet. `username` is passed as `undefined` when the source has none, so a
	 * backfill never clears the target's username.
	 */
	copyFieldsTo(fromJid: string, toJid: string): void {
		const src = this.getByJid(fromJid)
		if (!src) return
		this.upsertRow({
			jid: toJid,
			waName: src.wa_name,
			displayName: src.display_name,
			status: src.status,
			username: src.username ?? undefined
		})
	}

	/** Wipes every contact row. Not wired to socket-close — wa_contacts is persistent. */
	clear(): void {
		this.stmts.clear.run()
	}
}
