/**
 * Response parsers for the official phone-number registration endpoints,
 * transcribed 1:1 from W4B 2.26.36.72:
 *
 * - /v2/code     -> `FOG`, parsed by KotlinRegistrationBridge.A09 continuation
 *                   + helpers A00/A0O/A0P/A0Q (KotlinRegistrationBridge.java).
 * - /v2/register -> `FDZ`, parsed by KotlinRegistrationBridge.A08
 *                   (KotlinRegistrationBridge.java:1365-1548).
 *
 * Field types mirror the APK's accessors exactly, including their defaults:
 * `optString(k, null)` -> `string | null`, `optInt`/`optLong` with a default ->
 * `number` (default applied), `optBoolean` -> `boolean` (false when absent).
 * Note the endpoint asymmetry the APK has: /v2/code keeps the wait fields as
 * strings while /v2/register keeps them as longs.
 *
 * Two deliberate enrichments: `reason` stays the raw server string (the APK
 * folds it into an internal status code and drops the text), and
 * `edge_routing_info` is kept even though the APK's Kotlin parser reads and
 * discards it.
 *
 * Fields the APK reads and discards (aux_attributes, image_blob, audio_blob,
 * email, min_poll, voice_length, sms_length, password_manager, passkey_aaguid)
 * are intentionally absent: parity means dropping what the app drops.
 */

export type NativeAndroidRegistrationStatus = 'ok' | 'sent' | 'attached' | 'fail' | 'unknown'

/** Every `reason` the APK's /v2/code fail switch handles (KRB A09). */
export const NATIVE_ANDROID_CODE_REASONS = [
	'format_wrong',
	'provider_timeout',
	'provider_unroutable',
	'temporarily_unavailable',
	'missing_param',
	'flash_disabled',
	'waiting_for_sms',
	'too_many',
	'limited_release',
	'too_many_all_methods',
	'security_code',
	'too_many_guesses',
	'blocked',
	'second_code',
	'invalid_skey',
	'no_routes',
	'old_version',
	'send_sms',
	'next_method',
	'challenge',
	'device_confirm_or_second_code',
	'not_allowed',
	'too_recent',
	'bad_param',
	'bad_token'
] as const

/** Every `reason` the APK's /v2/register fail switch handles (KRB A08). */
export const NATIVE_ANDROID_REGISTER_REASONS = [
	'sms_required',
	'format_wrong',
	'consent_parent_linking_already_registered',
	'incorrect',
	'temporarily_unavailable',
	'mismatch',
	'limited_release',
	'security_code',
	'too_many_guesses',
	'blocked',
	'stale',
	'second_code',
	'consent',
	'missing',
	'challenge',
	'device_confirm_or_second_code',
	'reset_too_soon',
	'not_allowed',
	'guessed_too_fast'
] as const

/**
 * The APK's `FOF` violation block. Its fields are flat keys on the response
 * root (`violation_type`, `violated_policy`, `violation_reason`, `is_eu_smb`,
 * `appeal_token`), and the block exists only when type, policy or appeal token
 * is present — exactly the FOF construction guard.
 */
export type NativeAndroidRegistrationViolation = {
	/** `violation_type` */
	type: string | null
	/** `violated_policy` */
	policy: string | null
	/** `violation_reason`; the /v2/code parser passes null here. */
	reason: string | null
	/** `appeal_token` */
	appealToken: string | null
	/** `is_eu_smb` — optBoolean with false default. */
	isEuSmb: boolean
}

export type NativeAndroidRequestCodeResponse = {
	status: NativeAndroidRegistrationStatus
	/** Fail reason; one of NATIVE_ANDROID_CODE_REASONS when the server sends one. */
	reason: string | null
	/** 2FA contact point echoed back (`login`). */
	login: string | null
	/** Account kind: `{"new":1,"existing":2}` (KRB A00 + X/AbstractC33436Eni). */
	type: 'new' | 'existing' | null
	/** `retry_after` — optString. */
	retryAfter: string | null
	/** `length` — expected code length, optInt default 0. */
	length: number
	/** `code` — flash/attached verification code. */
	code: string | null
	smsWait: string | null
	voiceWait: string | null
	waOldWait: string | null
	flashWait: string | null
	silentAuthWait: string | null
	sendSmsWait: string | null
	emailOtpWait: string | null
	cliFilter: string | null
	cliCc: string | null
	cliPrefix: string | null
	cliMatchLength: string | null
	flashTimeout: string | null
	notifyAfter: string | null
	wipeToken: string | null
	/** `wipe_wait` — optLong default 0. */
	wipeWait: number
	param: string | null
	firstPartyMigrationInitiated: boolean
	fpmInitiatedCrossPlatform: boolean
	resetMethod: string | null
	wipeType: string | null
	/** Base64 autoconf challenge; echoed as `auth_response` on /v2/register. */
	authChallenge: string | null
	/** `autoconf_type` — optInt default 0. */
	autoconfType: number
	/** `email_otp_eligible` — optInt default 0. */
	emailOtpEligible: number
	sendSmsNumber: string | null
	uri: string | null
	/** `code_list` — kept as the raw string like the APK's optString. */
	codeList: string | null
	passkeyCredential: string | null
	ts43Cred: string | null
	ts43Nonce: string | null
	/** `lid_blocklist` — optBoolean. */
	lidBlocklist: boolean
	/** The LID paired with the registering account. */
	lid: string | null
	fallbackMethods: string[] | null
	recommendedMethod: string[] | null
	/** `num_visible_dbs_methods` — optInt default 3. */
	numVisibleDbsMethods: number
	violation: NativeAndroidRegistrationViolation | null
	versionUpgrade: Record<string, unknown> | null
	customBlockScreen: Record<string, unknown> | null
}

export type NativeAndroidRegisterResponse = {
	status: NativeAndroidRegistrationStatus
	/** Fail reason; one of NATIVE_ANDROID_REGISTER_REASONS when the server sends one. */
	reason: string | null
	login: string | null
	type: 'new' | 'existing' | null
	/** `retry_after` — optString. */
	retryAfter: string | null
	firstPartyMigrationInitiated: boolean
	fpmInitiatedCrossPlatform: boolean
	resetMethod: string | null
	wipeType: string | null
	wipeToken: string | null
	/** `wipe_wait` — optLong default 0. */
	wipeWait: number
	/** `wipe_expiry_time` — optLong default 0. */
	wipeExpiryTime: number
	/** `autoconf_type` — optInt default 0. */
	autoconfType: number
	/** `guess_wait` — optString. */
	guessWait: string | null
	/** `server_time` — optLong default 0. */
	serverTime: number
	securityCodeSet: boolean
	waAcMachineId: string | null
	/** `secure_verifier` — optBoolean. */
	secureVerifier: boolean
	/** `sms_wait` — optLong default 0. */
	smsWait: number
	/** `voice_wait` — optLong default 0. */
	voiceWait: number
	/** `flash_wait` — optLong default 0. */
	flashWait: number
	/** `need_chat_restore_pn_verify` — optInt flag read as a boolean. */
	needChatRestorePnVerify: boolean
	pending: string | null
	parentConsentUrl: string | null
	/** `consent_id` — optInt default 0. */
	consentId: number
	/** `consent_version` — optInt default 0. */
	consentVersion: number
	idvToken: string | null
	passkeyCredential: string | null
	/** `lid_blocklist` — optBoolean. */
	lidBlocklist: boolean
	/** The LID pair element. Consumed by the auth-state assembly. */
	lid: string | null
	/**
	 * `edge_routing_info`. The APK's Kotlin parser reads this and discards it
	 * because the native layer routes via the XMPP `edge_routing` notification
	 * instead. The motor keeps it available: its `routingInfo` credential has
	 * exactly this meaning and the XMPP path may never fire before the first
	 * connect.
	 */
	edgeRoutingInfo: string | null
	/** `paa_role` — optInt default 0. */
	paaRole: number
	/** `paa_pending` — optString. */
	paaPending: string | null
	coexProducts: string | null
	coexUsecase: string | null
	entAccessToken: string | null
	entCanonicalFbid: string | null
	secondFactorMethods: string[] | null
	/** `is_device_trusted` — optBoolean. */
	isDeviceTrusted: boolean
	violation: NativeAndroidRegistrationViolation | null
	versionUpgrade: Record<string, unknown> | null
	customBlockScreen: Record<string, unknown> | null
}

const asRecord = (value: unknown): Record<string, unknown> | null =>
	typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null

/** optString semantics: scalars coerce to string, anything else is absent. */
const readString = (source: Record<string, unknown> | null, key: string): string | null => {
	if (!source) return null
	const value = source[key]
	if (value === undefined || value === null) return null
	if (typeof value === 'string') return value
	if (typeof value === 'number' && Number.isFinite(value)) return String(value)
	if (typeof value === 'boolean') return value ? 'true' : 'false'
	return null
}

/** optInt/optLong semantics: numbers and numeric strings parse, else the default. */
const readInt = (source: Record<string, unknown> | null, key: string, fallback: number): number => {
	if (!source) return fallback
	const value = source[key]
	if (typeof value === 'number' && Number.isFinite(value)) return Math.trunc(value)
	if (typeof value === 'string' && value.trim() !== '') {
		const parsed = Number(value)
		if (Number.isFinite(parsed)) return Math.trunc(parsed)
	}

	return fallback
}

/** optBoolean semantics: `true`/`false` strings coerce, anything else is false. */
const readBoolean = (source: Record<string, unknown> | null, key: string): boolean => {
	if (!source) return false
	const value = source[key]
	if (typeof value === 'boolean') return value
	if (typeof value === 'string') return value.trim().toLowerCase() === 'true'
	return false
}

const readStringArray = (source: Record<string, unknown> | null, key: string): string[] | null => {
	if (!source) return null
	const value = source[key]
	if (!Array.isArray(value)) return null
	const items = value
		.filter(item => typeof item === 'string' || (typeof item === 'number' && Number.isFinite(item)))
		.map(item => String(item))
	return items.length > 0 ? items : null
}

const readRawObject = (source: Record<string, unknown> | null, key: string): Record<string, unknown> | null => {
	if (!source) return null
	return asRecord(source[key])
}

const readStatus = (source: Record<string, unknown> | null): NativeAndroidRegistrationStatus => {
	const status = readString(source, 'status')
	if (status === 'ok' || status === 'sent' || status === 'attached' || status === 'fail') return status
	return 'unknown'
}

/**
 * Builds the APK's `FOF` violation block from the flat response keys. The
 * block exists only when violation_type, violated_policy or appeal_token is
 * present (the FOF construction guard); `violation_reason` alone is not enough.
 * `reason` is always null outside /v2/register, the only parser that passes it
 * to FOF.
 */
const readViolation = (
	source: Record<string, unknown> | null,
	register: boolean
): NativeAndroidRegistrationViolation | null => {
	if (!source) return null
	const type = readString(source, 'violation_type')
	const policy = readString(source, 'violated_policy')
	const appealToken = readString(source, 'appeal_token')
	if (type === null && policy === null && appealToken === null) return null
	return {
		type,
		policy,
		reason: register ? readString(source, 'violation_reason') : null,
		appealToken,
		isEuSmb: readBoolean(source, 'is_eu_smb')
	}
}

const readAccountType = (source: Record<string, unknown> | null): 'new' | 'existing' | null => {
	const type = readString(source, 'type')
	return type === 'new' || type === 'existing' ? type : null
}

/**
 * Parses a /v2/code response body (already JSON-decoded) exactly like the
 * APK's `FOG` DTO. Unknown fields are ignored, mirroring the parser.
 */
export const parseNativeAndroidRequestCodeResponse = (body: unknown): NativeAndroidRequestCodeResponse => {
	const source = asRecord(body)
	return {
		status: readStatus(source),
		reason: readString(source, 'reason'),
		login: readString(source, 'login'),
		type: readAccountType(source),
		retryAfter: readString(source, 'retry_after'),
		length: readInt(source, 'length', 0),
		code: readString(source, 'code'),
		smsWait: readString(source, 'sms_wait'),
		voiceWait: readString(source, 'voice_wait'),
		waOldWait: readString(source, 'wa_old_wait'),
		flashWait: readString(source, 'flash_wait'),
		silentAuthWait: readString(source, 'silent_auth_wait'),
		sendSmsWait: readString(source, 'send_sms_wait'),
		emailOtpWait: readString(source, 'email_otp_wait'),
		cliFilter: readString(source, 'cli_filter'),
		cliCc: readString(source, 'cli_cc'),
		cliPrefix: readString(source, 'cli_prefix'),
		cliMatchLength: readString(source, 'cli_match_length'),
		flashTimeout: readString(source, 'flash_timeout'),
		notifyAfter: readString(source, 'notify_after'),
		wipeToken: readString(source, 'wipe_token'),
		wipeWait: readInt(source, 'wipe_wait', 0),
		param: readString(source, 'param'),
		firstPartyMigrationInitiated: readBoolean(source, 'first_party_migration_initiated'),
		fpmInitiatedCrossPlatform: readBoolean(source, 'fpm_initiated_cross_platform'),
		resetMethod: readString(source, 'reset_method'),
		wipeType: readString(source, 'wipe_type'),
		authChallenge: readString(source, 'auth_challenge'),
		autoconfType: readInt(source, 'autoconf_type', 0),
		emailOtpEligible: readInt(source, 'email_otp_eligible', 0),
		sendSmsNumber: readString(source, 'send_sms_number'),
		uri: readString(source, 'uri'),
		codeList: readString(source, 'code_list'),
		passkeyCredential: readString(source, 'passkey_credential'),
		ts43Cred: readString(source, 'ts_43_cred'),
		ts43Nonce: readString(source, 'ts_43_nonce'),
		lidBlocklist: readBoolean(source, 'lid_blocklist'),
		lid: readString(source, 'lid'),
		fallbackMethods: readStringArray(source, 'fallback_methods'),
		recommendedMethod: readStringArray(source, 'recommended_method'),
		numVisibleDbsMethods: readInt(source, 'num_visible_dbs_methods', 3),
		violation: readViolation(source, false),
		versionUpgrade: readRawObject(source, 'version_upgrade'),
		customBlockScreen: readRawObject(source, 'custom_block_screen')
	}
}

/**
 * Parses a /v2/register response body (already JSON-decoded) exactly like the
 * APK's `FDZ` DTO.
 */
export const parseNativeAndroidRegisterResponse = (body: unknown): NativeAndroidRegisterResponse => {
	const source = asRecord(body)
	return {
		status: readStatus(source),
		reason: readString(source, 'reason'),
		login: readString(source, 'login'),
		type: readAccountType(source),
		retryAfter: readString(source, 'retry_after'),
		firstPartyMigrationInitiated: readBoolean(source, 'first_party_migration_initiated'),
		fpmInitiatedCrossPlatform: readBoolean(source, 'fpm_initiated_cross_platform'),
		resetMethod: readString(source, 'reset_method'),
		wipeType: readString(source, 'wipe_type'),
		wipeToken: readString(source, 'wipe_token'),
		wipeWait: readInt(source, 'wipe_wait', 0),
		wipeExpiryTime: readInt(source, 'wipe_expiry_time', 0),
		autoconfType: readInt(source, 'autoconf_type', 0),
		guessWait: readString(source, 'guess_wait'),
		serverTime: readInt(source, 'server_time', 0),
		securityCodeSet: readBoolean(source, 'security_code_set'),
		waAcMachineId: readString(source, 'wa_ac_machine_id'),
		secureVerifier: readBoolean(source, 'secure_verifier'),
		smsWait: readInt(source, 'sms_wait', 0),
		voiceWait: readInt(source, 'voice_wait', 0),
		flashWait: readInt(source, 'flash_wait', 0),
		needChatRestorePnVerify: readInt(source, 'need_chat_restore_pn_verify', 0) === 1,
		pending: readString(source, 'pending'),
		parentConsentUrl: readString(source, 'parent_consent_url'),
		consentId: readInt(source, 'consent_id', 0),
		consentVersion: readInt(source, 'consent_version', 0),
		idvToken: readString(source, 'idv_token'),
		passkeyCredential: readString(source, 'passkey_credential'),
		lidBlocklist: readBoolean(source, 'lid_blocklist'),
		lid: readString(source, 'lid'),
		edgeRoutingInfo: readString(source, 'edge_routing_info'),
		paaRole: readInt(source, 'paa_role', 0),
		paaPending: readString(source, 'paa_pending'),
		coexProducts: readString(source, 'coex_products'),
		coexUsecase: readString(source, 'coex_usecase'),
		entAccessToken: readString(source, 'ent_access_token'),
		entCanonicalFbid: readString(source, 'ent_canonical_fbid'),
		secondFactorMethods: readStringArray(source, 'second_factor_methods'),
		isDeviceTrusted: readBoolean(source, 'is_device_trusted'),
		violation: readViolation(source, true),
		versionUpgrade: readRawObject(source, 'version_upgrade'),
		customBlockScreen: readRawObject(source, 'custom_block_screen')
	}
}

/** The APK treats `ok` and `sent` as non-fail outcomes on both endpoints. */
export const isRegistrationSuccess = (response: { status: NativeAndroidRegistrationStatus }): boolean =>
	response.status === 'ok' || response.status === 'sent'

/**
 * The pre-flight block gate the APK screens before ever issuing /v2/code
 * (`/v2/reg_onboard_abprop`, `/v2/exist` bodies carry the same `status`/
 * `reason`/`custom_block_screen` fail shape as the code/register DTOs). A
 * `custom_block_screen` is rendered verbatim and stops the registration;
 * `reason: 'incorrect'` is the fresh-identity signal that lets the client
 * continue to /v2/code.
 */
export type NativeAndroidRegistrationBlockGate = {
	status: NativeAndroidRegistrationStatus
	reason: string | null
	/** `custom_block_screen` — opaque server-rendered screen DTO. */
	customBlockScreen: Record<string, unknown> | null
}

export const parseNativeAndroidRegistrationBlockGate = (body: unknown): NativeAndroidRegistrationBlockGate => {
	const source = asRecord(body)
	return {
		status: readStatus(source),
		reason: readString(source, 'reason'),
		customBlockScreen: readRawObject(source, 'custom_block_screen')
	}
}
