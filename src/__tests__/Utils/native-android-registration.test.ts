import { createDecipheriv } from 'crypto'
import { Curve, generateSignalPubKey } from '../../Utils/crypto'
import { createNativeAndroidRegistrationBridgeProvider } from '../../Utils/native-android-registration-bridge-provider'
import { createNativeAndroidRegistrationHttpClient } from '../../Utils/native-android-registration-client'
import {
	buildNativeAndroidRegistrationKeyBundle,
	createNativeAndroidRegistrationSignalKeys
} from '../../Utils/native-android-registration-keys'
import {
	buildNativeAndroidRegisterRequest,
	buildNativeAndroidRequestCodeRequest,
	percentEncodeRegistrationBytes,
	percentEncodeRegistrationString,
	protectNativeAndroidRegistrationBody
} from '../../Utils/native-android-registration-protocol'

const COMMON = {
	appVariant: 'business',
	language: 'pt',
	country: 'BR',
	countryCallingCode: '55',
	nationalNumber: '11999999999',
	fingerprintDeviceId: 'fixed-fdid',
	expirationId: '7d444840-9dc0-11d1-b245-5ffdce74fad2',
	identityId: Uint8Array.from([0x01, 0x2b, 0xff]),
	backupToken: Uint8Array.from([0x61, 0x62, 0x63]),
	keyBundle: {
		authkey: Uint8Array.from([1]),
		e_ident: Uint8Array.from([2]),
		e_keytype: Uint8Array.from([5]),
		e_regid: Uint8Array.from([0, 0, 0x30, 0x39]),
		e_skey_id: Uint8Array.from([0, 0, 1]),
		e_skey_val: Uint8Array.from([3]),
		e_skey_sig: Uint8Array.from([4])
	}
} as const

describe('native_android primary registration keys', () => {
	it('creates device-0 Signal material with a verified signed pre-key', () => {
		const keys = createNativeAndroidRegistrationSignalKeys()
		const bundle = buildNativeAndroidRegistrationKeyBundle(keys)

		expect(keys.registrationId).toBeGreaterThan(0)
		expect(keys.registrationId).toBeLessThanOrEqual(0x3fff)
		expect(keys.clientStaticKeyPair.private).toHaveLength(32)
		expect(keys.clientStaticKeyPair.public).toHaveLength(32)
		expect(keys.identity.private).toHaveLength(32)
		expect(keys.identity.public).toHaveLength(32)
		expect(Buffer.from(keys.clientStaticKeyPair.public).equals(Buffer.from(keys.identity.public))).toBe(false)
		expect(bundle.authkey).toEqual(keys.clientStaticKeyPair.public)
		expect(bundle.e_ident).toEqual(keys.identity.public)
		expect(bundle.e_keytype).toEqual(Uint8Array.from([5]))
		expect(bundle.e_regid).toHaveLength(4)
		expect(bundle.e_skey_id).toHaveLength(3)
		expect(bundle.e_skey_val).toHaveLength(32)
		expect(
			Curve.verify(keys.identity.public, generateSignalPubKey(keys.signedPreKey.keyPair.public), keys.signedPreKey.signature)
		).toBe(true)
		expect(keys.signedPreKey.signature).toHaveLength(64)
		expect(keys.signedPreKey.signature).toEqual(
			Curve.sign(keys.identity.private, generateSignalPubKey(keys.signedPreKey.keyPair.public))
		)
	})
})

describe('native_android official registration wire', () => {
	it('uses Java-style upper-case percent encoding', () => {
		expect(percentEncodeRegistrationBytes(Uint8Array.from([0x41, 0x61, 0x30, 0x2d, 0x2e, 0x5f, 0x7e]))).toBe('Aa0-._~')
		expect(percentEncodeRegistrationString('a b+c/d=e')).toBe('a%20b%2Bc%2Fd%3De')
	})

	it('builds /v2/code with APK insertion order and national token', () => {
		const request = buildNativeAndroidRequestCodeRequest(COMMON, {
			token: '11999999999',
			method: 'sms'
		})

		expect(request.endpoint).toBe('/v2/code')
		// W4B 2.26.36.72 identifies Business registration as `smba` and adds
		// platform before the endpoint-specific captured map order.
		expect(request.body.startsWith('platform=smba&id=%01%2B%FF&lg=pt')).toBe(true)
		expect(request.body).toContain('&cc=55&in=11999999999&backup_token=abc')
		expect([...new URLSearchParams(request.body).keys()]).toEqual([
			'platform',
			'id',
			'lg',
			'cc',
			'in',
			'backup_token',
			'e_ident',
			'e_skey_sig',
			'token',
			'expid',
			'e_skey_id',
			'authkey',
			'e_skey_val',
			'e_regid',
			'method',
			'e_keytype',
			'fdid'
		])
		// Primary registration: userType and waTwoFaContactPoint are null in
		// the APK, so neither `login` nor `type` reaches the wire.
		expect(request.body).not.toMatch(/(^|&)login=/)
		expect(request.body).not.toMatch(/(^|&)type=/)
		expect(request.body).toContain('&authkey=')
	})

	it('omits flash-call fields for primary when the caller supplies no values', () => {
		const request = buildNativeAndroidRequestCodeRequest(COMMON, {
			token: '11999999999',
			method: 'voice'
		})

		// Fresh-install APK defaults are -1 (CJT.A00 skips) and the
		// client_start_message is null outside autoconf, so the wire has none
		// of the four fields even though the A09 gate lets them through.
		expect(request.body).not.toContain('clicked_education_link=')
		expect(request.body).not.toContain('manage_call_permission=')
		expect(request.body).not.toContain('call_log_permission=')
		expect(request.body).not.toContain('client_start_message=')
	})

	it('writes type and login only for the WA_TWO_FA flow and drops cc/in there', () => {
		const request = buildNativeAndroidRequestCodeRequest(
			{
				...COMMON,
				login: '5511999999999@s.whatsapp.net',
				registrationType: 1
			},
			{
				token: '11999999999',
				method: 'sms'
			}
		)

		expect(request.body).not.toMatch(/(^|&)cc=/)
		expect(request.body).not.toMatch(/(^|&)in=/)
		expect(request.body).not.toContain('clicked_education_link=')
		expect(request.body).toContain('login=5511999999999%40s.whatsapp.net&type=1&backup_token=abc&e_ident=')
	})

	it('builds /v2/code environment fields only when the device supplies them', () => {
		const request = buildNativeAndroidRequestCodeRequest(COMMON, {
			token: '11999999999',
			method: 'voice',
			environment: {
				_gs: '{"em":"real-google-payload"}',
				sim_mnc: '260',
				recaptcha: '{"stage":"ABPROP_DISABLED"}',
				device_ram: '2.42',
				db: 1,
				rc: 0,
				pid: 10600,
				cellular_strength: 4,
				gpia: 'real-play-integrity-token',
				hasinrc: 1,
				roaming_type: 0,
				mistyped: 7,
				mnc: '260',
				airplane_mode_type: 0,
				mcc: '310',
				_ge: '{"sb":false,"sv":false}',
				prefer_sms_over_flash: false,
				sim_type: 1,
				sim_mcc: '310',
				simnum: 0,
				client_metrics: '{"attempts":32,"is_sim_absent":false}',
				education_screen_displayed: false,
				network_radio_type: 1,
				feo2_query_status: 'error_security_exception',
				reason: 'server-send-request-no-routes'
			}
		})

		expect([...new URLSearchParams(request.body).keys()]).toEqual([
			'platform',
			'_gs',
			'sim_mnc',
			'id',
			'recaptcha',
			'device_ram',
			'db',
			'lg',
			'rc',
			'pid',
			'cellular_strength',
			'gpia',
			'hasinrc',
			'roaming_type',
			'mistyped',
			'cc',
			'in',
			'backup_token',
			'mnc',
			'airplane_mode_type',
			'mcc',
			'_ge',
			'prefer_sms_over_flash',
			'sim_type',
			'e_ident',
			'e_skey_sig',
			'sim_mcc',
			'simnum',
			'token',
			'expid',
			'client_metrics',
			'e_skey_id',
			'education_screen_displayed',
			'authkey',
			'e_skey_val',
			'e_regid',
			'network_radio_type',
			'method',
			'e_keytype',
			'feo2_query_status',
			'reason',
			'fdid'
		])
		expect(request.body).toContain('reason=server-send-request-no-routes')
		expect(request.body).not.toContain('&aid=')
		expect(request.body).not.toContain('&_gp=')
		expect(request.body).not.toContain('&_gg=')
		expect(request.body).not.toContain('&_gi=')
	})

	it('builds /v2/register with the verification code before the key bundle', () => {
		const request = buildNativeAndroidRegisterRequest(COMMON, {
			code: '123456',
			authResponse: Uint8Array.from([0x0a, 0x0b])
		})

		expect(request.endpoint).toBe('/v2/register')
		expect(request.body).toContain('&code=123456&auth_response=Cgs')
		expect(request.body.indexOf('&authkey=')).toBeGreaterThan(request.body.indexOf('&auth_response='))
	})
})

describe('native_android request protection', () => {
	it('decrypts the bridge-protected body to the original query', () => {
		const body = 'lg=pt&lc=BR&type=0'
		const hmacKey = Buffer.alloc(32, 1)
		const encryptionKey = Buffer.alloc(32, 2)
		const iv = Buffer.alloc(12, 3)
		const protectedBody = protectNativeAndroidRegistrationBody(body, {
			hmacKeyBase64: hmacKey.toString('base64'),
			encryptionKeyBase64: encryptionKey.toString('base64'),
			ivBase64: iv.toString('base64')
		})
		const raw = Buffer.from(protectedBody, 'base64')
		expect(raw.subarray(0, 12).equals(iv)).toBe(true)

		const cipher = createDecipheriv('aes-256-gcm', encryptionKey, raw.subarray(0, 12))
		const encrypted = raw.subarray(12)
		cipher.setAuthTag(encrypted.subarray(encrypted.length - 16))
		const plaintext = Buffer.concat([cipher.update(encrypted.subarray(0, encrypted.length - 16)), cipher.final()])
		expect(plaintext.subarray(0, 32).toString('hex')).toHaveLength(64)
		expect(plaintext.subarray(32).toString('utf8')).toBe(body)
	})
})

describe('native_android registration bridge provider', () => {
	it('rejects non-loopback plain HTTP before sending any registration material', () => {
		expect(() => createNativeAndroidRegistrationBridgeProvider({ url: 'http://bridge.example' })).toThrow(
			'requires HTTPS for non-loopback urls'
		)
		expect(() =>
			createNativeAndroidRegistrationBridgeProvider({
				url: 'http://host.docker.internal',
				allowInsecureLoopbackAliases: ['host.docker.internal']
			})
		).not.toThrow()
	})

	it('requires a genuine attestation and protected body', async () => {
		const calls: Array<Record<string, unknown>> = []
		const provider = createNativeAndroidRegistrationBridgeProvider({
			url: 'http://127.0.0.1:8790',
			token: 'secret-token',
			fetch: (async (_url: RequestInfo | URL, init?: RequestInit) => {
				calls.push(JSON.parse(String(init?.body)))
				return new Response(JSON.stringify({ authorization: 'Native attestation', body: 'protected' }), {
					status: 200
				})
			}) as unknown as typeof fetch
		})

		const result = await provider({
			endpoint: '/v2/code',
			appVariant: 'business',
			phoneNumber: '5511999999999',
			login: '5511999999999@s.whatsapp.net',
			body: 'lg=pt'
		})
		expect(result).toEqual({ authorization: 'Native attestation', body: 'protected' })
		expect(calls[0]).toMatchObject({ endpoint: '/v2/code', appVariant: 'business' })

		const authorizationOnlyProvider = createNativeAndroidRegistrationBridgeProvider({
			url: 'http://127.0.0.1',
			fetch: (async () => new Response(JSON.stringify({ authorization: 'only' }))) as unknown as typeof fetch
		})
		const authorizationOnly = await authorizationOnlyProvider({
			endpoint: '/v2/code',
			appVariant: 'business',
			phoneNumber: '5511999999999',
			login: '5511999999999@s.whatsapp.net',
			body: 'lg=pt'
		})
		expect(authorizationOnly).toEqual({ authorization: 'only', body: undefined })
	})
})

describe('native_android registration HTTP client', () => {
	const provider = async () => ({ authorization: 'Native attestation', body: 'protected' })

	it('retries retryable status codes and keeps the official four-attempt ceiling', async () => {
		const statuses = [503, 200]
		const authorization: string[] = []
		const client = createNativeAndroidRegistrationHttpClient(
			{
				appVariant: 'business',
				phoneNumber: '5511999999999',
				login: '5511999999999@s.whatsapp.net',
				baseUrl: 'https://registration.lab.invalid',
				sleep: async ms => {
					expect(ms).toBe(1000)
				},
				fetch: (async (_url: RequestInfo | URL, init?: RequestInit) => {
					authorization.push(String(new Headers(init?.headers).get('Authorization')))
					return new Response(JSON.stringify({ status: statuses.shift() === 200 ? 'ok' : 'retry' }), {
						status: statuses.length === 1 ? 503 : 200
					})
				}) as unknown as typeof fetch
			},
			provider
		)

		const result = await client({ endpoint: '/v2/register', body: 'code=123456' })
		expect(result).toEqual({ status: 200, body: { status: 'ok' }, attempts: 2 })
		expect(authorization).toEqual(['Native attestation', 'Native attestation'])
	})

	it('does not retry a definitive JSON response', async () => {
		let calls = 0
		const fetchMock = (() => {
			calls += 1
			return new Response(JSON.stringify({ status: 'fail', reason: 'blocked' }), { status: 403 })
		}) as unknown as typeof fetch
		const client = createNativeAndroidRegistrationHttpClient(
			{
				appVariant: 'consumer',
				phoneNumber: '5511999999999',
				login: '5511999999999@s.whatsapp.net',
				baseUrl: 'https://registration.lab.invalid',
				fetch: fetchMock
			},
			provider
		)

		const result = await client({ endpoint: '/v2/code', body: 'method=sms' })
		expect(result).toEqual({ status: 403, body: { status: 'fail', reason: 'blocked' }, attempts: 1 })
		expect(calls).toBe(1)
	})
})
