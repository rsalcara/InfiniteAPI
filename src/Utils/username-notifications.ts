import type { BaileysEventEmitter, Contact } from '../Types'
import { jidNormalizedUser } from '../WABinary'
import type { ILogger } from './logger'

/**
 * Re-shapers for the three `<notification type="mex">` ops that
 * WhatsApp pushes when an account's @username changes (2026 rollout).
 *
 * Each function takes the parsed `data` payload from the mex envelope
 * (the JSON inside `<update op_name="..."><![CDATA[ {data: {…}} ]]>
 * </update>`) and translates it into a regular `contacts.update`
 * event addressed by LID — so consumers (and the
 * `attachMeUsernameSync` listener) see all three flows on the same
 * event channel as any other contact update.
 *
 * Lives outside `messages-recv.ts` so each can be unit-tested by
 * passing a plain `EventEmitter`, without standing up a socket.
 *
 * Discovered by reverse-engineering `WAWebMexUsernameUpdateNotification
 * Handler` in the WhatsApp Web bundle — three dispatch arms keyed by
 * `OperationName`:
 *   - `UsernameSetNotification` → `mexHandleUsernameChange`
 *   - `UsernameDeleteNotification` → `mexHandleUsernameDelete`
 *   - `UsernameUpdateNotification` → `mexHandleUsernameChangeForSideSub`
 */

/**
 * `UsernameSetNotification` — payload `xwa2_notify_username_on_change`
 * with `{ username, lid }`. Re-emitted as `contacts.update`:
 *   `{ id: lid, lid, username }`
 */
export const handleUsernameSetNotification = (
	data: Record<string, unknown>,
	ev: BaileysEventEmitter,
	logger: ILogger
) => {
	const payload = data.xwa2_notify_username_on_change as { username?: unknown; lid?: unknown } | undefined
	// Type-guard each field individually — the payload comes from the
	// wire JSON and the server (or a tampered relay) could send a
	// non-string, which would otherwise land in `contacts.update` as
	// `{username: 42}` etc and crash downstream consumers. (audit P2-3)
	if (typeof payload?.lid !== 'string' || typeof payload?.username !== 'string') {
		logger.warn({ payload }, 'username set notification missing lid or username')
		return
	}

	const lid = jidNormalizedUser(payload.lid)
	logger.info({ lid, username: payload.username }, 'username set notification received')

	ev.emit('contacts.update', [
		{
			id: lid,
			lid,
			username: payload.username
		}
	])
}

/**
 * `UsernameDeleteNotification` — payload `xwa2_notify_username_delete`
 * with `{ lid, display_name? }`. Re-emitted as `contacts.update` with
 * `username: null` (the explicit "clear" signal that
 * `attachMeUsernameSync` reads):
 *   `{ id: lid, lid, username: null, name?: display_name }`
 *
 * `display_name` is the fallback name to render now that the @ handle
 * is gone (e.g. "Renato Alcará") — NOT the username. Forwarded as
 * `name` on the update so consumers don't render `null/undefined` in
 * the chat header while waiting for the next contact sync.
 */
export const handleUsernameDeleteNotification = (
	data: Record<string, unknown>,
	ev: BaileysEventEmitter,
	logger: ILogger
) => {
	const payload = data.xwa2_notify_username_delete as { lid?: unknown; display_name?: unknown } | undefined
	// Same wire-trust posture as the SET handler — only `lid` is
	// required, and it MUST be a string. (audit P2-3)
	if (typeof payload?.lid !== 'string') {
		logger.warn({ payload }, 'username delete notification missing lid')
		return
	}

	const lid = jidNormalizedUser(payload.lid)
	const displayName = typeof payload.display_name === 'string' ? payload.display_name : undefined
	logger.info({ lid, displayName }, 'username delete notification received')

	// `null` (not undefined) is the explicit "this user's handle is
	// now gone" signal — `attachMeUsernameSync` reads this as
	// "clear `creds.me.username`" when the LID matches `me`. The
	// public `Contact.username` is typed `string | undefined` (no
	// `null` arm), so the field is built with the looser shape and
	// cast through `unknown` at emit time.
	const update: Record<string, unknown> = {
		id: lid,
		lid,
		username: null
	}

	if (displayName) {
		update.name = displayName
	}

	ev.emit('contacts.update', [update as unknown as Partial<Contact>])
}

/**
 * `UsernameUpdateNotification` — payload
 * `xwa2_notify_username_on_update_side_sub` with `{ hash }`. The
 * server tells us a contact whose usernames map onto multiple linked
 * accounts had one update, referenced by an opaque content hash. We
 * don't carry the `getContactRecordByHash` index that WA Web uses, so
 * the best we can do is log it and move on — real consumers that
 * care can re-issue a USync to refresh.
 */
export const handleUsernameSideSubNotification = (
	data: Record<string, unknown>,
	logger: ILogger
) => {
	const payload = data.xwa2_notify_username_on_update_side_sub as { hash?: string } | undefined
	logger.info(
		{ hash: payload?.hash },
		'username side-sub change notification — ignored (no contact-by-hash index)'
	)
}
