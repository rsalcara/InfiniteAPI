import { createCipheriv, createHmac, randomBytes } from 'node:crypto'
import type { NativeAndroidRegistrationKeyBundle } from './native-android-registration-keys'

export type NativeAndroidRegistrationEndpoint =
	| '/v2/code'
	| '/v2/register'
	| '/v2/security'
	| '/v2/consent'
	| '/v2/device_confirm'
	| '/v2/autoconf'

export type NativeAndroidRegistrationCommon = {
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

export type NativeAndroidRequestCodeInput = {
	token: string
	method: 'sms' | 'voice'
	context?: string
	advertisingId?: string
	clickedEducationLink?: 0 | 1
	manageCallPermission?: 0 | 1
	callLogPermission?: 0 | 1
	clientStartMessage?: Uint8Array
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
	// Network layer injects `platform=android` for every registration
	// endpoint (C90133y9.A01 line 44, CGL line 42; W4B 2.26.36.72).
	builder.requiredString('platform', 'smba')
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

export const buildNativeAndroidRequestCodeRequest = (
	common: NativeAndroidRegistrationCommon,
	input: NativeAndroidRequestCodeInput
): NativeAndroidRegistrationRequest => {
	if (input.method !== 'sms' && input.method !== 'voice') {
		throw new Error('native_android registration: method must be sms or voice')
	}

	const builder = new RegistrationRequestBuilder()
	addCommonParams(builder, common)
	builder.requiredString('token', input.token)
	builder.requiredString('method', input.method)
	builder.optionalString('context', input.context)
	// A09 gates these on `userType != WA_TWO_FA_CONTACT_POINT`, so the
	// primary flow also attempts them; each write skips null/-1 values
	// (CJT.A00/A05), which is the fresh-install default, so all four stay
	// out of the wire unless the caller supplies real values.
	if (common.registrationType !== 1) {
		builder.booleanOrSkip('clicked_education_link', input.clickedEducationLink)
		builder.booleanOrSkip('manage_call_permission', input.manageCallPermission)
		builder.booleanOrSkip('call_log_permission', input.callLogPermission)
		builder.base64('client_start_message', input.clientStartMessage)
	}

	builder.optionalString('advertising_id', input.advertisingId)
	addLoginAndType(builder, common)
	addKeyBundle(builder, common.keyBundle)

	return { endpoint: '/v2/code', body: builder.toString() }
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

	return { endpoint: '/v2/register', body: builder.toString() }
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

	return { endpoint: '/v2/security', body: builder.toString() }
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

	return { endpoint: '/v2/consent', body: builder.toString() }
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

	return { endpoint: '/v2/device_confirm', body: builder.toString() }
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

	return { endpoint: '/v2/autoconf', body: builder.toString() }
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


