import type { AuthenticationCreds, BaileysEventEmitter, Contact } from '../Types'
import { jidNormalizedUser } from '../WABinary'
import type { ILogger } from './logger'

/**
 * Keep `creds.me.username` in sync with what the server tells us.
 *
 * Wire context
 * ------------
 * WhatsApp's `@username` rollout (2026) lets the user reserve / change /
 * delete a handle on their primary phone. When that happens, the server
 * pushes a `<notification type="mex">` with one of these op-names
 * (decoded from the WAWebMexUsernameUpdateNotificationHandler module):
 *
 *   - `UsernameSetNotification` → payload `xwa2_notify_username_on_change`
 *   - `UsernameDeleteNotification` → payload `xwa2_notify_username_delete`
 *
 * `messages-recv.handleMexNotification` re-shapes both into a
 * `contacts.update` event addressed by LID, with `username` set
 * (string) on SET and `null` on DELETE. This module subscribes to
 * `contacts.upsert` + `contacts.update`, filters for the entry that
 * matches `creds.me.id` (or `creds.me.lid`), and flips
 * `creds.me.username` accordingly — then emits `creds.update` so the
 * normal persistence layer (the typical `useMultiFileAuthState` saver
 * or any custom one) writes the new value to disk on the same
 * heartbeat as every other creds change.
 *
 * Properties:
 *   - Purely reactive — never sends a stanza, never blocks.
 *   - Idempotent — emits `creds.update` ONLY on a real value flip;
 *     repeated upserts with the same handle are no-ops.
 *   - Safe across LID/PN duality — matches on both `creds.me.id`
 *     (whichever shape it has) and `creds.me.lid` when present, so
 *     a contact event addressed in EITHER form lands. The server-side
 *     notification carries the LID, so the `me.lid` arm is the one
 *     that actually fires in practice.
 *   - Handles soft-delete — an incoming `username` that's explicitly
 *     `null` clears `creds.me.username`, matching the WA server
 *     semantic for a deleted handle. An incoming `undefined` is left
 *     alone (= the event has no opinion on the handle, e.g. a notify
 *     change for the same contact).
 */
export const attachMeUsernameSync = (ev: BaileysEventEmitter, creds: AuthenticationCreds, logger: ILogger) => {
	const handle = (contacts: Array<Partial<Contact>>) => {
		const meId = creds.me?.id ? jidNormalizedUser(creds.me.id) : undefined
		const meLid = creds.me?.lid ? jidNormalizedUser(creds.me.lid) : undefined
		if (!meId && !meLid) {
			return
		}

		for (const c of contacts) {
			// Match on BOTH `c.id` and `c.lid` — the inbound payload may
			// carry the addressing on either field (PN events tend to
			// have `c.lid` populated as the LID-side counterpart, while
			// our own mex notification re-shaper emits `{id: lid,
			// lid}`). Without the `c.lid` arm a self-update that
			// surfaces with `c.id` = PN and `c.lid` = the matching LID
			// would slip past when only `creds.me.lid` is known.
			// (audit P2-2)
			const cId = c.id ? jidNormalizedUser(c.id) : undefined
			const cLid = c.lid ? jidNormalizedUser(c.lid) : undefined
			const idMatches = cId !== undefined && (cId === meId || cId === meLid)
			const lidMatches = cLid !== undefined && (cLid === meId || cLid === meLid)
			if (!idMatches && !lidMatches) {
				continue
			}

			// `undefined` = the event has no opinion on the handle (e.g.
			// it was emitted for a name/notify change). Leave creds alone
			// instead of clobbering with undefined and emitting a no-op
			// `creds.update`.
			if (!('username' in c) || c.username === undefined) {
				continue
			}

			const next = c.username || undefined // normalize "" → undefined
			if (next === creds.me!.username) {
				continue
			}

			const prev = creds.me!.username
			creds.me!.username = next

			logger.info(
				{ prev, next, jid: creds.me!.id },
				next ? '[username] me.username updated from contacts event' : '[username] me.username cleared'
			)

			ev.emit('creds.update', { me: creds.me })
		}
	}

	ev.on('contacts.upsert', handle)
	ev.on('contacts.update', handle)
}
