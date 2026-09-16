import { jidWithoutExplicitZeroDevice } from '../WABinary'

export type ResolvePresenceJid = (jid: string | undefined) => Promise<string | undefined>

export type PresenceUpdateIdentifiers = {
	id: string | undefined
	participant: string | undefined
}

/**
 * Public presence events use canonical user JIDs. Keep the raw wire JIDs for
 * attribution/logging only; strip the explicit primary-device suffix before
 * LID -> PN resolution so consumers do not get duplicate `:0` presence rows.
 */
export const resolvePresenceUpdateIdentifiers = async ({
	rawJid,
	rawParticipant,
	resolveJid
}: {
	rawJid: string | undefined
	rawParticipant: string | undefined
	resolveJid: ResolvePresenceJid
}): Promise<PresenceUpdateIdentifiers> => {
	const canonicalJid = jidWithoutExplicitZeroDevice(rawJid)
	const canonicalParticipant = jidWithoutExplicitZeroDevice(rawParticipant)
	const [id, participant] = await Promise.all([resolveJid(canonicalJid), resolveJid(canonicalParticipant)])

	return { id, participant }
}
