import { isAnyLidUser, isAnyPnUser, jidDecode, jidNormalizedUser } from '../WABinary'

const RETRY_RELAY_SERVERS = new Set([
	's.whatsapp.net',
	'hosted',
	'lid',
	'hosted.lid',
	'g.us',
	'broadcast',
	'newsletter',
	'bot',
	'call'
])

const isValidRetryRelayRoute = (jid: string): boolean => {
	const decoded = jidDecode(jid)
	return Boolean(decoded?.user && RETRY_RELAY_SERVERS.has(decoded.server))
}

export type RetryReceiptRouteSource =
	| 'recent-message-cache'
	| 'recipient-attribute'
	| 'stanza-remote-context'
	| 'unresolved'

export interface RetryReceiptRouteInput {
	stanzaFrom: string
	recipient?: string
	isNodeFromMe: boolean
	isGroup: boolean
	isRetry: boolean
	recentMessageTo?: string
}

/**
 * Preserve the original chat route for retry receipts. WhatsApp can omit the
 * `recipient` attribute on own-device/LID receipts; the stanza's remote
 * context remains a valid fallback and must never be replaced with undefined.
 */
export const resolveRetryReceiptRoute = ({
	stanzaFrom,
	recipient,
	isNodeFromMe,
	isGroup,
	isRetry,
	recentMessageTo
}: RetryReceiptRouteInput): { remoteJid: string | undefined; source: RetryReceiptRouteSource } => {
	if (!isNodeFromMe || isGroup) return { remoteJid: stanzaFrom, source: 'stanza-remote-context' }
	if (recipient) return { remoteJid: recipient, source: 'recipient-attribute' }
	if (recentMessageTo) return { remoteJid: recentMessageTo, source: 'recent-message-cache' }
	if (isRetry) return { remoteJid: undefined, source: 'unresolved' }
	return { remoteJid: stanzaFrom, source: 'stanza-remote-context' }
}

/**
 * Chooses a retry relay destination without reintroducing a PN/LID mismatch.
 * A persisted LID is authoritative for the original wire route; an older PN
 * cache entry may be upgraded to the now-known canonical LID after a mapping
 * was learned between the initial send and the retry receipt.
 * `exactCachedRoute` must come from a destination+id lookup, never the
 * unique-message-id fallback used only to restore an omitted receipt route.
 */
export const resolveRetryRelayDestination = (
	exactCachedRoute?: string,
	canonicalRoute?: string
): string | undefined => {
	const cached = exactCachedRoute ? jidNormalizedUser(exactCachedRoute) : ''
	const canonical = canonicalRoute ? jidNormalizedUser(canonicalRoute) : ''
	const validCached = cached && isValidRetryRelayRoute(cached) ? cached : undefined
	const validCanonical = canonical && isValidRetryRelayRoute(canonical) ? canonical : undefined
	if (!validCached) return validCanonical
	if (isAnyPnUser(cached) && validCanonical && isAnyLidUser(validCanonical)) return validCanonical

	return validCached
}

/** Pure state transition used inside the per-message retry lock. */
export const nextRetrySendAttempt = (current: number, maximum: number): { proceed: boolean; count: number } =>
	current >= maximum ? { proceed: false, count: current } : { proceed: true, count: current + 1 }

export const hasRetrySendBudget = (current: number, maximum: number): boolean => current < maximum

export const shouldIncludeRetryKeysForSession = (
	retryCount: number,
	forceIncludeKeys: boolean,
	sessionExists?: boolean
): boolean => retryCount > 1 || forceIncludeKeys || sessionExists === false

export type RetryCounterStore = {
	get(key: string): Promise<number | undefined> | number | undefined
	set(key: string, value: number): Promise<void> | void | number | boolean
}

export type RetrySendReservation = {
	proceed: boolean
	count: number
	reservationFailure?: 'write-rejected' | 'verification-failed'
}

/**
 * Reserve one resend attempt and prove that the counter was persisted before
 * allowing the relay. A saturated or lossy cache must fail closed; otherwise
 * each repeated receipt would observe the same old value and bypass the cap.
 * Callers still provide the per-key lock around this operation.
 */
export const persistRetrySendReservation = async (
	store: RetryCounterStore,
	key: string,
	maximum: number
): Promise<RetrySendReservation> => {
	const current = (await store.get(key)) ?? 0
	const attempt = nextRetrySendAttempt(current, maximum)
	if (!attempt.proceed) return attempt

	const writeResult = await store.set(key, attempt.count)
	if (writeResult === false) {
		return { proceed: false, count: current, reservationFailure: 'write-rejected' }
	}

	const stored = await store.get(key)
	if (stored !== attempt.count) {
		return { proceed: false, count: current, reservationFailure: 'verification-failed' }
	}

	return attempt
}
