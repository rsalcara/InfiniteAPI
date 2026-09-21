import { jidDecode, jidEncode, type JidServer } from '../WABinary/jid-utils'

/**
 * WhatsApp Android keeps a bi-map between Meta AI's phone-form identity and
 * its public FBID bot identity (jadx `C31471Yu`, cases 15/16, and
 * `convertBotJidtoPnOrLidIfExists`). Key bundles are requested from the
 * phone-form identity; message routing remains on `@bot`.
 */
export const META_AI_FBID_TO_PN = {
	'718584497008509': '13135550202'
} as const satisfies Record<string, string>

export const resolveMetaAiBotAliasJid = (jid: string | undefined): string | undefined => {
	const decoded = jidDecode(jid)
	if (decoded?.server !== 'bot') return undefined

	const pnUser = META_AI_FBID_TO_PN[decoded.user as keyof typeof META_AI_FBID_TO_PN]
	if (!pnUser) return undefined

	return jidEncode(pnUser, 's.whatsapp.net' satisfies JidServer, decoded.device)
}

/**
 * Signal addresses are `user[_domainType].device`; no dot means device 0.
 * Mapping the FBID here keeps session lookup/injection and encryption on the
 * same storage address as the phone-form identity returned by the server.
 */
export const resolveMetaAiBotSignalAddressId = (signalAddressId: string): string => {
	const separator = signalAddressId.indexOf('.')
	const [signalUser, domainSuffix = ''] =
		separator < 0 ? [signalAddressId] : [signalAddressId.slice(0, separator), signalAddressId.slice(separator)]
	const pnUser = META_AI_FBID_TO_PN[signalUser as keyof typeof META_AI_FBID_TO_PN]
	if (!pnUser) return signalAddressId

	return `${pnUser}${domainSuffix}`
}
