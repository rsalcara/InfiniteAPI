import { createServer, type IncomingMessage, type ServerResponse } from 'http'
import type { AddressInfo } from 'net'
import { WHATSAPP_MESSENGER_CLIENT_APP_ID, WABA_CLIENT_APP_ID } from '../../Defaults'
import { makeNativeAndroidBridgeAttestationProvider, resolveInfiniteApiRuntimeProfile } from '../../Utils'

const listen = async (handler: (request: IncomingMessage, response: ServerResponse) => void) => {
	const server = createServer(handler)
	await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
	const address = server.address() as AddressInfo
	return {
		baseUrl: `http://127.0.0.1:${address.port}`,
		close: () => new Promise<void>((resolve, reject) => server.close(error => (error ? reject(error) : resolve())))
	}
}

const businessContext = {
	stanza: { tag: 'iq', attrs: {} },
	profileId: 'captured-generic-android',
	appVariant: 'business' as const,
	clientAppId: WABA_CLIENT_APP_ID,
	packageName: 'com.whatsapp.w4b'
}

describe('native Android provider bridge', () => {
	it('returns validated provider artifacts without persisting private material', async () => {
		let receivedAuthorization: string | undefined
		let receivedProfileId: string | undefined
		const bridge = await listen(async (request, response) => {
			receivedAuthorization = request.headers.authorization
			const chunks: Buffer[] = []
			for await (const chunk of request) chunks.push(Buffer.from(chunk))
			receivedProfileId = JSON.parse(Buffer.concat(chunks).toString()).profileId
			response.setHeader('content-type', 'application/json')
			response.end(
				JSON.stringify({
					keyAttestationBase64: Buffer.from([1, 2, 3]).toString('base64'),
					gpiaBase64: '',
					clientAppId: WABA_CLIENT_APP_ID,
					packageName: 'com.rsalcara.infiniteapi.attestation',
					appVariant: 'business',
					targetPackageName: 'com.whatsapp.w4b',
					generatedAtMs: 1_700_000_000_000,
					expiresAtMs: 1_700_000_600_000
				})
			)
		})

		try {
			const provider = makeNativeAndroidBridgeAttestationProvider({
				baseUrl: bridge.baseUrl,
				bearerToken: 'test-token',
				expectedPackageName: 'com.rsalcara.infiniteapi.attestation',
				now: () => 1_700_000_100_000
			})
			const result = await provider(businessContext)
			expect(Buffer.from(result.keyAttestation)).toEqual(Buffer.from([1, 2, 3]))
			expect(Buffer.from(result.gpia as Uint8Array)).toHaveLength(0)
			expect(result.clientAppId).toBe(WABA_CLIENT_APP_ID)
			expect(receivedAuthorization).toBe('Bearer test-token')
			expect(receivedProfileId).toBe('captured-generic-android')
		} finally {
			await bridge.close()
		}
	})

	it('fails closed on a package mismatch or stale attestation', async () => {
		const bridge = await listen((_request, response) => {
			response.setHeader('content-type', 'application/json')
			response.end(
				JSON.stringify({
					keyAttestationBase64: Buffer.from([1]).toString('base64'),
					gpiaBase64: '',
					clientAppId: '123',
					packageName: 'unexpected.package',
					generatedAtMs: 100,
					expiresAtMs: 200
				})
			)
		})

		try {
			const wrongPackage = makeNativeAndroidBridgeAttestationProvider({
				baseUrl: bridge.baseUrl,
				expectedPackageName: 'com.rsalcara.infiniteapi.attestation',
				now: () => 100
			})
			await expect(wrongPackage({ ...businessContext, profileId: 'fixture' })).rejects.toThrow(
				'provider package mismatch'
			)

			const stale = makeNativeAndroidBridgeAttestationProvider({
				baseUrl: bridge.baseUrl,
				expectedPackageName: 'unexpected.package',
				now: () => 1_000
			})
			await expect(stale({ ...businessContext, profileId: 'fixture' })).rejects.toThrow(
				'expired or insufficiently fresh'
			)
		} finally {
			await bridge.close()
		}
	})

	it('fails closed when the provider rejects the request or returns malformed artifacts', async () => {
		const rejectedBridge = await listen((_request, response) => {
			response.statusCode = 503
			response.end(JSON.stringify({ ok: false, reason: 'attestation-unavailable' }))
		})

		try {
			const rejected = makeNativeAndroidBridgeAttestationProvider({
				baseUrl: rejectedBridge.baseUrl
			})
			await expect(rejected({ ...businessContext, profileId: 'fixture' })).rejects.toThrow('HTTP 503')
		} finally {
			await rejectedBridge.close()
		}

		const malformedBridge = await listen((_request, response) => {
			response.setHeader('content-type', 'application/json')
			response.end(
				JSON.stringify({
					keyAttestationBase64: 'not base64',
					gpiaBase64: '',
					clientAppId: WABA_CLIENT_APP_ID,
					packageName: 'com.rsalcara.infiniteapi.attestation',
					expiresAtMs: 1_700_000_600_000
				})
			)
		})

		try {
			const malformed = makeNativeAndroidBridgeAttestationProvider({
				baseUrl: malformedBridge.baseUrl,
				now: () => 1_700_000_100_000
			})
			await expect(malformed({ ...businessContext, profileId: 'fixture' })).rejects.toThrow(
				'keyAttestationBase64 is not valid base64'
			)
		} finally {
			await malformedBridge.close()
		}
	})

	it('routes a consumer pairing request with the Messenger identity', async () => {
		let receivedBody: Record<string, string> | undefined
		const bridge = await listen(async (request, response) => {
			const chunks: Buffer[] = []
			for await (const chunk of request) chunks.push(Buffer.from(chunk))
			receivedBody = JSON.parse(Buffer.concat(chunks).toString())
			response.setHeader('content-type', 'application/json')
			response.end(
				JSON.stringify({
					keyAttestationBase64: Buffer.from([4, 5, 6]).toString('base64'),
					gpiaBase64: '',
					clientAppId: WHATSAPP_MESSENGER_CLIENT_APP_ID,
					packageName: 'com.rsalcara.infiniteapi.attestation',
					appVariant: 'consumer',
					targetPackageName: 'com.whatsapp',
					generatedAtMs: 1_700_000_000_000,
					expiresAtMs: 1_700_000_600_000
				})
			)
		})

		try {
			const provider = makeNativeAndroidBridgeAttestationProvider({
				baseUrl: bridge.baseUrl,
				now: () => 1_700_000_100_000
			})
			const result = await provider({
				...businessContext,
				appVariant: 'consumer',
				clientAppId: WHATSAPP_MESSENGER_CLIENT_APP_ID,
				packageName: 'com.whatsapp'
			})

			expect(result.clientAppId).toBe(WHATSAPP_MESSENGER_CLIENT_APP_ID)
			expect(receivedBody).toMatchObject({
				appVariant: 'consumer',
				clientAppId: WHATSAPP_MESSENGER_CLIENT_APP_ID,
				packageName: 'com.whatsapp'
			})
		} finally {
			await bridge.close()
		}
	})

	it('keeps Web and storage selection independent while requiring a provider for native Android', () => {
		expect(
			resolveInfiniteApiRuntimeProfile({
				INFINITEAPI_TRANSPORT: 'web',
				INFINITEAPI_AUTH_STORAGE: 'json'
			})
		).toEqual({ transportProfile: 'web', authStorage: 'json' })

		expect(() =>
			resolveInfiniteApiRuntimeProfile({
				INFINITEAPI_TRANSPORT: 'native_android',
				INFINITEAPI_AUTH_STORAGE: 'multi_db_sqlite'
			})
		).toThrow('INFINITEAPI_ANDROID_PROVIDER_URL')

		const native = resolveInfiniteApiRuntimeProfile({
			INFINITEAPI_TRANSPORT: 'native_android',
			INFINITEAPI_AUTH_STORAGE: 'multi_db_sqlite',
			INFINITEAPI_ANDROID_PROVIDER_URL: 'http://127.0.0.1:8789'
		})
		expect(native.transportProfile).toBe('native_android')
		expect(native.authStorage).toBe('multi_db_sqlite')
		expect(native.attestationProvider).toBeInstanceOf(Function)
	})
})
