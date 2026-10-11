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

const DEVICE = {
	profileId: 'fixture-profile',
	manufacturer: 'Xiaomi',
	device: 'fixture-device',
	osVersion: '14',
	osBuildNumber: 'AP1A.240505.005',
	phoneId: 'f85c1f5ff4823fcb',
	deviceExpId: '9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d',
	mcc: '724',
	mnc: '05',
	localeLanguageIso6391: 'pt',
	localeCountryIso31661Alpha2: 'BR'
}

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
			account: ACCOUNT,
			device: DEVICE
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
		// Official C10890eL: both cursors start at the same random id
		// (nextInt(16777214)+1), not at 1.
		expect(creds.firstUnuploadedPreKeyId).toBe(creds.nextPreKeyId)
		expect(creds.firstUnuploadedPreKeyId).toBeGreaterThanOrEqual(1)
		expect(creds.firstUnuploadedPreKeyId).toBeLessThanOrEqual(16_777_214)
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
			register: { status: 'ok', lid: null, edgeRoutingInfo: null } as never,
			device: DEVICE
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
				register: { status: 'sent', reason: null } as never,
				device: DEVICE
			})
		).toThrow('status of "sent"')
		expect(() =>
			buildPrimaryRegistrationAuthCreds({
				keys,
				common: COMMON,
				register: { status: 'fail', reason: 'blocked' } as never,
				device: DEVICE
			})
		).toThrow('reason: blocked')
		expect(() =>
			buildPrimaryRegistrationAuthCreds({
				keys,
				common: { ...COMMON, nationalNumber: '' },
				register: { status: 'ok' } as never,
				device: DEVICE
			})
		).toThrow('account digits')
		// Fail-closed (audit A06): an unmarked session would be classified as
		// non-primary on every later connect.
		expect(() =>
			buildPrimaryRegistrationAuthCreds({
				keys,
				common: COMMON,
				register: { status: 'ok' } as never,
				device: undefined as never
			})
		).toThrow('persisted device profile')
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
			skipOnboarding: true,
			skipFunnel: true,
			common: COMMON,
			account: ACCOUNT,
			nativeIdentity: { device: DEVICE },
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

		const code = await flow.requestCode({ method: 'sms', token: '11999999999' })
		expect(code.httpStatus).toBe(200)
		expect(code.attempts).toBe(1)
		expect(code.response.status).toBe('sent')
		// /v2/code keeps the wait fields as strings (optString), 1:1 with the APK.
		expect(code.response.smsWait).toBe('30')
		// The caller passes the bridge placeholder explicitly (the motor never
		// fabricates a token); the bridge replaces it in-APK before the wire.
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
			skipOnboarding: true,
			skipFunnel: true,
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

		const code = await flow.requestCode({ method: 'voice', token: '11999999999' })
		expect(code.request.registrationType).toBe(1)
		expect(contexts[0]!.registrationType).toBe(1)
		expect(code.request.body).toContain('login=5511999999999%40s.whatsapp.net&type=1')
		expect(code.request.body).not.toMatch(/(^|&)in=/)
	})

	it('returns no creds when /v2/register does not complete', async () => {
		const flow = createNativeAndroidRegistrationFlow({
			skipOnboarding: true,
			skipFunnel: true,
			common: COMMON,
			nativeIdentity: { device: DEVICE },
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
			skipOnboarding: true,
			skipFunnel: true,
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

		const code = await flow.requestCode({ method: 'sms', token: '11999999999' })
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

	it('runs the onboarding pre-flight abprop → exist before the first /v2/code', async () => {
		const calls: { url: string; body: string }[] = []
		const flow = createNativeAndroidRegistrationFlow({
			skipFunnel: true,
			common: COMMON,
			advertisingId: '11111111-2222-3333-4444-555555555555',
			onboardClientMetrics: '{"GMSVersion":263234032}',
			attestationProvider: async context => ({ authorization: 'Native attestation', body: context.body }),
			http: {
				baseUrl: 'https://registration.lab.invalid',
				fetch: (async (url: RequestInfo | URL, init?: RequestInit) => {
					calls.push({ url: String(url), body: String(init?.body ?? '') })
					const payload = calls.length < 3 ? { status: 'ok' } : { status: 'sent' }
					return new Response(JSON.stringify(payload), { status: 200 })
				}) as unknown as typeof fetch
			}
		})

		const code = await flow.requestCode({ method: 'sms', token: '11999999999' })
		expect(calls.map(call => call.url)).toEqual([
			'https://registration.lab.invalid/v2/reg_onboard_abprop',
			'https://registration.lab.invalid/v2/exist',
			'https://registration.lab.invalid/v2/code'
		])

		// abprop = the native "common" map: rc first, in last, never `platform`.
		const abprop = calls[0]!.body
		expect(abprop.startsWith('rc=')).toBe(true)
		expect(abprop.endsWith(`in=${COMMON.nationalNumber}`)).toBe(true)
		expect(abprop).not.toContain('platform=')
		expect(abprop).toContain(`fdid=${COMMON.fingerprintDeviceId}`)
		expect(abprop).toContain('lc=BR&lg=pt')

		// exist = the device onboarding check: no token on the wire.
		// advertising_id leads (official wire order), backup_token right after.
		const exist = calls[1]!.body
		// Server schema (2026-10-08): /v2/exist demands `in` right after `cc`
		// (missing_param: `in`); the 2026-09-24 capture carried no number.
		expect(exist).toContain(`cc=55&in=${COMMON.nationalNumber}`)
		expect(exist).not.toMatch(/(^|&)token=/)
		expect(exist.startsWith('advertising_id=11111111-2222-3333-4444-555555555555&backup_token=')).toBe(true)
		expect(exist).toContain('cc=55')
		expect(exist).toContain('e_skey_id=')
		// Server schema (2026-10-08): /v2/exist requires the FULL e_* key
		// bundle — the live server walked missing_param one field at a time
		// (e_skey_sig, then e_skey_val). The 2026-09-24 capture sent only
		// e_skey_id; the wire schema tightened afterwards.
		expect(exist).toContain('authkey=')
		expect(exist).toContain('e_ident=')
		expect(exist).toContain('e_keytype=')
		expect(exist).toContain('e_regid=')
		expect(exist).toContain('e_skey_val=')
		expect(exist).toContain('e_skey_sig=')
		// exist carries its own client_metrics producer ({"GMSVersion":...}).
		expect(exist).toContain('client_metrics=%7B%22GMSVersion%22%3A263234032%7D')

		// The install GAID falls through to /v2/code when the call passes none.
		expect(calls[2]!.body).toContain('advertising_id=11111111-2222-3333-4444-555555555555')

		// onboard() shares one promise: re-entry never duplicates the pre-flight.
		await flow.onboard()
		expect(calls).toHaveLength(3)
		expect(code.response.status).toBe('sent')
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
			skipOnboarding: true,
			skipFunnel: true,
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

	it('sends the consumer-variant token computed from the com.whatsapp material', async () => {
		const material: NativeAndroidRegistrationTokenMaterial = {
			packageName: NATIVE_ANDROID_REGISTRATION_PACKAGES.consumer,
			logoResource: readFileSync(join(fixturesDir, 'consumer', 'about_logo.png')),
			signingCertDer: readFileSync(join(fixturesDir, 'consumer', 'signing-cert.der')),
			classesDexMd5: Uint8Array.from(
				Buffer.from(readFileSync(join(fixturesDir, 'consumer', 'classes-dex.md5'), 'utf8').trim(), 'hex')
			)
		}
		const flow = singleShotFlow({ tokenMaterial: material })
		const code = await flow.requestCode({ method: 'sms' })
		// Same `in=1531997072` as the golden business capture, consumer variant:
		// recomputed 1:1 from the 2.26.38.10 com.whatsapp install material.
		expect(code.request.body).toContain(`token=${percentEncodeRegistrationString('B+sKKrrUz4S/mlayTyhjAPfS+Bc=')}`)
		expect(code.request.body).not.toContain('&token=hEjVbznrgA3o2tS3JoE4vuRVxVg%3D')
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

	it('rejects /v2/code without a token and sends only a caller-passed bridge placeholder', async () => {
		const flow = singleShotFlow({})
		// The motor never fabricates a token (audit A07): without tokenMaterial
		// the caller must pass the bridge placeholder explicitly.
		await expect(flow.requestCode({ method: 'sms' })).rejects.toThrow(/official token/)
		const code = await flow.requestCode({ method: 'sms', token: '1531997072' })
		expect(code.request.body).toContain('&token=1531997072')
	})
})
