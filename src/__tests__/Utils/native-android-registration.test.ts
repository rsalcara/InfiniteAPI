import { createDecipheriv } from 'crypto'
import { Curve, generateSignalPubKey } from '../../Utils/crypto'
import {
	createNativeAndroidRegistrationBridgeProvider,
	createNativeAndroidRegistrationEnvironmentProvider,
	mapBridgeRegistrationEnvironment,
	nativeAndroidGpiaRequestHash,
	type NativeAndroidRegistrationBridgeContext,
	percentDecodeRegistrationBytes
} from '../../Utils/native-android-registration-bridge-provider'
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

		// Official C10890eL: registration_id = SecureRandom.nextInt(2147483646)+1
		// (full 31-bit positive range; e_regid is a plain 4-byte BE encoding,
		// NOT masked to 14 bits like the companion Signal registration id).
		expect(keys.registrationId).toBeGreaterThan(0)
		expect(keys.registrationId).toBeLessThanOrEqual(2_147_483_646)
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
			Curve.verify(
				keys.identity.public,
				generateSignalPubKey(keys.signedPreKey.keyPair.public),
				keys.signedPreKey.signature
			)
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
		// Official 48-field /v2/code order (2026-09-24 capture): `id` opens the
		// body and `reason=` serializes even when empty. No `platform` — the APK
		// never writes it on any registration request (KotlinRegistrationBridge
		// A0S/A0T/A0U/A0R/A0V + FMA map helpers), and a live capture carrying it
		// came back `blocked` while the same body without it returned `sent`.
		// The official /v2/code capture does not carry `lc`.
		expect(request.body.startsWith('id=%01%2B%FF&lg=pt&backup_token=abc')).toBe(true)
		expect(request.body).not.toContain('platform=')
		expect(request.body).toContain('&cc=55&token=11999999999&in=11999999999&expid=')
		expect([...new URLSearchParams(request.body).keys()]).toEqual([
			'id',
			'lg',
			'backup_token',
			'e_ident',
			'e_skey_sig',
			'cc',
			'token',
			'in',
			'expid',
			'e_skey_id',
			'authkey',
			'e_skey_val',
			'e_regid',
			'method',
			'e_keytype',
			'reason',
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

	it('serializes an explicitly supplied flash-call trio', () => {
		const request = buildNativeAndroidRequestCodeRequest(COMMON, {
			token: '11999999999',
			method: 'flash',
			manageCallPermission: 1,
			callLogPermission: 1,
			environment: { prefer_sms_over_flash: false }
		})

		// flash-call needs prefer_sms_over_flash=false plus both call permissions
		// granted; the values come from the caller's real device state (GBM.A02
		// writes A0B()/A0A() grant-check results) and serialize as supplied.
		expect(request.body).toContain('method=flash')
		expect(request.body).toContain('prefer_sms_over_flash=false')
		expect(request.body).toContain('manage_call_permission=true')
		expect(request.body).toContain('call_log_permission=true')
	})

	it('rejects flash without the real flash-call trio', () => {
		expect(() =>
			buildNativeAndroidRequestCodeRequest(COMMON, {
				token: '11999999999',
				method: 'flash'
			})
		).toThrow(/flash-call trio/)
		expect(() =>
			buildNativeAndroidRequestCodeRequest(COMMON, {
				token: '11999999999',
				method: 'flash',
				manageCallPermission: 0,
				callLogPermission: 1,
				environment: { prefer_sms_over_flash: false }
			})
		).toThrow(/flash-call trio/)
		expect(() =>
			buildNativeAndroidRequestCodeRequest(COMMON, {
				token: '11999999999',
				method: 'flash',
				manageCallPermission: 1,
				callLogPermission: 1,
				environment: { prefer_sms_over_flash: true }
			})
		).toThrow(/flash-call trio/)
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
				_ga: 'real-native-payload',
				sim_mnc: '260',
				recaptcha: '{"stage":"ABPROP_DISABLED"}',
				device_ram: '2.42',
				db: 1,
				hasav: 2,
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
			'_gs',
			'sim_mnc',
			'id',
			'recaptcha',
			'device_ram',
			'db',
			'hasav',
			'lg',
			'rc',
			'pid',
			'cellular_strength',
			'gpia',
			'hasinrc',
			'roaming_type',
			'mistyped',
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
			'cc',
			'token',
			'in',
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
			'fdid',
			'_ga'
		])
		expect(request.body).toContain('reason=server-send-request-no-routes')
		expect(request.body).not.toContain('&aid=')
		expect(request.body).not.toContain('&_gp=')
		expect(request.body).not.toContain('&_gg=')
		expect(request.body).not.toContain('&_gi=')
	})

	it('keeps system-owned install-source diagnostics out of the /v2/code wire', () => {
		const request = buildNativeAndroidRequestCodeRequest(COMMON, {
			token: '11999999999',
			method: 'voice',
			environment: {
				installer_package: 'com.android.vending',
				package_source: 'store',
				installing_package: 'com.android.vending',
				initiating_package: 'com.android.vending',
				install_source_consistent: true
			}
		})

		expect(request.endpoint).toBe('/v2/code')
		expect(request.body).not.toContain('installer_package=')
		expect(request.body).not.toContain('package_source=')
		expect(request.body).not.toContain('installing_package=')
		expect(request.body).not.toContain('initiating_package=')
		expect(request.body).not.toContain('install_source_consistent=')
	})

	it('builds /v2/register with the verification code before the key bundle', () => {
		const request = buildNativeAndroidRegisterRequest(COMMON, {
			code: '123456',
			authResponse: Uint8Array.from([0x0a, 0x0b])
		})

		expect(request.endpoint).toBe('/v2/register')
		// addCommonParams mirrors KotlinRegistrationBridge.A0S/A0T/A0U: cc,in,
		// lg,lc,fdid,expid,access_session_id,id,backup_token — and no `platform`
		// anywhere in the register wire (or any registration request).
		expect(request.body.startsWith('cc=55&in=11999999999&lg=pt&lc=BR&fdid=fixed-fdid&expid=')).toBe(true)
		expect(request.body).not.toContain('platform=')
		expect(request.body).toContain('&code=123456&auth_response=Cgs')
		expect(request.body.indexOf('&authkey=')).toBeGreaterThan(request.body.indexOf('&auth_response='))
	})

	it('encodes Uint8Array environment blobs exactly once', () => {
		const request = buildNativeAndroidRequestCodeRequest(COMMON, {
			token: '11999999999',
			method: 'sms',
			environment: {
				_gs: Uint8Array.from([0x7b, 0x22, 0x65, 0x6d, 0x22, 0x7d]),
				_ga: Uint8Array.from([0x25, 0x20])
			}
		})

		// Raw blob bytes go through a single percent-encoding pass: a `%` byte
		// (as produced by decoding the hook's pre-encoded values) leaves as
		// `%25`, never as a literal escape.
		expect(request.body).toContain('_gs=%7B%22em%22%7D')
		expect(request.body).toContain('_ga=%25%20')
	})

	it('takes string environment values as plain text (encoded once)', () => {
		const request = buildNativeAndroidRequestCodeRequest(COMMON, {
			token: '11999999999',
			method: 'sms',
			environment: { _gs: '%7B' }
		})
		expect(request.body).toContain('_gs=%257B')
	})

	it('stamps the official user type as request metadata for the bridge', () => {
		expect(
			buildNativeAndroidRequestCodeRequest(COMMON, { token: '11999999999', method: 'sms' }).registrationType
		).toBeUndefined()
		expect(
			buildNativeAndroidRequestCodeRequest(
				{ ...COMMON, login: '5511999999999@s.whatsapp.net', registrationType: 1 },
				{ token: '11999999999', method: 'sms' }
			).registrationType
		).toBe(1)
		expect(
			buildNativeAndroidRegisterRequest({ ...COMMON, registrationType: 0 }, { code: '123456' }).registrationType
		).toBe(0)
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

	it('threads the official user type to the bridge', async () => {
		const calls: Array<Record<string, unknown>> = []
		const provider = createNativeAndroidRegistrationBridgeProvider({
			url: 'http://127.0.0.1:8790',
			fetch: (async (_url: RequestInfo | URL, init?: RequestInit) => {
				calls.push(JSON.parse(String(init?.body)))
				return new Response(JSON.stringify({ authorization: 'a' }), { status: 200 })
			}) as unknown as typeof fetch
		})

		await provider({
			endpoint: '/v2/code',
			appVariant: 'business',
			phoneNumber: '5511999999999',
			login: '5511999999999@s.whatsapp.net',
			registrationType: 1,
			body: 'lg=pt'
		})
		expect(calls[0]!.registrationType).toBe(1)

		await provider({
			endpoint: '/v2/code',
			appVariant: 'business',
			phoneNumber: '5511999999999',
			login: '5511999999999@s.whatsapp.net',
			body: 'lg=pt'
		})
		expect('registrationType' in calls[1]!).toBe(false)
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

	it('prefers the request registration type over the client default', async () => {
		const contexts: Array<Record<string, unknown>> = []
		const trackingProvider = async (context: NativeAndroidRegistrationBridgeContext) => {
			contexts.push(context as unknown as Record<string, unknown>)
			return { authorization: 'Native attestation' }
		}

		const client = createNativeAndroidRegistrationHttpClient(
			{
				appVariant: 'business',
				phoneNumber: '5511999999999',
				login: '5511999999999@s.whatsapp.net',
				registrationType: 0,
				baseUrl: 'https://registration.lab.invalid',
				fetch: (async () =>
					new Response(JSON.stringify({ status: 'sent' }), { status: 200 })) as unknown as typeof fetch
			},
			trackingProvider
		)

		await client({ endpoint: '/v2/code', body: 'lg=pt', registrationType: 1 })
		expect(contexts[0]!.registrationType).toBe(1)
		await client({ endpoint: '/v2/code', body: 'lg=pt' })
		expect(contexts[1]!.registrationType).toBe(0)
	})
})

describe('native_android registration environment provider', () => {
	it('round-trips the hook percent-encoding to raw bytes', () => {
		const raw = Uint8Array.from([0x00, 0x2f, 0x41, 0xff, 0x7e, 0x25])
		expect(percentDecodeRegistrationBytes(percentEncodeRegistrationBytes(raw))).toEqual(raw)
		expect(percentDecodeRegistrationBytes('abc%2Fdef')).toEqual(Uint8Array.from(Buffer.from('abc/def', 'utf8')))
	})

	it('maps the bridge environment into builder fields without touching scalars', () => {
		const mapped = mapBridgeRegistrationEnvironment({
			mcc: '310',
			mnc: '260',
			pid: 10600,
			hasinrc: 1,
			prefer_sms_over_flash: false,
			gpia: 'real-token',
			_gs: '%7B%22em%22%3A%22p%22%7D',
			installer_package: 'com.android.vending',
			package_source: 'store',
			install_source_consistent: null,
			unknown_key: 'dropped'
		})

		expect(mapped.mcc).toBe('310')
		expect(mapped.pid).toBe(10600)
		expect(mapped.prefer_sms_over_flash).toBe(false)
		expect(mapped.gpia).toBe('real-token')
		expect(mapped._gs).toEqual(Uint8Array.from(Buffer.from('{"em":"p"}', 'utf8')))
		expect(mapped.installer_package).toBe('com.android.vending')
		expect(mapped.install_source_consistent).toBeNull()
		expect('unknown_key' in mapped).toBe(false)
	})

	it('fetches the real-device environment from the bridge', async () => {
		const calls: Array<{ url: string; body: unknown }> = []
		const provider = createNativeAndroidRegistrationEnvironmentProvider({
			url: 'http://127.0.0.1:8790',
			fetch: (async (url: RequestInfo | URL, init?: RequestInit) => {
				calls.push({ url: String(url), body: JSON.parse(String(init?.body)) })
				return new Response(JSON.stringify({ environment: { gpia: 'tok', _gs: 'abc', mcc: '310' } }), {
					status: 200
				})
			}) as unknown as typeof fetch
		})

		const environment = await provider('business')
		expect(calls[0]!.url).toBe('http://127.0.0.1:8790/registration/environment')
		expect(calls[0]!.body).toEqual({ appVariant: 'business' })
		expect(environment._gs).toEqual(Uint8Array.from(Buffer.from('abc', 'utf8')))
		expect(environment.gpia).toBe('tok')
		expect(environment.mcc).toBe('310')
	})

	it('computes the official gpia requestHash (Base64 flag 3 of the authkey) and sends it ready', async () => {
		// Flag 3 = NO_WRAP|NO_PADDING, alfabeto padrão — 1:1 com
		// `Base64.encodeToString(authkey, 3)` (GWM case 25 / C42288Ijh).
		// 0xfb,0xff,0xbf produz "+/+/" no alfabeto padrão e "-_-_" no URL_SAFE;
		// 0x00 produz "AA==" com padding e "AA" sem.
		expect(nativeAndroidGpiaRequestHash(Uint8Array.from([0xfb, 0xff, 0xbf]))).toBe('+/+/')
		expect(nativeAndroidGpiaRequestHash(Uint8Array.from([0x00]))).toBe('AA')

		const authkey = Uint8Array.from([0x02, 0xfb, 0xff, 0xbf, 0x01])
		const calls: Array<{ body: unknown }> = []
		const provider = createNativeAndroidRegistrationEnvironmentProvider({
			url: 'http://127.0.0.1:8790',
			fetch: (async (url: RequestInfo | URL, init?: RequestInit) => {
				calls.push({ body: JSON.parse(String(init?.body)) })
				return new Response(JSON.stringify({ environment: {} }), { status: 200 })
			}) as unknown as typeof fetch
		})

		await provider('business', { challenge: authkey })
		expect(calls[0]!.body).toEqual({
			appVariant: 'business',
			challengeBase64: Buffer.from(authkey).toString('base64'),
			gpiaRequestHashBase64: nativeAndroidGpiaRequestHash(authkey)
		})
	})

	it('rejects answers without an environment object and invalid app variants', async () => {
		const provider = createNativeAndroidRegistrationEnvironmentProvider({
			url: 'http://127.0.0.1:8790',
			fetch: (async () => new Response(JSON.stringify({}), { status: 200 })) as unknown as typeof fetch
		})
		await expect(provider('business')).rejects.toThrow('did not provide an environment')
		await expect(provider('other' as never)).rejects.toThrow('app variant')
	})
})
