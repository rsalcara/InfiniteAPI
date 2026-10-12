import { Curve } from '../../Utils/crypto'
import type { NativeAndroidRegistrationBridgeContext } from '../../Utils/native-android-registration-bridge-provider'
import { createNativeAndroidRegistrationRelayProvider } from '../../Utils/native-android-registration-relay-provider'
import {
	FIXTURE_ATTESTATION_MATERIAL,
	FIXTURE_AUTHORIZATION,
	signFixtureProof
} from './native-android-registration-attestation-fixtures'

const QUERY = 'cc=55&token=hEjVbznrgA3o2tS3JoE4vuRVxVg%3D&in=1531997072'

const CONTEXT: NativeAndroidRegistrationBridgeContext = {
	endpoint: '/v2/code',
	appVariant: 'business',
	phoneNumber: '551531997072',
	login: '551531997072@s.whatsapp.net',
	body: QUERY
}

type RelayRequestBody = {
	payloadBase64: string
	challengeBase64: string
	packageName?: string
	appVariant?: string
}

type FetchCall = {
	url: string
	init: { body?: string; headers?: Record<string, string> }
	request: RelayRequestBody
	response: Record<string, unknown>
}

type RelayProof = { h: string; authorization: string }
type RelayResponseSpec = Record<string, unknown> | ((proof: RelayProof) => Record<string, unknown>)

// Every relay response is proof-checked against the exact bytes the provider
// signed, so the mock signs the received payload with the fixture leaf key and
// answers with the fixture chain (official flag-11 / flag-2 encodings).
const makeFetch = (
	response: { status?: number; ok?: boolean; json?: RelayResponseSpec },
	calls: FetchCall[]
) =>
	((url: unknown, init?: unknown) => {
		const initRecord = (init ?? {}) as { body?: string; headers?: Record<string, string> }
		const request = JSON.parse(initRecord.body ?? '{}') as RelayRequestBody
		const proof = signFixtureProof(Buffer.from(request.payloadBase64, 'base64'))
		const json = typeof response.json === 'function' ? response.json(proof) : (response.json ?? proof)
		calls.push({ url: String(url), init: initRecord, request, response: json })
		const ok = response.ok ?? (response.status ?? 200) < 300
		return Promise.resolve({
			ok,
			status: response.status ?? 200,
			text: async () => JSON.stringify(json),
			body: { cancel: async () => undefined }
		})
	}) as unknown as typeof fetch

describe('native android registration relay provider', () => {
	it('seals with the built-in server key by default and appends the device h= verbatim', async () => {
		const calls: FetchCall[] = []
		const provider = createNativeAndroidRegistrationRelayProvider({
			url: 'https://api.example.com',
			challenge: FIXTURE_ATTESTATION_MATERIAL,
			fetch: makeFetch({}, calls)
		})

		const attested = await provider(CONTEXT)

		expect(calls).toHaveLength(1)
		expect(calls[0]!.url).toBe('https://api.example.com/registration/attestation')
		// Gap B: the body names the app the proof is FOR and carries the binding material.
		expect(calls[0]!.request.challengeBase64).toBe(Buffer.from(FIXTURE_ATTESTATION_MATERIAL).toString('base64'))
		expect(calls[0]!.request.appVariant).toBe('business')
		expect(calls[0]!.request.packageName).toBeUndefined()
		// Default seal: the device signs the bare enc value carried in the body.
		expect(attested.body!.startsWith('ENC=')).toBe(true)
		const signedPayload = Buffer.from(calls[0]!.request.payloadBase64, 'base64').toString('utf8')
		expect(attested.body).toBe(`ENC=${signedPayload}&H=${calls[0]!.response.h as string}`)
		expect(attested.authorization).toBe(FIXTURE_AUTHORIZATION)
		expect(attested.userAgent).toBeUndefined()
		// Gap C: the proof is verified before the request is placed on the wire.
		expect(attested.attestation?.chainLength).toBe(2)
		expect(attested.attestation?.packageNameMatches).toBe(true)
		expect(attested.attestation?.signingCertMatches).toBe(true)
		expect(attested.attestation?.challengeTimestampMs).toBe(1759996800 * 1000)
	})

	it('forwards the package name when the context carries one', async () => {
		const calls: FetchCall[] = []
		const provider = createNativeAndroidRegistrationRelayProvider({
			url: 'https://api.example.com',
			challenge: FIXTURE_ATTESTATION_MATERIAL,
			fetch: makeFetch({}, calls)
		})

		await provider({ ...CONTEXT, packageName: 'com.whatsapp.w4b' })

		expect(calls[0]!.request.packageName).toBe('com.whatsapp.w4b')
		expect(calls[0]!.request.appVariant).toBe('business')
	})

	it('keeps the signed-plaintext fallback when the seal is unavailable (APK parity)', async () => {
		const calls: FetchCall[] = []
		const provider = createNativeAndroidRegistrationRelayProvider({
			url: 'https://api.example.com',
			envelopeMaterial: { serverPublicKey: new Uint8Array(3) },
			challenge: FIXTURE_ATTESTATION_MATERIAL,
			fetch: makeFetch({}, calls)
		})

		const attested = await provider(CONTEXT)

		const signedPayload = Buffer.from(calls[0]!.request.payloadBase64, 'base64').toString('utf8')
		expect(signedPayload).toBe(QUERY)
		expect(attested.body).toBe(`${QUERY}&H=${calls[0]!.response.h as string}`)
		expect(attested.authorization).toBe(FIXTURE_AUTHORIZATION)
	})

	it('sends the bare enc value as payload when the envelope material is set', async () => {
		const calls: FetchCall[] = []
		const material = { serverPublicKey: Curve.generateKeyPair().public }
		const provider = createNativeAndroidRegistrationRelayProvider({
			url: 'https://api.example.com',
			envelopeMaterial: material,
			challenge: FIXTURE_ATTESTATION_MATERIAL,
			fetch: makeFetch({}, calls)
		})

		const attested = await provider(CONTEXT)

		// Each seal uses a fresh ephemeral key, so the test checks internal
		// consistency instead of re-sealing: the signed payload must be the
		// bare enc value carried in the returned body.
		expect(attested.body!.startsWith('ENC=')).toBe(true)
		const signedPayload = Buffer.from(calls[0]!.request.payloadBase64, 'base64').toString('utf8')
		expect(attested.body).toBe(`ENC=${signedPayload}&H=${calls[0]!.response.h as string}`)
		expect(signedPayload).not.toContain('ENC=')
		expect(calls[0]!.request.challengeBase64).toBe(Buffer.from(FIXTURE_ATTESTATION_MATERIAL).toString('base64'))
	})

	it('builds the User-Agent in the motor: explicit override, then real hardware, then raffled, device string last', async () => {
		const calls: FetchCall[] = []
		// The device cannot know which build its token material proves (the
		// material is server-side), and its hardcoded UA string is stale — the
		// motor must win the version/platform pair. Wire shape is the
		// Connector's `signer.deviceProperties()`.
		const withDeviceFields = (proof: RelayProof) => ({
			...proof,
			userAgent: 'WhatsApp/2.26.39.72 SMBA/16 Device/Xiaomi-25078PC3EG',
			deviceProfile: { manufacturer: 'Xiaomi', model: '25078PC3EG', androidVersion: '16', sdkInt: '36' }
		})
		const CONSUMER_CONTEXT: NativeAndroidRegistrationBridgeContext = { ...CONTEXT, appVariant: 'consumer' }

		const withDevice = createNativeAndroidRegistrationRelayProvider({
			url: 'https://api.example.com',
			challenge: FIXTURE_ATTESTATION_MATERIAL,
			deviceProfile: { manufacturer: 'samsung', deviceModelType: 'SM-S948B', osVersion: '16' },
			fetch: makeFetch({ json: withDeviceFields }, calls)
		})
		const fromDevice = await withDevice(CONSUMER_CONTEXT)
		// Real hardware from the device, variant version/platform from the motor.
		expect(fromDevice.userAgent).toBe('WhatsApp/2.26.40.7 Android/16 Device/Xiaomi-25078PC3EG')
		expect(fromDevice.deviceProfile).toEqual({
			manufacturer: 'Xiaomi',
			model: '25078PC3EG',
			androidVersion: '16',
			sdkInt: '36'
		})

		const withOverride = createNativeAndroidRegistrationRelayProvider({
			url: 'https://api.example.com',
			challenge: FIXTURE_ATTESTATION_MATERIAL,
			userAgent: 'WhatsApp/2.26.39.72 SMBA/16 Device/samsung-SM-S948B',
			fetch: makeFetch({ json: withDeviceFields }, calls)
		})
		const overridden = await withOverride(CONTEXT)
		expect(overridden.userAgent).toBe('WhatsApp/2.26.39.72 SMBA/16 Device/samsung-SM-S948B')

		const withoutDeviceProfile = createNativeAndroidRegistrationRelayProvider({
			url: 'https://api.example.com',
			challenge: FIXTURE_ATTESTATION_MATERIAL,
			deviceProfile: { manufacturer: 'samsung', deviceModelType: 'SM-S948B', osVersion: '16' },
			fetch: makeFetch({}, calls)
		})
		const raffled = await withoutDeviceProfile(CONTEXT)
		expect(raffled.userAgent).toBe('WhatsApp/2.26.39.72 SMBA/16 Device/samsung-SM-S948B')

		const bare = createNativeAndroidRegistrationRelayProvider({
			url: 'https://api.example.com',
			challenge: FIXTURE_ATTESTATION_MATERIAL,
			fetch: makeFetch({ json: withDeviceFields }, calls)
		})
		const consumerBare = await bare(CONSUMER_CONTEXT)
		// No profile anywhere (device profile incomplete + no raffled): only
		// then is the device-supplied string trusted.
		const onlyString = createNativeAndroidRegistrationRelayProvider({
			url: 'https://api.example.com',
			challenge: FIXTURE_ATTESTATION_MATERIAL,
			fetch: makeFetch({ json: proof => ({ ...proof, userAgent: withDeviceFields(proof).userAgent }) }, calls)
		})
		const lastResort = await onlyString(CONSUMER_CONTEXT)
		expect(consumerBare.userAgent).toBe('WhatsApp/2.26.40.7 Android/16 Device/Xiaomi-25078PC3EG')
		expect(lastResort.userAgent).toBe('WhatsApp/2.26.39.72 SMBA/16 Device/Xiaomi-25078PC3EG')
	})

	it('rejects relay responses without signature or attestation', async () => {
		const calls: FetchCall[] = []
		const noSignature = createNativeAndroidRegistrationRelayProvider({
			url: 'https://api.example.com',
			challenge: FIXTURE_ATTESTATION_MATERIAL,
			fetch: makeFetch({ json: { authorization: FIXTURE_AUTHORIZATION } }, calls)
		})
		await expect(noSignature(CONTEXT)).rejects.toThrow('did not provide the payload signature')

		const noChain = createNativeAndroidRegistrationRelayProvider({
			url: 'https://api.example.com',
			challenge: FIXTURE_ATTESTATION_MATERIAL,
			fetch: makeFetch({ json: { h: 'c2ln' } }, calls)
		})
		await expect(noChain(CONTEXT)).rejects.toThrow('did not provide attestation')

		const httpError = createNativeAndroidRegistrationRelayProvider({
			url: 'https://api.example.com',
			challenge: FIXTURE_ATTESTATION_MATERIAL,
			fetch: makeFetch({ status: 503, json: { error: 'no_provider_available' } }, calls)
		})
		await expect(httpError(CONTEXT)).rejects.toThrow('returned HTTP 503')
	})

	it('rejects a proof whose signature does not cover the signed bytes', async () => {
		const calls: FetchCall[] = []
		const tampered = createNativeAndroidRegistrationRelayProvider({
			url: 'https://api.example.com',
			challenge: FIXTURE_ATTESTATION_MATERIAL,
			fetch: makeFetch({ json: proof => ({ ...proof, h: signFixtureProof(Buffer.from('other bytes')).h }) }, calls)
		})
		await expect(tampered(CONTEXT)).rejects.toThrow('payload signature does not verify')
	})

	it('requires the attestation binding material and HTTPS for non-loopback relay urls', () => {
		// The config TYPE requires the material; the runtime check is what this
		// exercises (callers compiled with `any` could still omit it).
		expect(() =>
			createNativeAndroidRegistrationRelayProvider({
				url: 'https://api.example.com',
				fetch: makeFetch({}, [])
			} as unknown as Parameters<typeof createNativeAndroidRegistrationRelayProvider>[0])
		).toThrow('requires the attestation binding material')
		expect(() =>
			createNativeAndroidRegistrationRelayProvider({
				url: 'http://api.example.com',
				challenge: FIXTURE_ATTESTATION_MATERIAL,
				fetch: makeFetch({}, [])
			})
		).toThrow('requires HTTPS')
		expect(() =>
			createNativeAndroidRegistrationRelayProvider({
				url: 'http://127.0.0.1:8080',
				challenge: FIXTURE_ATTESTATION_MATERIAL,
				fetch: makeFetch({}, [])
			})
		).not.toThrow()
	})
})
