import type { LIDMapping } from '../Types'
import { isAnyLidUser, isAnyPnUser } from '../WABinary/jid-utils'

/**
 * Resolve addresses used by the encrypt-key IQ. Known PN mappings use their
 * LID, while an unmapped PN must remain present so callers can still fetch a
 * usable PN session.
 */
export const resolveSessionFetchJids = (
	requestedJids: readonly string[],
	mappings: readonly LIDMapping[]
): string[] => {
	const mappedPns = new Map(mappings.map(mapping => [mapping.pn, mapping.lid]))
	return [
		...new Set([
			...requestedJids.filter(jid => isAnyLidUser(jid)),
			...requestedJids.filter(jid => isAnyPnUser(jid)).map(jid => mappedPns.get(jid) || jid)
		])
	]
}
