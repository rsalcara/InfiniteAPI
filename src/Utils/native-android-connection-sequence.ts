import { promises as dns } from 'dns'
import net from 'net'
import tls from 'tls'
import type {
	NativeAndroidConnectionEndpoint,
	NativeAndroidProxyConfig,
	NativeAndroidTransportConfig,
	PersistedNativeAndroidIdentity
} from '../Types'
import { resolveNativeAndroidHardcodedAddresses } from './native-android-hardcoded-addresses'

const PRIMARY_HOST = 'g.whatsapp.net'
const FALLBACK_HOST = 'g-fallback.whatsapp.net'
const EDGE_HOSTS = Array.from({ length: 16 }, (_, index) => `e${index + 1}.whatsapp.net`)
const DNS_TTL_MS = 60 * 60 * 1000
const DNS_CACHE_MAX_ENTRIES = 64
const DEFAULT_DNS_TIMEOUT_MS = 20_000
const HAPPY_EYEBALLS_DELAY_MS = 250
const MAX_NODE_TIMER_MS = 2_147_483_647
const MAX_HTTP_PROXY_HEADER_BYTES = 16 * 1024

type CachedAddresses = { expiresAt: number; addresses: string[] }
const dnsCache = new Map<string, CachedAddresses>()

export const parseNativeAndroidProxyUrl = (value: string): NativeAndroidProxyConfig => {
	const parsed = new URL(value)
	const protocol = parsed.protocol.toLowerCase()
	const type =
		protocol === 'http:'
			? 'http-connect'
			: protocol === 'https:'
				? 'https-connect'
				: protocol === 'socks4:' || protocol === 'socks4a:'
					? 'socks4'
					: protocol === 'socks:' || protocol === 'socks5:' || protocol === 'socks5h:'
						? 'socks5'
						: undefined
	if (!type) throw new Error(`native_android: unsupported proxy protocol ${protocol || '(missing)'}`)
	if (!parsed.hostname) throw new Error('native_android: proxy URL is missing a host')
	const defaultPort = type === 'https-connect' ? 443 : type === 'http-connect' ? 80 : 1080
	const port = parsed.port ? Number.parseInt(parsed.port, 10) : defaultPort
	if (!validPort(port)) throw new Error('native_android: proxy URL has an invalid port')

	const proxyHost =
		parsed.hostname.startsWith('[') && parsed.hostname.endsWith(']') ? parsed.hostname.slice(1, -1) : parsed.hostname

	return {
		type,
		host: proxyHost,
		port,
		username: parsed.username ? decodeURIComponent(parsed.username) : undefined,
		password: parsed.password ? decodeURIComponent(parsed.password) : undefined,
		resolveDns: protocol === 'socks4:' ? false : protocol === 'socks4a:' || protocol === 'socks5h:' ? true : undefined
	}
}

export type NativeConnectionCandidate = NativeAndroidConnectionEndpoint & {
	connectHost: string
	/** At most one randomly selected IPv4 and IPv6 address, as in Android Happy Eyeballs. */
	connectHosts?: string[]
	addressSource: number
	dnsCached: boolean
}

const validPort = (port: number) => Number.isInteger(port) && port >= 1 && port <= 65535

const normalizeSocketHost = (host: string) => (host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host)
const normalizeHost = (host: string) => normalizeSocketHost(host.trim().replace(/\.$/, '').toLowerCase())

const endpointKey = (endpoint: NativeConnectionCandidate) =>
	`${endpoint.sequenceStep || 0}|${endpoint.source || 'configured'}|${(endpoint.connectHosts || [endpoint.connectHost]).join(',').toLowerCase()}|${endpoint.host.toLowerCase()}|${endpoint.port}`

const normalizeUnique = (seen: Set<string>, endpoint: NativeConnectionCandidate | undefined) => {
	if (!endpoint || !endpoint.host || !endpoint.connectHost || !validPort(endpoint.port)) return
	const normalized = {
		...endpoint,
		host: normalizeHost(endpoint.host),
		connectHost: normalizeSocketHost(endpoint.connectHost.trim()),
		connectHosts: endpoint.connectHosts?.map(host => normalizeSocketHost(host.trim())),
		source: endpoint.source || 'configured',
		addressSource: endpoint.addressSource ?? 1,
		dnsCached: endpoint.dnsCached ?? false
	}
	const key = endpointKey(normalized)
	if (!seen.has(key)) {
		seen.add(key)
		return normalized
	}
}

type NativeAndroidDnsLookup = (host: string) => Promise<string[]>

const abortError = () => {
	const error = new Error('native_android: connection attempt aborted')
	error.name = 'AbortError'
	return error
}

const throwIfAborted = (signal?: AbortSignal) => {
	if (signal?.aborted) throw abortError()
}

const timeoutAfter = <T>(promise: Promise<T>, timeoutMs: number, message: string, signal?: AbortSignal) =>
	new Promise<T>((resolve, reject) => {
		let settled = false
		const finish = (error?: unknown, value?: T) => {
			if (settled) return
			settled = true
			clearTimeout(timer)
			signal?.removeEventListener('abort', onAbort)
			if (error !== undefined) reject(error)
			else resolve(value as T)
		}

		const onAbort = () => finish(abortError())
		const timer = setTimeout(() => finish(new Error(message)), Math.min(Math.max(1, timeoutMs), MAX_NODE_TIMER_MS))
		if (signal?.aborted) {
			finish(abortError())
			return
		}

		signal?.addEventListener('abort', onAbort, { once: true })
		promise.then(
			value => finish(undefined, value),
			error => finish(error)
		)
	})

const systemLookup: NativeAndroidDnsLookup = async host => {
	const records = await dns.lookup(host, { all: true, verbatim: true })
	return records.map(record => record.address)
}

const resolveAll = async (
	host: string,
	lookup: NativeAndroidDnsLookup,
	timeoutMs: number,
	signal?: AbortSignal
): Promise<{ addresses: string[]; cached: boolean }> => {
	throwIfAborted(signal)
	const normalized = normalizeHost(host)
	const cached = dnsCache.get(normalized)
	if (cached && cached.expiresAt > Date.now()) return { addresses: [...cached.addresses], cached: true }
	if (cached) dnsCache.delete(normalized)

	const addresses = [
		...new Set(
			(
				await timeoutAfter(
					lookup(normalized),
					timeoutMs,
					`native_android: DNS lookup timed out for ${normalized}`,
					signal
				)
			).filter((address): address is string => typeof address === 'string' && net.isIP(address) !== 0)
		)
	]
	if (addresses.length === 0) return { addresses: [], cached: false }

	for (const [cachedHost, entry] of dnsCache) {
		if (entry.expiresAt <= Date.now()) dnsCache.delete(cachedHost)
	}

	while (dnsCache.size >= DNS_CACHE_MAX_ENTRIES) {
		const oldest = dnsCache.keys().next().value
		if (oldest === undefined) break
		dnsCache.delete(oldest)
	}

	dnsCache.set(normalized, { expiresAt: Date.now() + DNS_TTL_MS, addresses })
	return { addresses, cached: false }
}

const randomIndex = (length: number, random: () => number) =>
	Math.floor(Math.max(0, Math.min(0.999999999, random())) * length)

const selectOfficialAddresses = (addresses: string[], random: () => number) => {
	const ipv4 = addresses.filter(address => net.isIPv4(address))
	const ipv6 = addresses.filter(address => net.isIPv6(address))
	if (ipv4.length && ipv6.length)
		return [ipv4[randomIndex(ipv4.length, random)]!, ipv6[randomIndex(ipv6.length, random)]!]
	const available = ipv4.length ? ipv4 : ipv6
	return available.length ? [available[randomIndex(available.length, random)]!] : []
}

type NativeAndroidConnectionSequenceOptions = {
	config: NativeAndroidTransportConfig
	persisted?: PersistedNativeAndroidIdentity
	random?: () => number
	lookup?: NativeAndroidDnsLookup
	dnsTimeoutMs?: number
	sequenceDeadline?: number
	signal?: AbortSignal
}

class NativeAndroidSequenceTimeoutError extends Error {}

export async function* iterateNativeAndroidConnectionSequence({
	config,
	persisted,
	random = Math.random,
	lookup = systemLookup,
	dnsTimeoutMs = DEFAULT_DNS_TIMEOUT_MS,
	sequenceDeadline,
	signal
}: NativeAndroidConnectionSequenceOptions): AsyncGenerator<NativeConnectionCandidate> {
	throwIfAborted(signal)
	const seen = new Set<string>()
	const configuredHost = normalizeHost(config.host || PRIMARY_HOST)
	const hardcodedAddresses = resolveNativeAndroidHardcodedAddresses(config.hardcodedAddresses)
	const currentDnsTimeout = () => {
		if (sequenceDeadline === undefined) return dnsTimeoutMs
		const remaining = sequenceDeadline - Date.now()
		if (remaining <= 0) throw new NativeAndroidSequenceTimeoutError('native_android: connection sequence timed out')
		return Math.min(dnsTimeoutMs, remaining)
	}

	const officialPortForStep = (sequenceStep: number) => {
		const history = persisted?.connectionEndpoint
		if (history?.sequenceStep === sequenceStep && history.port !== 80 && validPort(history.port)) return history.port
		return random() < 0.5 ? 443 : 5222
	}

	const addEndpoint = (
		endpoint: NativeAndroidConnectionEndpoint | undefined,
		addressSource = 3,
		connectHosts?: string[],
		dnsCached = false
	) =>
		normalizeUnique(
			seen,
			endpoint
				? {
						...endpoint,
						connectHost: connectHosts?.[0] || endpoint.address || endpoint.host,
						connectHosts,
						addressSource,
						dnsCached
					}
				: undefined
		)
	const proxyUsesRemoteDns =
		config.proxy &&
		(config.proxy.type === 'http-connect' ||
			config.proxy.type === 'https-connect' ||
			(config.proxy.resolveDns ?? config.proxy.type === 'socks5'))
	const expandEndpoint = async (endpoint: NativeAndroidConnectionEndpoint, addressSource = 3) => {
		if (endpoint.address || net.isIP(endpoint.host) || proxyUsesRemoteDns) {
			const candidate = addEndpoint(endpoint, addressSource)
			return candidate ? [candidate] : []
		}

		try {
			const resolved = await resolveAll(endpoint.host, lookup, currentDnsTimeout(), signal)
			const selected = selectOfficialAddresses(resolved.addresses, random)
			if (selected.length === 0) return []
			const candidate = addEndpoint({ ...endpoint, address: selected[0] }, addressSource, selected, resolved.cached)
			return candidate ? [candidate] : []
		} catch (error) {
			if (error instanceof NativeAndroidSequenceTimeoutError || (error as Error)?.name === 'AbortError') throw error
			return []
		}
	}

	if (config.host || config.port) {
		for (const candidate of await expandEndpoint({
			host: configuredHost,
			port: config.port || 443,
			source: 'configured',
			sequenceStep: 1
		}))
			yield candidate
	}

	const serverEndpoints = config.connectionEndpoints || []
	for (const endpoint of serverEndpoints.filter(endpoint => endpoint.sequenceStep !== 8)) {
		for (const candidate of await expandEndpoint({
			...endpoint,
			source: 'server',
			sequenceStep: endpoint.sequenceStep ?? 2
		}))
			yield candidate
	}

	const resolveHostCandidates = async (
		host: string,
		port: number,
		source: NativeAndroidConnectionEndpoint['source'],
		sequenceStep: number,
		addresses?: readonly string[]
	): Promise<NativeConnectionCandidate[]> => {
		if (source === 'hardcoded' && !addresses) return []
		if (proxyUsesRemoteDns && !addresses) {
			const candidate = addEndpoint({ host, port, source, sequenceStep }, 1)
			return candidate ? [candidate] : []
		}

		try {
			const resolved = addresses
				? { addresses: [...addresses], cached: false }
				: await resolveAll(host, lookup, currentDnsTimeout(), signal)
			const selected = selectOfficialAddresses(resolved.addresses, random)
			if (selected.length === 0) return []
			const candidate = addEndpoint(
				{ host, address: selected[0], port, source, sequenceStep },
				addresses ? 2 : 1,
				selected,
				resolved.cached
			)
			return candidate ? [candidate] : []
		} catch (error) {
			if (error instanceof NativeAndroidSequenceTimeoutError || (error as Error)?.name === 'AbortError') throw error
			// The following hardcoded/fallback stages remain eligible.
			return []
		}
	}

	for (const candidate of await resolveHostCandidates(PRIMARY_HOST, officialPortForStep(5), 'dns', 5)) yield candidate

	for (const endpoint of serverEndpoints.filter(endpoint => endpoint.sequenceStep === 8)) {
		for (const candidate of await expandEndpoint({ ...endpoint, source: 'server', sequenceStep: 8 }, 4)) yield candidate
	}

	for (const candidate of await resolveHostCandidates(PRIMARY_HOST, 80, 'fallback', 9)) yield candidate

	// Android inserts HISTORY after state 9 only for steps whose address can
	// be reconstructed safely. ClientPayload reports the original step, not 15.
	const persistedStep = persisted?.connectionEndpoint?.sequenceStep
	if (persistedStep && [6, 7, 10, 11, 13, 14].includes(persistedStep)) {
		for (const history of await expandEndpoint({
			...persisted!.connectionEndpoint!,
			source: 'history',
			sequenceStep: persistedStep
		}))
			yield history
	}

	const fallbackPort = officialPortForStep(13)
	for (const candidate of await resolveHostCandidates(FALLBACK_HOST, fallbackPort, 'fallback', 13)) yield candidate
	for (const candidate of await resolveHostCandidates(FALLBACK_HOST, 80, 'fallback', 14)) yield candidate
	for (const candidate of await resolveHostCandidates(
		FALLBACK_HOST,
		fallbackPort,
		'hardcoded',
		13,
		hardcodedAddresses[FALLBACK_HOST]
	))
		yield candidate
	for (const candidate of await resolveHostCandidates(
		FALLBACK_HOST,
		80,
		'hardcoded',
		14,
		hardcodedAddresses[FALLBACK_HOST]
	))
		yield candidate

	const hardcodedPort = officialPortForStep(6)
	for (const candidate of await resolveHostCandidates(
		PRIMARY_HOST,
		hardcodedPort,
		'hardcoded',
		6,
		hardcodedAddresses[PRIMARY_HOST]
	))
		yield candidate
	for (const candidate of await resolveHostCandidates(
		PRIMARY_HOST,
		80,
		'hardcoded',
		10,
		hardcodedAddresses[PRIMARY_HOST]
	))
		yield candidate

	// Android A04() independently selects exactly one e1-e16 host whenever
	// state 7 or 11 is entered; it never rotates through all 16 hosts.
	const edge = EDGE_HOSTS[randomIndex(EDGE_HOSTS.length, random)]!
	const edgePort = officialPortForStep(7)
	for (const candidate of await resolveHostCandidates(edge, edgePort, 'edge', 7)) yield candidate
	for (const candidate of await resolveHostCandidates(edge, edgePort, 'hardcoded', 7, hardcodedAddresses[edge]))
		yield candidate
	const edge80 = EDGE_HOSTS[randomIndex(EDGE_HOSTS.length, random)]!
	for (const candidate of await resolveHostCandidates(edge80, 80, 'edge', 11)) yield candidate
	for (const candidate of await resolveHostCandidates(edge80, 80, 'hardcoded', 11, hardcodedAddresses[edge80]))
		yield candidate
}

export const buildNativeAndroidConnectionSequence = async (options: NativeAndroidConnectionSequenceOptions) => {
	const candidates: NativeConnectionCandidate[] = []
	for await (const candidate of iterateNativeAndroidConnectionSequence(options)) candidates.push(candidate)
	return candidates
}

const remainingTime = (deadline: number) => Math.min(Math.max(1, deadline - Date.now()), MAX_NODE_TIMER_MS)

const readHttpHeader = (socket: net.Socket, deadline: number, signal?: AbortSignal) =>
	new Promise<Buffer>((resolve, reject) => {
		let buffered = Buffer.alloc(0)
		let settled = false
		const timer = setTimeout(
			() => finish(new Error('native_android: HTTP CONNECT proxy timed out')),
			remainingTime(deadline)
		)
		const finish = (error?: Error) => {
			if (settled) return false
			settled = true
			clearTimeout(timer)
			socket.off('data', onData)
			socket.off('error', onError)
			signal?.removeEventListener('abort', onAbort)
			if (error) reject(error)
			return true
		}

		const onError = (error: Error) => finish(error)
		const onAbort = () => finish(abortError())
		const onData = (chunk: Buffer) => {
			buffered = Buffer.concat([buffered, chunk])
			const end = buffered.indexOf('\r\n\r\n')
			if (end < 0) {
				if (buffered.length > MAX_HTTP_PROXY_HEADER_BYTES)
					finish(new Error('native_android: proxy response header is too large'))
				return
			}

			if (end + 4 > MAX_HTTP_PROXY_HEADER_BYTES) {
				finish(new Error('native_android: proxy response header is too large'))
				return
			}

			const header = buffered.subarray(0, end + 4)
			const remainder = buffered.subarray(end + 4)
			if (!finish()) return
			if (remainder.length) socket.unshift(remainder)
			resolve(header)
		}

		socket.on('data', onData)
		socket.once('error', onError)
		if (signal?.aborted) finish(abortError())
		else signal?.addEventListener('abort', onAbort, { once: true })
	})

const connectDirect = (host: string, port: number, deadline: number, signal?: AbortSignal) =>
	new Promise<net.Socket>((resolve, reject) => {
		const socket = net.createConnection({ host, port })
		const timer = setTimeout(
			() => socket.destroy(new Error('native_android: TCP connect timed out')),
			remainingTime(deadline)
		)
		const cleanup = () => {
			clearTimeout(timer)
			socket.off('error', onError)
			signal?.removeEventListener('abort', onAbort)
		}

		const onError = (error: Error) => {
			cleanup()
			reject(error)
		}

		const onAbort = () => socket.destroy(abortError())

		socket.once('error', onError)
		if (signal?.aborted) onAbort()
		else signal?.addEventListener('abort', onAbort, { once: true })
		socket.once('connect', () => {
			cleanup()
			resolve(socket)
		})
	})

const connectTlsProxy = (host: string, port: number, deadline: number, signal?: AbortSignal) =>
	new Promise<tls.TLSSocket>((resolve, reject) => {
		const socket = tls.connect({ host, port, servername: net.isIP(host) ? undefined : host })
		const timer = setTimeout(
			() => socket.destroy(new Error('native_android: TLS proxy connect timed out')),
			remainingTime(deadline)
		)
		const cleanup = () => {
			clearTimeout(timer)
			socket.off('error', onError)
			signal?.removeEventListener('abort', onAbort)
		}

		const onError = (error: Error) => {
			cleanup()
			reject(error)
		}

		const onAbort = () => socket.destroy(abortError())

		socket.once('error', onError)
		if (signal?.aborted) onAbort()
		else signal?.addEventListener('abort', onAbort, { once: true })
		socket.once('secureConnect', () => {
			cleanup()
			resolve(socket)
		})
	})

const connectHttpProxy = async (
	proxy: NativeAndroidProxyConfig,
	candidate: NativeConnectionCandidate,
	deadline: number,
	signal?: AbortSignal
) => {
	const socket =
		proxy.type === 'https-connect'
			? await connectTlsProxy(normalizeSocketHost(proxy.host), proxy.port, deadline, signal)
			: await connectDirect(normalizeSocketHost(proxy.host), proxy.port, deadline, signal)
	try {
		const authorityHost = net.isIPv6(candidate.connectHost) ? `[${candidate.connectHost}]` : candidate.connectHost
		const authority = `${authorityHost}:${candidate.port}`
		const authorization =
			proxy.username !== undefined
				? `Proxy-Authorization: Basic ${Buffer.from(`${proxy.username}:${proxy.password || ''}`).toString('base64')}\r\n`
				: ''
		socket.write(
			`CONNECT ${authority} HTTP/1.1\r\nHost: ${authority}\r\n${authorization}Connection: keep-alive\r\n\r\n`
		)
		const response = (await readHttpHeader(socket, deadline, signal)).toString('latin1')
		const status = /^HTTP\/\d(?:\.\d)?\s+(\d{3})/.exec(response)?.[1]
		if (status !== '200') {
			throw new Error(`native_android: HTTP CONNECT proxy rejected the tunnel (${status || 'invalid response'})`)
		}

		return socket
	} catch (error) {
		socket.destroy()
		throw error
	}
}

const connectSocksProxy = async (
	proxy: NativeAndroidProxyConfig,
	candidate: NativeConnectionCandidate,
	deadline: number,
	signal?: AbortSignal
) => {
	throwIfAborted(signal)
	const { SocksClient } = await import('socks')
	const proxySocket = await connectDirect(normalizeSocketHost(proxy.host), proxy.port, deadline, signal)
	const connection = SocksClient.createConnection({
		command: 'connect',
		timeout: remainingTime(deadline),
		existing_socket: proxySocket,
		proxy: {
			host: normalizeSocketHost(proxy.host),
			port: proxy.port,
			type: proxy.type === 'socks4' ? 4 : 5,
			userId: proxy.username,
			password: proxy.password
		},
		destination: { host: candidate.connectHost, port: candidate.port }
	})
	if (!signal) return (await connection).socket

	return new Promise<net.Socket>((resolve, reject) => {
		let settled = false
		const onAbort = () => {
			if (settled) return
			settled = true
			proxySocket.destroy(abortError())
			reject(abortError())
		}

		signal.addEventListener('abort', onAbort, { once: true })
		if (signal.aborted) onAbort()
		connection.then(
			result => {
				signal.removeEventListener('abort', onAbort)
				if (settled || signal.aborted) {
					result.socket.destroy()
					if (!settled) reject(abortError())
					return
				}

				settled = true
				resolve(result.socket)
			},
			error => {
				signal.removeEventListener('abort', onAbort)
				if (settled) return
				settled = true
				if (!proxySocket.destroyed) proxySocket.destroy()
				reject(error)
			}
		)
	})
}

const connectHappyEyeballs = (
	hosts: string[],
	connect: (host: string, signal: AbortSignal) => Promise<net.Socket>,
	signal?: AbortSignal
): Promise<{ socket: net.Socket; host: string }> => {
	const uniqueHosts = [...new Set(hosts)]

	return new Promise((resolve, reject) => {
		let nextIndex = 0
		let failures = 0
		let settled = false
		let lastError: Error | undefined
		let staggerTimer: NodeJS.Timeout | undefined
		const controllers = new Set<AbortController>()
		const abortAll = (except?: AbortController) => {
			for (const controller of controllers) if (controller !== except) controller.abort()
		}

		const onAbort = () => {
			if (settled) return
			settled = true
			if (staggerTimer) clearTimeout(staggerTimer)
			abortAll()
			reject(abortError())
		}

		const startNext = () => {
			if (settled || nextIndex >= uniqueHosts.length) return
			const host = uniqueHosts[nextIndex++]!
			const controller = new AbortController()
			controllers.add(controller)
			void connect(host, controller.signal).then(
				socket => {
					controllers.delete(controller)
					if (settled) {
						socket.destroy()
						return
					}

					settled = true
					if (staggerTimer) clearTimeout(staggerTimer)
					signal?.removeEventListener('abort', onAbort)
					abortAll(controller)
					resolve({ socket, host })
				},
				error => {
					controllers.delete(controller)
					if (settled) return
					failures++
					lastError = error instanceof Error ? error : new Error(String(error))
					if (nextIndex < uniqueHosts.length) {
						if (staggerTimer) clearTimeout(staggerTimer)
						startNext()
					} else if (!settled && failures === uniqueHosts.length) {
						settled = true
						signal?.removeEventListener('abort', onAbort)
						reject(lastError)
					}
				}
			)
		}

		if (signal?.aborted) {
			onAbort()
			return
		}

		signal?.addEventListener('abort', onAbort, { once: true })
		startNext()
		if (uniqueHosts.length > 1) staggerTimer = setTimeout(startNext, HAPPY_EYEBALLS_DELAY_MS)
	})
}

const connectedHostBySocket = new WeakMap<net.Socket, string>()

export const connectNativeAndroidCandidate = (
	candidate: NativeConnectionCandidate,
	proxy: NativeAndroidProxyConfig | undefined,
	timeoutMs: number,
	signal?: AbortSignal
) => {
	throwIfAborted(signal)
	const deadline = Date.now() + timeoutMs
	const hosts = candidate.connectHosts?.length ? candidate.connectHosts : [candidate.connectHost]
	return connectHappyEyeballs(
		hosts,
		(host, attemptSignal) => {
			const selected = { ...candidate, connectHost: host, connectHosts: undefined }
			if (!proxy) return connectDirect(host, selected.port, deadline, attemptSignal)
			return proxy.type === 'socks4' || proxy.type === 'socks5'
				? connectSocksProxy(proxy, selected, deadline, attemptSignal)
				: connectHttpProxy(proxy, selected, deadline, attemptSignal)
		},
		signal
	).then(({ socket, host }) => {
		connectedHostBySocket.set(socket, host)
		return socket
	})
}

export const getNativeAndroidConnectedHost = (socket: net.Socket) => connectedHostBySocket.get(socket)

export const clearNativeAndroidDnsCache = () => dnsCache.clear()
