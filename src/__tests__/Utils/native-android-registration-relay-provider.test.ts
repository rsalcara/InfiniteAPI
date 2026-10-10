import { Curve } from '../../Utils/crypto'
import type { NativeAndroidRegistrationBridgeContext } from '../../Utils/native-android-registration-bridge-provider'
import { createNativeAndroidRegistrationRelayProvider } from '../../Utils/native-android-registration-relay-provider'

const QUERY = 'cc=55&token=hEjVbznrgA3o2tS3JoE4vuRVxVg%3D&in=1531997072'

const CONTEXT: NativeAndroidRegistrationBridgeContext = {
	endpoint: '/v2/code',
	appVariant: 'business',
	phoneNumber: '551531997072',
	login: '551531997072@s.whatsapp.net',
	body: QUERY
}

const RELAY_H = '-_8'
const RELAY_AUTHORIZATION = 'AQID'

type FetchCall = { url: string; init: { body?: string; headers?: Record<string, string> } }

const makeFetch = (response: { status?: number; ok?: boolean; json?: unknown }, calls: FetchCall[]) =>
	((url: unknown, init?: unknown) => {
		calls.push({ url: String(url), init: (init ?? {}) as { body?: string; headers?: Record<string, string> } })
		const ok = response.ok ?? (response.status ?? 200) < 300
		return Promise.resolve({
			ok,
			status: response.status ?? 200,
			text: async () => JSON.stringify(response.json ?? { h: RELAY_H, authorization: RELAY_AUTHORIZATION }),
			body: { cancel: async () => undefined }
		})
	}) as unknown as typeof fetch

describe('native android registration relay provider', () => {
	it('signs through the device relay and appends the device h= verbatim', async () => {
		const calls: FetchCall[] = []
		const provider = createNativeAndroidRegistrationRelayProvider({
			url: 'https://api.example.com',
			fetch: makeFetch({ json: { h: RELAY_H, authorization: RELAY_AUTHORIZATION } }, calls)
		})

		const attested = await provider(CONTEXT)

		expect(calls).toHaveLength(1)
		expect(calls[0]!.url).toBe('https://api.example.com/registration/attestation')
		const payload = JSON.parse(calls[0]!.init.body!) as { payloadBase64: string; challengeBase64?: string }
		// Signed-plaintext fallback: the device signs the exact query bytes.
		expect(Buffer.from(payload.payloadBase64, 'base64').toString('utf8')).toBe(QUERY)
		expect(payload.challengeBase64).toBeUndefined()
		expect(attested.body).toBe(`${QUERY}&H=${RELAY_H}`)
		expect(attested.authorization).toBe(RELAY_AUTHORIZATION)
		expect(attested.userAgent).toBeUndefined()
	})

	it('sends the bare enc value as payload when the envelope material is set', async () => {
		const calls: FetchCall[] = []
		const material = { serverPublicKey: Curve.generateKeyPair().public }
		const provider = createNativeAndroidRegistrationRelayProvider({
			url: 'https://api.example.com',
			envelopeMaterial: material,
			challenge: Uint8Array.from([1, 2, 3]),
			fetch: makeFetch({ json: { h: RELAY_H, authorization: RELAY_AUTHORIZATION } }, calls)
		})

		const attested = await provider(CONTEXT)

		// Each seal uses a fresh ephemeral key, so the test checks internal
		// consistency instead of re-sealing: the signed payload must be the
		// bare enc value carried in the returned body.
		expect(attested.body!.startsWith('ENC=')).toBe(true)
		const payload = JSON.parse(calls[0]!.init.body!) as { payloadBase64: string; challengeBase64?: string }
		const signedPayload = Buffer.from(payload.payloadBase64, 'base64').toString('utf8')
		expect(attested.body).toBe(`ENC=${signedPayload}&H=${RELAY_H}`)
		expect(signedPayload).not.toContain('ENC=')
		expect(payload.challengeBase64).toBe('AQID')
	})

	it('builds the User-Agent in the motor: explicit override, then real hardware, then raffled, device string last', async () => {
		const calls: FetchCall[] = []
		// The device cannot know which build its token material proves (the
		// material is server-side), and its hardcoded UA string is stale — the
		// motor must win the version/platform pair. Wire shape is the
		// Connector's `signer.deviceProperties()`.
		const deviceResponse = {
			h: RELAY_H,
			authorization: RELAY_AUTHORIZATION,
			userAgent: 'WhatsApp/2.26.36.72 SMBA/16 Device/Xiaomi-25078PC3EG',
			deviceProfile: { manufacturer: 'Xiaomi', model: '25078PC3EG', androidVersion: '16', sdkInt: '36' }
		}
		const CONSUMER_CONTEXT: NativeAndroidRegistrationBridgeContext = { ...CONTEXT, appVariant: 'consumer' }

		const withDevice = createNativeAndroidRegistrationRelayProvider({
			url: 'https://api.example.com',
			deviceProfile: { manufacturer: 'samsung', deviceModelType: 'SM-S948B', osVersion: '16' },
			fetch: makeFetch({ json: deviceResponse }, calls)
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
			userAgent: 'WhatsApp/2.26.36.72 SMBA/16 Device/samsung-SM-S948B',
			fetch: makeFetch({ json: deviceResponse }, calls)
		})
		const overridden = await withOverride(CONTEXT)
		expect(overridden.userAgent).toBe('WhatsApp/2.26.36.72 SMBA/16 Device/samsung-SM-S948B')

		const withoutDeviceProfile = createNativeAndroidRegistrationRelayProvider({
			url: 'https://api.example.com',
			deviceProfile: { manufacturer: 'samsung', deviceModelType: 'SM-S948B', osVersion: '16' },
			fetch: makeFetch({ json: { h: RELAY_H, authorization: RELAY_AUTHORIZATION } }, calls)
		})
		const raffled = await withoutDeviceProfile(CONTEXT)
		expect(raffled.userAgent).toBe('WhatsApp/2.26.36.72 SMBA/16 Device/samsung-SM-S948B')

		const bare = createNativeAndroidRegistrationRelayProvider({
			url: 'https://api.example.com',
			fetch: makeFetch({ json: deviceResponse }, calls)
		})
		const consumerBare = await bare(CONSUMER_CONTEXT)
		// No profile anywhere (device profile incomplete + no raffled): only
		// then is the device-supplied string trusted.
		const onlyString = createNativeAndroidRegistrationRelayProvider({
			url: 'https://api.example.com',
			fetch: makeFetch({ json: { ...deviceResponse, deviceProfile: undefined } }, calls)
		})
		const lastResort = await onlyString(CONSUMER_CONTEXT)
		expect(consumerBare.userAgent).toBe('WhatsApp/2.26.40.7 Android/16 Device/Xiaomi-25078PC3EG')
		expect(lastResort.userAgent).toBe('WhatsApp/2.26.36.72 SMBA/16 Device/Xiaomi-25078PC3EG')
	})

	it('rejects relay responses without signature or attestation', async () => {
		const calls: FetchCall[] = []
		const noSignature = createNativeAndroidRegistrationRelayProvider({
			url: 'https://api.example.com',
			fetch: makeFetch({ json: { authorization: RELAY_AUTHORIZATION } }, calls)
		})
		await expect(noSignature(CONTEXT)).rejects.toThrow('did not provide the payload signature')

		const noChain = createNativeAndroidRegistrationRelayProvider({
			url: 'https://api.example.com',
			fetch: makeFetch({ json: { h: RELAY_H } }, calls)
		})
		await expect(noChain(CONTEXT)).rejects.toThrow('did not provide attestation')

		const httpError = createNativeAndroidRegistrationRelayProvider({
			url: 'https://api.example.com',
			fetch: makeFetch({ status: 503, json: { error: 'no_provider_available' } }, calls)
		})
		await expect(httpError(CONTEXT)).rejects.toThrow('returned HTTP 503')
	})

	it('requires HTTPS for non-loopback relay urls', () => {
		expect(() =>
			createNativeAndroidRegistrationRelayProvider({ url: 'http://api.example.com', fetch: makeFetch({}, []) })
		).toThrow('requires HTTPS')
		expect(() =>
			createNativeAndroidRegistrationRelayProvider({ url: 'http://127.0.0.1:8080', fetch: makeFetch({}, []) })
		).not.toThrow()
	})
})
