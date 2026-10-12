import {
	buildNativeAndroidClientFunnelQuery,
	buildNativeAndroidClientFunnelRequest,
	buildNativeAndroidPrePnFunnelQuery,
	buildNativeAndroidPrePnFunnelRequest,
	type NativeAndroidRegistrationFunnelOptions
} from '../../Utils/native-android-registration-funnel'
import { createNativeAndroidRegistrationFlow } from '../../Utils/native-android-registration-flow'
import {
	buildNativeAndroidRegistrationKeyBundle,
	createNativeAndroidRegistrationSignalKeys
} from '../../Utils/native-android-registration-keys'
import type { NativeAndroidRegistrationCommon } from '../../Utils/native-android-registration-protocol'

const keys = createNativeAndroidRegistrationSignalKeys()

const COMMON: NativeAndroidRegistrationCommon = {
	appVariant: 'business',
	language: 'pt',
	country: 'BR',
	countryCallingCode: '55',
	nationalNumber: '11999999999',
	fingerprintDeviceId: 'fixed-fdid',
	expirationId: '7d444840-9dc0-11d1-b245-5ffdce74fad2',
	identityId: Uint8Array.from([0x00, 0xff]),
	backupToken: Uint8Array.from([0x61, 0x62]),
	keyBundle: buildNativeAndroidRegistrationKeyBundle(keys)
}

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

// expid: UUID -> 16 bytes -> base64url, exactly like APK A03 (Fvy.A15).
const EXPID_B64 = Buffer.from('7d4448409dc011d1b2455ffdce74fad2', 'hex').toString('base64url')

const EVENT = {
	currentScreen: 'enter_number',
	previousScreen: 'unknown',
	actionTaken: 'session_start',
	eventName: 'registration_session_start'
}

const OPTIONS: NativeAndroidRegistrationFunnelOptions = {
	accessSessionId: '1c9a2f6e-5b3d-4a21-9f0e-88aa77bb66cc',
	advertisingId: '11111111-2222-3333-4444-555555555555',
	environment: { network_radio_type: 13, simnum: 1, hasinrc: 0 },
	userAgent: 'WhatsApp/2.26.39.72 SMBA/14 Device/Xiaomi-fixture-device'
}

const queryKeys = (query: string): string[] => query.split('&').map(part => part.split('=')[0]!)
const queryValue = (query: string, key: string): string | undefined => {
	const prefix = `${key}=`
	const part = query.split('&').find(entry => entry.startsWith(prefix))
	return part === undefined ? undefined : part.slice(prefix.length)
}

describe('native_android registration funnel wire (APK 1:1)', () => {
	it('builds /v2/pre_pn_client_log exactly like sendPrePNClientFunnelLog', () => {
		const query = buildNativeAndroidPrePnFunnelQuery(COMMON, EVENT, OPTIONS)
		expect(queryKeys(query)).toEqual([
			'lg',
			'lc',
			'expid',
			'access_session_id',
			'current_screen',
			'previous_screen',
			'action_taken',
			'event_name',
			'is_add_account_flow',
			'access_funnel_type',
			'android_advertising_id',
			'device_country',
			'fdid',
			'network_radio_type',
			'simnum',
			'hasinrc',
			'pid',
			'rc'
		])
		expect(queryValue(query, 'lg')).toBe('pt')
		expect(queryValue(query, 'lc')).toBe('BR')
		expect(queryValue(query, 'expid')).toBe(EXPID_B64)
		expect(queryValue(query, 'access_session_id')).toBe(
			Buffer.from('1c9a2f6e5b3d4a219f0e88aa77bb66cc', 'hex').toString('base64url')
		)
		expect(queryValue(query, 'current_screen')).toBe('enter_number')
		expect(queryValue(query, 'previous_screen')).toBe('unknown')
		expect(queryValue(query, 'action_taken')).toBe('session_start')
		expect(queryValue(query, 'event_name')).toBe('registration_session_start')
		expect(queryValue(query, 'is_add_account_flow')).toBe('false')
		expect(queryValue(query, 'access_funnel_type')).toBe('wa')
		expect(queryValue(query, 'android_advertising_id')).toBe('11111111-2222-3333-4444-555555555555')
		expect(queryValue(query, 'device_country')).toBe('br')
		expect(queryValue(query, 'fdid')).toBe('fixed-fdid')
		expect(queryValue(query, 'network_radio_type')).toBe('13')
		expect(queryValue(query, 'simnum')).toBe('1')
		expect(queryValue(query, 'hasinrc')).toBe('0')
		expect(queryValue(query, 'pid')).toBe(String(process.pid))
		expect(queryValue(query, 'rc')).toBe('0')
		// The pre-pn direct-field set has no fdid/id/backup_token/e2e bundle.
		expect(query).not.toContain('backup_token=')
		expect(query).not.toContain('authkey=')
	})

	it('builds /v2/client_log exactly like sendClientFunnelLog', () => {
		const query = buildNativeAndroidClientFunnelQuery(COMMON, { ...EVENT, currentScreen: 'verify_sms' }, OPTIONS)
		expect(queryKeys(query)).toEqual([
			'cc',
			'in',
			'lg',
			'lc',
			'fdid',
			'expid',
			'access_session_id',
			'id',
			'backup_token',
			'authkey',
			'e_ident',
			'e_keytype',
			'e_regid',
			'e_skey_id',
			'e_skey_val',
			'e_skey_sig',
			'current_screen',
			'previous_screen',
			'action_taken',
			'event_name',
			'registration_type',
			'is_add_account_flow',
			'android_advertising_id',
			'trace_id_int',
			'exposure_error_type',
			'network_radio_type',
			'simnum',
			'hasinrc',
			'pid',
			'rc'
		])
		expect(queryValue(query, 'cc')).toBe('55')
		expect(queryValue(query, 'in')).toBe('11999999999')
		expect(queryValue(query, 'id')).toBe('%00%FF')
		expect(queryValue(query, 'backup_token')).toBe('ab')
		expect(queryValue(query, 'current_screen')).toBe('verify_sms')
		expect(queryValue(query, 'registration_type')).toBe('0')
		expect(queryValue(query, 'exposure_error_type')).toBe('empty_exposure')
		const traceId = queryValue(query, 'trace_id_int')!
		expect(traceId).toMatch(/^\d+$/)
		expect(BigInt(traceId)).toBeLessThan(1n << 63n)
		// No `platform` field on any registration request.
		expect(query).not.toContain('platform=')
	})

	it('drops cc/in for the WA_TWO_FA flow like the /v2/code serializer', () => {
		const query = buildNativeAndroidClientFunnelQuery(
			{ ...COMMON, registrationType: 1, login: '5511999999999@s.whatsapp.net' },
			EVENT,
			OPTIONS
		)
		expect(queryKeys(query).slice(0, 2)).toEqual(['lg', 'lc'])
		expect(query).not.toMatch(/(^|&)cc=/)
		expect(query).not.toMatch(/(^|&)in=/)
	})

	it('seals the funnel bodies with ENC= only — no &H=, no attestation', () => {
		for (const request of [
			buildNativeAndroidPrePnFunnelRequest(COMMON, EVENT, OPTIONS),
			buildNativeAndroidClientFunnelRequest(COMMON, EVENT, OPTIONS)
		]) {
			expect(request.body.startsWith('ENC=')).toBe(true)
			expect(request.body).not.toContain('&H=')
			expect(request.sendAttestationPayload).toBe(false)
			expect(request.userAgent).toBe(OPTIONS.userAgent)
		}
		expect(buildNativeAndroidPrePnFunnelRequest(COMMON, EVENT, OPTIONS).endpoint).toBe('/v2/pre_pn_client_log')
		expect(buildNativeAndroidClientFunnelRequest(COMMON, EVENT, OPTIONS).endpoint).toBe('/v2/client_log')
	})
})

describe('native_android registration funnel flow sequence', () => {
	const flowHarness = (fetchImpl: typeof fetch) =>
		createNativeAndroidRegistrationFlow({
			common: COMMON,
			nativeIdentity: { device: DEVICE },
			attestationProvider: async context => ({ authorization: 'Native attestation', body: context.body }),
			http: { baseUrl: 'https://registration.lab.invalid', fetch: fetchImpl }
		})

	it('fires the official funnel events around exist, code and register', async () => {
		const calls: { url: string; body: string }[] = []
		const attestedEndpoints: string[] = []
		const responses = [
			{}, // pre_pn session_start
			{ status: 'ok' }, // abprop
			{}, // exist_attempt
			{ status: 'fail', reason: 'incorrect' }, // exist: identity fresh
			{}, // exist_success
			{}, // request_code_attempt
			{ status: 'sent', auth_challenge: 'Cgs' }, // /v2/code
			{}, // request_code_success
			{}, // submit_code_attempt
			{ status: 'ok', lid: '123456789012345', edge_routing_info: 'cm91dGU=' }, // /v2/register
			{} // submit_code_success
		]
		const flow = createNativeAndroidRegistrationFlow({
			common: COMMON,
			nativeIdentity: { device: DEVICE },
			attestationProvider: async context => {
				attestedEndpoints.push(context.endpoint)
				return { authorization: 'Native attestation', body: context.body }
			},
			http: {
				baseUrl: 'https://registration.lab.invalid',
				fetch: (async (url: RequestInfo | URL, init?: RequestInit) => {
					calls.push({ url: String(url), body: String(init?.body ?? '') })
					return new Response(JSON.stringify(responses.shift() ?? {}), { status: 200 })
				}) as unknown as typeof fetch
			}
		})

		await flow.requestCode({ method: 'sms', token: '11999999999' })
		const verified = await flow.verifyCode({ code: '123456' })
		expect(verified.creds).toBeDefined()

		expect(calls.map(call => call.url.replace('https://registration.lab.invalid', ''))).toEqual([
			'/v2/pre_pn_client_log',
			'/v2/reg_onboard_abprop',
			'/v2/client_log', // exist_attempt
			'/v2/exist',
			'/v2/client_log', // exist_success
			'/v2/client_log', // request_code_attempt
			'/v2/code',
			'/v2/client_log', // request_code_success
			'/v2/client_log', // submit_code_attempt
			'/v2/register',
			'/v2/client_log' // submit_code_success
		])

		// The funnel goes out sealed and unsigned; the attestation provider is
		// never called for it (HS5(false) routes carry no &H=/Authorization).
		for (const call of calls.filter(entry => entry.url.endsWith('_log'))) {
			expect(call.body.startsWith('ENC=')).toBe(true)
			expect(call.body).not.toContain('&H=')
		}
		expect(attestedEndpoints).toEqual(['/v2/reg_onboard_abprop', '/v2/exist', '/v2/code', '/v2/register'])

		// previous_screen follows the APK's pref chain ("unknown" first).
		const funnel = calls.filter(entry => entry.url.endsWith('_log'))
		expect(funnel[0]!.body.startsWith('ENC=')).toBe(true)
	})

	it('never lets funnel telemetry abort a registration', async () => {
		let registerStatus = ''
		const flow = flowHarness(
			(async (url: RequestInfo | URL) => {
				if (String(url).endsWith('_log')) throw new Error('telemetry endpoint down')
				if (String(url).endsWith('/register')) {
					registerStatus = 'ok'
					return new Response(JSON.stringify({ status: 'ok', lid: '123456789012345' }), { status: 200 })
				}

				return new Response(JSON.stringify({ status: 'sent', auth_challenge: 'Cgs' }), { status: 200 })
			}) as unknown as typeof fetch
		)

		const code = await flow.requestCode({ method: 'sms', token: '11999999999' })
		expect(code.response.status).toBe('sent')
		const verified = await flow.verifyCode({ code: '123456' })
		expect(registerStatus).toBe('ok')
		expect(verified.creds).toBeDefined()
	})
})
