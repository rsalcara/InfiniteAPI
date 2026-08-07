import { Boom } from '@hapi/boom'
import type { NewChatMessageCapInfo, ReachoutTimelockState } from '../Types'
import { isAnyLidUser, isAnyPnUser, jidDecode, jidNormalizedUser } from '../WABinary'
import type { USyncContactType, USyncQueryResultList } from '../WAUSync'
import type { ILogger } from './logger'
import { evaluateOutboundPolicy } from './outbound-policy'

export type DirectRecipientResolution = {
	contactType: USyncContactType
	destinationJid: string
	lidJid?: string
	pnJid: string
	username?: string
	result: USyncQueryResultList
}

export type DirectRecipientPreflightResult<TDevice> = {
	requestedPn: string
	pnJid: string
	lidJid: string
	username?: string
	freshTargetDevices?: TDevice[]
}

export type DirectRecipientPreflightOptions<TDevice> = {
	requestedJid: string
	getKnownLIDForPN: (pn: string) => Promise<string | null>
	fetchReachout: () => Promise<ReachoutTimelockState | undefined>
	fetchCapping: () => Promise<NewChatMessageCapInfo | undefined>
	resolveUSync: (phoneUser: string) => Promise<USyncQueryResultList[]>
	storeMapping: (mapping: { lid: string; pn: string }) => Promise<unknown>
	onResolvedUsername?: (resolution: DirectRecipientResolution) => void
	getDevices: (lid: string) => Promise<TDevice[]>
	logger: Pick<ILogger, 'warn' | 'info'>
}

/** Keeps a direct-message envelope aligned with the identity used for device fanout. */
export const resolveDirectRecipientWireJid = (requestedJid: string, resolvedLid?: string): string => {
	return resolvedLid ? jidNormalizedUser(resolvedLid) : jidNormalizedUser(requestedJid) || requestedJid
}

export const assertDirectRecipientCiphertext = ({
	isExternalDirectRecipient,
	recipientCount,
	ciphertextCount,
	requestedJid,
	lidJid
}: {
	isExternalDirectRecipient: boolean
	recipientCount: number
	ciphertextCount: number
	requestedJid: string
	lidJid?: string
}): void => {
	if (!isExternalDirectRecipient) return
	if (recipientCount > 0 && ciphertextCount === recipientCount) return

	const noCiphertext = ciphertextCount === 0
	throw new Boom(
		noCiphertext ? 'No ciphertext was produced for the recipient' : 'Incomplete ciphertext fanout for the recipient',
		{
			statusCode: 503,
			data: {
				requestedJid,
				lidJid,
				category: 'recipient-fanout',
				reason: ciphertextCount === 0 ? 'recipient-fanout-empty' : 'recipient-fanout-incomplete',
				recipientCount,
				ciphertextCount
			}
		}
	)
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

/** Production preflight for a previously unknown direct PN recipient. */
export const runDirectRecipientPreflight = async <TDevice>({
	requestedJid,
	getKnownLIDForPN,
	fetchReachout,
	fetchCapping,
	resolveUSync,
	storeMapping,
	onResolvedUsername,
	getDevices,
	logger
}: DirectRecipientPreflightOptions<TDevice>): Promise<DirectRecipientPreflightResult<TDevice> | undefined> => {
	const requestedPn = jidNormalizedUser(requestedJid)
	if (!isAnyPnUser(requestedPn)) return undefined

	const knownLid = await getKnownLIDForPN(requestedPn)
	if (knownLid) {
		return { requestedPn, pnJid: requestedPn, lidJid: jidNormalizedUser(knownLid) }
	}

	const [reachout, capping] = await Promise.all([
		fetchReachout().catch(error => {
			logger.warn({ error, requestedJid: requestedPn }, 'cold-recipient reachout policy lookup failed')
			return undefined
		}),
		fetchCapping().catch(error => {
			logger.warn({ error, requestedJid: requestedPn }, 'cold-recipient message-capping lookup failed')
			return undefined
		})
	])
	const policy = evaluateOutboundPolicy({ reachout, capping })
	if (!policy.allowed && policy.restriction) {
		logger.warn({ requestedJid: requestedPn, ...policy.restriction }, 'outbound cold-recipient send blocked by policy')
		throw new Boom('Outbound send blocked by WhatsApp account policy', {
			statusCode: 403,
			data: { requestedJid: requestedPn, ...policy.restriction }
		})
	}

	const phoneUser = jidDecode(requestedPn)?.user
	if (!phoneUser) {
		throw new Boom('Invalid recipient PN', {
			statusCode: 400,
			data: { requestedJid, category: 'recipient-resolution', reason: 'invalid-pn' }
		})
	}

	const resolution = resolveDirectRecipientUSync(requestedPn, await resolveUSync(phoneUser))
	if (!resolution) {
		logger.warn(
			{
				requestedJid: requestedPn,
				category: 'recipient-resolution',
				reason: 'registration-or-identity-unavailable',
				action: 'blocked-no-retry'
			},
			'cold-recipient preflight could not resolve a unique registered identity'
		)
		throw new Boom('Recipient is not registered or has no resolvable identity', {
			statusCode: 404,
			data: {
				requestedJid: requestedPn,
				category: 'recipient-resolution',
				reason: 'registration-or-identity-unavailable'
			}
		})
	}

	if (resolution.contactType !== 'in') {
		const reason = resolution.contactType === 'invalid' ? 'invalid-number' : 'not-registered'
		logger.warn(
			{
				requestedJid: requestedPn,
				contactType: resolution.contactType,
				category: 'recipient-registration',
				reason,
				action: 'blocked-no-retry'
			},
			'cold-recipient preflight rejected the destination'
		)
		throw new Boom('Recipient is not registered on WhatsApp', {
			statusCode: 404,
			data: {
				requestedJid: requestedPn,
				contactType: resolution.contactType,
				category: 'recipient-registration',
				reason
			}
		})
	}

	if (!resolution.lidJid) {
		throw new Boom('Registered recipient has no LID mapping', {
			statusCode: 503,
			data: { requestedJid: requestedPn, category: 'recipient-resolution', reason: 'lid-unavailable' }
		})
	}

	await storeMapping({ lid: resolution.lidJid, pn: resolution.pnJid })
	if (resolution.username) onResolvedUsername?.(resolution)

	const freshTargetDevices = await getDevices(resolution.lidJid)
	if (freshTargetDevices.length === 0) {
		throw new Boom('Recipient has no addressable devices', {
			statusCode: 503,
			data: {
				requestedJid: requestedPn,
				lidJid: resolution.lidJid,
				category: 'recipient-fanout',
				reason: 'no-devices'
			}
		})
	}

	logger.info(
		{
			requestedJid: requestedPn,
			pnJid: resolution.pnJid,
			lidJid: resolution.lidJid,
			username: resolution.username,
			deviceCount: freshTargetDevices.length
		},
		'cold-recipient preflight resolved PN to canonical LID'
	)

	return {
		requestedPn,
		pnJid: resolution.pnJid,
		lidJid: resolution.lidJid,
		...(resolution.username ? { username: resolution.username } : {}),
		freshTargetDevices
	}
}
