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

	return {
		type,
		host: parsed.hostname,
		port,
		username: parsed.username ? decodeURIComponent(parsed.username) : undefined,
		password: parsed.password ? decodeURIComponent(parsed.password) : undefined,
		resolveDns: protocol === 'socks4:' ? false : protocol === 'socks4a:' || protocol === 'socks5h:' ? true : undefined
	}
}

export type NativeConnectionCandidate = NativeAndroidConnectionEndpoint & {
	connectHost: string
	addressSource: number
	dnsCached: boolean
}

const validPort = (port: number) => Number.isInteger(port) && port >= 1 && port <= 65535

const normalizeHost = (host: string) => host.trim().replace(/\.$/, '').toLowerCase()

const endpointKey = (endpoint: NativeConnectionCandidate) =>
	`${endpoint.connectHost.toLowerCase()}|${endpoint.host.toLowerCase()}|${endpoint.port}`

const normalizeUnique = (seen: Set<string>, endpoint: NativeConnectionCandidate | undefined) => {
	if (!endpoint || !endpoint.host || !endpoint.connectHost || !validPort(endpoint.port)) return
	const normalized = {
		...endpoint,
		host: normalizeHost(endpoint.host),
		connectHost: endpoint.connectHost.trim(),
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

const systemLookup: NativeAndroidDnsLookup = async host => {
	const records = await dns.lookup(host, { all: true, verbatim: true })
	return records.map(record => record.address)
}

const resolveAll = async (
	host: string,
	lookup: NativeAndroidDnsLookup
): Promise<{ addresses: string[]; cached: boolean }> => {
	const normalized = normalizeHost(host)
	const cached = dnsCache.get(normalized)
	if (cached && cached.expiresAt > Date.now()) return { addresses: [...cached.addresses], cached: true }

	const addresses = [...new Set(await lookup(normalized))]
	dnsCache.set(normalized, { expiresAt: Date.now() + DNS_TTL_MS, addresses })
	return { addresses, cached: false }
}

type NativeAndroidConnectionSequenceOptions = {
	config: NativeAndroidTransportConfig
	persisted?: PersistedNativeAndroidIdentity
	random?: () => number
	lookup?: NativeAndroidDnsLookup
}

export async function* iterateNativeAndroidConnectionSequence({
	config,
	persisted,
	random = Math.random,
	lookup = systemLookup
}: NativeAndroidConnectionSequenceOptions): AsyncGenerator<NativeConnectionCandidate> {
	const seen = new Set<string>()
	const configuredHost = normalizeHost(config.host || PRIMARY_HOST)
	const hardcodedAddresses = resolveNativeAndroidHardcodedAddresses(config.hardcodedAddresses)
	const officialPortForStep = (sequenceStep: number) => {
		const history = persisted?.connectionEndpoint
		if (history?.sequenceStep === sequenceStep && history.port !== 80 && validPort(history.port)) return history.port
		return random() < 0.5 ? 443 : 5222
	}

	const addEndpoint = (endpoint: NativeAndroidConnectionEndpoint | undefined, addressSource = 3) =>
		normalizeUnique(
			seen,
			endpoint
				? {
						...endpoint,
						connectHost: endpoint.address || endpoint.host,
						addressSource,
						dnsCached: false
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
			const resolved = await resolveAll(endpoint.host, lookup)
			return resolved.addresses.flatMap(address => {
				const candidate = addEndpoint({ ...endpoint, address }, addressSource)
				if (candidate) candidate.dnsCached = resolved.cached
				return candidate ? [candidate] : []
			})
		} catch {
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
		ports: number[],
		source: NativeAndroidConnectionEndpoint['source'],
		sequenceStep: number
	): Promise<NativeConnectionCandidate[]> => {
		const resolvedCandidates: NativeConnectionCandidate[] = []
		if (proxyUsesRemoteDns) {
			for (const port of ports) {
				const candidate = normalizeUnique(seen, {
					host,
					port,
					source,
					sequenceStep,
					connectHost: host,
					addressSource: 1,
					dnsCached: false
				})
				if (candidate) resolvedCandidates.push(candidate)
			}

			return resolvedCandidates
		}

		try {
			const resolved = await resolveAll(host, lookup)
			for (const port of ports) {
				for (const address of resolved.addresses) {
					const candidate = normalizeUnique(seen, {
						host,
						address,
						port,
						source,
						sequenceStep,
						connectHost: address,
						addressSource: 1,
						dnsCached: resolved.cached
					})
					if (candidate) resolvedCandidates.push(candidate)
				}
			}
		} catch {
			// The following hardcoded/fallback stages remain eligible.
		}
		return resolvedCandidates
	}

	for (const candidate of await resolveHostCandidates(PRIMARY_HOST, [officialPortForStep(5)], 'dns', 5)) yield candidate

	for (const endpoint of serverEndpoints.filter(endpoint => endpoint.sequenceStep === 8)) {
		for (const candidate of await expandEndpoint({ ...endpoint, source: 'server', sequenceStep: 8 }, 4)) yield candidate
	}

	for (const candidate of await resolveHostCandidates(PRIMARY_HOST, [80], 'fallback', 9)) yield candidate

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
	for (const candidate of await resolveHostCandidates(FALLBACK_HOST, [fallbackPort], 'fallback', 13)) yield candidate
	for (const candidate of await resolveHostCandidates(FALLBACK_HOST, [80], 'fallback', 14)) yield candidate

	for (const address of hardcodedAddresses[FALLBACK_HOST] || []) {
		for (const port of [fallbackPort, 80]) {
			const candidate = normalizeUnique(seen, {
				host: FALLBACK_HOST,
				address,
				port,
				source: 'hardcoded',
				sequenceStep: port === 80 ? 14 : 13,
				connectHost: address,
				addressSource: 2,
				dnsCached: false
			})
			if (candidate) yield candidate
		}
	}

	const hardcodedPort = officialPortForStep(6)
	for (const address of hardcodedAddresses[PRIMARY_HOST] || []) {
		const candidate = normalizeUnique(seen, {
			host: PRIMARY_HOST,
			address,
			port: hardcodedPort,
			source: 'hardcoded',
			sequenceStep: 6,
			connectHost: address,
			addressSource: 2,
			dnsCached: false
		})
		if (candidate) yield candidate
	}
	for (const address of hardcodedAddresses[PRIMARY_HOST] || []) {
		const candidate = normalizeUnique(seen, {
			host: PRIMARY_HOST,
			address,
			port: 80,
			source: 'hardcoded',
			sequenceStep: 10,
			connectHost: address,
			addressSource: 2,
			dnsCached: false
		})
		if (candidate) yield candidate
	}

	const edgeStart = Math.floor(Math.max(0, Math.min(0.999999, random())) * EDGE_HOSTS.length)
	const edges = [...EDGE_HOSTS.slice(edgeStart), ...EDGE_HOSTS.slice(0, edgeStart)]
	for (const edge of edges) {
		const edgePort = officialPortForStep(7)
		for (const candidate of await resolveHostCandidates(edge, [edgePort], 'edge', 7)) yield candidate
		for (const candidate of await resolveHostCandidates(edge, [80], 'edge', 11)) yield candidate
		for (const address of hardcodedAddresses[edge] || []) {
			for (const port of [edgePort, 80]) {
				const candidate = normalizeUnique(seen, {
					host: edge,
					address,
					port,
					source: 'hardcoded',
					sequenceStep: port === 80 ? 11 : 7,
					connectHost: address,
					addressSource: 2,
					dnsCached: false
				})
				if (candidate) yield candidate
			}
		}
	}
}

export const buildNativeAndroidConnectionSequence = async (options: NativeAndroidConnectionSequenceOptions) => {
	const candidates: NativeConnectionCandidate[] = []
	for await (const candidate of iterateNativeAndroidConnectionSequence(options)) candidates.push(candidate)
	return candidates
}

const readHttpHeader = (socket: net.Socket, timeoutMs: number) =>
	new Promise<Buffer>((resolve, reject) => {
		let buffered = Buffer.alloc(0)
		let settled = false
		const timer = setTimeout(() => finish(new Error('native_android: HTTP CONNECT proxy timed out')), timeoutMs)
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

const connectDirect = (host: string, port: number, timeoutMs: number) =>
	new Promise<net.Socket>((resolve, reject) => {
		const socket = net.createConnection({ host, port })
		const timer = setTimeout(() => socket.destroy(new Error('native_android: TCP connect timed out')), timeoutMs)
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

const connectTlsProxy = (host: string, port: number, timeoutMs: number) =>
	new Promise<tls.TLSSocket>((resolve, reject) => {
		const socket = tls.connect({ host, port, servername: net.isIP(host) ? undefined : host })
		const timer = setTimeout(() => socket.destroy(new Error('native_android: TLS proxy connect timed out')), timeoutMs)
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
	timeoutMs: number
) => {
	const socket =
		proxy.type === 'https-connect'
			? await connectTlsProxy(proxy.host, proxy.port, timeoutMs)
			: await connectDirect(proxy.host, proxy.port, timeoutMs)
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
		const response = (await readHttpHeader(socket, timeoutMs)).toString('latin1')
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
	timeoutMs: number
) => {
	const { SocksClient } = await import('socks')
	const result = await SocksClient.createConnection({
		command: 'connect',
		timeout: timeoutMs,
		proxy: {
			host: proxy.host,
			port: proxy.port,
			type: proxy.type === 'socks4' ? 4 : 5,
			userId: proxy.username,
			password: proxy.password
		},
		destination: { host: candidate.connectHost, port: candidate.port }
	})
	return result.socket
}

export const connectNativeAndroidCandidate = (
	candidate: NativeConnectionCandidate,
	proxy: NativeAndroidProxyConfig | undefined,
	timeoutMs: number
) => {
	if (!proxy) return connectDirect(candidate.connectHost, candidate.port, timeoutMs)
	return proxy.type === 'socks4' || proxy.type === 'socks5'
		? connectSocksProxy(proxy, candidate, timeoutMs)
		: connectHttpProxy(proxy, candidate, timeoutMs)
}

export const clearNativeAndroidDnsCache = () => dnsCache.clear()
