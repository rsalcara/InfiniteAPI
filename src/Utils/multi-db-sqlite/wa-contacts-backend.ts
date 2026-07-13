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
 * event-driven contact handling. Reads go through {@link resolveStoredContact},
 * which prefers the PN row but falls back to the original jid's (LID) row when
 * the PN row is absent (#630), so a contact stored only under its LID is still
 * found.
 *
 * `wa_contacts` is PERSISTENT (contacts survive a reconnect), so — unlike the
 * transient mirrors — there is no socket-close wipe.
 */
import { isAnyLidUser, jidNormalizedUser } from '../../WABinary/jid-utils'
import type { SqliteDbLike, SqliteStatementLike } from './types'

/** The consumer-facing shape returned by {@link resolveStoredContact}. */
export type StoredContactView = {
	id: string
	name?: string
	notify?: string
	status?: string
	username?: string
}

/**
 * Resolves a stored contact for any `jid`, PN-transparently. Pure + injectable
 * (row getter + LID→PN resolver passed in) so the socket wiring stays thin and
 * this is unit-testable.
 *
 * Lookup order (audit #630): prefer the PN row (canonical identity), then fall
 * back to the ORIGINAL jid when the PN is unknown OR is known but has no stored
 * row. `wa_contacts` keys by jid and holds a contact's LID row and PN row
 * independently (they are backfilled separately once a mapping resolves), so a
 * PN-only lookup would return `null` for a contact we DO have under its LID —
 * dropping it. Returns `null` only when neither jid has a row.
 */
export async function resolveStoredContact(
	jid: string,
	getByJid: (jid: string) => StoredWaContactRow | null,
	getPnForLid: (lid: string) => Promise<string | undefined>
): Promise<StoredContactView | null> {
	const id = jidNormalizedUser(jid)
	const pn = isAnyLidUser(id) ? (await getPnForLid(id)) || undefined : id

	let row = pn ? getByJid(pn) : null
	if (!row && pn !== id) {
		row = getByJid(id)
	}

	if (!row) {
		return null
	}

	return {
		id: pn ?? id,
		name: row.display_name ?? undefined,
		notify: row.wa_name ?? undefined,
		status: row.status ?? undefined,
		username: row.username ?? undefined
	}
}

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
	 * pair once a mapping resolves. A MERGE, not a strict copy: it goes through
	 * {@link upsertRow}, so a NULL wa_name/display_name/status on the source
	 * leaves the target's value intact (never overwrites with NULL). No-op if
	 * `fromJid` has no row yet.
	 *
	 * `username` is SEED-ONLY: it is written only when this call CREATES the
	 * target row, never merged into an existing one. Merging it would resurrect a
	 * username that was explicitly cleared on the target (the delete signal) from
	 * the stale other side — the bidirectional backfill would let whichever side
	 * still holds a non-null username win over a correct deletion. Seeding on
	 * creation still propagates a username to a brand-new pair row.
	 */
	copyFieldsTo(fromJid: string, toJid: string): void {
		const src = this.getByJid(fromJid)
		if (!src) return
		const targetExists = this.getByJid(toJid) !== null
		this.upsertRow({
			jid: toJid,
			waName: src.wa_name,
			displayName: src.display_name,
			status: src.status,
			username: targetExists ? undefined : (src.username ?? undefined)
		})
	}

	/** Wipes every contact row. Not wired to socket-close — wa_contacts is persistent. */
	clear(): void {
		this.stmts.clear.run()
	}
}
