import { Agent } from 'https'
import { DEFAULT_CONNECTION_CONFIG } from '../../Defaults'
import type { NativeAndroidTransportConfig, SocketConfig } from '../../Types'
import {
	applyFetchAgentToRequestOptions,
	resolveProxyConnectionPhase,
	resolveProxyRouteAudit
} from '../../Utils/proxy-route'

const nativeAndroid = (): NativeAndroidTransportConfig => ({
	enabled: true,
	appVariant: 'business',
	appVersion: [2, 26, 27, 83],
	device: {
		profileId: 'proxy-route-test',
		manufacturer: 'test',
		device: 'test',
		osVersion: '16',
		osBuildNumber: 'test',
		phoneId: 'test-phone',
		deviceExpId: 'test-device',
		mcc: '724',
		mnc: '05',
		localeLanguageIso6391: 'pt',
		localeCountryIso31661Alpha2: 'BR'
	},
	historySync: {
		fullSyncDaysLimit: 365,
		fullSyncSizeMbLimit: 4096,
		thumbnailSyncDaysLimit: 30,
		supportGroupHistory: false,
		onDemandReady: true,
		supportHatchHistory: false,
		supportedBotChannelFbids: []
	}
})

const nativeConfig = (): SocketConfig => ({
	...DEFAULT_CONNECTION_CONFIG,
	transportProfile: 'native_android',
	nativeAndroid: nativeAndroid()
})

describe('full proxy route policy', () => {
	it('infers the protocol phase without guessing the consumer restart trigger', () => {
		const config = nativeConfig()
		expect(resolveProxyConnectionPhase(config)).toBe('new_pairing')

		config.auth = {
			creds: { me: { id: '5515991426667:8@s.whatsapp.net' }, accountSyncCounter: 0 }
		} as SocketConfig['auth']
		expect(resolveProxyConnectionPhase(config)).toBe('initial_pair_login')

		config.auth.creds.accountSyncCounter = 1
		expect(resolveProxyConnectionPhase(config)).toBe('reconnect')
	})

	it('propagates a Node agent into all socket HTTP request options', () => {
		const agent = new Agent()
		const options = applyFetchAgentToRequestOptions({ headers: { 'x-test': '1' } }, agent)

		expect(options).toMatchObject({ agent, headers: { 'x-test': '1' } })
		expect(options.dispatcher).toBeUndefined()
	})

	it('propagates an Undici dispatcher without retaining a conflicting Node agent', () => {
		const dispatcher = { dispatch: () => undefined }
		const options = applyFetchAgentToRequestOptions({ agent: new Agent() }, dispatcher)

		expect(options.dispatcher).toBe(dispatcher)
		expect(options.agent).toBeUndefined()
	})

	it('keeps direct sessions unchanged when no proxy is configured', () => {
		expect(resolveProxyRouteAudit(nativeConfig(), 'native_android')).toEqual({
			proxyCoverage: 'direct',
			proxyPolicyEnforced: false,
			nativeTcpProxied: false,
			webSocketProxied: false,
			httpMediaProxied: false
		})
	})

	it('reports legacy socket-only proxy configuration as partial', () => {
		const config = nativeConfig()
		config.nativeAndroid = {
			...config.nativeAndroid!,
			proxy: { type: 'socks5', host: 'proxy.example', port: 1080 }
		}

		expect(resolveProxyRouteAudit(config, 'native_android')).toMatchObject({
			proxyCoverage: 'partial',
			proxyPolicyEnforced: false,
			nativeTcpProxied: true,
			httpMediaProxied: false
		})
	})

	it('fails closed when native full coverage has no media agent', () => {
		const config = nativeConfig()
		config.nativeAndroid = {
			...config.nativeAndroid!,
			proxy: { type: 'http-connect', host: 'proxy.example', port: 8080 }
		}
		config.proxyRoute = { mode: 'full' }

		expect(() => resolveProxyRouteAudit(config, 'native_android')).toThrow(
			'proxyRoute full coverage requires fetchAgent'
		)
	})

	it('accepts complete native coverage and preserves verified egress metadata', () => {
		const config = nativeConfig()
		config.fetchAgent = new Agent()
		config.nativeAndroid = {
			...config.nativeAndroid!,
			proxy: { type: 'http-connect', host: 'proxy.example', port: 8080 }
		}
		config.proxyRoute = {
			mode: 'full',
			expectedEgressIp: '198.51.100.42',
			provider: 'InfiniteAPI Residential',
			routeId: 'infinite-store-f5ac0b9a',
			verifiedAt: '2026-08-22T13:51:59.000Z'
		}

		expect(resolveProxyRouteAudit(config, 'native_android')).toEqual({
			proxyCoverage: 'full',
			proxyPolicyEnforced: true,
			nativeTcpProxied: true,
			webSocketProxied: false,
			httpMediaProxied: true,
			proxyExpectedEgressIp: '198.51.100.42',
			proxyProvider: 'InfiniteAPI Residential',
			proxyRouteId: 'infinite-store-f5ac0b9a',
			proxyVerifiedAt: '2026-08-22T13:51:59.000Z'
		})
	})

	it('requires both WebSocket and HTTP/media agents for Web full coverage', () => {
		const config: SocketConfig = {
			...DEFAULT_CONNECTION_CONFIG,
			proxyRoute: { mode: 'full' }
		}

		expect(() => resolveProxyRouteAudit(config, 'web')).toThrow('requires agent for the WebSocket')
		config.agent = new Agent()
		expect(() => resolveProxyRouteAudit(config, 'web')).toThrow('requires fetchAgent')
		config.fetchAgent = new Agent()
		expect(resolveProxyRouteAudit(config, 'web')).toMatchObject({
			proxyCoverage: 'full',
			webSocketProxied: true,
			httpMediaProxied: true
		})
	})

	it('rejects invalid audit metadata before network I/O', () => {
		const config = nativeConfig()
		config.fetchAgent = new Agent()
		config.nativeAndroid = {
			...config.nativeAndroid!,
			proxy: { type: 'socks5', host: 'proxy.example', port: 1080 }
		}
		config.proxyRoute = { mode: 'full', expectedEgressIp: 'not-an-ip' }
		expect(() => resolveProxyRouteAudit(config, 'native_android')).toThrow('expectedEgressIp')

		config.proxyRoute = { mode: 'full', expectedEgressIp: 1234 } as unknown as SocketConfig['proxyRoute']
		expect(() => resolveProxyRouteAudit(config, 'native_android')).toThrow('expectedEgressIp')

		config.proxyRoute = { mode: 'full', verifiedAt: 'not-a-date' }
		expect(() => resolveProxyRouteAudit(config, 'native_android')).toThrow('ISO-8601')

		config.proxyRoute = { mode: 'full', verifiedAt: 'August 22, 2026' }
		expect(() => resolveProxyRouteAudit(config, 'native_android')).toThrow('ISO-8601')

		config.proxyRoute = { mode: 'full', provider: '   ' }
		expect(() => resolveProxyRouteAudit(config, 'native_android')).toThrow('provider must be a non-empty string')
	})

	it('rejects an unusable fetchAgent under full policy', () => {
		const config = nativeConfig()
		config.nativeAndroid = {
			...config.nativeAndroid!,
			proxy: { type: 'socks5', host: 'proxy.example', port: 1080 }
		}
		config.fetchAgent = { dispatch: undefined } as unknown as SocketConfig['fetchAgent']
		config.proxyRoute = { mode: 'full' }

		expect(() => resolveProxyRouteAudit(config, 'native_android')).toThrow(
			'must be a Node HTTP agent or an Undici dispatcher'
		)
	})
})
