import { jidNormalizedUser } from '../WABinary'

/**
 * In-memory map of peer `@username`s seen on the wire. The app fills the same
 * map from its contact database and stamps `peer_recipient_username` on
 * outbound envelopes whenever it knows the peer's username
 * (`X/AbstractC29399Cur.A07`); an empty entry omits the attr.
 *
 * Sources: inbound stanza attrs (`peer_recipient_username` /
 * `participant_username` / `username`, decoded in decode-wa-message) and USync
 * contact resolution (`withUsernameProtocol`, surfaced by the direct-recipient
 * preflight). Bounded and per-process — after a restart the map refills from
 * the next sighting, and the attr is simply omitted meanwhile, exactly like the
 * app's empty-map case.
 */

const usernames = new Map<string, string>()
const MAX_ENTRIES = 5000

export const rememberUsername = (jid: string | null | undefined, username: string | null | undefined): void => {
	if (!jid || !username) return
	const key = jidNormalizedUser(jid)
	if (!key) return
	// Usernames change rarely: dropping the oldest entry is enough to stay bounded.
	if (usernames.size >= MAX_ENTRIES && !usernames.has(key)) {
		const oldest = usernames.keys().next()
		if (!oldest.done) {
			usernames.delete(oldest.value)
		}
	}

	usernames.set(key, username)
}

export const getKnownUsername = (jid: string | null | undefined): string | undefined => {
	if (!jid) return undefined
	const key = jidNormalizedUser(jid)
	return key ? usernames.get(key) : undefined
}

/** Test hook — clears the process map. */
export const clearUsernameMap = (): void => {
	usernames.clear()
}
