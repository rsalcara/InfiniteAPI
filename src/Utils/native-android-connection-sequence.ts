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

const normalizeHost = (host: string) => host.trim().replace(/\.$/, '').toLowerCase()
const normalizeSocketHost = (host: string) => (host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host)

const endpointKey = (endpoint: NativeConnectionCandidate) =>
	`${endpoint.sequenceStep || 0}|${endpoint.source || 'configured'}|${(endpoint.connectHosts || [endpoint.connectHost]).join(',').toLowerCase()}|${endpoint.host.toLowerCase()}|${endpoint.port}`

const normalizeUnique = (seen: Set<string>, endpoint: NativeConnectionCandidate | undefined) => {
	if (!endpoint || !endpoint.host || !endpoint.connectHost || !validPort(endpoint.port)) return
	const normalized = {
		...endpoint,
		host: normalizeHost(endpoint.host),
		connectHost: endpoint.connectHost.trim(),
		connectHosts: endpoint.connectHosts?.map(host => host.trim()),
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

const timeoutAfter = <T>(promise: Promise<T>, timeoutMs: number, message: string) =>
	new Promise<T>((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error(message)), timeoutMs)
		promise.then(
			value => {
				clearTimeout(timer)
				resolve(value)
			},
			error => {
				clearTimeout(timer)
				reject(error)
			}
		)
	})

const systemLookup: NativeAndroidDnsLookup = async host => {
	const records = await dns.lookup(host, { all: true, verbatim: true })
	return records.map(record => record.address)
}

const resolveAll = async (
	host: string,
	lookup: NativeAndroidDnsLookup,
	timeoutMs: number
): Promise<{ addresses: string[]; cached: boolean }> => {
	const normalized = normalizeHost(host)
	const cached = dnsCache.get(normalized)
	if (cached && cached.expiresAt > Date.now()) return { addresses: [...cached.addresses], cached: true }
	if (cached) dnsCache.delete(normalized)

	const addresses = [
		...new Set(
			await timeoutAfter(lookup(normalized), timeoutMs, `native_android: DNS lookup timed out for ${normalized}`)
		)
	]
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
}

class NativeAndroidSequenceTimeoutError extends Error {}

export async function* iterateNativeAndroidConnectionSequence({
	config,
	persisted,
	random = Math.random,
	lookup = systemLookup,
	dnsTimeoutMs = DEFAULT_DNS_TIMEOUT_MS,
	sequenceDeadline
}: NativeAndroidConnectionSequenceOptions): AsyncGenerator<NativeConnectionCandidate> {
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
			const resolved = await resolveAll(endpoint.host, lookup, currentDnsTimeout())
			const selected = selectOfficialAddresses(resolved.addresses, random)
			if (selected.length === 0) return []
			const candidate = addEndpoint({ ...endpoint, address: selected[0] }, addressSource, selected, resolved.cached)
			return candidate ? [candidate] : []
		} catch (error) {
			if (error instanceof NativeAndroidSequenceTimeoutError) throw error
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
				: await resolveAll(host, lookup, currentDnsTimeout())
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
			if (error instanceof NativeAndroidSequenceTimeoutError) throw error
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

const remainingTime = (deadline: number) => Math.max(1, deadline - Date.now())

const readHttpHeader = (socket: net.Socket, deadline: number) =>
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
			if (error) reject(error)
			return true
		}

		const onError = (error: Error) => finish(error)
		const onData = (chunk: Buffer) => {
			buffered = Buffer.concat([buffered, chunk])
			const end = buffered.indexOf('\r\n\r\n')
			if (end < 0) {
				if (buffered.length > 16 * 1024) finish(new Error('native_android: proxy response header is too large'))
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
	})

const connectDirect = (host: string, port: number, deadline: number) =>
	new Promise<net.Socket>((resolve, reject) => {
		const socket = net.createConnection({ host, port })
		const timer = setTimeout(
			() => socket.destroy(new Error('native_android: TCP connect timed out')),
			remainingTime(deadline)
		)
		const cleanup = () => {
			clearTimeout(timer)
			socket.off('error', onError)
		}

		const onError = (error: Error) => {
			cleanup()
			reject(error)
		}

		socket.once('error', onError)
		socket.once('connect', () => {
			cleanup()
			resolve(socket)
		})
	})

const connectTlsProxy = (host: string, port: number, deadline: number) =>
	new Promise<tls.TLSSocket>((resolve, reject) => {
		const socket = tls.connect({ host, port, servername: net.isIP(host) ? undefined : host })
		const timer = setTimeout(
			() => socket.destroy(new Error('native_android: TLS proxy connect timed out')),
			remainingTime(deadline)
		)
		const cleanup = () => {
			clearTimeout(timer)
			socket.off('error', onError)
		}

		const onError = (error: Error) => {
			cleanup()
			reject(error)
		}

		socket.once('error', onError)
		socket.once('secureConnect', () => {
			cleanup()
			resolve(socket)
		})
	})

const connectHttpProxy = async (
	proxy: NativeAndroidProxyConfig,
	candidate: NativeConnectionCandidate,
	deadline: number
) => {
	const socket =
		proxy.type === 'https-connect'
			? await connectTlsProxy(normalizeSocketHost(proxy.host), proxy.port, deadline)
			: await connectDirect(normalizeSocketHost(proxy.host), proxy.port, deadline)
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
		const response = (await readHttpHeader(socket, deadline)).toString('latin1')
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
	deadline: number
) => {
	const { SocksClient } = await import('socks')
	const result = await SocksClient.createConnection({
		command: 'connect',
		timeout: remainingTime(deadline),
		proxy: {
			host: normalizeSocketHost(proxy.host),
			port: proxy.port,
			type: proxy.type === 'socks4' ? 4 : 5,
			userId: proxy.username,
			password: proxy.password
		},
		destination: { host: candidate.connectHost, port: candidate.port }
	})
	return result.socket
}

const connectHappyEyeballs = (
	hosts: string[],
	connect: (host: string) => Promise<net.Socket>
): Promise<{ socket: net.Socket; host: string }> => {
	const uniqueHosts = [...new Set(hosts)]
	if (uniqueHosts.length === 1) return connect(uniqueHosts[0]!).then(socket => ({ socket, host: uniqueHosts[0]! }))

	return new Promise((resolve, reject) => {
		let nextIndex = 0
		let failures = 0
		let settled = false
		let staggerTimer: ReturnType<typeof setTimeout> | undefined
		let lastError: Error | undefined

		const startNext = () => {
			if (nextIndex >= uniqueHosts.length) return
			const host = uniqueHosts[nextIndex++]!
			void connect(host).then(
				socket => {
					if (settled) {
						socket.destroy()
						return
					}

					settled = true
					if (staggerTimer) clearTimeout(staggerTimer)
					resolve({ socket, host })
				},
				error => {
					failures++
					lastError = error instanceof Error ? error : new Error(String(error))
					if (nextIndex < uniqueHosts.length) {
						if (staggerTimer) clearTimeout(staggerTimer)
						startNext()
					} else if (!settled && failures === uniqueHosts.length) {
						settled = true
						reject(lastError)
					}
				}
			)
		}

		startNext()
		staggerTimer = setTimeout(startNext, HAPPY_EYEBALLS_DELAY_MS)
	})
}

const connectedHostBySocket = new WeakMap<net.Socket, string>()

export const connectNativeAndroidCandidate = (
	candidate: NativeConnectionCandidate,
	proxy: NativeAndroidProxyConfig | undefined,
	timeoutMs: number
) => {
	const deadline = Date.now() + timeoutMs
	const hosts = candidate.connectHosts?.length ? candidate.connectHosts : [candidate.connectHost]
	return connectHappyEyeballs(hosts, host => {
		const selected = { ...candidate, connectHost: host, connectHosts: undefined }
		if (!proxy) return connectDirect(host, selected.port, deadline)
		return proxy.type === 'socks4' || proxy.type === 'socks5'
			? connectSocksProxy(proxy, selected, deadline)
			: connectHttpProxy(proxy, selected, deadline)
	}).then(({ socket, host }) => {
		connectedHostBySocket.set(socket, host)
		return socket
	})
}

export const getNativeAndroidConnectedHost = (socket: net.Socket) => connectedHostBySocket.get(socket)

export const clearNativeAndroidDnsCache = () => dnsCache.clear()
