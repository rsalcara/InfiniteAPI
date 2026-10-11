import { Boom } from '@hapi/boom'
import { randomUUID } from 'node:crypto'
import type { proto } from '../../WAProto/index.js'
import type { AuthenticationCreds, NativeAndroidDeviceProfile } from '../Types'
import { buildPrimaryRegistrationAuthCreds } from './native-android-registration-auth'
import type {
	NativeAndroidRegistrationBridgeAttestation,
	NativeAndroidRegistrationBridgeContext
} from './native-android-registration-bridge-provider'
import {
	createNativeAndroidRegistrationHttpClient,
	type NativeAndroidRegistrationHttpConfig
} from './native-android-registration-client'
import { buildNativeAndroidRegistrationUserAgent } from './native-android-registration-device-attestation'
import {
	buildNativeAndroidClientFunnelRequest,
	buildNativeAndroidPrePnFunnelRequest
} from './native-android-registration-funnel'
import {
	buildNativeAndroidRegistrationKeyBundle,
	createNativeAndroidRegistrationSignalKeys,
	type NativeAndroidRegistrationSignalKeys
} from './native-android-registration-keys'
import {
	buildNativeAndroidExistRequest,
	buildNativeAndroidRegisterRequest,
	buildNativeAndroidRegOnboardAbpropRequest,
	buildNativeAndroidRequestCodeRequest,
	type NativeAndroidRegisterInput,
	type NativeAndroidRegistrationCommon,
	type NativeAndroidRegistrationRequest,
	type NativeAndroidRequestCodeEnvironment,
	type NativeAndroidRequestCodeInput
} from './native-android-registration-protocol'
import {
	type NativeAndroidRegisterResponse,
	type NativeAndroidRequestCodeResponse,
	isRegistrationSuccess,
	parseNativeAndroidRegisterResponse,
	parseNativeAndroidRequestCodeResponse
} from './native-android-registration-response'
import {
	buildClassicRegistrationToken,
	type NativeAndroidRegistrationTokenMaterial
} from './native-android-registration-token'
import logger from './logger'
import { safeRegistrationLog } from './safe-registration-log'

export type NativeAndroidRegistrationFlowHttpOptions = Omit<
	NativeAndroidRegistrationHttpConfig,
	'appVariant' | 'phoneNumber' | 'login' | 'registrationType'
>

export type NativeAndroidRegistrationFlowOptions = {
	/**
	 * Registration context without the key bundle: the flow owns the keys and
	 * injects `buildNativeAndroidRegistrationKeyBundle(keys)` so the uploaded
	 * bundle can never drift from the keys later used to connect.
	 */
	common: Omit<NativeAndroidRegistrationCommon, 'keyBundle'>
	/** Device-0 Signal material; generated fresh when omitted. */
	keys?: NativeAndroidRegistrationSignalKeys
	/**
	 * APK byte material for the official classic `token`. When set, the flow
	 * computes the token itself (self-computed mode) and the registration
	 * bridge no longer needs to replace it in-process.
	 */
	tokenMaterial?: NativeAndroidRegistrationTokenMaterial
	attestationProvider: (
		context: NativeAndroidRegistrationBridgeContext
	) => Promise<NativeAndroidRegistrationBridgeAttestation>
	http?: NativeAndroidRegistrationFlowHttpOptions
	/** Default /v2/code environment; overridable per request. */
	environment?: NativeAndroidRequestCodeEnvironment
	/**
	 * Install-scoped advertising id (GAID). Persisted with the install identity
	 * and forwarded to the pre-flight `/v2/exist` and to every /v2/code unless
	 * the call passes its own `advertisingId`.
	 */
	advertisingId?: string
	/**
	 * `/v2/exist` client_metrics value (observed `{"GMSVersion":263234032}`),
	 * which the APK builds with a different producer than the /v2/code map.
	 */
	onboardClientMetrics?: string
	/**
	 * Skips the onboarding pre-flight (`/v2/reg_onboard_abprop` → `/v2/exist`).
	 * The APK always runs both before the first /v2/code of a registration
	 * (captured 2026-09-24T14:42:01→03Z); the flag exists for unit tests that
	 * isolate a single endpoint.
	 */
	skipOnboarding?: boolean
	/**
	 * Skips the registration funnel telemetry (`/v2/pre_pn_client_log`,
	 * `/v2/client_log`). The APK always sends it around the registration
	 * calls; the flag exists for unit tests that isolate a single endpoint.
	 */
	skipFunnel?: boolean
	/** ADV signed device identity to persist with the resulting creds, when known. */
	account?: proto.IADVSignedDeviceIdentity
	/**
	 * Hardware profile this registration runs as. When set, `verifyCode` seeds
	 * the full `nativeAndroidIdentity` with the creds (app identity pinned to
	 * the registration build, `signal_protocol_store_is_new` true), so the
	 * login that follows reuses exactly this install's identity.
	 */
	nativeIdentity?: { device: NativeAndroidDeviceProfile }
}

export type NativeAndroidRegistrationStepResult<TResponse> = {
	request: NativeAndroidRegistrationRequest
	httpStatus: number
	attempts: number
	response: TResponse
}

export type NativeAndroidVerifyCodeResult = NativeAndroidRegistrationStepResult<NativeAndroidRegisterResponse> & {
	/** Present only when /v2/register completed with `status: 'ok'`. */
	creds?: AuthenticationCreds
}

export type NativeAndroidOnboardResult = {
	/** `/v2/reg_onboard_abprop` response carries `ab_hash`/`ab_key`/`exp_cfg`. */
	abprop: NativeAndroidRegistrationStepResult<unknown>
	/** `/v2/exist` — device onboarding check; body carries no number. */
	exist: NativeAndroidRegistrationStepResult<unknown>
}

export type NativeAndroidRequestCodeCall = Omit<NativeAndroidRequestCodeInput, 'token'> & {
	/**
	 * Official `token`. When `tokenMaterial` is configured the flow computes it
	 * itself (see `buildClassicRegistrationToken`) and this override is rarely
	 * needed; without material the caller must pass the value explicitly — the
	 * registration bridge replaces its own placeholder in-process (hook.js
	 * computes it via the in-APK class) before the request goes on the wire.
	 * The flow never fabricates a token (audit A07).
	 */
	token?: string
}

export type NativeAndroidRegistrationFlow = {
	keys: NativeAndroidRegistrationSignalKeys
	/** The exact common context (with key bundle) every request was/will be built from. */
	common: NativeAndroidRegistrationCommon
	/**
	 * Runs the official onboarding pre-flight once per flow (abprop → exist).
	 * `requestCode` awaits it automatically unless `skipOnboarding` is set; the
	 * same promise is shared, so explicit + automatic calls never duplicate.
	 */
	onboard: () => Promise<NativeAndroidOnboardResult>
	requestCode: (
		input: NativeAndroidRequestCodeCall
	) => Promise<NativeAndroidRegistrationStepResult<NativeAndroidRequestCodeResponse>>
	verifyCode: (input: NativeAndroidRegisterInput) => Promise<NativeAndroidVerifyCodeResult>
}

/**
 * Decodes the `/v2/code` `auth_challenge` payload the APK echoes back as
 * `auth_response` on /v2/register. Node's base64 decoder accepts both the
 * standard and URL-safe alphabets, so the official wire form round-trips.
 */
export const decodeRegistrationAuthChallenge = (challenge: string): Uint8Array =>
	Uint8Array.from(Buffer.from(challenge, 'base64'))

/**
 * Creates a complete primary phone-registration flow: requestCode
 * (/v2/code) → verifyCode (/v2/register) → AuthenticationCreds.
 *
 * With `tokenMaterial` the official `token` is computed in the motor
 * (self-computed mode) and the attestation provider only signs — a device
 * signer (`createNativeAndroidRegistrationDeviceAttestationProvider`) replaces
 * the registration bridge entirely for token and envelope work. Without
 * material the caller passes the bridge placeholder explicitly and the bridge
 * replaces it in-process, possibly executing the POST inside the real APK
 * (short-circuiting the motor's own HTTP call); the flow refuses to dispatch
 * /v2/code with no token at all (audit A07).
 * Responses are parsed 1:1 with the APK's FOG/FDZ parsers.
 */
export const createNativeAndroidRegistrationFlow = (
	options: NativeAndroidRegistrationFlowOptions
): NativeAndroidRegistrationFlow => {
	if (!options?.common) throw new Error('native_android registration flow requires the registration context')
	if (!options.attestationProvider) {
		throw new Error('native_android registration flow requires an attestation provider')
	}

	const keys = options.keys ?? createNativeAndroidRegistrationSignalKeys()
	const common: NativeAndroidRegistrationCommon = {
		...options.common,
		keyBundle: buildNativeAndroidRegistrationKeyBundle(keys)
	}

	// Official token keying (in-APK hook): the WA_TWO_FA flow signs the `login`
	// digits, the primary flow signs the `in=` national digits.
	const tokenDigits =
		common.registrationType === 1 && common.login ? common.login.split('@')[0]!.split(':')[0]! : common.nationalNumber
	const computedToken = options.tokenMaterial
		? buildClassicRegistrationToken(tokenDigits, options.tokenMaterial)
		: undefined

	const digits = `${common.countryCallingCode}${common.nationalNumber}`
	const client = createNativeAndroidRegistrationHttpClient(
		{
			...options.http,
			appVariant: common.appVariant === 'business' ? 'business' : 'consumer',
			phoneNumber: digits,
			login: common.login ?? `${digits}@s.whatsapp.net`,
			registrationType: common.registrationType
		},
		options.attestationProvider
	)

	/** Pending auth challenge from the last /v2/code, echoed by /v2/register. */
	let pendingAuthChallenge: Uint8Array | undefined

	// Registration funnel (1:1 com BaseFunnelLogger/PrePnBaseFunnelLogger). The
	// APK fires these around abprop/exist/code/register and only logs failures
	// ("failed to send funnel log"): telemetry that can abort a registration is
	// worse than no telemetry, so every funnel error is swallowed here.
	// `previous_screen` follows the APK's `pref_previous_screen` ("unknown"
	// before the first event) and the session id is minted once per flow — a
	// funnel-local value: it never touches `common`, so no existing request
	// body changes.
	const funnelAccessSessionId = common.accessSessionId ?? randomUUID()
	const funnelUserAgent = options.nativeIdentity?.device
		? buildNativeAndroidRegistrationUserAgent(
				options.nativeIdentity.device,
				common.appVariant === 'business' ? 'business' : 'consumer'
			)
		: undefined
	const funnelOptions = {
		accessSessionId: funnelAccessSessionId,
		...(options.advertisingId ? { advertisingId: options.advertisingId } : {}),
		...(options.environment ? { environment: options.environment } : {}),
		...(funnelUserAgent ? { userAgent: funnelUserAgent } : {})
	}
	let funnelPreviousScreen: string | undefined
	let lastRequestedMethod: string | undefined

	const sendFunnelEvent = async (request: NativeAndroidRegistrationRequest, currentScreen: string): Promise<void> => {
		if (options.skipFunnel) return
		// The APK stores the new previous-screen pref before the POST goes out.
		funnelPreviousScreen = currentScreen
		try {
			await client(request)
		} catch {
			// Allowlisted metadata only (audit M10): the Error never reaches the log.
			logger.debug(
				safeRegistrationLog({
					endpoint: request.endpoint,
					operationId: 'funnel-event',
					phase: 'funnel',
					attempts: 1,
					durationMs: 0,
					category: 'funnel_send_failed'
				}),
				'native_android registration funnel log failed'
			)
		}
	}

	const sendPrePnFunnel = async (actionTaken: string, eventName: string): Promise<void> => {
		await sendFunnelEvent(
			buildNativeAndroidPrePnFunnelRequest(
				common,
				{
					currentScreen: 'enter_number',
					previousScreen: funnelPreviousScreen ?? 'unknown',
					actionTaken,
					eventName
				},
				funnelOptions
			),
			'enter_number'
		)
	}

	const sendClientFunnel = async (
		currentScreen: string,
		actionTaken: string,
		eventName: string
	): Promise<void> => {
		await sendFunnelEvent(
			buildNativeAndroidClientFunnelRequest(
				common,
				{
					currentScreen,
					previousScreen: funnelPreviousScreen ?? 'unknown',
					actionTaken,
					eventName
				},
				funnelOptions
			),
			currentScreen
		)
	}

	// The APK's registration onboarding always announces the install identity
	// (abprop) and checks the device state (exist) before the first /v2/code of
	// a registration; both run under the SAME identity/keys as the code request.
	let onboardPromise: Promise<NativeAndroidOnboardResult> | undefined
	const onboard = (): Promise<NativeAndroidOnboardResult> => {
		onboardPromise ??= (async () => {
			// Session-start event, fired before the number is committed — the
			// APK's PrePn funnel sends it from the number-entry screen before
			// any registration request exists.
			await sendPrePnFunnel('session_start', 'registration_session_start')
			const abpropRequest = buildNativeAndroidRegOnboardAbpropRequest(common, {
				environment: options.environment
			})
			const abpropHttp = await client(abpropRequest)
			await sendClientFunnel('enter_number', 'exist_check', 'exist_attempt')
			const existRequest = buildNativeAndroidExistRequest(common, {
				environment: options.environment,
				advertisingId: options.advertisingId,
				clientMetrics: options.onboardClientMetrics
			})
			const existHttp = await client(existRequest)
			// `exist_success` means the identity is fresh (`reason: incorrect`),
			// the state that lets the client proceed to /v2/code;
			// `exist_failure` means the server found it already registered.
			const existBody = existHttp.body as { status?: string; reason?: string } | undefined
			const existFresh = existBody?.reason === 'incorrect' || existBody?.status !== 'ok'
			await sendClientFunnel('enter_number', 'exist_check', existFresh ? 'exist_success' : 'exist_failure')
			return {
				abprop: {
					request: abpropRequest,
					httpStatus: abpropHttp.status,
					attempts: abpropHttp.attempts,
					response: abpropHttp.body
				},
				exist: {
					request: existRequest,
					httpStatus: existHttp.status,
					attempts: existHttp.attempts,
					response: existHttp.body
				}
			}
		})().catch(error => {
			// A rejected onboarding must not stay cached: the next caller retries
			// from scratch instead of replaying the same failure forever.
			onboardPromise = undefined
			throw error
		})
		return onboardPromise
	}

	return {
		keys,
		common,
		onboard,
		requestCode: async input => {
			if (!options.skipOnboarding) {
				const onboarded = await onboard()
				// The APK never issues /v2/code after a failed onboarding step; both
				// steps must complete at the HTTP level first.
				for (const step of ['abprop', 'exist'] as const) {
					const result = onboarded[step]
					if (result.httpStatus < 200 || result.httpStatus >= 300) {
						throw new Boom(`registration onboarding failed at ${step}`, {
							statusCode: 502,
							data: {
								step,
								endpoint: step === 'abprop' ? '/v2/reg_onboard_abprop' : '/v2/exist',
								httpStatus: result.httpStatus
							}
						})
					}
				}
			}

			// The official `token` is the classic HMAC over the `in=` digits
			// (buildClassicRegistrationToken, the in-APK computation); the motor
			// computes it whenever the APK material is configured. There is no
			// silent fallback to the raw phone number — that would fabricate wire
			// (audit A07). In-APK bridge callers that replace the token in-process
			// pass their placeholder explicitly via `input.token`.
			const token = input.token ?? computedToken
			if (!token) {
				throw new Boom(
					'native_android registration: /v2/code requires an official token (configure tokenMaterial or pass token)',
					{ statusCode: 500, data: { step: 'code-token' } }
				)
			}

			// The screen a later event belongs to is named after the method asked
			// for here, so record it before the request rather than after.
			lastRequestedMethod = input.method
			const verifyScreen = `verify_${input.method}`
			await sendClientFunnel(verifyScreen, 'request_code', 'request_code_attempt')
			const request = buildNativeAndroidRequestCodeRequest(common, {
				...input,
				token,
				advertisingId: input.advertisingId ?? options.advertisingId,
				environment: input.environment ?? options.environment
			})
			const http = await client(request)
			const response = parseNativeAndroidRequestCodeResponse(http.body)
			pendingAuthChallenge = response.authChallenge
				? decodeRegistrationAuthChallenge(response.authChallenge)
				: undefined
			if (isRegistrationSuccess(response)) {
				await sendClientFunnel(verifyScreen, 'request_code', 'request_code_success')
			}
			return { request, httpStatus: http.status, attempts: http.attempts, response }
		},
		verifyCode: async input => {
			// Fail-closed before /v2/register (audit A06): the creds assembled from
			// the response seed `nativeAndroidIdentity` from this device profile;
			// without it the session would be born unmarked and every later connect
			// would misclassify it as non-primary.
			const deviceProfile = options.nativeIdentity?.device
			if (!deviceProfile) {
				throw new Boom('native_android registration: a persisted device profile is required before /v2/register', {
					statusCode: 500,
					data: { step: 'device-profile' }
				})
			}

			const verifyScreen = lastRequestedMethod ? `verify_${lastRequestedMethod}` : 'enter_number'
			await sendClientFunnel(verifyScreen, 'submit_code', 'submit_code_attempt')
			const request = buildNativeAndroidRegisterRequest(common, {
				...input,
				authResponse: input.authResponse ?? pendingAuthChallenge
			})
			const http = await client(request)
			const response = parseNativeAndroidRegisterResponse(http.body)
			const creds =
				http.status >= 200 && http.status < 300 && response.status === 'ok'
					? buildPrimaryRegistrationAuthCreds({
							keys,
							common,
							register: response,
							account: options.account,
							device: deviceProfile
						})
					: undefined
			// The challenge answers exactly one /v2/register attempt (the APK keeps
			// it on the verification screen state and clears it on completion). Only
			// a completed registration consumes it — a failed attempt keeps the
			// challenge so the retry can echo the same auth_response (audit A07).
			if (creds) {
				pendingAuthChallenge = undefined
				await sendClientFunnel('account_verification_complete', 'submit_code', 'submit_code_success')
			}
			return { request, httpStatus: http.status, attempts: http.attempts, response, creds }
		}
	}
}
