import type { proto } from '../../WAProto/index.js'
import type { AuthenticationCreds } from '../Types'
import { buildPrimaryRegistrationAuthCreds } from './native-android-registration-auth'
import type {
	NativeAndroidRegistrationBridgeAttestation,
	NativeAndroidRegistrationBridgeContext
} from './native-android-registration-bridge-provider'
import {
	createNativeAndroidRegistrationHttpClient,
	type NativeAndroidRegistrationHttpConfig
} from './native-android-registration-client'
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
	parseNativeAndroidRegisterResponse,
	parseNativeAndroidRequestCodeResponse
} from './native-android-registration-response'
import {
	buildClassicRegistrationToken,
	type NativeAndroidRegistrationTokenMaterial
} from './native-android-registration-token'

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
	/** ADV signed device identity to persist with the resulting creds, when known. */
	account?: proto.IADVSignedDeviceIdentity
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
	 * needed; without material it defaults to a placeholder the registration
	 * bridge replaces in-process (hook.js computes it via the in-APK class)
	 * before the request goes on the wire.
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
 * material the bridge still replaces the token in-process and may execute the
 * POST inside the real APK, short-circuiting the motor's own HTTP call.
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

	// The APK's registration onboarding always announces the install identity
	// (abprop) and checks the device state (exist) before the first /v2/code of
	// a registration; both run under the SAME identity/keys as the code request.
	let onboardPromise: Promise<NativeAndroidOnboardResult> | undefined
	const onboard = (): Promise<NativeAndroidOnboardResult> => {
		onboardPromise ??= (async () => {
			const abpropRequest = buildNativeAndroidRegOnboardAbpropRequest(common, {
				environment: options.environment
			})
			const abpropHttp = await client(abpropRequest)
			const existRequest = buildNativeAndroidExistRequest(common, {
				environment: options.environment,
				advertisingId: options.advertisingId,
				clientMetrics: options.onboardClientMetrics
			})
			const existHttp = await client(existRequest)
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
		})()
		return onboardPromise
	}

	return {
		keys,
		common,
		onboard,
		requestCode: async input => {
			if (!options.skipOnboarding) await onboard()
			const request = buildNativeAndroidRequestCodeRequest(common, {
				...input,
				token: input.token ?? computedToken ?? common.nationalNumber,
				advertisingId: input.advertisingId ?? options.advertisingId,
				environment: input.environment ?? options.environment
			})
			const http = await client(request)
			const response = parseNativeAndroidRequestCodeResponse(http.body)
			pendingAuthChallenge = response.authChallenge
				? decodeRegistrationAuthChallenge(response.authChallenge)
				: undefined
			return { request, httpStatus: http.status, attempts: http.attempts, response }
		},
		verifyCode: async input => {
			const request = buildNativeAndroidRegisterRequest(common, {
				...input,
				authResponse: input.authResponse ?? pendingAuthChallenge
			})
			const http = await client(request)
			const response = parseNativeAndroidRegisterResponse(http.body)
			const creds =
				response.status === 'ok'
					? buildPrimaryRegistrationAuthCreds({ keys, common, register: response, account: options.account })
					: undefined
			return { request, httpStatus: http.status, attempts: http.attempts, response, creds }
		}
	}
}
