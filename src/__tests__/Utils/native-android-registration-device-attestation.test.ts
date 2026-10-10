import { Curve } from '../../Utils/crypto'
import type { NativeAndroidRegistrationBridgeContext } from '../../Utils/native-android-registration-bridge-provider'
import {
	buildNativeAndroidRegistrationUserAgent,
	buildNativeAndroidRegistrationUserAgentFromParts,
	createNativeAndroidRegistrationDeviceAttestationProvider,
	nativeAndroidRegistrationAppVersion
} from '../../Utils/native-android-registration-device-attestation'

const QUERY = 'cc=55&token=hEjVbznrgA3o2tS3JoE4vuRVxVg%3D&in=1531997072'

const CONTEXT: NativeAndroidRegistrationBridgeContext = {
	endpoint: '/v2/code',
	appVariant: 'business',
	phoneNumber: '551531997072',
	login: '551531997072@s.whatsapp.net',
	body: QUERY
}

const SIGNATURE = Uint8Array.from([251, 255]) // flag-11 base64 (URL_SAFE) -> '-_8'
const KEY_CHAIN = Uint8Array.from([1, 2, 3]) // flag-2 base64 -> 'AQID'

const makeSigner = (calls: string[]) => ({
	signPayload: async (payload: Uint8Array) => {
		calls.push(`sign:${Buffer.from(payload).toString('utf8')}`)
		return SIGNATURE
	},
	buildAuthorization: async () => {
		calls.push('auth')
		return KEY_CHAIN
	}
})

describe('native android device attestation provider', () => {
	it('seals, signs and returns the wire body with H= and the key chain in official order', async () => {
		const calls: string[] = []
		const provider = createNativeAndroidRegistrationDeviceAttestationProvider({
			signer: makeSigner(calls),
			envelopeMaterial: { serverPublicKey: Curve.generateKeyPair().public },
			deviceProfile: { manufacturer: 'samsung', deviceModelType: 'SM-S948B', osVersion: '16' }
		})

		const attested = await provider(CONTEXT)
		expect(attested.body!.startsWith('ENC=')).toBe(true)
		expect(attested.body!.endsWith('&H=-_8')).toBe(true)
		// The signature covers the bare enc value, not the plain query.
		expect(calls[0]!.startsWith('sign:')).toBe(true)
		expect(calls[0]).not.toBe(`sign:${QUERY}`)
		expect(calls[0]!.slice(5)).toBe(attested.body!.slice(4, -'&H=-_8'.length))
		// Official order: the key chain is built AFTER the payload signature.
		expect(calls[1]).toBe('auth')
		expect(attested.authorization).toBe('AQID')
	})

	it('uses the APK signed-plaintext fallback without envelope material', async () => {
		const calls: string[] = []
		const provider = createNativeAndroidRegistrationDeviceAttestationProvider({
			signer: makeSigner(calls),
			deviceProfile: { manufacturer: 'samsung', deviceModelType: 'SM-S948B', osVersion: '16' }
		})

		const attested = await provider(CONTEXT)
		expect(attested.body).toBe(`${QUERY}&H=-_8`)
		expect(calls[0]).toBe(`sign:${QUERY}`)
		expect(attested.authorization).toBe('AQID')
	})

	it('derives the official User-Agent from the raffled device profile', async () => {
		const provider = createNativeAndroidRegistrationDeviceAttestationProvider({
			signer: makeSigner([]),
			deviceProfile: {
				manufacturer: 'samsung',
				deviceModelType: 'SM-S948B',
				osVersion: '16'
			}
		})

		const attested = await provider(CONTEXT)
		expect(attested.userAgent).toBe('WhatsApp/2.26.36.72 SMBA/16 Device/samsung-SM-S948B')
	})

	it('prefers an explicit User-Agent over the profile derivation', async () => {
		const provider = createNativeAndroidRegistrationDeviceAttestationProvider({
			signer: makeSigner([]),
			deviceProfile: { manufacturer: 'samsung', deviceModelType: 'SM-S948B', osVersion: '16' },
			userAgent: 'WhatsApp/2.26.36.72 SMBA/12 Device/Google-emulator64_x86_64_arm64'
		})

		const attested = await provider(CONTEXT)
		expect(attested.userAgent).toBe('WhatsApp/2.26.36.72 SMBA/12 Device/Google-emulator64_x86_64_arm64')
	})

	it('fails closed when neither profile nor override is given', async () => {
		const provider = createNativeAndroidRegistrationDeviceAttestationProvider({ signer: makeSigner([]) })
		await expect(provider(CONTEXT)).rejects.toThrow('registration User-Agent is required')
	})

	it('builds the exact X.0d3.A00 user-agent shape with the APK sanitize rule', () => {
		expect(
			buildNativeAndroidRegistrationUserAgentFromParts({
				androidVersion: '14',
				manufacturer: 'Google',
				model: 'Pixel 7'
			})
		).toBe('WhatsApp/2.26.36.72 SMBA/14 Device/Google-Pixel_7')
		// [^,\.\w\-\(\)] -> '_': spaces and other loose characters collapse to _
		expect(
			buildNativeAndroidRegistrationUserAgentFromParts({
				androidVersion: '12L',
				manufacturer: 'HMD Global',
				model: 'Nokia G50'
			})
		).toBe('WhatsApp/2.26.36.72 SMBA/12L Device/HMD_Global-Nokia_G50')
		expect(
			buildNativeAndroidRegistrationUserAgent({
				manufacturer: 'Google',
				deviceModelType: 'emulator64_x86_64_arm64',
				osVersion: '12'
			})
		).toBe('WhatsApp/2.26.36.72 SMBA/12 Device/Google-emulator64_x86_64_arm64')
	})

	it('announces the variant build with the official platform token', () => {
		// The token material of each variant comes from a specific build, and the
		// server pairs the announced User-Agent version with that material — a
		// mismatch reads as `bad_token`. Business material is 2.26.36.72
		// (`SMBA`); consumer material is 2.26.40.7 (`Android`, live native
		// registration capture — never the all-caps `ANDROID`).
		expect(nativeAndroidRegistrationAppVersion('business')).toEqual([2, 26, 36, 72])
		expect(nativeAndroidRegistrationAppVersion('consumer')).toEqual([2, 26, 40, 7])
		expect(nativeAndroidRegistrationAppVersion()).toEqual([2, 26, 36, 72])
		expect(
			buildNativeAndroidRegistrationUserAgentFromParts(
				{ androidVersion: '14', manufacturer: 'Google', model: 'Pixel 7' },
				'consumer'
			)
		).toBe('WhatsApp/2.26.40.7 Android/14 Device/Google-Pixel_7')
		expect(
			buildNativeAndroidRegistrationUserAgentFromParts(
				{ androidVersion: '14', manufacturer: 'Google', model: 'Pixel 7' },
				'business'
			)
		).toBe('WhatsApp/2.26.36.72 SMBA/14 Device/Google-Pixel_7')
	})

	it('rejects a provider without a device signer', () => {
		expect(() => createNativeAndroidRegistrationDeviceAttestationProvider({} as never)).toThrow(/device signer/)
		expect(() =>
			createNativeAndroidRegistrationDeviceAttestationProvider({
				signer: { signPayload: async () => new Uint8Array() } as never
			})
		).toThrow(/device signer/)
	})
})
