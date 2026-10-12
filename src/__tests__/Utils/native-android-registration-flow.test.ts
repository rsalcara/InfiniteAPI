import { createDecipheriv } from 'node:crypto'
import { jest } from '@jest/globals'
import { readFileSync } from 'fs'
import { dirname, join } from 'path'
import { fileURLToPath } from 'url'
import type { proto } from '../../../WAProto/index.js'
import { Curve } from '../../Utils/crypto'
import { buildPrimaryRegistrationAuthCreds, normalizeLidJid } from '../../Utils/native-android-registration-auth'
import type { NativeAndroidAttestationProofDiagnostics } from '../../Utils/native-android-registration-attestation-validation'
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
	computeRegistrationMaterialHash,
	NATIVE_ANDROID_REGISTRATION_PACKAGES,
	type NativeAndroidRegistrationTokenMaterial
} from '../../Utils/native-android-registration-token'
import logger from '../../Utils/logger'
import { registrationBlockScreenHash, type RegistrationLogMetadata } from '../../Utils/safe-registration-log'

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

describe('native_android registration block gate before /v2/code (audit gap E)', () => {
	const gateFlow = (existBody: unknown, abpropBody: unknown = { status: 'ok' }) => {
		const calls: string[] = []
		const flow = createNativeAndroidRegistrationFlow({
			skipFunnel: true,
			common: COMMON,
			attestationProvider: async context => ({ authorization: 'Native attestation', body: context.body }),
			http: {
				baseUrl: 'https://registration.lab.invalid',
				fetch: (async (url: RequestInfo | URL) => {
					const endpoint = String(url).replace('https://registration.lab.invalid', '')
					calls.push(endpoint)
					const payload =
						endpoint === '/v2/exist' ? existBody : endpoint === '/v2/reg_onboard_abprop' ? abpropBody : { status: 'sent' }
					return new Response(JSON.stringify(payload), { status: 200 })
				}) as unknown as typeof fetch
			}
		})
		return { flow, calls }
	}

	const rejectWith = async (promise: Promise<unknown>) =>
		promise.then(
			() => null,
			(error: unknown) => error as { message: string; data: Record<string, unknown> }
		)

	it('stops on a custom_block_screen from /v2/exist and preserves the screen in the error data', async () => {
		const screen = { title: 'Baixe o app oficial do WhatsApp para continuar' }
		const { flow, calls } = gateFlow({ status: 'fail', reason: 'blocked', custom_block_screen: screen })
		const rejected = await rejectWith(flow.requestCode({ method: 'sms', token: '11999999999' }))
		expect(rejected).not.toBeNull()
		expect(rejected!.message).toMatch(/registration blocked at exist/)
		expect(rejected!.data).toMatchObject({
			step: 'exist',
			endpoint: '/v2/exist',
			status: 'fail',
			reason: 'blocked',
			customBlockScreen: screen
		})
		// The APK renders the screen and never hammers the endpoint while blocked.
		expect(calls).toEqual(['/v2/reg_onboard_abprop', '/v2/exist'])
		expect(calls).not.toContain('/v2/code')
	})

	it('stops on a hard fail with a non-fresh reason before /v2/code', async () => {
		const { flow, calls } = gateFlow({ status: 'fail', reason: 'too_recent', retry_after: '24' })
		const rejected = await rejectWith(flow.requestCode({ method: 'sms', token: '11999999999' }))
		expect(rejected).not.toBeNull()
		expect(rejected!.message).toMatch(/registration blocked at exist/)
		expect(rejected!.data).toMatchObject({ step: 'exist', status: 'fail', reason: 'too_recent', customBlockScreen: null })
		expect(calls).not.toContain('/v2/code')
	})

	it('stops on a custom_block_screen from the abprop step too', async () => {
		const screen = { title: 'Atualize o WhatsApp para continuar' }
		const { flow, calls } = gateFlow({ status: 'fail', reason: 'incorrect' }, { status: 'fail', custom_block_screen: screen })
		const rejected = await rejectWith(flow.requestCode({ method: 'sms', token: '11999999999' }))
		expect(rejected).not.toBeNull()
		expect(rejected!.message).toMatch(/registration blocked at abprop/)
		expect(rejected!.data).toMatchObject({ step: 'abprop', endpoint: '/v2/reg_onboard_abprop', customBlockScreen: screen })
		// The onboarding pair (abprop → exist) runs as one pre-flight unit; the
		// gate guards the number-burning /v2/code, which must never go out.
		expect(calls).toEqual(['/v2/reg_onboard_abprop', '/v2/exist'])
		expect(calls).not.toContain('/v2/code')
	})

	it('treats reason incorrect as the fresh identity and continues to /v2/code', async () => {
		const { flow, calls } = gateFlow({ status: 'fail', reason: 'incorrect' })
		const code = await flow.requestCode({ method: 'sms', token: '11999999999' })
		expect(code.response.status).toBe('sent')
		expect(calls).toContain('/v2/code')
	})

	it('continues on status ok and on a fail with no actionable reason', async () => {
		const ok = gateFlow({ status: 'ok' })
		expect((await ok.flow.requestCode({ method: 'sms', token: '11999999999' })).response.status).toBe('sent')
		expect(ok.calls).toContain('/v2/code')

		// The gate needs an actionable reason to block (locked decision): a bare
		// `fail` without one does not name a screen, so the flow continues.
		const bare = gateFlow({ status: 'fail' })
		expect((await bare.flow.requestCode({ method: 'sms', token: '11999999999' })).response.status).toBe('sent')
		expect(bare.calls).toContain('/v2/code')
	})
})

describe('native_android registration attested device identity (audit gap D)', () => {
	// `signer.deviceProperties()` on the physical device: Build.MANUFACTURER,
	// Build.MODEL, Build.VERSION.RELEASE.
	const ATTESTED = { manufacturer: 'Xiaomi', model: '25078PC3EG', androidVersion: '16' }

	const rejectWith = async (promise: Promise<unknown>) =>
		promise.then(
			() => null,
			(error: unknown) => error as { message: string; data: Record<string, unknown> }
		)

	const fetchRecording = (calls: string[], payloads?: Record<string, unknown>) =>
		((async (url: RequestInfo | URL) => {
			calls.push(String(url).replace('https://registration.lab.invalid', ''))
			const body = String(url).endsWith('/register')
				? { status: 'ok', lid: '123456789012345' }
				: (payloads ?? { status: 'sent' })
			return new Response(JSON.stringify(body), { status: 200 })
		}) as unknown as typeof fetch)

	it('seeds the creds with the attested hardware winning over the raffled fields', async () => {
		const calls: string[] = []
		const flow = createNativeAndroidRegistrationFlow({
			skipOnboarding: true,
			skipFunnel: true,
			common: COMMON,
			nativeIdentity: { device: DEVICE },
			attestationProvider: async context => ({
				authorization: 'Native attestation',
				body: context.body,
				deviceProfile: ATTESTED
			}),
			http: { baseUrl: 'https://registration.lab.invalid', fetch: fetchRecording(calls) }
		})
		const code = await flow.requestCode({ method: 'sms', token: '11999999999' })
		expect(code.response.status).toBe('sent')
		const verified = await flow.verifyCode({ code: '123456' })
		const device = verified.creds?.nativeAndroidIdentity?.device
		expect(device).toMatchObject({
			// The TEE-reported Build.* fields win over the raffled ones...
			manufacturer: 'Xiaomi',
			deviceModelType: '25078PC3EG',
			osVersion: '16',
			// ...while the rest of the persisted install identity survives.
			profileId: DEVICE.profileId,
			phoneId: DEVICE.phoneId,
			deviceExpId: DEVICE.deviceExpId,
			mcc: DEVICE.mcc
		})
		// The flow exposes the same merged identity for the caller to persist.
		expect(flow.deviceProfile()).toMatchObject({
			manufacturer: 'Xiaomi',
			deviceModelType: '25078PC3EG',
			osVersion: '16',
			profileId: DEVICE.profileId
		})
	})

	it('rejects a mid-registration divergence of the attested hardware', async () => {
		const calls: string[] = []
		const reports = [ATTESTED, { manufacturer: 'Samsung', model: 'SM-A546B', androidVersion: '14' }]
		const flow = createNativeAndroidRegistrationFlow({
			skipFunnel: true,
			common: COMMON,
			nativeIdentity: { device: DEVICE },
			attestationProvider: async context => ({
				authorization: 'Native attestation',
				body: context.body,
				deviceProfile: reports.shift()
			}),
			http: { baseUrl: 'https://registration.lab.invalid', fetch: fetchRecording(calls) }
		})
		const rejected = await rejectWith(flow.requestCode({ method: 'sms', token: '11999999999' }))
		expect(rejected).not.toBeNull()
		expect(rejected!.message).toMatch(/diverged mid-registration/)
		expect(rejected!.data).toMatchObject({ step: 'device-profile-divergence' })
		// The divergent attestation never releases a request to the wire.
		expect(calls).toEqual(['/v2/reg_onboard_abprop'])
		expect(calls).not.toContain('/v2/code')
	})

	it('accepts alias spellings of the same hardware across attestations', async () => {
		const calls: string[] = []
		const reports = [ATTESTED, { manufacturer: 'Xiaomi', deviceModelType: '25078PC3EG', osVersion: '16' }]
		const flow = createNativeAndroidRegistrationFlow({
			skipOnboarding: true,
			skipFunnel: true,
			common: COMMON,
			nativeIdentity: { device: DEVICE },
			attestationProvider: async context => ({
				authorization: 'Native attestation',
				body: context.body,
				deviceProfile: reports.shift()
			}),
			http: { baseUrl: 'https://registration.lab.invalid', fetch: fetchRecording(calls) }
		})
		const first = await flow.requestCode({ method: 'sms', token: '11999999999' })
		const second = await flow.requestCode({ method: 'sms', token: '11999999999' })
		expect(first.response.status).toBe('sent')
		expect(second.response.status).toBe('sent')
		expect(calls).toEqual(['/v2/code', '/v2/code'])
	})

	it('names the attested hardware on funnel events sent after the first attestation', async () => {
		const userAgents: { endpoint: string; ua: string | null }[] = []
		const flow = createNativeAndroidRegistrationFlow({
			common: COMMON,
			// Persisted profile: the raffled install identity (Redmi model code).
			nativeIdentity: { device: { ...DEVICE, deviceModelType: '23127PN0CC' } },
			attestationProvider: async context => ({
				authorization: 'Native attestation',
				body: context.body,
				// Only the first attestation reports hardware; later silence is
				// not divergence and the captured profile keeps winning.
				...(context.endpoint === '/v2/reg_onboard_abprop' ? { deviceProfile: ATTESTED } : {})
			}),
			http: {
				baseUrl: 'https://registration.lab.invalid',
				fetch: (async (url: RequestInfo | URL, init?: RequestInit) => {
					const endpoint = String(url).replace('https://registration.lab.invalid', '')
					userAgents.push({ endpoint, ua: new Headers(init?.headers).get('user-agent') })
					return new Response(JSON.stringify(endpoint.endsWith('_log') ? {} : { status: 'sent' }), { status: 200 })
				}) as unknown as typeof fetch
			}
		})
		await flow.requestCode({ method: 'sms', token: '11999999999' })

		const uaFor = (endpoint: string) => userAgents.filter(entry => entry.endpoint === endpoint).map(entry => entry.ua)
		// `session_start` fires before any attestation: the persisted profile.
		expect(uaFor('/v2/pre_pn_client_log')).toEqual(['WhatsApp/2.26.36.72 SMBA/14 Device/Xiaomi-23127PN0CC'])
		// Every funnel event after the first attestation names the TEE hardware.
		const clientLogs = uaFor('/v2/client_log')
		expect(clientLogs.length).toBeGreaterThan(0)
		for (const ua of clientLogs) {
			expect(ua).toBe('WhatsApp/2.26.36.72 SMBA/16 Device/Xiaomi-25078PC3EG')
		}
	})
})

describe('native_android registration sanitized step correlation (audit gap F)', () => {
	const PROOF: NativeAndroidAttestationProofDiagnostics = {
		chainLength: 3,
		chainHash: 'a'.repeat(64),
		signatureHash: 'b'.repeat(64),
		attestationHash: 'c'.repeat(64),
		attestedPackage: 'com.whatsapp.w4b',
		packageNameMatches: true,
		signingCertMatches: true,
		challengeTimestampMs: 1_700_000_000_000,
		challengeAgeMs: 42,
		rootFingerprint: 'd'.repeat(64)
	}

	const material: NativeAndroidRegistrationTokenMaterial = {
		packageName: NATIVE_ANDROID_REGISTRATION_PACKAGES.business,
		logoResource: Uint8Array.from([1, 2, 3]),
		signingCertDer: Uint8Array.from([4, 5]),
		// The token validation pins classesDexMd5 to the raw 16-byte MD5 digest.
		classesDexMd5: Uint8Array.from({ length: 16 }, (_, index) => index)
	}

	const ALLOWED_KEYS = new Set([
		'endpoint',
		'operationId',
		'phase',
		'attempts',
		'durationMs',
		'httpStatus',
		'category',
		'status',
		'reason',
		'blockScreenHash',
		'materialHash',
		'proofHash',
		'attestedPackage',
		'challengeAgeMs',
		'packageNameMatches',
		'signingCertMatches'
	])

	const stepLines = (spy: { mock: { calls: unknown[][] } }): RegistrationLogMetadata[] =>
		spy.mock.calls
			.filter(call => call[1] === 'native_android registration step')
			.map(call => call[0] as RegistrationLogMetadata)

	const httpLines = (spy: { mock: { calls: unknown[][] } }): RegistrationLogMetadata[] =>
		spy.mock.calls
			.filter(call => call[1] === 'native_android registration response')
			.map(call => call[0] as RegistrationLogMetadata)

	const fetchRecording = (calls: string[], payloads?: Record<string, unknown>) =>
		((async (url: RequestInfo | URL) => {
			calls.push(String(url).replace('https://registration.lab.invalid', ''))
			const body = String(url).endsWith('/register')
				? { status: 'ok', lid: '123456789012345' }
				: (payloads ?? { status: 'sent' })
			return new Response(JSON.stringify(body), { status: 200 })
		}) as unknown as typeof fetch)

	it('logs one allowlisted correlation line per registration step', async () => {
		const debugSpy = jest.spyOn(logger, 'debug').mockImplementation(() => {})
		try {
			const calls: string[] = []
			const flow = createNativeAndroidRegistrationFlow({
				skipFunnel: true,
				common: COMMON,
				nativeIdentity: { device: DEVICE },
				tokenMaterial: material,
				attestationProvider: async context => ({
					authorization: 'Native attestation',
					body: context.body,
					attestation: PROOF
				}),
				http: { baseUrl: 'https://registration.lab.invalid', fetch: fetchRecording(calls) }
			})
			await flow.requestCode({ method: 'sms' })
			await flow.verifyCode({ code: '123456' })

			const steps = stepLines(debugSpy)
			expect(steps.map(line => line.phase)).toEqual(['abprop', 'exist', 'code', 'register'])
			expect(steps.map(line => line.endpoint)).toEqual([
				'/v2/reg_onboard_abprop',
				'/v2/exist',
				'/v2/code',
				'/v2/register'
			])
			for (const line of steps) {
				expect(line.operationId).toBe('native-android-registration')
				expect(line.status).toBeDefined()
				// The material and the proof are named by digest/identity only.
				expect(line.materialHash).toBe(computeRegistrationMaterialHash(material))
				expect(line.proofHash).toBe(PROOF.signatureHash)
				expect(line.attestedPackage).toBe(PROOF.attestedPackage)
				expect(line.challengeAgeMs).toBe(42)
				expect(Object.keys(line).every(key => ALLOWED_KEYS.has(key))).toBe(true)
			}

			// The per-HTTP lines carry the same proof correlation per request.
			const http = httpLines(debugSpy)
			expect(http.map(line => line.endpoint)).toEqual([
				'/v2/reg_onboard_abprop',
				'/v2/exist',
				'/v2/code',
				'/v2/register'
			])
			for (const line of http) {
				expect(line.proofHash).toBe(PROOF.signatureHash)
				expect(line.attestedPackage).toBe(PROOF.attestedPackage)
				expect(line.challengeAgeMs).toBe(42)
				expect(line.materialHash).toBeUndefined()
			}
		} finally {
			debugSpy.mockRestore()
		}
	})

	it('digests a custom_block_screen on the step line and never logs its content', async () => {
		const debugSpy = jest.spyOn(logger, 'debug').mockImplementation(() => {})
		try {
			const screen = { title: 'Baixe o app oficial do WhatsApp para continuar' }
			const calls: string[] = []
			const flow = createNativeAndroidRegistrationFlow({
				skipFunnel: true,
				common: COMMON,
				tokenMaterial: material,
				attestationProvider: async context => ({
					authorization: 'Native attestation',
					body: context.body,
					attestation: PROOF
				}),
				http: {
					baseUrl: 'https://registration.lab.invalid',
					fetch: (async (url: RequestInfo | URL) => {
						const endpoint = String(url).replace('https://registration.lab.invalid', '')
						calls.push(endpoint)
						const payload =
							endpoint === '/v2/exist'
								? { status: 'fail', reason: 'blocked', custom_block_screen: screen }
								: { status: 'ok' }
						return new Response(JSON.stringify(payload), { status: 200 })
					}) as unknown as typeof fetch
				}
			})
			await expect(flow.requestCode({ method: 'sms' })).rejects.toThrow(/registration blocked at exist/)

			const steps = stepLines(debugSpy)
			expect(steps.map(line => line.phase)).toEqual(['abprop', 'exist'])
			const exist = steps.find(line => line.phase === 'exist')!
			expect(exist.status).toBe('fail')
			expect(exist.reason).toBe('blocked')
			expect(exist.blockScreenHash).toBe(registrationBlockScreenHash(screen))
			// The screen document itself never reaches any log line.
			expect(JSON.stringify(debugSpy.mock.calls)).not.toContain('Baixe o app oficial')
		} finally {
			debugSpy.mockRestore()
		}
	})

	it('drops hostile server/device tokens instead of logging or throwing on them', async () => {
		const debugSpy = jest.spyOn(logger, 'debug').mockImplementation(() => {})
		try {
			const flow = createNativeAndroidRegistrationFlow({
				skipFunnel: true,
				skipOnboarding: true,
				common: COMMON,
				tokenMaterial: material,
				attestationProvider: async context => ({
					authorization: 'Native attestation',
					body: context.body,
					attestation: {
						...PROOF,
						attestedPackage: '<script>alert(1)</script>',
						challengeAgeMs: Number.NaN
					}
				}),
				http: {
					baseUrl: 'https://registration.lab.invalid',
					fetch: (async () =>
						new Response(JSON.stringify({ status: 'fail', reason: 'too recent!' }), {
							status: 200
						})) as unknown as typeof fetch
				}
			})
			await flow.requestCode({ method: 'sms' })

			const code = stepLines(debugSpy).find(line => line.phase === 'code')!
			expect(code.status).toBe('fail')
			// Hostile tokens are dropped — the line still logs, the flow still runs.
			expect(code.reason).toBeUndefined()
			expect(code.attestedPackage).toBeUndefined()
			expect(code.challengeAgeMs).toBeUndefined()
			expect(code.proofHash).toBe(PROOF.signatureHash)
		} finally {
			debugSpy.mockRestore()
		}
	})
})

describe('native_android registration unattested profile (whalibmob default)', () => {
	// Mirrors the server-side decrypt of the `ENC=` body (same as the envelope
	// suite), used with a test-owned server key pair to prove the sealed wire
	// carries the exact plaintext query.
	const decryptEnvelope = (enc: string, serverPrivate: Uint8Array): string => {
		const combined = Buffer.from(enc, 'base64')
		const ephemeralPublic = combined.subarray(0, 32)
		const cipherText = combined.subarray(32)
		const aesKey = Curve.sharedKey(serverPrivate, ephemeralPublic)
		const decipher = createDecipheriv('aes-256-gcm', aesKey, new Uint8Array(12))
		decipher.setAuthTag(cipherText.subarray(cipherText.length - 16))
		return Buffer.concat([
			decipher.update(cipherText.subarray(0, cipherText.length - 16)),
			decipher.final()
		]).toString('utf8')
	}

	type WireCall = { endpoint: string; headers: Record<string, string>; body: string }

	const wireRecording = (calls: WireCall[]) =>
		((async (url: RequestInfo | URL, init?: RequestInit) => {
			const headers: Record<string, string> = {}
			for (const [key, value] of Object.entries((init?.headers ?? {}) as Record<string, string>)) {
				headers[key.toLowerCase()] = String(value)
			}
			const endpoint = String(url).replace('https://registration.lab.invalid', '')
			calls.push({ endpoint, headers, body: String(init?.body ?? '') })
			const body = endpoint.endsWith('/register')
				? { status: 'ok', lid: '123456789012345' }
				: endpoint.endsWith('/exist')
					? { status: 'fail', reason: 'incorrect' }
					: { status: 'sent' }
			return new Response(JSON.stringify(body), { status: 200 })
		}) as unknown as typeof fetch)

	const unattestedFlow = (
		calls: WireCall[],
		overrides: Partial<Parameters<typeof createNativeAndroidRegistrationFlow>[0]> = {}
	) =>
		createNativeAndroidRegistrationFlow({
			attestationProfile: 'unattested',
			skipFunnel: true,
			common: COMMON,
			nativeIdentity: { device: DEVICE },
			http: { baseUrl: 'https://registration.lab.invalid', fetch: wireRecording(calls) },
			...overrides
		})

	it('sends every registration route as a sealed ENC= body with no H= and no Authorization', async () => {
		const calls: WireCall[] = []
		const flow = unattestedFlow(calls)
		await flow.requestCode({ method: 'voice', token: '1531997072' })
		const verified = await flow.verifyCode({ code: '123456' })
		expect(calls.map(call => call.endpoint)).toEqual([
			'/v2/reg_onboard_abprop',
			'/v2/exist',
			'/v2/code',
			'/v2/register'
		])
		for (const call of calls) {
			expect(call.body.startsWith('ENC=')).toBe(true)
			expect(call.body).not.toContain('&H=')
			expect(call.headers.authorization).toBeUndefined()
			// The UA is the one platform-selector input left once the provider is
			// gone: it names the persisted device and the announced build.
			expect(call.headers['user-agent']).toMatch(/^WhatsApp\/[\d.]+ SMBA\/14 Device\/Xiaomi-/)
		}
		// The unattested wire still completes the registration.
		expect(verified.creds?.registered).toBe(true)
	})

	it('drops the attestation artifacts from the environment and keeps the collected telemetry', async () => {
		const calls: WireCall[] = []
		const flow = unattestedFlow(calls, {
			environment: {
				gpia: 'foreign-jws-token',
				_gg: 'gg-leg',
				_gi: 'gi-leg',
				_gp: 'gp-leg',
				_ge: 'ge-leg',
				_ga: 'ga-leg',
				mcc: '724',
				mnc: '005',
				pid: 4321
			}
		})
		const code = await flow.requestCode({ method: 'sms', token: '1531997072' })
		// `code.request.body` is the plaintext the server recovers after
		// decrypting `ENC=`: no attestation artifact survives the profile while
		// the telemetry stays exactly as collected.
		for (const key of ['gpia', '_gg', '_gi', '_gp', '_ge', '_ga']) {
			expect(code.request.body).not.toContain(`${key}=`)
		}
		expect(code.request.body).toContain('mcc=724')
		expect(code.request.body).toContain('mnc=005')
		expect(code.request.body).toContain('pid=4321')
	})

	it('replays the official wamsys gpia blob via gpiaMaterial over the sanitized map', async () => {
		const calls: WireCall[] = []
		const flow = unattestedFlow(calls, {
			environment: {
				gpia: 'foreign-jws-token',
				_gg: 'gg-leg',
				mcc: '724'
			},
			// Captured official-APK blob (399-char base64url, no dots) — replayed
			// verbatim, never minted by the flow.
			gpiaMaterial: 'CucBARCnMGuUec80qoccpQQaREALBLOB'
		})
		const code = await flow.requestCode({ method: 'sms', token: '1531997072' })
		expect(code.request.body).toContain('gpia=CucBARCnMGuUec80qoccpQQaREALBLOB')
		expect(code.request.body).not.toContain('foreign-jws-token')
		// gpiaMaterial owns only `gpia`: the Play Integrity legs stay dropped.
		expect(code.request.body).not.toContain('_gg=')
		expect(code.request.body).toContain('mcc=724')
	})

	it('seals with the caller envelope material so the plaintext round-trips', async () => {
		const server = Curve.generateKeyPair()
		const calls: WireCall[] = []
		const flow = unattestedFlow(calls, { envelopeMaterial: { serverPublicKey: server.public } })
		const code = await flow.requestCode({ method: 'sms', token: '1531997072' })
		const wire = calls.find(call => call.endpoint === '/v2/code')!
		expect(decryptEnvelope(wire.body.slice(4), server.private)).toBe(code.request.body)
	})

	it('requires a device profile for the User-Agent', () => {
		expect(() => createNativeAndroidRegistrationFlow({ attestationProfile: 'unattested', common: COMMON })).toThrow(
			/requires a device profile/
		)
	})

	it('refuses an attestation provider on the unattested profile', () => {
		expect(() =>
			createNativeAndroidRegistrationFlow({
				attestationProfile: 'unattested',
				common: COMMON,
				nativeIdentity: { device: DEVICE },
				attestationProvider: async () => ({ authorization: 'Native attestation' })
			})
		).toThrow(/never uses an attestation provider/)
	})

	it('still requires an attestation provider on the device profile', () => {
		expect(() => createNativeAndroidRegistrationFlow({ skipOnboarding: true, skipFunnel: true, common: COMMON })).toThrow(
			/requires an attestation provider/
		)
	})
})
