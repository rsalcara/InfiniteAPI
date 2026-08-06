import { isAnyLidUser, isAnyPnUser, jidDecode, jidNormalizedUser } from '../WABinary'
import type { USyncContactType, USyncQueryResultList } from '../WAUSync'

export type DirectRecipientResolution = {
	contactType: USyncContactType
	destinationJid: string
	lidJid?: string
	pnJid: string
	username?: string
	result: USyncQueryResultList
}

const normalizeAlias = (value: unknown): string | undefined => {
	if (typeof value !== 'string' || value.length === 0) return undefined
	const normalized = jidNormalizedUser(value)
	return normalized || undefined
}

const aliasesForResult = (result: USyncQueryResultList): string[] => {
	const aliases = [result.id, result.jid, result.pnJid, result.newJid, result.lid]
		.map(normalizeAlias)
		.filter((jid): jid is string => Boolean(jid))

	return [...new Set(aliases)]
}

/**
 * Resolve a PN from the combined contact/LID/device/username USync response.
 * The server can return multiple rows; only an exact PN alias or one
 * unambiguous row is accepted. Unknown/ambiguous rows are rejected so a
 * message can never be encrypted for another contact by accident.
 */
export const resolveDirectRecipientUSync = (
	requestedPn: string,
	results: USyncQueryResultList[]
): DirectRecipientResolution | undefined => {
	const pnJid = jidNormalizedUser(requestedPn)
	if (!isAnyPnUser(pnJid)) return undefined

	const exactMatches = results.filter(result => aliasesForResult(result).includes(pnJid))
	const candidates = exactMatches.length > 0 ? exactMatches : results.length === 1 ? results : []
	if (candidates.length !== 1) return undefined

	const result = candidates[0]!
	const contactType = result.contactType
	if (contactType !== 'in' && contactType !== 'out' && contactType !== 'invalid') return undefined

	const aliases = aliasesForResult(result)
	const lidJid = aliases.find(isAnyLidUser)
	const resolvedPnJid = aliases.find(isAnyPnUser) || pnJid
	const decodedLid = lidJid ? jidDecode(lidJid) : undefined
	const username = typeof result.username === 'string' && result.username.length > 0 ? result.username : undefined

	return {
		contactType,
		destinationJid: lidJid || resolvedPnJid,
		...(lidJid ? { lidJid: decodedLid ? jidNormalizedUser(lidJid) : lidJid } : {}),
		pnJid: resolvedPnJid,
		...(username ? { username } : {}),
		result
	}
}
