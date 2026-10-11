import { randomBytes } from 'node:crypto'
import { buildNativeAndroidRegistrationWireBody } from './native-android-registration-envelope'
import {
	RegistrationRequestBuilder,
	addKeyBundle,
	type NativeAndroidRegistrationCommon,
	type NativeAndroidRegistrationRequest,
	type NativeAndroidRequestCodeEnvironment
} from './native-android-registration-protocol'

/**
 * Registration funnel telemetry, 1:1 with the APK's
 * `KotlinRegistrationBridge.sendPrePNClientFunnelLog` (route `HAW.A08`) and
 * `sendClientFunnelLog` (route `HAW.A03`), consumer 2.26.38.10. The routes are
 * the XOR-18 `AbstractC39735HbD` constants: `/v2/pre_pn_client_log` and
 * `/v2/client_log`.
 *
 * Wire shape is the one difference from every attested route: both funnel
 * routes are flagged `HS5(false)` (`H9S` route map) — `sendAttestationPayload`
 * false — so `RetryingHttpClient` skips `signWithKeyAttestation` entirely and
 * the request carries ONLY `ENC=<blob>`: no `&H=` suffix, no `Authorization`
 * header. The seal, Content-Type and User-Agent are the same client.
 *
 * The engine produces every field locally — keys, ids, locale, session id —
 * so the funnel runs with no device and no external dependency.
 */

export type NativeAndroidRegistrationFunnelEvent = {
	/** `current_screen`: the registration screen the event belongs to. */
	currentScreen: string
	/**
	 * `previous_screen`. The APK reads it from `pref_previous_screen` and sends
	 * `unknown` before the first event, then the previous `current_screen`.
	 */
	previousScreen: string
	/** `action_taken`, e.g. `session_start`, `exist_check`, `request_code`. */
	actionTaken: string
	/** `event_name`, e.g. `registration_session_start`, `exist_attempt`. */
	eventName?: string
	/** Extra `A06` map entries, merged last like the APK's additionalParams. */
	additionalParams?: ReadonlyMap<string, string> | Record<string, string>
}

export type NativeAndroidRegistrationFunnelOptions = {
	/**
	 * Session-scoped access id (APK `A03`: UUID → 16 bytes → base64url). The
	 * official client mints one per registration session and threads it through
	 * every funnel event of that session.
	 */
	accessSessionId?: string
	/** GAID; becomes `android_advertising_id` in the map when present. */
	advertisingId?: string
	/** Runtime device facts — the same values /v2/exist carries on the wire. */
	environment?: NativeAndroidRequestCodeEnvironment
	/** Official User-Agent; the platform selector rejects requests without one. */
	userAgent?: string
	/**
	 * `rc` map value: the build's release channel (APK `C1K3`: RELEASE=0,
	 * BETA=1, ALPHA=2). The live official app registers as RELEASE.
	 */
	releaseChannel?: number
}

/**
 * `trace_id_int`: the WAM trace id the APK mints per funnel send
 * (`C0Q1.A01.A06()`), a positive 63-bit integer on the wire.
 */
const generateFunnelTraceId = (): string => {
	const bytes = randomBytes(8)
	bytes[0] = (bytes[0]! & 0x7f) >>> 0
	return BigInt(`0x${bytes.toString('hex')}`).toString(10)
}

const mergeAdditionalParams = (map: Map<string, string>, params: NativeAndroidRegistrationFunnelEvent['additionalParams']): void => {
	if (!params) return
	const entries = params instanceof Map ? params.entries() : Object.entries(params)
	for (const [key, value] of entries) map.set(key, value)
}

/**
 * `C40546HrV.A0L` + `A0X` ("addCommonFieldStatParams"): the device-fact block
 * the RegistrationHttpManager merges into every funnel map before sending.
 * Values the runtime does not report stay absent — the APK omits map entries
 * without runtime values and so must the motor (audit A03/A04: device state is
 * reported, never invented).
 */
const putFieldStatParams = (map: Map<string, string>, options?: NativeAndroidRegistrationFunnelOptions): void => {
	const environment = options?.environment ?? {}
	if (environment.network_radio_type !== undefined) map.set('network_radio_type', String(environment.network_radio_type))
	if (environment.simnum !== undefined) map.set('simnum', String(environment.simnum))
	if (environment.hasinrc !== undefined) map.set('hasinrc', String(environment.hasinrc))
	// A0L writes the sending process id unconditionally.
	map.set('pid', String(process.pid))
	// A0X: the release channel of the announced build.
	map.set('rc', String(options?.releaseChannel ?? 0))
}

const buildFunnelQuery = (builder: RegistrationRequestBuilder, map: Map<string, string>): string => {
	// A06 map merge: entries land after the explicit fields, in insertion order.
	for (const [key, value] of map) builder.setRaw(key, value)
	return builder.toString()
}

/**
 * Both funnel routes seal with the official envelope and stop there — the
 * `HS5(false)` gate never signs (`:cond_11` builds `HA6.A02("ENC")+"="+blob`)
 * and never sets `Authorization`.
 */
const funnelRequest = (
	endpoint: '/v2/pre_pn_client_log' | '/v2/client_log',
	query: string,
	common: NativeAndroidRegistrationCommon,
	options?: NativeAndroidRegistrationFunnelOptions
): NativeAndroidRegistrationRequest => {
	const wire = buildNativeAndroidRegistrationWireBody(query)
	return {
		endpoint,
		body: wire.body,
		sendAttestationPayload: false,
		registrationType: common.registrationType,
		...(options?.userAgent ? { userAgent: options.userAgent } : {})
	}
}

export const buildNativeAndroidPrePnFunnelQuery = (
	common: NativeAndroidRegistrationCommon,
	event: NativeAndroidRegistrationFunnelEvent,
	options?: NativeAndroidRegistrationFunnelOptions
): string => {
	// sendPrePNClientFunnelLog field order (KotlinRegistrationBridge.A0E):
	// A01 lg, A01 lc, A03 expid, A03 access_session_id?, A01 current_screen,
	// A01 previous_screen, A01 action_taken, A02 event_name, A06 map.
	const builder = new RegistrationRequestBuilder()
	builder.requiredString('lg', common.language)
	builder.requiredString('lc', common.country)
	builder.uuid('expid', common.expirationId)
	builder.uuid('access_session_id', options?.accessSessionId)
	builder.requiredString('current_screen', event.currentScreen)
	builder.setRaw('previous_screen', event.previousScreen)
	builder.requiredString('action_taken', event.actionTaken)
	builder.optionalString('event_name', event.eventName)

	// PrePnBaseFunnelLogger map, in its insertion order.
	const map = new Map<string, string>()
	map.set('is_add_account_flow', 'false')
	map.set('access_funnel_type', 'wa')
	// `app_campaign_download_source` (Play install referrer) is omitted: the
	// motor has no install-referrer source and the value is never fabricated.
	if (options?.advertisingId) map.set('android_advertising_id', options.advertisingId)
	// The SIM country ISO the APK reads via TelephonyManager; the registration
	// device is the same pt-BR install every other request announces.
	map.set('device_country', common.country.toLowerCase())
	// The pre-pn route carries fdid inside the map — the direct-field set has none.
	map.set('fdid', common.fingerprintDeviceId)
	putFieldStatParams(map, options)
	mergeAdditionalParams(map, event.additionalParams)
	return buildFunnelQuery(builder, map)
}

export const buildNativeAndroidPrePnFunnelRequest = (
	common: NativeAndroidRegistrationCommon,
	event: NativeAndroidRegistrationFunnelEvent,
	options?: NativeAndroidRegistrationFunnelOptions
): NativeAndroidRegistrationRequest =>
	funnelRequest('/v2/pre_pn_client_log', buildNativeAndroidPrePnFunnelQuery(common, event, options), common, options)

export const buildNativeAndroidClientFunnelQuery = (
	common: NativeAndroidRegistrationCommon,
	event: NativeAndroidRegistrationFunnelEvent,
	options?: NativeAndroidRegistrationFunnelOptions
): string => {
	// sendClientFunnelLog field order (KotlinRegistrationBridge.A0F):
	// A02 cc, A02 in, A01 lg, A0N (lc, fdid, expid, access_session_id?),
	// A0O (id, backup_token), C39910HeD key bundle, A01 current_screen,
	// A01 previous_screen, A01 action_taken, A06 map.
	const builder = new RegistrationRequestBuilder()
	// The WA_TWO_FA flow drops cc/in here exactly as the /v2/code serializer does.
	if (common.registrationType !== 1) {
		builder.optionalString('cc', common.countryCallingCode)
		builder.optionalString('in', common.nationalNumber)
	}
	builder.requiredString('lg', common.language)
	builder.requiredString('lc', common.country)
	builder.requiredString('fdid', common.fingerprintDeviceId)
	builder.uuid('expid', common.expirationId)
	builder.uuid('access_session_id', options?.accessSessionId)
	builder.requiredPercentEncoded('id', common.identityId)
	builder.requiredPercentEncoded('backup_token', common.backupToken)
	// C39910HeD.A00.A00 writes the e2e bundle in this exact order.
	addKeyBundle(builder, common.keyBundle)
	builder.requiredString('current_screen', event.currentScreen)
	builder.setRaw('previous_screen', event.previousScreen)
	builder.requiredString('action_taken', event.actionTaken)

	// BaseFunnelLogger map: `event_name` rides here (the logger reads it back
	// with `map.get("event_name")`), never as a direct field.
	const map = new Map<string, string>()
	if (event.eventName) map.set('event_name', event.eventName)
	map.set('registration_type', '0')
	map.set('is_add_account_flow', 'false')
	if (options?.advertisingId) map.set('android_advertising_id', options.advertisingId)
	map.set('trace_id_int', generateFunnelTraceId())
	// A0m exposure block: a fresh install has no pre-chatd AB exposure yet.
	map.set('exposure_error_type', 'empty_exposure')
	putFieldStatParams(map, options)
	mergeAdditionalParams(map, event.additionalParams)
	return buildFunnelQuery(builder, map)
}

export const buildNativeAndroidClientFunnelRequest = (
	common: NativeAndroidRegistrationCommon,
	event: NativeAndroidRegistrationFunnelEvent,
	options?: NativeAndroidRegistrationFunnelOptions
): NativeAndroidRegistrationRequest =>
	funnelRequest('/v2/client_log', buildNativeAndroidClientFunnelQuery(common, event, options), common, options)
