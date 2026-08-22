import { jest } from '@jest/globals'
import net from 'net'
import { Duplex } from 'stream'
import tls from 'tls'
import type { NativeAndroidTransportConfig, PersistedNativeAndroidIdentity } from '../../Types'
import {
	buildNativeAndroidConnectionSequence,
	clearNativeAndroidDnsCache,
	connectNativeAndroidCandidate,
	getNativeAndroidConnectedHost,
	iterateNativeAndroidConnectionSequence,
	type NativeConnectionCandidate,
	parseNativeAndroidProxyUrl
} from '../../Utils/native-android-connection-sequence'
import { OFFICIAL_NATIVE_ANDROID_HARDCODED_ADDRESSES } from '../../Utils/native-android-hardcoded-addresses'

const config = (overrides: Partial<NativeAndroidTransportConfig> = {}): NativeAndroidTransportConfig =>
	({
		enabled: true,
		appVersion: [2, 26, 27, 83],
		appVariant: 'consumer',
		historySync: {
			fullSyncDaysLimit: 365,
			fullSyncSizeMbLimit: 4096,
			thumbnailSyncDaysLimit: 30,
			supportGroupHistory: false,
			onDemandReady: true,
			supportHatchHistory: false,
			supportedBotChannelFbids: []
		},
		device: {} as NativeAndroidTransportConfig['device'],
		...overrides
	}) as NativeAndroidTransportConfig

const persisted = (
	connectionEndpoint: PersistedNativeAndroidIdentity['connectionEndpoint']
): PersistedNativeAndroidIdentity => ({
	schemaVersion: 1,
	profile: 'native_android',
	device: {} as PersistedNativeAndroidIdentity['device'],
	connectionEndpoint
})

describe('native Android connection sequence', () => {
	afterEach(() => clearNativeAndroidDnsCache())

	it('keeps the Android 2.26.27.83 hardcoded table as a fallback-only source', () => {
		expect(OFFICIAL_NATIVE_ANDROID_HARDCODED_ADDRESSES['g.whatsapp.net']).toHaveLength(52)
		expect(OFFICIAL_NATIVE_ANDROID_HARDCODED_ADDRESSES['g.whatsapp.net']).toContain('57.144.253.33')
		expect(OFFICIAL_NATIVE_ANDROID_HARDCODED_ADDRESSES['g.whatsapp.net']).toContain(
			'2a03:2880:f36e:121:face:b00c:0:7260'
		)
		for (let index = 1; index <= 16; index++) {
			expect(OFFICIAL_NATIVE_ANDROID_HARDCODED_ADDRESSES[`e${index}.whatsapp.net`]).toEqual([
				'15.197.206.217',
				'3.33.252.61',
				'15.197.210.208',
				'3.33.221.48'
			])
		}
	})

	it('keeps server endpoints, history and official defaults in the observed state order', async () => {
		const candidates = await buildNativeAndroidConnectionSequence({
			config: config({
				proxy: { type: 'socks5', host: 'proxy.example', port: 1080 },
				connectionEndpoints: [
					{ host: 'primary-server.example', port: 5222 },
					{ host: 'secondary-server.example', port: 443, sequenceStep: 8 }
				]
			}),
			persisted: persisted({ host: 'history.example', port: 443, source: 'edge', sequenceStep: 7 }),
			random: () => 0
		})

		const sources = candidates.map(candidate => `${candidate.host}:${candidate.sequenceStep}`)
		const indexOf = (source: NativeConnectionCandidate['source'], step: number) =>
			candidates.findIndex(candidate => candidate.source === source && candidate.sequenceStep === step)
		expect(sources[0]).toBe('primary-server.example:2')
		expect(sources.indexOf('secondary-server.example:8')).toBeGreaterThan(sources.indexOf('g.whatsapp.net:5'))
		expect(sources.indexOf('history.example:7')).toBeGreaterThan(sources.indexOf('g.whatsapp.net:9'))
		expect(sources.indexOf('history.example:7')).toBeLessThan(sources.indexOf('g-fallback.whatsapp.net:13'))
		expect(indexOf('fallback', 13)).toBeLessThan(indexOf('fallback', 14))
		expect(indexOf('fallback', 14)).toBeLessThan(indexOf('hardcoded', 6))
		expect(indexOf('hardcoded', 6)).toBeLessThan(indexOf('hardcoded', 10))
		expect(indexOf('hardcoded', 10)).toBeLessThan(indexOf('edge', 7))
		expect(indexOf('edge', 7)).toBeLessThan(indexOf('edge', 11))
	})

	it('does not resolve fallback DNS before an earlier server endpoint is attempted', async () => {
		const lookup = jest.fn(async () => ['127.0.0.1'])
		const sequence = iterateNativeAndroidConnectionSequence({
			config: config({
				proxy: { type: 'socks5', host: 'proxy.example', port: 1080 },
				connectionEndpoints: [{ host: 'server.example', port: 5222 }]
			}),
			lookup
		})

		expect((await sequence.next()).value).toMatchObject({
			host: 'server.example',
			port: 5222,
			source: 'server',
			sequenceStep: 2
		})
		expect(lookup).not.toHaveBeenCalled()
		await sequence.return(undefined)
	})

	it('tries an explicit endpoint first without disabling the official fallback sequence', async () => {
		const sequence = await buildNativeAndroidConnectionSequence({
			config: config({
				host: 'customer-endpoint.example',
				port: 5222,
				proxy: { type: 'socks5', host: 'proxy.example', port: 1080 }
			}),
			random: () => 0
		})

		expect(sequence[0]).toMatchObject({
			host: 'customer-endpoint.example',
			port: 5222,
			source: 'configured',
			sequenceStep: 1
		})
		expect(sequence.some(candidate => candidate.host === 'g.whatsapp.net' && candidate.sequenceStep === 5)).toBe(true)
		expect(sequence.some(candidate => candidate.host === 'g-fallback.whatsapp.net')).toBe(true)
		expect(sequence.some(candidate => candidate.host === 'e1.whatsapp.net')).toBe(true)
		expect(sequence.some(candidate => candidate.host === 'e16.whatsapp.net')).toBe(false)
	})

	it('resolves SOCKS4 targets locally but keeps SOCKS4a targets on the proxy', async () => {
		const localLookup = jest.fn(async () => ['192.0.2.10'])
		const localSequence = iterateNativeAndroidConnectionSequence({
			config: config({
				proxy: { type: 'socks4', host: 'proxy.example', port: 1080, resolveDns: false },
				connectionEndpoints: [{ host: 'server.example', port: 443 }]
			}),
			lookup: localLookup
		})
		expect((await localSequence.next()).value).toMatchObject({ connectHost: '192.0.2.10' })
		expect(localLookup).toHaveBeenCalledWith('server.example')
		await localSequence.return(undefined)

		const remoteLookup = jest.fn(async () => ['192.0.2.11'])
		const remoteSequence = iterateNativeAndroidConnectionSequence({
			config: config({
				proxy: { type: 'socks4', host: 'proxy.example', port: 1080, resolveDns: true },
				connectionEndpoints: [{ host: 'server.example', port: 443 }]
			}),
			lookup: remoteLookup
		})
		expect((await remoteSequence.next()).value).toMatchObject({ connectHost: 'server.example' })
		expect(remoteLookup).not.toHaveBeenCalled()
		await remoteSequence.return(undefined)
	})

	it('keeps DNS on the proxy and selects one official edge host per edge state', async () => {
		const directPortCandidates = await buildNativeAndroidConnectionSequence({
			config: config({ proxy: { type: 'socks5', host: 'proxy.example', port: 1080 } }),
			random: () => 0
		})
		const alternatePortCandidates = await buildNativeAndroidConnectionSequence({
			config: config({ proxy: { type: 'socks5', host: 'proxy.example', port: 1080 } }),
			random: () => 0.999999
		})

		expect(directPortCandidates.some(candidate => candidate.host === 'g.whatsapp.net' && candidate.port === 443)).toBe(
			true
		)
		expect(
			alternatePortCandidates.some(candidate => candidate.host === 'g.whatsapp.net' && candidate.port === 5222)
		).toBe(true)
		expect(directPortCandidates.some(candidate => candidate.host === 'e1.whatsapp.net')).toBe(true)
		expect(directPortCandidates.some(candidate => candidate.host === 'e16.whatsapp.net')).toBe(false)
		expect(alternatePortCandidates.some(candidate => candidate.host === 'e16.whatsapp.net')).toBe(true)
		expect(alternatePortCandidates.some(candidate => candidate.host === 'e1.whatsapp.net')).toBe(false)
		expect(
			new Set(directPortCandidates.filter(candidate => candidate.sequenceStep === 7).map(candidate => candidate.host))
				.size
		).toBe(1)
		expect(
			new Set(directPortCandidates.filter(candidate => candidate.sequenceStep === 11).map(candidate => candidate.host))
				.size
		).toBe(1)
		expect(
			directPortCandidates.some(candidate => candidate.host === 'g-fallback.whatsapp.net' && candidate.port === 80)
		).toBe(true)
		expect(
			directPortCandidates
				.filter(candidate => candidate.source === 'dns')
				.every(candidate => candidate.address === undefined)
		).toBe(true)
	})

	it('caches direct A/AAAA lookup results for the official one-hour window', async () => {
		const lookup = jest.fn(async () => ['127.0.0.1', '::1'])
		const options = { config: config(), random: () => 0, lookup }
		const first = await buildNativeAndroidConnectionSequence(options)
		const second = await buildNativeAndroidConnectionSequence(options)

		expect(first.some(candidate => candidate.connectHosts?.includes('::1') && candidate.dnsCached === false)).toBe(true)
		expect(second.some(candidate => candidate.connectHosts?.includes('::1') && candidate.dnsCached === true)).toBe(true)
		expect(lookup).toHaveBeenCalledTimes(3)
	})

	it('bounds a stalled DNS lookup before advancing to the next server endpoint', async () => {
		const lookup = jest.fn((host: string) =>
			host === 'stalled.example' ? new Promise<string[]>(() => {}) : Promise.resolve(['127.0.0.1'])
		)
		const sequence = iterateNativeAndroidConnectionSequence({
			config: config({
				connectionEndpoints: [
					{ host: 'stalled.example', port: 443 },
					{ host: '127.0.0.1', port: 5222 }
				]
			}),
			lookup,
			dnsTimeoutMs: 20
		})

		const startedAt = Date.now()
		expect((await sequence.next()).value).toMatchObject({ host: '127.0.0.1', port: 5222 })
		expect(Date.now() - startedAt).toBeLessThan(500)
		await sequence.return(undefined)
	})

	it('does not reintroduce an unresolved hostname when DNS returns no usable address', async () => {
		const lookup = jest.fn(async () => ['not-an-ip'])
		const sequence = await buildNativeAndroidConnectionSequence({
			config: config({ host: 'empty-dns.example', port: 443 }),
			lookup,
			random: () => 0
		})

		expect(
			sequence.some(candidate => candidate.host === 'empty-dns.example' && candidate.source === 'configured')
		).toBe(false)
		expect(sequence.some(candidate => candidate.source === 'hardcoded')).toBe(true)
	})

	it('caps the shared DNS cache and evicts the oldest arbitrary endpoint', async () => {
		const lookup = jest.fn(async () => ['127.0.0.1'])
		for (let index = 0; index < 65; index++) {
			const sequence = iterateNativeAndroidConnectionSequence({
				config: config({ host: `cache-${index}.example`, port: 443 }),
				lookup
			})
			await sequence.next()
			await sequence.return(undefined)
		}

		const firstAgain = iterateNativeAndroidConnectionSequence({
			config: config({ host: 'cache-0.example', port: 443 }),
			lookup
		})
		await firstAgain.next()
		await firstAgain.return(undefined)
		expect(lookup).toHaveBeenCalledTimes(66)
	})

	it.each([
		['http://user:p%40ss@proxy.example:3128', 'http-connect', 3128, undefined],
		['https://proxy.example', 'https-connect', 443, undefined],
		['socks4://proxy.example', 'socks4', 1080, false],
		['socks4a://proxy.example', 'socks4', 1080, true],
		['socks5://proxy.example:1081', 'socks5', 1081, undefined],
		['socks5h://proxy.example', 'socks5', 1080, true]
	])('parses supported proxy URL %s', (url, type, port, resolveDns) => {
		expect(parseNativeAndroidProxyUrl(url)).toMatchObject({ type, port, resolveDns })
	})

	it('normalizes bracketed IPv6 proxy hosts for Node socket APIs', () => {
		expect(parseNativeAndroidProxyUrl('socks5://[::1]:1080')).toMatchObject({ host: '::1', port: 1080 })
	})

	it('rejects unsupported proxy protocols instead of silently connecting directly', () => {
		expect(() => parseNativeAndroidProxyUrl('ftp://proxy.example:21')).toThrow('unsupported proxy protocol')
	})

	it('uses an HTTP CONNECT proxy as a mandatory egress tunnel', async () => {
		const proxy = net.createServer(socket => {
			socket.once('data', request => {
				expect(request.toString()).toContain('CONNECT g.whatsapp.net:443 HTTP/1.1')
				socket.write('HTTP/1.1 200 Connection Established\r\n\r\n')
			})
		})
		await new Promise<void>(resolve => proxy.listen(0, '127.0.0.1', () => resolve()))
		const address = proxy.address()
		if (!address || typeof address === 'string') throw new Error('proxy did not bind')

		const socket = await connectNativeAndroidCandidate(
			{
				host: 'g.whatsapp.net',
				port: 443,
				source: 'dns',
				connectHost: 'g.whatsapp.net',
				addressSource: 1,
				dnsCached: false
			},
			{ type: 'http-connect', host: '127.0.0.1', port: address.port },
			1000
		)
		expect(socket.destroyed).toBe(false)
		socket.destroy()
		await new Promise<void>(resolve => proxy.close(() => resolve()))
	})

	it('uses one deadline across the HTTPS proxy handshake and CONNECT response', async () => {
		class SilentTlsSocket extends Duplex {
			_write(_chunk: Buffer, _encoding: BufferEncoding, callback: (error?: Error | null) => void) {
				callback()
			}
			_read() {}
		}
		const tunnel = new SilentTlsSocket()
		const connect = jest.spyOn(tls, 'connect').mockImplementation((() => {
			setTimeout(() => tunnel.emit('secureConnect'), 150)
			return tunnel as unknown as tls.TLSSocket
		}) as typeof tls.connect)
		const startedAt = Date.now()

		try {
			await expect(
				connectNativeAndroidCandidate(
					{
						host: 'g.whatsapp.net',
						port: 443,
						source: 'dns',
						connectHost: 'g.whatsapp.net',
						addressSource: 1,
						dnsCached: false
					},
					{ type: 'https-connect', host: 'secure-proxy.example', port: 443 },
					200
				)
			).rejects.toThrow('timed out')
			expect(Date.now() - startedAt).toBeLessThan(300)
		} finally {
			connect.mockRestore()
			tunnel.destroy()
		}
	})

	it('connects through the selected IPv4/IPv6 pair without serial address fanout', async () => {
		const server = net.createServer()
		await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
		const address = server.address()
		if (!address || typeof address === 'string') throw new Error('server did not bind')

		try {
			const socket = await connectNativeAndroidCandidate(
				{
					host: 'dual-stack.example',
					address: '127.0.0.2',
					port: address.port,
					source: 'dns',
					connectHost: '127.0.0.2',
					connectHosts: ['127.0.0.2', '127.0.0.1'],
					addressSource: 1,
					dnsCached: false
				},
				undefined,
				1000
			)
			expect(getNativeAndroidConnectedHost(socket)).toBe('127.0.0.1')
			socket.destroy()
		} finally {
			await new Promise<void>(resolve => server.close(() => resolve()))
		}
	})

	it('uses a TLS tunnel for HTTPS CONNECT proxies', async () => {
		class MockTlsSocket extends Duplex {
			_write(chunk: Buffer, _encoding: BufferEncoding, callback: (error?: Error | null) => void) {
				expect(chunk.toString()).toContain('CONNECT g.whatsapp.net:443 HTTP/1.1')
				callback()
				queueMicrotask(() => this.push(Buffer.from('HTTP/1.1 200 Connection Established\r\n\r\n')))
			}
			_read() {}
		}
		const tunnel = new MockTlsSocket()
		const connect = jest.spyOn(tls, 'connect').mockImplementation((() => {
			queueMicrotask(() => tunnel.emit('secureConnect'))
			return tunnel as unknown as tls.TLSSocket
		}) as typeof tls.connect)

		try {
			const socket = await connectNativeAndroidCandidate(
				{
					host: 'g.whatsapp.net',
					port: 443,
					source: 'dns',
					connectHost: 'g.whatsapp.net',
					addressSource: 1,
					dnsCached: false
				},
				{ type: 'https-connect', host: 'secure-proxy.example', port: 443 },
				1000
			)
			expect(socket).toBe(tunnel)
			expect(connect).toHaveBeenCalledWith(
				expect.objectContaining({ host: 'secure-proxy.example', port: 443, servername: 'secure-proxy.example' })
			)
		} finally {
			connect.mockRestore()
			tunnel.destroy()
		}
	})

	it('does not contact the destination directly when the configured proxy is unavailable', async () => {
		let destinationConnections = 0
		const destination = net.createServer(() => destinationConnections++)
		await new Promise<void>(resolve => destination.listen(0, '127.0.0.1', resolve))
		const destinationAddress = destination.address()
		if (!destinationAddress || typeof destinationAddress === 'string') throw new Error('destination did not bind')

		const unavailableProxy = net.createServer()
		await new Promise<void>(resolve => unavailableProxy.listen(0, '127.0.0.1', resolve))
		const proxyAddress = unavailableProxy.address()
		if (!proxyAddress || typeof proxyAddress === 'string') throw new Error('proxy did not bind')
		await new Promise<void>(resolve => unavailableProxy.close(() => resolve()))

		await expect(
			connectNativeAndroidCandidate(
				{
					host: '127.0.0.1',
					port: destinationAddress.port,
					connectHost: '127.0.0.1',
					source: 'configured',
					addressSource: 3,
					dnsCached: false
				},
				{ type: 'http-connect', host: '127.0.0.1', port: proxyAddress.port },
				250
			)
		).rejects.toBeDefined()
		expect(destinationConnections).toBe(0)
		await new Promise<void>(resolve => destination.close(() => resolve()))
	})

	it('opens a SOCKS5 tunnel without exposing proxy credentials in failures', async () => {
		const proxy = net.createServer(socket => {
			let stage = 0
			socket.on('data', () => {
				if (stage++ === 0) socket.write(Buffer.from([5, 0]))
				else socket.write(Buffer.from([5, 0, 0, 1, 127, 0, 0, 1, 0, 80]))
			})
		})
		await new Promise<void>(resolve => proxy.listen(0, '127.0.0.1', resolve))
		const address = proxy.address()
		if (!address || typeof address === 'string') throw new Error('SOCKS proxy did not bind')

		const socket = await connectNativeAndroidCandidate(
			{
				host: 'g.whatsapp.net',
				port: 443,
				connectHost: 'g.whatsapp.net',
				source: 'dns',
				addressSource: 1,
				dnsCached: false
			},
			{ type: 'socks5', host: '127.0.0.1', port: address.port },
			1000
		)
		expect(socket.destroyed).toBe(false)
		socket.destroy()
		await new Promise<void>(resolve => proxy.close(() => resolve()))
	})

	it.each([
		['socks4', '127.0.0.1', false],
		['socks4a', 'g.whatsapp.net', true]
	])('opens a %s tunnel', async (_label, connectHost, remoteDns) => {
		let request = Buffer.alloc(0)
		const proxy = net.createServer(socket => {
			socket.once('data', data => {
				request = Buffer.from(data)
				socket.write(Buffer.from([0, 90, 1, 187, 127, 0, 0, 1]))
			})
		})
		await new Promise<void>(resolve => proxy.listen(0, '127.0.0.1', resolve))
		const address = proxy.address()
		if (!address || typeof address === 'string') throw new Error('SOCKS4 proxy did not bind')

		const socket = await connectNativeAndroidCandidate(
			{
				host: 'g.whatsapp.net',
				port: 443,
				connectHost,
				source: 'dns',
				addressSource: 1,
				dnsCached: false
			},
			{ type: 'socks4', host: '127.0.0.1', port: address.port, resolveDns: remoteDns },
			1000
		)
		expect(request[0]).toBe(4)
		expect(request[1]).toBe(1)
		if (remoteDns) expect(request.includes(Buffer.from('g.whatsapp.net'))).toBe(true)
		socket.destroy()
		await new Promise<void>(resolve => proxy.close(() => resolve()))
	})
})
