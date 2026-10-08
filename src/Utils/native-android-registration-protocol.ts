import { createCipheriv, createHmac, randomBytes } from 'node:crypto'
import type { NativeAndroidRegistrationKeyBundle } from './native-android-registration-keys'

export type NativeAndroidRegistrationEndpoint =
	| '/v2/reg_onboard_abprop'
	| '/v2/exist'
	| '/v2/code'
	| '/v2/register'
	| '/v2/security'
	| '/v2/consent'
	| '/v2/device_confirm'
	| '/v2/autoconf'

export type NativeAndroidRegistrationCommon = {
	/** Selects the official platform token: W4B uses `smba`; Consumer uses `android`. */
	appVariant?: 'business' | 'consumer'
	/** BCP-47 language, e.g. `pt`; official param name is `lg`. */
	language: string
	/** ISO-3166 country, e.g. `BR`; official param name is `lc`. */
	country: string
	/** Selected dialing code from the registration UI, e.g. `55`; official param name is `cc`. */
	countryCallingCode: string
	/** National subscriber digits, without the country code; official param name is `in`. */
	nationalNumber: string
	/** Persistent Android fingerprint device id (`fdid`). */
	fingerprintDeviceId: string
	/** Installation UUID (`expid`). */
	expirationId: string
	/** Persistent random registration id bytes (`id`). */
	identityId: Uint8Array
	/** Persistent random operation backup token (`backup_token`). */
	backupToken: Uint8Array
	accessSessionId?: string
	/**
	 * Official `waTwoFaContactPoint` passed to `A0R` as the `login` value.
	 * Primary phone registration passes null in the APK
	 * (RequestCodeRepository.doInBackground -> generateAuthCodeBlocking user
	 * type/contact point both null), so this stays undefined there.
	 */
	login?: string
	/**
	 * Official `EnumC25805BgE` user type. Primary phone registration passes
	 * null, so the wire omits `type` entirely (KotlinRegistrationBridge.A0R
	 * only writes `type` when the enum is non-null). `1` selects the
	 * WA_TWO_FA_CONTACT_POINT flow, which drops cc/in and the flash-call
	 * fields and requires `login`.
	 */
	registrationType?: 0 | 1
	keyBundle: NativeAndroidRegistrationKeyBundle
}

/**
 * Values captured from W4B 2.26.36.72 immediately before /v2/code encryption.
 * Every field is supplied by the real device or by the local registration
 * bridge. This type intentionally has no defaults: the official APK omits a
 * field when its runtime value is absent, and so must the motor.
 */
export type NativeAndroidRequestCodeEnvironment = {
	/**
	 * Native WAMSYS map blobs. Raw bytes are percent-encoded exactly once here;
	 * strings are treated as plain (not pre-encoded) values. The registration
	 * bridge delivers the hook's pre-encoded values as decoded bytes so the
	 * wire always carries a single encoding pass.
	 */
	_gs?: string | Uint8Array
	_ga?: string | Uint8Array
	sim_mnc?: string
	recaptcha?: string
	device_ram?: string | number
	db?: 0 | 1
	/** Presence state of the advertising id, as written by the APK map (observed 2). */
	hasav?: number
	rc?: number
	pid?: number
	cellular_strength?: number
	gpia?: string
	hasinrc?: 0 | 1
	roaming_type?: number
	mistyped?: number
	aid?: string | Uint8Array
	mnc?: string
	airplane_mode_type?: 0 | 1
	mcc?: string
	_gp?: string | Uint8Array
	_gg?: string | Uint8Array
	_ge?: string | Uint8Array
	prefer_sms_over_flash?: boolean
	sim_type?: number
	sim_mcc?: string
	simnum?: number
	client_metrics?: string
	_gi?: string | Uint8Array
	education_screen_displayed?: boolean
	network_radio_type?: number
	feo2_query_status?: string
	reason?: string
	/** FCM push token, carried by /v2/exist (observed `dM_R5...:APA91bF...`). */
	push_token?: string
	/** Pref `backup_token_retrieval_error`; fresh installs send `null_token`. */
	backup_token_error?: string
	/** UI counter persisted in prefs; `0` on a fresh install. */
	language_selector_time_spent?: number
	/** UI counter persisted in prefs; `0` on a fresh install. */
	language_selector_clicked_count?: number
	/** `1` when READ_PHONE_STATE was granted at request time (FMA checkIfExists). */
	read_phone_permission_granted?: 0 | 1
	/** `FHa.A00(application).isEmpty()` negated — FOA fdid apps installed. */
	is_foa_fdid_app_installed?: boolean
	/** `Build.DEVICE` (FMA checkIfExists line 1338). */
	device_name?: string
	/** `TelephonyManager.getSimState()` (observed `5` = ready). */
	sim_state?: number
	/** Offline AB-prop exposure JSON (FMA checkIfExists `offline_ab`). */
	offline_ab?: string
	/** `TelephonyManager.getNetworkOperatorName()` (observed `T-Mobile`). */
	network_operator_name?: string
	/** System-owned installation state; diagnostic only and never serialized. */
	installer_package?: string
	package_source?: 'store' | 'local_file' | 'downloaded_file' | 'other' | 'unspecified' | `unknown_${number}`
	installing_package?: string
	initiating_package?: string | null
	install_source_consistent?: boolean | null
}

export type NativeAndroidRequestCodeInput = {
	token: string
	method: 'sms' | 'voice'
	context?: string
	advertisingId?: string
	clickedEducationLink?: 0 | 1
	manageCallPermission?: 0 | 1
	callLogPermission?: 0 | 1
	clientStartMessage?: Uint8Array
	environment?: NativeAndroidRequestCodeEnvironment
}

export type NativeAndroidRegisterInput = {
	code: string
	authResponse?: Uint8Array
	context?: string
	method?: string
	advertisingId?: string
}

export type NativeAndroidSecurityInput = {
	code: string
	reset?: string
	wipeToken?: Uint8Array
	advertisingId?: string
}

export type NativeAndroidConsentInput = {
	dateOfBirth?: string
	securityCode?: string
	advertisingId?: string
	context?: string
	supportsPaa?: boolean
}

export type NativeAndroidDeviceConfirmInput = {
	token: string
	advertisingId?: string
}

export type NativeAndroidAutoconfInput = {
	consent: string
	clientCapabilities?: Uint8Array
}

export type NativeAndroidRegistrationRequest = {
	endpoint: NativeAndroidRegistrationEndpoint
	/** Canonical UTF-8 query string, in the exact APK insertion order. */
	body: string
	/**
	 * Official user type of this request. Not serialized on the wire — it is
	 * metadata for the registration bridge, whose in-APK `token` computation
	 * keys on `in=` for primary requests and on `login=` digits for type 1.
	 */
	registrationType?: 0 | 1
}

const byteAt = (value: Uint8Array, index: number): number => value[index] ?? 0

/**
 * Exact Java implementation from `AbstractC26306BoO.A00`: upper-case percent
 * encoding with only `A-Z a-z 0-9 - . _ ~` left unescaped. This is not
 * `encodeURIComponent`, which leaves several additional characters intact.
 */
export const percentEncodeRegistrationBytes = (value: Uint8Array): string => {
	let output = ''
	for (let index = 0; index < value.byteLength; ++index) {
		const byte = byteAt(value, index)
		const isAlphanumeric =
			(byte >= 0x41 && byte <= 0x5a) || (byte >= 0x61 && byte <= 0x7a) || (byte >= 0x30 && byte <= 0x39)
		const isSafePunctuation = byte === 0x2d || byte === 0x2e || byte === 0x5f || byte === 0x7e
		if (isAlphanumeric || isSafePunctuation) {
			output += String.fromCharCode(byte)
		} else {
			output += `%${byte.toString(16).toUpperCase().padStart(2, '0')}`
		}
	}

	return output
}

export const percentEncodeRegistrationString = (value: string): string =>
	percentEncodeRegistrationBytes(Buffer.from(value, 'utf8'))

// CJT.A04 and CJT.A05 use android.util.Base64 flags 11:
// Base64.URL_SAFE | Base64.NO_WRAP | Base64.NO_PADDING.
const base64Official = (value: Uint8Array): string => Buffer.from(value).toString('base64url')

const uuidToBytes = (value: string): Uint8Array => {
	const normalized = value.trim().toLowerCase()
	if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(normalized)) {
		throw new Error(`native_android registration: invalid UUID: ${normalized}`)
	}

	return Uint8Array.from(
		normalized
			.replace(/-/g, '')
			.match(/.{2}/g)!
			.map(part => Number.parseInt(part, 16))
	)
}

class RegistrationRequestBuilder {
	private readonly values = new Map<string, string>()
	private readonly percentEncoded = new Set<string>()

	requiredString(key: string, value: string): void {
		if (!value) throw new Error(`native_android registration: ${key} is required`)
		this.values.set(key, value)
	}

	optionalString(key: string, value: string | undefined): void {
		if (value !== undefined && value !== null && value !== '') this.values.set(key, value)
	}

	uuid(key: string, value: string | undefined): void {
		if (value === undefined) return
		this.base64(key, uuidToBytes(value))
	}

	requiredBase64(key: string, value: Uint8Array): void {
		this.values.set(key, base64Official(value))
	}

	base64(key: string, value: Uint8Array | undefined): void {
		if (value !== undefined && value !== null) this.values.set(key, base64Official(value))
	}

	requiredPercentEncoded(key: string, value: Uint8Array): void {
		this.values.set(key, percentEncodeRegistrationBytes(value))
		this.percentEncoded.add(key)
	}

	setRaw(key: string, value: string): void {
		this.values.set(key, value)
	}

	booleanOrSkip(key: string, value: 0 | 1 | undefined): void {
		// CJT.A00 skips values other than zero and one.
		if (value === 0 || value === 1) this.values.set(key, value === 1 ? 'true' : 'false')
	}

	toString(): string {
		return [...this.values.entries()]
			.map(([key, value]) =>
				this.percentEncoded.has(key)
					? `${percentEncodeRegistrationString(key)}=${value}`
					: `${percentEncodeRegistrationString(key)}=${percentEncodeRegistrationString(value)}`
			)
			.join('&')
	}
}

const addCommonParams = (builder: RegistrationRequestBuilder, common: NativeAndroidRegistrationCommon): void => {
	const registrationType = common.registrationType
	if (registrationType !== undefined && registrationType !== 0 && registrationType !== 1) {
		throw new Error('native_android registration: registrationType must be undefined, 0 or 1')
	}

	// A09 gates A0S on `userType != WA_TWO_FA_CONTACT_POINT`, so cc/in are
	// written for the primary flow (userType=null) and dropped for type 1.
	if (registrationType !== 1) {
		builder.requiredString('cc', common.countryCallingCode)
		builder.requiredString('in', common.nationalNumber)
	}

	// A0T
	builder.requiredString('lg', common.language)
	builder.requiredString('lc', common.country)
	// W4B registration telemetry identifies as `smba` (K8i lines 26/45);
	// Consumer registration URLs use `android` (C90133y9/CGL).
	builder.requiredString('platform', common.appVariant === 'business' ? 'smba' : 'android')
	builder.requiredString('fdid', common.fingerprintDeviceId)
	builder.uuid('expid', common.expirationId)

	// A0U
	builder.uuid('access_session_id', common.accessSessionId)
	builder.requiredPercentEncoded('id', common.identityId)
	builder.requiredPercentEncoded('backup_token', common.backupToken)
}

// A0R is called late in every official request, after endpoint-specific fields
// such as token/method/context and advertising_id. `A02` (login) and the
// `type` write both skip nulls: the primary flow sends neither.
const addLoginAndType = (builder: RegistrationRequestBuilder, common: NativeAndroidRegistrationCommon): void => {
	builder.optionalString('login', common.login)
	if (common.registrationType !== undefined) builder.setRaw('type', String(common.registrationType))
}

const addKeyBundle = (builder: RegistrationRequestBuilder, bundle: NativeAndroidRegistrationKeyBundle): void => {
	builder.requiredBase64('authkey', bundle.authkey)
	builder.requiredBase64('e_ident', bundle.e_ident)
	builder.requiredBase64('e_keytype', bundle.e_keytype)
	builder.requiredBase64('e_regid', bundle.e_regid)
	builder.requiredBase64('e_skey_id', bundle.e_skey_id)
	builder.requiredBase64('e_skey_val', bundle.e_skey_val)
	builder.requiredBase64('e_skey_sig', bundle.e_skey_sig)
}

/**
 * Writes one runtime environment field at its observed position in the W4B
 * 2.26.36.72 /v2/code wire. Undefined means the APK did not produce the value;
 * it never falls back to a fabricated default.
 */
const addEnvironmentField = (
	builder: RegistrationRequestBuilder,
	environment: NativeAndroidRequestCodeEnvironment,
	key: keyof NativeAndroidRequestCodeEnvironment
): void => {
	const value = environment[key]
	if (value === undefined || value === null) return
	// The APK wire serializer omits empty CJT entries: the 2026-09-21
	// 17:59:59Z official /v2/code capture has no `_gs=`, `_ga=`, `aid=`,
	// `_gp=` or `_ge=` even though the CJT map carries those keys.
	if (typeof value === 'string' && value.length === 0) return
	if (value instanceof Uint8Array) {
		// Raw blob bytes are encoded exactly once and marked pre-encoded so
		// toString() never re-encodes them.
		if (value.byteLength === 0) return
		builder.requiredPercentEncoded(key, value)
	} else if (typeof value === 'number') builder.setRaw(key, String(value))
	else if (typeof value === 'boolean') builder.setRaw(key, String(value))
	else builder.setRaw(key, value)
}

export type NativeAndroidPreflightInput = {
	environment?: NativeAndroidRequestCodeEnvironment
	advertisingId?: string
	/**
	 * `/v2/exist` client_metrics override. The APK builds this map with a
	 * different producer than /v2/code (observed `{"GMSVersion":263234032}`
	 * against /v2/code's `{"attempts":N,...}`), so the pre-flight carries its
	 * own value instead of reusing the code environment entry.
	 */
	clientMetrics?: string
}

/**
 * `/v2/reg_onboard_abprop` — the onboarding announce the APK sends before any
 * number work (captured 2026-09-24T14:42:01Z, 14 fields, 611B on the wire).
 * The body is the wamsys "common" map: identity keys plus the locale pair, in
 * the exact native order (rc first, `in` last). No `platform`, no `login`.
 */
export const buildNativeAndroidRegOnboardAbpropRequest = (
	common: NativeAndroidRegistrationCommon,
	input?: NativeAndroidPreflightInput
): NativeAndroidRegistrationRequest => {
	const builder = new RegistrationRequestBuilder()
	const environment = input?.environment ?? {}
	// The native map initializes `rc` unconditionally (observed `rc=0` even on
	// captures whose CJT map carried no rc entry).
	builder.setRaw('rc', String(environment.rc ?? 0))
	builder.requiredBase64('e_skey_sig', common.keyBundle.e_skey_sig)
	builder.uuid('expid', common.expirationId)
	builder.requiredBase64('e_skey_id', common.keyBundle.e_skey_id)
	builder.requiredString('cc', common.countryCallingCode)
	builder.requiredBase64('e_ident', common.keyBundle.e_ident)
	builder.requiredBase64('e_skey_val', common.keyBundle.e_skey_val)
	builder.requiredBase64('e_regid', common.keyBundle.e_regid)
	builder.requiredBase64('e_keytype', common.keyBundle.e_keytype)
	builder.requiredBase64('authkey', common.keyBundle.authkey)
	builder.requiredString('fdid', common.fingerprintDeviceId)
	builder.requiredString('lc', common.country)
	builder.requiredString('lg', common.language)
	builder.requiredString('in', common.nationalNumber)

	return { endpoint: '/v2/reg_onboard_abprop', body: builder.toString(), registrationType: common.registrationType }
}

/**
 * `/v2/exist` — the device onboarding check the APK sends after abprop and
 * before /v2/code (captured 2026-09-24T14:42:03Z, 37 fields, 6630B on the
 * wire). The wire body carries NO `token` and NO `in`: the check is about the
 * device/install state, not the subscriber. Field order is the observed wire
 * order (advertising_id first, offline_ab last).
 */
export const buildNativeAndroidExistRequest = (
	common: NativeAndroidRegistrationCommon,
	input?: NativeAndroidPreflightInput
): NativeAndroidRegistrationRequest => {
	const builder = new RegistrationRequestBuilder()
	const environment = input?.environment ?? {}
	builder.optionalString('advertising_id', input?.advertisingId)
	builder.requiredPercentEncoded('backup_token', common.backupToken)
	addEnvironmentField(builder, environment, 'recaptcha')
	builder.requiredString('lg', common.language)
	addEnvironmentField(builder, environment, 'language_selector_time_spent')
	addEnvironmentField(builder, environment, 'rc')
	addEnvironmentField(builder, environment, 'airplane_mode_type')
	builder.requiredPercentEncoded('id', common.identityId)
	addEnvironmentField(builder, environment, '_gs')
	addEnvironmentField(builder, environment, 'pid')
	addEnvironmentField(builder, environment, 'push_token')
	addEnvironmentField(builder, environment, 'backup_token_error')
	addEnvironmentField(builder, environment, 'device_ram')
	addEnvironmentField(builder, environment, 'db')
	addEnvironmentField(builder, environment, 'cellular_strength')
	addEnvironmentField(builder, environment, 'gpia')
	addEnvironmentField(builder, environment, 'hasinrc')
	addEnvironmentField(builder, environment, 'read_phone_permission_granted')
	addEnvironmentField(builder, environment, '_gg')
	addEnvironmentField(builder, environment, 'is_foa_fdid_app_installed')
	addEnvironmentField(builder, environment, 'aid')
	addEnvironmentField(builder, environment, '_ge')
	addEnvironmentField(builder, environment, 'feo2_query_status')
	addEnvironmentField(builder, environment, 'language_selector_clicked_count')
	addEnvironmentField(builder, environment, 'network_operator_name')
	addEnvironmentField(builder, environment, 'mistyped')
	addEnvironmentField(builder, environment, 'roaming_type')
	addEnvironmentField(builder, environment, 'device_name')
	builder.requiredString('cc', common.countryCallingCode)
		addEnvironmentField(builder, environment, 'simnum')
		if (input?.clientMetrics !== undefined) builder.setRaw('client_metrics', input.clientMetrics)
		else addEnvironmentField(builder, environment, 'client_metrics')
	builder.requiredBase64('e_skey_id', common.keyBundle.e_skey_id)
	addEnvironmentField(builder, environment, '_gi')
	builder.requiredString('fdid', common.fingerprintDeviceId)
	addEnvironmentField(builder, environment, 'sim_state')
	addEnvironmentField(builder, environment, 'network_radio_type')
	addEnvironmentField(builder, environment, 'offline_ab')

	return { endpoint: '/v2/exist', body: builder.toString(), registrationType: common.registrationType }
}

export const buildNativeAndroidRequestCodeRequest = (
	common: NativeAndroidRegistrationCommon,
	input: NativeAndroidRequestCodeInput
): NativeAndroidRegistrationRequest => {
	if (input.method !== 'sms' && input.method !== 'voice') {
		throw new Error('native_android registration: method must be sms or voice')
	}

	// Field order from the official /v2/code wire captures (2026-09-21 thin
	// body and the 2026-09-24 48-field body that the server answered with
	// `status: ok` seventeen times). The CJT map holds 46 entries; the APK
	// serializer omits empty map values, so absent runtime fields stay absent.
	// This endpoint does not send `lc`.
	const builder = new RegistrationRequestBuilder()
	const environment = input.environment ?? {}
	builder.requiredString('platform', common.appVariant === 'business' ? 'smba' : 'android')
	addEnvironmentField(builder, environment, '_gs')
	addEnvironmentField(builder, environment, '_ga')
	addEnvironmentField(builder, environment, 'sim_mnc')
	builder.requiredPercentEncoded('id', common.identityId)
	addEnvironmentField(builder, environment, 'recaptcha')
	addEnvironmentField(builder, environment, 'device_ram')
	addEnvironmentField(builder, environment, 'db')
	addEnvironmentField(builder, environment, 'hasav')
	builder.requiredString('lg', common.language)
	addEnvironmentField(builder, environment, 'rc')
	addEnvironmentField(builder, environment, 'pid')
	addEnvironmentField(builder, environment, 'cellular_strength')
	addEnvironmentField(builder, environment, 'gpia')
	addEnvironmentField(builder, environment, 'hasinrc')
	addEnvironmentField(builder, environment, 'roaming_type')
	addEnvironmentField(builder, environment, 'mistyped')
	builder.optionalString('login', common.login)
	if (common.registrationType !== undefined) builder.setRaw('type', String(common.registrationType))
	// A09 writes cc/in only when userType != WA_TWO_FA_CONTACT_POINT.
	if (common.registrationType !== 1) {
		builder.requiredString('cc', common.countryCallingCode)
		builder.requiredString('in', common.nationalNumber)
	}

	builder.optionalString('advertising_id', input.advertisingId)
	builder.requiredPercentEncoded('backup_token', common.backupToken)
	addEnvironmentField(builder, environment, 'aid')
	addEnvironmentField(builder, environment, 'mnc')
	addEnvironmentField(builder, environment, 'airplane_mode_type')
	addEnvironmentField(builder, environment, 'mcc')
	addEnvironmentField(builder, environment, '_gp')
	addEnvironmentField(builder, environment, '_gg')
	addEnvironmentField(builder, environment, '_ge')
	addEnvironmentField(builder, environment, 'prefer_sms_over_flash')
	addEnvironmentField(builder, environment, 'sim_type')
	builder.requiredBase64('e_ident', common.keyBundle.e_ident)
	builder.requiredBase64('e_skey_sig', common.keyBundle.e_skey_sig)
	addEnvironmentField(builder, environment, 'sim_mcc')
	addEnvironmentField(builder, environment, 'simnum')
	builder.requiredString('token', input.token)
	builder.uuid('expid', common.expirationId)
	addEnvironmentField(builder, environment, 'client_metrics')
	addEnvironmentField(builder, environment, '_gi')
	builder.requiredBase64('e_skey_id', common.keyBundle.e_skey_id)
	addEnvironmentField(builder, environment, 'education_screen_displayed')
	builder.requiredBase64('authkey', common.keyBundle.authkey)
	builder.requiredBase64('e_skey_val', common.keyBundle.e_skey_val)
	builder.requiredBase64('e_regid', common.keyBundle.e_regid)
	addEnvironmentField(builder, environment, 'network_radio_type')
	builder.requiredString('method', input.method)
	builder.optionalString('context', input.context)
	// A09 gates these on userType != WA_TWO_FA_CONTACT_POINT; each write skips
	// null/-1 values, the fresh-install default.
	if (common.registrationType !== 1) {
		builder.booleanOrSkip('clicked_education_link', input.clickedEducationLink)
		builder.booleanOrSkip('manage_call_permission', input.manageCallPermission)
		builder.booleanOrSkip('call_log_permission', input.callLogPermission)
		builder.base64('client_start_message', input.clientStartMessage)
	}

	builder.requiredBase64('e_keytype', common.keyBundle.e_keytype)
	addEnvironmentField(builder, environment, 'feo2_query_status')
	// `reason=` é serializado mesmo vazio no corpo oficial de 48 campos — não
	// passa pela regra de omitir entradas vazias do mapa CJT.
	builder.setRaw('reason', environment.reason ?? '')
	builder.requiredString('fdid', common.fingerprintDeviceId)

	return { endpoint: '/v2/code', body: builder.toString(), registrationType: common.registrationType }
}

export const buildNativeAndroidRegisterRequest = (
	common: NativeAndroidRegistrationCommon,
	input: NativeAndroidRegisterInput
): NativeAndroidRegistrationRequest => {
	const builder = new RegistrationRequestBuilder()
	addCommonParams(builder, common)
	builder.requiredString('code', input.code)
	builder.base64('auth_response', input.authResponse)
	builder.optionalString('context', input.context)
	builder.optionalString('method', input.method)
	builder.optionalString('advertising_id', input.advertisingId)
	addLoginAndType(builder, common)
	addKeyBundle(builder, common.keyBundle)

	return { endpoint: '/v2/register', body: builder.toString(), registrationType: common.registrationType }
}

export const buildNativeAndroidSecurityRequest = (
	common: NativeAndroidRegistrationCommon,
	input: NativeAndroidSecurityInput
): NativeAndroidRegistrationRequest => {
	const builder = new RegistrationRequestBuilder()
	addCommonParams(builder, common)
	builder.requiredString('code', input.code)
	builder.optionalString('reset', input.reset)
	builder.base64('wipe_token', input.wipeToken)
	builder.optionalString('advertising_id', input.advertisingId)
	addLoginAndType(builder, common)
	addKeyBundle(builder, common.keyBundle)

	return { endpoint: '/v2/security', body: builder.toString(), registrationType: common.registrationType }
}

export const buildNativeAndroidConsentRequest = (
	common: NativeAndroidRegistrationCommon,
	input: NativeAndroidConsentInput
): NativeAndroidRegistrationRequest => {
	const builder = new RegistrationRequestBuilder()
	addCommonParams(builder, common)
	builder.optionalString('dob', input.dateOfBirth)
	builder.optionalString('security_code', input.securityCode)
	builder.optionalString('advertising_id', input.advertisingId)
	builder.requiredString('context', input.context ?? '')
	if (input.supportsPaa) builder.requiredString('supports_paa', '1')
	addLoginAndType(builder, common)
	addKeyBundle(builder, common.keyBundle)

	return { endpoint: '/v2/consent', body: builder.toString(), registrationType: common.registrationType }
}

export const buildNativeAndroidDeviceConfirmRequest = (
	common: NativeAndroidRegistrationCommon,
	input: NativeAndroidDeviceConfirmInput
): NativeAndroidRegistrationRequest => {
	const builder = new RegistrationRequestBuilder()
	addCommonParams(builder, common)
	builder.requiredString('token', input.token)
	builder.optionalString('advertising_id', input.advertisingId)
	addLoginAndType(builder, common)
	addKeyBundle(builder, common.keyBundle)

	return { endpoint: '/v2/device_confirm', body: builder.toString(), registrationType: common.registrationType }
}

export const buildNativeAndroidAutoconfRequest = (
	common: NativeAndroidRegistrationCommon,
	input: NativeAndroidAutoconfInput
): NativeAndroidRegistrationRequest => {
	const builder = new RegistrationRequestBuilder()
	addCommonParams(builder, common)
	builder.requiredString('consent', input.consent)
	builder.base64('client_capabilities', input.clientCapabilities)
	addKeyBundle(builder, common.keyBundle)

	return { endpoint: '/v2/autoconf', body: builder.toString(), registrationType: common.registrationType }
}

export type NativeAndroidRequestSigningMaterial = {
	hmacKeyBase64: string
	encryptionKeyBase64: string
	ivBase64?: string
}

/**
 * Applies the two-stage body protection: HMAC first, then AES-256-GCM with a
 * 12-byte IV and a 16-byte tag. The bridge supplies transient native keys and
 * InfiniteAPI never persists this material.
 */
export const protectNativeAndroidRegistrationBody = (
	body: string,
	material: NativeAndroidRequestSigningMaterial
): string => {
	const hmacKey = Buffer.from(material.hmacKeyBase64, 'base64')
	const encryptionKey = Buffer.from(material.encryptionKeyBase64, 'base64')
	const iv = material.ivBase64 === undefined ? randomBytes(12) : Buffer.from(material.ivBase64, 'base64')
	if (hmacKey.byteLength < 16) throw new Error('native_android registration: HMAC key is too short')
	if (encryptionKey.byteLength !== 32) throw new Error('native_android registration: AES key must be 32 bytes')
	if (iv.byteLength !== 12) throw new Error('native_android registration: AES-GCM IV must be 12 bytes')

	const bodyBytes = Buffer.from(body, 'utf8')
	const mac = createHmac('sha256', hmacKey).update(bodyBytes).digest()
	const cipher = createCipheriv('aes-256-gcm', encryptionKey, iv)
	const encrypted = Buffer.concat([cipher.update(Buffer.concat([mac, bodyBytes])), cipher.final(), cipher.getAuthTag()])
	return Buffer.concat([iv, encrypted]).toString('base64')
}
