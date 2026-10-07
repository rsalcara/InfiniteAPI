import { readFileSync } from 'fs'
import { dirname, join } from 'path'
import { fileURLToPath } from 'url'
import type { proto } from '../../../WAProto/index.js'
import { buildPrimaryRegistrationAuthCreds, normalizeLidJid } from '../../Utils/native-android-registration-auth'
import type { NativeAndroidRegistrationBridgeContext } from '../../Utils/native-android-registration-bridge-provider'
import {
	createNativeAndroidRegistrationFlow,
	decodeRegistrationAuthChallenge
} from '../../Utils/native-android-registration-flow'
import { createNativeAndroidRegistrationSignalKeys } from '../../Utils/native-android-registration-keys'
import type { NativeAndroidRegistrationCommon } from '../../Utils/native-android-registration-protocol'
import { percentEncodeRegistrationString } from '../../Utils/native-android-registration-protocol'
import {
	buildClassicRegistrationToken,
	NATIVE_ANDROID_REGISTRATION_PACKAGES,
	type NativeAndroidRegistrationTokenMaterial
} from '../../Utils/native-android-registration-token'

const COMMON: Omit<NativeAndroidRegistrationCommon, 'keyBundle'> = {
	appVariant: 'business',
	language: 'pt',
	country: 'BR',
	countryCallingCode: '55',
	nationalNumber: '11999999999',
	fingerprintDeviceId: 'fixed-fdid',
	expirationId: '7d444840-9dc0-11d1-b245-5ffdce74fad2',
	identityId: Uint8Array.from([0x01]),
	backupToken: Uint8Array.from([0x61, 0x62, 0x63])
}

const ACCOUNT = { details: Uint8Array.from([0x09, 0x08]) } as unknown as proto.IADVSignedDeviceIdentity

describe('native_android LID normalization', () => {
	it('normalizes every official lid form into digits@lid', () => {
		expect(normalizeLidJid('123456789012345')).toBe('123456789012345@lid')
		expect(normalizeLidJid('123456789012345@lid')).toBe('123456789012345@lid')
		expect(normalizeLidJid('123456789012345:12@lid')).toBe('123456789012345@lid')
		expect(normalizeLidJid('not-a-lid')).toBeUndefined()
		expect(normalizeLidJid('')).toBeUndefined()
		expect(normalizeLidJid(null)).toBeUndefined()
	})
})

describe('native_android primary registration auth state', () => {
	const keys = createNativeAndroidRegistrationSignalKeys()

	it('uses the registration static key as the Noise key and keeps the registered Signal material', () => {
		const creds = buildPrimaryRegistrationAuthCreds({
			keys,
			common: COMMON,
			register: {
				status: 'ok',
				lid: '123456789012345',
				edgeRoutingInfo: 'cm91dGU='
			} as never,
			account: ACCOUNT
		})

		expect(creds.noiseKey).toBe(keys.clientStaticKeyPair)
		expect(creds.signedIdentityKey).toBe(keys.identity)
		expect(creds.signedPreKey).toBe(keys.signedPreKey)
		expect(creds.registrationId).toBe(keys.registrationId)
		expect(creds.registered).toBe(true)
		expect(creds.platform).toBe('smba')
		expect(creds.me?.id).toBe('5511999999999@s.whatsapp.net')
		expect(creds.me?.lid).toBe('123456789012345@lid')
		expect(creds.routingInfo).toEqual(Buffer.from('cm91dGU=', 'base64'))
		expect(creds.account).toBe(ACCOUNT)
		expect(creds.firstUnuploadedPreKeyId).toBe(1)
		expect(creds.nextPreKeyId).toBe(1)
		expect(creds.accountSyncCounter).toBe(0)
		expect(creds.accountSettings).toEqual({ unarchiveChats: false })
		expect(creds.processedHistoryMessages).toEqual([])
		expect(creds.pairingCode).toBeUndefined()
		expect(creds.lastPropHash).toBeUndefined()
		// Companion-pairing material is fresh, exactly like initAuthCreds().
		expect(creds.advSecretKey).toHaveLength(44)
		expect(creds.pairingEphemeralKeyPair.private).toHaveLength(32)
	})

	it('identifies consumer registrations as android on the platform field', () => {
		const creds = buildPrimaryRegistrationAuthCreds({
			keys,
			common: { ...COMMON, appVariant: 'consumer' },
			register: { status: 'ok', lid: null, edgeRoutingInfo: null } as never
		})
		expect(creds.platform).toBe('android')
		expect(creds.me?.lid).toBeUndefined()
		expect(creds.routingInfo).toBeUndefined()
	})

	it('refuses to assemble auth state from an incomplete registration', () => {
		expect(() =>
			buildPrimaryRegistrationAuthCreds({
				keys,
				common: COMMON,
				register: { status: 'sent', reason: null } as never
			})
		).toThrow('status of "sent"')
		expect(() =>
			buildPrimaryRegistrationAuthCreds({
				keys,
				common: COMMON,
				register: { status: 'fail', reason: 'blocked' } as never
			})
		).toThrow('reason: blocked')
		expect(() =>
			buildPrimaryRegistrationAuthCreds({
				keys,
				common: { ...COMMON, nationalNumber: '' },
				register: { status: 'ok' } as never
			})
		).toThrow('account digits')
	})
})

describe('native_android registration flow', () => {
	it('runs requestCode → verifyCode with the bridge and assembles creds', async () => {
		const contexts: NativeAndroidRegistrationBridgeContext[] = []
		const bodies: string[] = []
		const responses = [
			{
				status: 'sent',
				auth_challenge: Buffer.from([0x0a, 0x0b]).toString('base64'),
				sms_wait: 30
			},
			{
				status: 'ok',
				type: 'existing',
				lid: '123456789012345',
				edge_routing_info: 'cm91dGU='
			}
		]
		const flow = createNativeAndroidRegistrationFlow({
			common: COMMON,
			account: ACCOUNT,
			attestationProvider: async context => {
				contexts.push(context)
				return { authorization: 'Native attestation', body: context.body }
			},
			http: {
				baseUrl: 'https://registration.lab.invalid',
				fetch: (async (url: RequestInfo | URL, init?: RequestInit) => {
					bodies.push(String(url) + ' ' + String(init?.body))
					return new Response(JSON.stringify(responses.shift()), { status: 200 })
				}) as unknown as typeof fetch
			}
		})

		const code = await flow.requestCode({ method: 'sms' })
		expect(code.httpStatus).toBe(200)
		expect(code.attempts).toBe(1)
		expect(code.response.status).toBe('sent')
		// /v2/code keeps the wait fields as strings (optString), 1:1 with the APK.
		expect(code.response.smsWait).toBe('30')
		// The placeholder token keeps the official wire shape; the bridge
		// replaces it in-APK before the request goes out.
		expect(code.request.body).toContain('&token=11999999999&')
		expect(code.request.registrationType).toBeUndefined()
		expect(contexts[0]).toMatchObject({
			endpoint: '/v2/code',
			appVariant: 'business',
			phoneNumber: '5511999999999',
			login: '5511999999999@s.whatsapp.net',
			body: code.request.body
		})
		expect(contexts[0]!.registrationType).toBeUndefined()

		const verified = await flow.verifyCode({ code: '123456' })
		expect(verified.request.body).toContain('&code=123456&')
		// The /v2/code auth challenge is echoed as auth_response, 1:1 with the APK.
		expect(verified.request.body).toContain('&auth_response=Cgs')
		expect(contexts[1]).toMatchObject({ endpoint: '/v2/register', body: verified.request.body })

		const creds = verified.creds!
		expect(creds.noiseKey).toBe(flow.keys.clientStaticKeyPair)
		expect(creds.me?.id).toBe('5511999999999@s.whatsapp.net')
		expect(creds.me?.lid).toBe('123456789012345@lid')
		expect(creds.routingInfo).toEqual(Buffer.from('cm91dGU=', 'base64'))
		expect(creds.account).toBe(ACCOUNT)
		expect(creds.registered).toBe(true)
	})

	it('threads the WA_TWO_FA registration type to request, bridge and client', async () => {
		const contexts: NativeAndroidRegistrationBridgeContext[] = []
		const flow = createNativeAndroidRegistrationFlow({
			common: {
				...COMMON,
				login: '5511999999999@s.whatsapp.net',
				registrationType: 1
			},
			attestationProvider: async context => {
				contexts.push(context)
				return { authorization: 'Native attestation' }
			},
			http: {
				baseUrl: 'https://registration.lab.invalid',
				fetch: (async () =>
					new Response(JSON.stringify({ status: 'sent' }), { status: 200 })) as unknown as typeof fetch
			}
		})

		const code = await flow.requestCode({ method: 'voice' })
		expect(code.request.registrationType).toBe(1)
		expect(contexts[0]!.registrationType).toBe(1)
		expect(code.request.body).toContain('login=5511999999999%40s.whatsapp.net&type=1')
		expect(code.request.body).not.toMatch(/(^|&)in=/)
	})

	it('returns no creds when /v2/register does not complete', async () => {
		const flow = createNativeAndroidRegistrationFlow({
			common: COMMON,
			attestationProvider: async () => ({ authorization: 'Native attestation' }),
			http: {
				baseUrl: 'https://registration.lab.invalid',
				fetch: (async () =>
					new Response(JSON.stringify({ status: 'fail', reason: 'guessed_too_fast', guess_wait: 60 }), {
						status: 200
					})) as unknown as typeof fetch
			}
		})

		const verified = await flow.verifyCode({ code: '000000' })
		expect(verified.response.reason).toBe('guessed_too_fast')
		expect(verified.response.guessWait).toBe('60')
		expect(verified.creds).toBeUndefined()
	})

	it('short-circuits on the APK-executed response without a direct fetch', async () => {
		let fetchCalls = 0
		const flow = createNativeAndroidRegistrationFlow({
			common: COMMON,
			attestationProvider: async context => ({
				authorization: 'Native attestation',
				body: context.body,
				apkResponse: { status: 200, body: JSON.stringify({ status: 'sent', sms_wait: 10 }) }
			}),
			http: {
				baseUrl: 'https://registration.lab.invalid',
				fetch: (async () => {
					fetchCalls += 1
					return new Response('{}', { status: 200 })
				}) as unknown as typeof fetch
			}
		})

		const code = await flow.requestCode({ method: 'sms' })
		expect(code.response.smsWait).toBe('10')
		expect(code.attempts).toBe(1)
		expect(fetchCalls).toBe(0)
	})

	it('decodes auth challenges from both base64 alphabets', () => {
		expect(decodeRegistrationAuthChallenge(Buffer.from([0x0a, 0x0b]).toString('base64'))).toEqual(
			Uint8Array.from([0x0a, 0x0b])
		)
		expect(decodeRegistrationAuthChallenge('Cgs')).toEqual(Uint8Array.from([0x0a, 0x0b]))
	})
})

describe('native_android registration flow self-computed token', () => {
	const fixturesDir = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'native-android-registration-token')

	const captureMaterial = (): NativeAndroidRegistrationTokenMaterial => ({
		packageName: NATIVE_ANDROID_REGISTRATION_PACKAGES.business,
		logoResource: readFileSync(join(fixturesDir, 'about_logo.png')),
		signingCertDer: readFileSync(join(fixturesDir, 'signing-cert.der')),
		classesDexMd5: Uint8Array.from(
			Buffer.from(readFileSync(join(fixturesDir, 'classes-dex.md5'), 'utf8').trim(), 'hex')
		)
	})

	const singleShotFlow = (options: Partial<Parameters<typeof createNativeAndroidRegistrationFlow>[0]>) =>
		createNativeAndroidRegistrationFlow({
			common: { ...COMMON, nationalNumber: '1531997072' },
			...options,
			attestationProvider: async context => ({ authorization: 'Native attestation', body: context.body }),
			http: {
				baseUrl: 'https://registration.lab.invalid',
				fetch: (async () =>
					new Response(JSON.stringify({ status: 'sent' }), { status: 200 })) as unknown as typeof fetch
			}
		})

	it('sends the wire-verified classic token computed in the motor', async () => {
		const flow = singleShotFlow({ tokenMaterial: captureMaterial() })
		const code = await flow.requestCode({ method: 'sms' })
		// Golden /v2/code capture: in=1531997072 -> token=hEjVbznrgA3o2tS3JoE4vuRVxVg=
		// percent-encoded by the official encoder ('=' -> %3D).
		expect(code.request.body).toContain('&token=hEjVbznrgA3o2tS3JoE4vuRVxVg%3D')
		expect(code.request.body).not.toContain('&token=1531997072')
	})

	it('keys the WA_TWO_FA token on the login digits, like the in-APK hook', async () => {
		const material = captureMaterial()
		const flow = singleShotFlow({
			common: { ...COMMON, login: '5511999999999@s.whatsapp.net', registrationType: 1 },
			tokenMaterial: material
		})
		const code = await flow.requestCode({ method: 'voice' })
		const expected = buildClassicRegistrationToken('5511999999999', material)
		expect(code.request.body).toContain(`token=${percentEncodeRegistrationString(expected)}`)
		expect(code.request.body).not.toContain('token=5511999999999')
	})

	it('keeps the placeholder token when no material is configured (bridge replaces it)', async () => {
		const flow = singleShotFlow({})
		const code = await flow.requestCode({ method: 'sms' })
		expect(code.request.body).toContain('&token=1531997072')
	})
})
