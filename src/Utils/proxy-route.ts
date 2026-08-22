import { Boom } from '@hapi/boom'
import type { Agent } from 'https'
import net from 'net'
import type { ConnectionTransportProfile, FetchDispatcher, SocketConfig } from '../Types'

export type ProxyRouteAudit = {
	proxyCoverage: 'direct' | 'partial' | 'full'
	proxyPolicyEnforced: boolean
	nativeTcpProxied: boolean
	webSocketProxied: boolean
	httpMediaProxied: boolean
	proxyExpectedEgressIp?: string
	proxyProvider?: string
	proxyRouteId?: string
	proxyVerifiedAt?: string
}

export type ProxyConnectionPhase = 'new_pairing' | 'initial_pair_login' | 'reconnect'

export const resolveProxyConnectionPhase = (config: SocketConfig): ProxyConnectionPhase => {
	const creds = config.auth?.creds
	if (!creds?.me) return 'new_pairing'
	return (creds.accountSyncCounter ?? 0) === 0 ? 'initial_pair_login' : 'reconnect'
}

const optionalNonBlank = (value: string | undefined, label: string) => {
	if (value !== undefined && (typeof value !== 'string' || value.trim().length === 0)) {
		throw new Boom(`${label} must be a non-empty string`, { statusCode: 400 })
	}

	return value?.trim()
}

const isNodeRequestAgent = (agent: unknown): agent is Agent =>
	typeof (agent as { addRequest?: unknown } | undefined)?.addRequest === 'function'

export const isFetchDispatcher = (agent: unknown): agent is FetchDispatcher =>
	typeof (agent as { dispatch?: unknown } | undefined)?.dispatch === 'function'

export const isSupportedHttpAgent = (agent: unknown): boolean => isNodeRequestAgent(agent) || isFetchDispatcher(agent)

/**
 * Makes the socket's fetchAgent authoritative for every internal HTTP/media
 * request. Node request agents and Undici dispatchers are different APIs, so
 * only the matching field is retained.
 */
export const applyFetchAgentToRequestOptions = (
	options: RequestInit,
	fetchAgent: SocketConfig['fetchAgent']
): RequestInit => {
	if (!fetchAgent) return options

	const next = { ...options }
	if (isFetchDispatcher(fetchAgent)) {
		delete next.agent
		next.dispatcher = fetchAgent
	} else if (isNodeRequestAgent(fetchAgent)) {
		delete next.dispatcher
		next.agent = fetchAgent
	}

	return next
}

/**
 * Validates a consumer-declared full proxy route before any WhatsApp network
 * I/O. Agent internals are intentionally opaque; the consumer remains
 * responsible for constructing both agents from the same route record.
 */
export const resolveProxyRouteAudit = (config: SocketConfig, profile: ConnectionTransportProfile): ProxyRouteAudit => {
	const nativeTcpProxied = profile === 'native_android' && Boolean(config.nativeAndroid?.proxy)
	const webSocketProxied = profile === 'web' && Boolean(config.agent)
	const hasHttpMediaAgent = Boolean(config.fetchAgent)
	const httpMediaProxied = isSupportedHttpAgent(config.fetchAgent)
	const configuredCount = Number(nativeTcpProxied) + Number(webSocketProxied) + Number(httpMediaProxied)
	const policy = config.proxyRoute

	if (!policy) {
		return {
			proxyCoverage: configuredCount === 0 ? 'direct' : 'partial',
			proxyPolicyEnforced: false,
			nativeTcpProxied,
			webSocketProxied,
			httpMediaProxied
		}
	}

	if (policy.mode !== 'full') {
		throw new Boom('proxyRoute.mode must be full', { statusCode: 400 })
	}

	if (profile === 'native_android' && !nativeTcpProxied) {
		throw new Boom('proxyRoute full coverage requires nativeAndroid.proxy for native_android', { statusCode: 400 })
	}

	if (profile === 'web' && !webSocketProxied) {
		throw new Boom('proxyRoute full coverage requires agent for the WebSocket transport', { statusCode: 400 })
	}

	if (!hasHttpMediaAgent) {
		throw new Boom('proxyRoute full coverage requires fetchAgent for HTTP and media traffic', { statusCode: 400 })
	}

	if (!isSupportedHttpAgent(config.fetchAgent)) {
		throw new Boom('proxyRoute.fetchAgent must be a Node HTTP agent or an Undici dispatcher', { statusCode: 400 })
	}

	let expectedEgressIp: string | undefined
	if (policy.expectedEgressIp !== undefined) {
		if (typeof policy.expectedEgressIp !== 'string' || net.isIP(policy.expectedEgressIp.trim()) === 0) {
			throw new Boom('proxyRoute.expectedEgressIp must be an IPv4 or IPv6 address', { statusCode: 400 })
		}

		expectedEgressIp = policy.expectedEgressIp.trim()
	}

	const verifiedAt = optionalNonBlank(policy.verifiedAt, 'proxyRoute.verifiedAt')
	const isoTimestamp = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/
	const timestampParts = verifiedAt?.match(isoTimestamp)
	const parsedTimestamp = verifiedAt === undefined ? Number.NaN : Date.parse(verifiedAt)
	let validVerifiedAt = timestampParts !== null && timestampParts !== undefined && !Number.isNaN(parsedTimestamp)
	if (validVerifiedAt && timestampParts) {
		const [, year, month, day, hour, minute, second] = timestampParts
		const calendarDate = new Date(0)
		calendarDate.setUTCFullYear(Number(year), Number(month) - 1, Number(day))
		calendarDate.setUTCHours(0, 0, 0, 0)
		const hourValue = Number(hour)
		const isEndOfDay = hourValue === 24 && Number(minute) === 0 && Number(second) === 0
		const validHour = (hourValue >= 0 && hourValue <= 23) || isEndOfDay
		validVerifiedAt =
			calendarDate.getUTCFullYear() === Number(year) &&
			calendarDate.getUTCMonth() === Number(month) - 1 &&
			calendarDate.getUTCDate() === Number(day) &&
			validHour &&
			Number(minute) >= 0 &&
			Number(minute) <= 59 &&
			Number(second) >= 0 &&
			Number(second) <= 59
	}

	if (verifiedAt !== undefined && !validVerifiedAt) {
		throw new Boom('proxyRoute.verifiedAt must be an ISO-8601 timestamp', { statusCode: 400 })
	}

	return {
		proxyCoverage: 'full',
		proxyPolicyEnforced: true,
		nativeTcpProxied,
		webSocketProxied,
		httpMediaProxied,
		proxyExpectedEgressIp: expectedEgressIp,
		proxyProvider: optionalNonBlank(policy.provider, 'proxyRoute.provider'),
		proxyRouteId: optionalNonBlank(policy.routeId, 'proxyRoute.routeId'),
		proxyVerifiedAt: verifiedAt
	}
}
