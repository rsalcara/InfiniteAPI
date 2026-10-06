import { Boom } from '@hapi/boom'
import type { ChatUpdate, NewChatMessageCapInfo, ReachoutTimelockState, StartChatTrustSignalsState } from '../Types'
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
	startChatTrustSignals?: StartChatTrustSignalsState
}

export type DirectRecipientIdentity = {
	requestedPn: string
	pnJid: string
	lidJid: string
}

export type DirectRecipientPreflightOptions<TDevice> = {
	requestedJid: string
	getKnownLIDForPN: (pn: string) => Promise<string | null>
	getKnownPNForLID?: (lid: string) => Promise<string | null>
	fetchReachout: () => Promise<ReachoutTimelockState | undefined>
	fetchCapping: () => Promise<NewChatMessageCapInfo | undefined>
	/**
	 * Whether any of these PN/LID aliases ever gave us a privacy token. The app
	 * applies the reachout timelock and the new-chat cap only to recipients
	 * outside that set (`PrivacyTokenStore.A08`, used by `C39781pK.A02` and
	 * `CappingGatingManager.A02`). Omitted means "no token": always checked.
	 */
	hasPrivacyToken?: (jids: string[]) => Promise<boolean>
	/**
	 * Whether any of these PN/LID aliases is this account. The app's new-chat
	 * gate skips the account itself (`CappingGatingManager.A02` calls
	 * `UserScopeMeManager.BN3`, `X/C48572Bp.java:34`, `X/C018108l.java:603`),
	 * so a self send or a peer message to our own devices (PDO, app-state key
	 * request) is neither a new chat nor a start-chat trust lookup.
	 */
	isOwnAccount?: (jids: string[]) => boolean
	/**
	 * Further reasons a new chat may not start, given the account state the
	 * gate just read (unknown timelock/quota, no first-contact token). Any
	 * reason blocks with `cold-outbound-not-ready` before USync. Omitted keeps
	 * the restriction-only check.
	 */
	coldOutboundReadiness?: (policy: { reachout?: ReachoutTimelockState; capping?: NewChatMessageCapInfo }) => string[]
	fetchStartChatTrustSignals?: (
		jid: string,
		context: { lookupJid: string; pnJid?: string }
	) => Promise<StartChatTrustSignalsState>
	startChatTrustSignalsPolicy?: 'observe' | 'require-known'
	resolveUSync: (phoneUser: string) => Promise<USyncQueryResultList[]>
	storeMapping: (mapping: { lid: string; pn: string }) => Promise<unknown>
	/** Called after the canonical PN/LID mapping is durably stored. */
	onResolvedIdentity?: (identity: DirectRecipientIdentity) => void | Promise<void>
	onResolvedUsername?: (resolution: DirectRecipientResolution) => void | Promise<void>
	getDevices: (lid: string) => Promise<TDevice[]>
	logger: Pick<ILogger, 'warn' | 'info'>
}

/**
 * Whether any alias is this account, matched per namespace: a PN against the
 * account PN and a LID against the account LID. Digits alone are not enough,
 * because a contact's PN can share digits with our LID (and the reverse).
 */
export const isOwnAccountJid = (jids: string[], me?: { id?: string; lid?: string }): boolean => {
	const own = new Set([me?.id, me?.lid].filter((jid): jid is string => !!jid).map(jid => jidNormalizedUser(jid)))
	return own.size > 0 && jids.some(jid => own.has(jidNormalizedUser(jid)))
}

/**
 * `createdTs` is durable observation metadata. `require-known` must only be
 * satisfied by an actual Android trust boolean, never by a non-empty payload
 * that happens to contain a timestamp.
 */
const hasStartChatTrustSignal = (signals?: StartChatTrustSignalsState['signals']): boolean =>
	Boolean(
		signals && (typeof signals.isSenderSuspicious === 'boolean' || typeof signals.isSenderNewAccount === 'boolean')
	)

/**
 * Builds consumer-facing chat merges for a cold recipient. The wire route is
 * the LID, while the public conversation identity is the canonical PN. The
 * originally requested PN is also an alias because USync can canonicalize a
 * stale/username-backed number to a different PN.
 */
export const buildDirectRecipientChatMerges = (
	{ requestedPn, pnJid, lidJid }: DirectRecipientIdentity,
	mergedAt = Date.now()
): ChatUpdate[] => {
	const canonical = jidNormalizedUser(pnJid)
	const normalizedLid = jidNormalizedUser(lidJid)
	if (
		!isAnyPnUser(canonical) ||
		!jidDecode(canonical)?.user ||
		!isAnyLidUser(normalizedLid) ||
		!jidDecode(normalizedLid)?.user
	) {
		return []
	}

	const previousIds = [...new Set([jidNormalizedUser(lidJid), jidNormalizedUser(requestedPn)])].filter(
		previousId => previousId && previousId !== canonical
	)

	return previousIds.map(previousId => ({
		id: canonical,
		merged: true,
		previousId,
		mergedAt
	}))
}

/** Keeps a direct-message envelope aligned with the identity used for device fanout. */
export const resolveDirectRecipientWireJid = (requestedJid: string, resolvedLid?: string): string => {
	const normalizedRequested = jidNormalizedUser(requestedJid) || requestedJid
	const normalizedLid = resolvedLid ? jidNormalizedUser(resolvedLid) : ''

	return isAnyLidUser(normalizedLid) && jidDecode(normalizedLid)?.user ? normalizedLid : normalizedRequested
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

const isValidLidJid = (jid: string | undefined): jid is string =>
	Boolean(jid && isAnyLidUser(jid) && jidDecode(jid)?.user)

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
	const lidJid = aliases.find(isValidLidJid)
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

/** Production preflight for a direct PN recipient (account policy, identity, devices). */
/**
 * The app's send gate (`C2DK.A00`) refuses a chat with no privacy token
 * while the account's reachout timelock is active (`C39781pK.A02`) or its
 * new-chat cap is reached (`CappingGatingManager.A02` +
 * `MessageCappingManager.A0N`), whether the recipient is addressed by PN or
 * LID. A recipient that gave us a token is not a new chat.
 * `coldOutboundReadiness` can add reasons (see `coldOutboundMode`).
 */
export const assertNewChatAllowed = async ({
	requestedJid,
	aliases,
	fetchReachout,
	fetchCapping,
	hasPrivacyToken,
	coldOutboundReadiness,
	logger
}: Pick<
	DirectRecipientPreflightOptions<unknown>,
	'fetchReachout' | 'fetchCapping' | 'hasPrivacyToken' | 'coldOutboundReadiness' | 'logger'
> & { requestedJid: string; aliases: string[] }) => {
	if (hasPrivacyToken && (await hasPrivacyToken(aliases))) return

	const [reachout, capping] = await Promise.all([
		fetchReachout().catch(error => {
			logger.warn({ error, requestedJid }, 'cold-recipient reachout policy lookup failed')
			return undefined
		}),
		fetchCapping().catch(error => {
			logger.warn({ error, requestedJid }, 'cold-recipient message-capping lookup failed')
			return undefined
		})
	])
	const policy = evaluateOutboundPolicy({ reachout, capping })
	if (!policy.allowed && policy.restriction) {
		logger.warn({ requestedJid, ...policy.restriction }, 'outbound cold-recipient send blocked by policy')
		throw new Boom('Outbound send blocked by WhatsApp account policy', {
			statusCode: 403,
			data: { requestedJid, ...policy.restriction }
		})
	}

	const reasons = coldOutboundReadiness?.({ reachout, capping }) ?? []
	if (reasons.length) {
		logger.warn({ requestedJid, reasons }, 'outbound cold-recipient send blocked: account not ready')
		throw new Boom('Account is not ready to start a new chat', {
			statusCode: 403,
			data: { requestedJid, category: 'cold-outbound-not-ready', reasons, action: 'blocked-no-retry' }
		})
	}
}

export const runDirectRecipientPreflight = async <TDevice>({
	requestedJid,
	getKnownLIDForPN,
	getKnownPNForLID,
	fetchReachout,
	fetchCapping,
	hasPrivacyToken,
	isOwnAccount,
	coldOutboundReadiness,
	fetchStartChatTrustSignals,
	startChatTrustSignalsPolicy,
	resolveUSync,
	storeMapping,
	onResolvedIdentity,
	onResolvedUsername,
	getDevices,
	logger
}: DirectRecipientPreflightOptions<TDevice>): Promise<DirectRecipientPreflightResult<TDevice> | undefined> => {
	const requestedPn = jidNormalizedUser(requestedJid)
	if (!isAnyPnUser(requestedPn)) return undefined

	const assertAllowed = (aliases: string[]) =>
		assertNewChatAllowed({
			requestedJid: requestedPn,
			aliases,
			fetchReachout,
			fetchCapping,
			hasPrivacyToken,
			coldOutboundReadiness,
			logger
		})

	// Best-effort like the reverse lookup below: a key-store failure or store
	// teardown reads as "no local mapping", not as a send abort.
	const knownLid = await getKnownLIDForPN(requestedPn).catch(() => null)
	if (knownLid && isValidLidJid(jidNormalizedUser(knownLid))) {
		const resolvedLid = jidNormalizedUser(knownLid)
		const knownPn = getKnownPNForLID ? await getKnownPNForLID(resolvedLid).catch(() => null) : null
		const normalizedKnownPn = knownPn ? jidNormalizedUser(knownPn) : ''
		const resolvedPnJid =
			normalizedKnownPn && isAnyPnUser(normalizedKnownPn) && jidDecode(normalizedKnownPn)?.user
				? normalizedKnownPn
				: requestedPn
		const aliases = [...new Set([requestedPn, resolvedPnJid, resolvedLid])]

		if (isOwnAccount?.(aliases)) {
			return { requestedPn, pnJid: resolvedPnJid, lidJid: resolvedLid }
		}

		await assertAllowed(aliases)

		if (startChatTrustSignalsPolicy === 'require-known') {
			const startChatTrustSignals = fetchStartChatTrustSignals
				? await fetchStartChatTrustSignals(requestedPn, { lookupJid: resolvedLid, pnJid: resolvedPnJid })
				: {
						jid: requestedPn,
						useCase: 'CHAT_FMX' as const,
						status: 'unavailable' as const,
						observedAt: Date.now(),
						error: 'provider-unavailable' as const
					}
			if (startChatTrustSignals.status !== 'known' || !hasStartChatTrustSignal(startChatTrustSignals.signals)) {
				throw new Boom('Start-chat trust signals are unavailable', {
					statusCode: 503,
					data: {
						requestedJid: requestedPn,
						trustSignalsJid: requestedPn,
						category: 'start-chat-trust-signals',
						reason: startChatTrustSignals.error ?? 'provider-unavailable',
						action: 'blocked-no-retry'
					}
				})
			}

			return {
				requestedPn,
				pnJid: resolvedPnJid,
				lidJid: resolvedLid,
				startChatTrustSignals
			}
		}

		let startChatTrustSignals: StartChatTrustSignalsState | undefined
		if (fetchStartChatTrustSignals) {
			startChatTrustSignals = await fetchStartChatTrustSignals(requestedPn, {
				lookupJid: resolvedLid,
				pnJid: resolvedPnJid
			})
		}

		return { requestedPn, pnJid: resolvedPnJid, lidJid: resolvedLid, startChatTrustSignals }
	}

	const ownAccount = isOwnAccount?.([requestedPn]) ?? false
	if (!ownAccount) {
		await assertAllowed([requestedPn])
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

	// USync may canonicalize a variant of our own number: check what it returned.
	const resolvedOwnAccount = ownAccount || (isOwnAccount?.([resolution.pnJid, resolution.lidJid]) ?? false)

	let startChatTrustSignals: StartChatTrustSignalsState | undefined
	if (!resolvedOwnAccount && (fetchStartChatTrustSignals || startChatTrustSignalsPolicy === 'require-known')) {
		startChatTrustSignals = fetchStartChatTrustSignals
			? await fetchStartChatTrustSignals(requestedPn, {
					lookupJid: resolution.lidJid,
					pnJid: resolution.pnJid
				})
			: {
					jid: requestedPn,
					useCase: 'CHAT_FMX',
					status: 'unavailable',
					observedAt: Date.now(),
					error: 'provider-unavailable'
				}
		if (
			startChatTrustSignalsPolicy === 'require-known' &&
			(startChatTrustSignals.status !== 'known' || !hasStartChatTrustSignal(startChatTrustSignals.signals))
		) {
			logger.warn(
				{
					requestedJid: requestedPn,
					trustSignalsJid: requestedPn,
					status: startChatTrustSignals.status,
					category: 'start-chat-trust-signals',
					reason: startChatTrustSignals.error ?? 'provider-unavailable',
					action: 'blocked-no-retry'
				},
				'cold-recipient preflight requires known start-chat trust signals'
			)
			throw new Boom('Start-chat trust signals are unavailable', {
				statusCode: 503,
				data: {
					requestedJid: requestedPn,
					trustSignalsJid: requestedPn,
					category: 'start-chat-trust-signals',
					reason: startChatTrustSignals.error ?? 'provider-unavailable',
					action: 'blocked-no-retry'
				}
			})
		}
	}

	const storeResult = await storeMapping({ lid: resolution.lidJid, pn: resolution.pnJid })
	const mappingErrors =
		typeof storeResult === 'object' && storeResult !== null && 'errors' in storeResult
			? Number((storeResult as { errors?: unknown }).errors) || 0
			: 0
	if (mappingErrors === 0) {
		try {
			await onResolvedIdentity?.({
				requestedPn,
				pnJid: resolution.pnJid,
				lidJid: resolution.lidJid
			})
		} catch (error) {
			logger.warn({ error, requestedJid: requestedPn }, 'cold-recipient chat merge notification failed; send continues')
		}
	} else {
		logger.warn(
			{ requestedJid: requestedPn, lidJid: resolution.lidJid, pnJid: resolution.pnJid, errors: mappingErrors },
			'cold-recipient mapping was not durable; merge notification suppressed'
		)
	}

	if (resolution.username) {
		try {
			await onResolvedUsername?.(resolution)
		} catch (error) {
			logger.warn({ error, requestedJid: requestedPn }, 'cold-recipient contact notification failed; send continues')
		}
	}

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
		freshTargetDevices,
		...(startChatTrustSignals ? { startChatTrustSignals } : {})
	}
}
