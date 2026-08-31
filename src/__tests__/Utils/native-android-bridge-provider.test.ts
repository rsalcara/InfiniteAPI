import { createNativeAndroidBridgeProvider } from '../../Utils/native-android-bridge-provider'
import type { NativeAndroidGpiaChallenge } from '../../Types'

describe('native_android bridge provider', () => {
	const makeChallenge = (signal = new AbortController().signal): NativeAndroidGpiaChallenge => ({
		kind: 'gpia',
		nonce: 'test-nonce-value',
		requestHash: 'test-nonce-value',
		cloudProjectNumber: 293955441834,
		profileId: 'samsung-galaxy-s26',
		appVariant: 'business',
		clientAppId: 'test-client-app-id',
		packageName: 'com.whatsapp.w4b',
		signal
	})

	it('rejects invalid configuration', () => {
		expect(() => createNativeAndroidBridgeProvider({ url: 'ftp://invalid' })).toThrow(
			'requires a valid http(s) url'
		)
		expect(() =>
			createNativeAndroidBridgeProvider({ url: 'http://bridge', token: 123 as unknown as string })
		).toThrow('token must be a string')
		expect(() =>
			createNativeAndroidBridgeProvider({ url: 'http://bridge', timeoutMs: -1 })
		).toThrow('timeoutMs must be a positive number')
	})

	it('sends the challenge without leaking credentials in error messages', async () => {
	const calls: Array<{ url: string; init: RequestInit }> = []
		const provider = createNativeAndroidBridgeProvider({
			url: 'http://bridge.local:9876/',
			token: 'secret-token',
			fetch: (async (url: RequestInfo | URL, init?: RequestInit) => {
				calls.push({ url: String(url), init: init ?? {} })
				return new Response(JSON.stringify({ jws: 'valid-jws-token' }), { status: 200 })
			}) as unknown as typeof fetch
		})

		const result = await provider(makeChallenge())
		expect(result).toEqual({ jws: 'valid-jws-token' })
		expect(calls).toHaveLength(1)
		expect(calls[0]!.url).toBe('http://bridge.local:9876/integrity/gpia')
		expect(calls[0]!.init.method).toBe('POST')

		const body = JSON.parse(String(calls[0]!.init.body))
		expect(body.nonce).toBe('test-nonce-value')
		expect(body.requestHash).toBe('test-nonce-value')
		expect(body.cloudProjectNumber).toBe(293955441834)
		expect(body.packageName).toBe('com.whatsapp.w4b')

		const headers = calls[0]!.init.headers as Record<string, string>
		expect(headers.Authorization).toBe('Bearer secret-token')
	})

	it('rejects HTTP errors and malformed responses', async () => {
		const provider = createNativeAndroidBridgeProvider({
			url: 'http://bridge.local',
			fetch: async () => new Response('error', { status: 503 }) as unknown as Response
		})
		await expect(provider(makeChallenge())).rejects.toThrow('returned HTTP 503')

		const provider2 = createNativeAndroidBridgeProvider({
			url: 'http://bridge.local',
			fetch: async () => new Response(JSON.stringify({})) as unknown as Response
		})
		await expect(provider2(makeChallenge())).rejects.toThrow('invalid jws')

		const provider3 = createNativeAndroidBridgeProvider({
			url: 'http://bridge.local',
			fetch: async () => new Response(JSON.stringify({ jws: '' })) as unknown as Response
		})
		await expect(provider3(makeChallenge())).rejects.toThrow('invalid jws')
	})

	it('respects abort signal', async () => {
		const controller = new AbortController()
		controller.abort()
		const provider = createNativeAndroidBridgeProvider({
			url: 'http://bridge.local',
			fetch: async () => {
				throw new Error('should not be called')
			}
		})
		await expect(provider(makeChallenge(controller.signal))).rejects.toThrow('aborted before dispatch')
	})
})
