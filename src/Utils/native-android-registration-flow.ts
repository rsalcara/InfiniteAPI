import { Boom } from '@hapi/boom'
import { randomUUID } from 'node:crypto'
import type { proto } from '../../WAProto/index.js'
import type { AuthenticationCreds, NativeAndroidDeviceProfile } from '../Types'
import { buildPrimaryRegistrationAuthCreds } from './native-android-registration-auth'
import type { NativeAndroidAttestationProofDiagnostics } from './native-android-registration-attestation-validation'
import type {
	NativeAndroidRegistrationBridgeAttestation,
	NativeAndroidRegistrationBridgeContext
} from './native-android-registration-bridge-provider'
import {
	createNativeAndroidRegistrationHttpClient,
	type NativeAndroidRegistrationHttpConfig
} from './native-android-registration-client'
import {
	buildNativeAndroidRegistrationUserAgent,
	mapAttestedDeviceProfile
} from './native-android-registration-device-attestation'
import {
	buildNativeAndroidRegistrationWireBody,
	type NativeAndroidRegistrationEnvelopeMaterial
} from './native-android-registration-envelope'
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
	sanitizeNativeAndroidRegistrationEnvironment,
	type NativeAndroidRegisterInput,
	type NativeAndroidRegistrationCommon,
	type NativeAndroidRegistrationEndpoint,
	type NativeAndroidRegistrationRequest,
	type NativeAndroidRequestCodeEnvironment,
	type NativeAndroidRequestCodeInput
} from './native-android-registration-protocol'
import {
	type NativeAndroidRegisterResponse,
	type NativeAndroidRequestCodeResponse,
	isRegistrationSuccess,
	parseNativeAndroidRegistrationBlockGate,
	parseNativeAndroidRegisterResponse,
	parseNativeAndroidRequestCodeResponse
} from './native-android-registration-response'
import {
	buildClassicRegistrationToken,
	computeRegistrationMaterialHash,
	materialManifestAppVersion,
	type NativeAndroidRegistrationTokenMaterial
} from './native-android-registration-token'
import logger from './logger'
import { registrationBlockScreenHash, safeRegistrationLog } from './safe-registration-log'

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
	/**
	 * How the registration wire carries attestation.
	 *
	 * `device` (default): the attestation provider seals AND signs every route
	 * — `&H=` plus `Authorization` carry the Keystore chain and the
	 * environment carries the Play Integrity legs. `attestationProvider` is
	 * required.
	 *
	 * `unattested`: the whalibmob reference profile with no attestation server
	 * attached (`attestBody` -> `EMPTY_BODY`, every attestation field omitted).
	 * The flow seals `ENC=` itself and each request goes out with no `&H=`, no
	 * `Authorization` and no Play Integrity legs in the environment.
	 *
	 * Falsified 2026-10-11 (wire experiment against v.whatsapp.net): the
	 * app-identity block ("Baixe o app oficial") is keyed on the `gpia` VALUE,
	 * not on the attestor package name. Absent `gpia` -> block; `gpia` = the
	 * Play Integrity Standard JWS minted by the Connector (556 chars, names
	 * `br.com.infiniteapi.connector`) -> block; `gpia` = the official app's
	 * wamsys blob (399 chars base64url, protobuf `field1(231B) field3(63B)`,
	 * minted by `JniBridge` inside the APK) -> normal protocol even with the
	 * Connector's Keystore `&H=` + `Authorization` naming our package on the
	 * same request. `gpiaMaterial` below is that official blob replayed.
	 */
	attestationProfile?: 'device' | 'unattested'
	attestationProvider?: (
		context: NativeAndroidRegistrationBridgeContext
	) => Promise<NativeAndroidRegistrationBridgeAttestation>
	/**
	 * Envelope material for the unattested profile's own seal; defaults to the
	 * official server key. Under `device` the provider owns the seal.
	 */
	envelopeMaterial?: NativeAndroidRegistrationEnvelopeMaterial
	http?: NativeAndroidRegistrationFlowHttpOptions
	/** Default /v2/code environment; overridable per request. */
	environment?: NativeAndroidRequestCodeEnvironment
	/**
	 * Official-app `gpia` material, replayed verbatim into the `gpia` field of
	 * `/v2/code` (the only endpoint the APK serializes it to; `/v2/register`
	 * never carries it). The blob is CAPTURED material from the official APK
	 * (`JniBridge`/wamsys, 399-char base64url without dots) — the flow never
	 * mints or fabricates one (audit rule: no forged signals). Applied after
	 * `sanitizeNativeAndroidRegistrationEnvironment`, so it survives the
	 * `unattested` profile: a wamsys blob is official-app material, not the
	 * foreign Play Integrity JWS the sanitize exists to drop.
	 */
	gpiaMaterial?: string
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
	 * The technical identity this registration runs as (audit gap D): the
	 * persisted device profile merged with the hardware the attestation chain
	 * reported (attested fields win). Callers persist it back into their flow
	 * state so requestCode, verify and every later connect announce one device.
	 */
	deviceProfile: () => NativeAndroidDeviceProfile | undefined
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
	const attestationProfile = options.attestationProfile ?? 'device'
	if (attestationProfile === 'unattested') {
		// The unattested profile signs nothing, so a provider could only
		// reintroduce the artifacts this profile exists to omit.
		if (options.attestationProvider) {
			throw new Error('native_android registration flow: the unattested profile never uses an attestation provider')
		}
		// The User-Agent is the one platform-selector input left once the
		// provider is gone — the provider is what normally supplies it.
		if (!options.nativeIdentity?.device) {
			throw new Error('native_android registration flow: the unattested profile requires a device profile for the User-Agent')
		}
	} else if (!options.attestationProvider) {
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
	// Announced build (audit gap A): with a material manifest the UA and the
	// seeded creds name the exact build whose blobs signed the token; without
	// one the pinned per-variant build applies (previous behavior).
	const announcedAppVersion = options.tokenMaterial?.manifest
		? materialManifestAppVersion(options.tokenMaterial.manifest)
		: undefined
	// Sanitized correlation identity (audit gap F): one digest naming the exact
	// APK material this flow signs with, computed once and logged per step —
	// the material bytes themselves never reach any log.
	const materialHash = options.tokenMaterial ? computeRegistrationMaterialHash(options.tokenMaterial) : undefined

	// Attested hardware identity (audit gap D): the attesting device is
	// authoritative for its own Build.* fields (the Keystore chain is TEE-signed),
	// so the flow captures the profile from the first attestation that reports
	// one. A later attestation reporting different hardware is a divergence the
	// flow rejects — one registration runs as exactly one device.
	let attestedDeviceProfile: Record<string, string> | undefined
	/** Last proof diagnostics per endpoint, keyed for the per-step correlation log. */
	const stepProofs = new Map<NativeAndroidRegistrationEndpoint, NativeAndroidAttestationProofDiagnostics>()
	const sameAttestedDeviceProfile = (a: Record<string, string>, b: Record<string, string>): boolean => {
		const left = mapAttestedDeviceProfile(a)
		const right = mapAttestedDeviceProfile(b)
		// Alias spellings (`model`/`deviceModelType`) normalize before comparing;
		// records that cannot name the hardware compare raw.
		if (left && right) {
			return (
				left.manufacturer === right.manufacturer &&
				left.deviceModelType === right.deviceModelType &&
				left.osVersion === right.osVersion
			)
		}
		const leftKeys = Object.keys(a).sort()
		const rightKeys = Object.keys(b).sort()
		if (leftKeys.length !== rightKeys.length) return false
		return leftKeys.every((key, index) => key === rightKeys[index] && a[key] === b[key])
	}
	const capturedAttestationProvider = async (
		context: NativeAndroidRegistrationBridgeContext
	): Promise<NativeAndroidRegistrationBridgeAttestation> => {
		// Guaranteed by the profile validation above: only the `device` profile
		// ever wraps a provider, and that profile requires one.
		const attestation = await options.attestationProvider!(context)
		const reported = attestation.deviceProfile
		if (reported) {
			if (!attestedDeviceProfile) attestedDeviceProfile = reported
			else if (!sameAttestedDeviceProfile(attestedDeviceProfile, reported)) {
				throw new Boom('native_android registration: attested device profile diverged mid-registration', {
					statusCode: 500,
					data: { step: 'device-profile-divergence' }
				})
			}
		}
		// Last proof per endpoint (audit gap F): the step log correlates the
		// response with the exact attestation that signed its request.
		if (attestation.attestation) stepProofs.set(context.endpoint, attestation.attestation)
		return attestation
	}

	/** Persisted profile merged with the attested hardware (attested fields win). */
	const mergedDeviceProfile = (): NativeAndroidDeviceProfile | undefined => {
		const persisted = options.nativeIdentity?.device
		const attested = mapAttestedDeviceProfile(attestedDeviceProfile)
		if (!persisted) return undefined
		return attested ? { ...persisted, ...attested } : persisted
	}

	/**
	 * One allowlisted correlation line per registration step (audit gap F):
	 * status/reason, the block-screen digest and the material/proof digests —
	 * never bodies, screens, creds or provider results. `safeRegistrationLog`
	 * re-validates every field, so hostile server/device tokens can only be
	 * dropped here, never leak or throw.
	 */
	const logRegistrationStep = (
		step: string,
		endpoint: NativeAndroidRegistrationEndpoint,
		http: { status: number; attempts: number },
		startedAt: number,
		response: unknown
	): void => {
		const gate = parseNativeAndroidRegistrationBlockGate(response)
		const proof = stepProofs.get(endpoint)
		const blockScreenHash = registrationBlockScreenHash(gate.customBlockScreen)
		const line = safeRegistrationLog({
			endpoint,
			operationId: 'native-android-registration',
			phase: step,
			attempts: http.attempts,
			durationMs: Date.now() - startedAt,
			httpStatus: http.status,
			status: gate.status,
			...(gate.reason !== null ? { reason: gate.reason } : {}),
			...(blockScreenHash !== undefined ? { blockScreenHash } : {}),
			...(materialHash !== undefined ? { materialHash } : {}),
			...(proof?.signatureHash !== undefined ? { proofHash: proof.signatureHash } : {}),
			...(proof?.attestedPackage != null ? { attestedPackage: proof.attestedPackage } : {}),
			...(typeof proof?.challengeAgeMs === 'number' ? { challengeAgeMs: proof.challengeAgeMs } : {}),
			...(proof?.packageNameMatches !== undefined ? { packageNameMatches: proof.packageNameMatches } : {}),
			...(proof?.signingCertMatches !== undefined ? { signingCertMatches: proof.signingCertMatches } : {})
		})
		// An attested install identity that does not name the registration
		// material is the server's "Baixe o app oficial" trigger waiting to
		// happen — surface it at warn level so it is visible without debug.
		const identityDiverged =
			proof != null && (proof.packageNameMatches === false || proof.signingCertMatches === false)
		if (identityDiverged) logger.warn(line, 'native_android registration step')
		else logger.debug(line, 'native_android registration step')
	}

	const digits = `${common.countryCallingCode}${common.nationalNumber}`
	const client = createNativeAndroidRegistrationHttpClient(
		{
			...options.http,
			appVariant: common.appVariant === 'business' ? 'business' : 'consumer',
			phoneNumber: digits,
			login: common.login ?? `${digits}@s.whatsapp.net`,
			registrationType: common.registrationType
		},
		attestationProfile === 'device' ? capturedAttestationProvider : undefined
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
	// Funnel UA is lazy (audit gap D): events sent after the first attestation
	// name the TEE-reported hardware; earlier ones fall back to the persisted
	// profile. The attested fields always win (`atestado ?? persistido`).
	const funnelUserAgent = (): string | undefined => {
		const profile = mapAttestedDeviceProfile(attestedDeviceProfile) ?? options.nativeIdentity?.device
		return profile
			? buildNativeAndroidRegistrationUserAgent(
					profile,
					common.appVariant === 'business' ? 'business' : 'consumer',
					announcedAppVersion
				)
			: undefined
	}
	// Unattested profile: the Play Integrity legs are dropped from every
	// environment map — the JWS minted by another application is the shape the
	// server rejects ("Baixe o app oficial"), and the unattested profile has no
	// official-app material to replay (see
	// NATIVE_ANDROID_REGISTRATION_ATTESTATION_ENV_KEYS). Telemetry (mcc/mnc/
	// sim/ram/pid/…) stays exactly as collected. The `device` profile keeps the
	// whole map: its provider minted the artifacts. `gpiaMaterial` (the official
	// wamsys blob, captured) is re-applied after the sanitize in both profiles —
	// 2026-10-11 wire experiment: that blob is what unblocks /v2/code.
	const flowEnvironment = (environment?: NativeAndroidRequestCodeEnvironment) => {
		const base =
			attestationProfile === 'unattested'
				? sanitizeNativeAndroidRegistrationEnvironment(environment)
				: environment
		if (options.gpiaMaterial === undefined) return base
		return { ...(base ?? {}), gpia: options.gpiaMaterial }
	}
	const funnelOptions = () => {
		const userAgent = funnelUserAgent()
		const environment = flowEnvironment(options.environment)
		return {
			accessSessionId: funnelAccessSessionId,
			...(options.advertisingId ? { advertisingId: options.advertisingId } : {}),
			...(environment ? { environment } : {}),
			...(userAgent ? { userAgent } : {})
		}
	}
	// The unattested profile has no provider to seal and sign, so the flow
	// seals the body itself (whalibmob `encryptPayload` + `sendEncrypted` over
	// `EMPTY_BODY`): `ENC=` only — never `&H=`, never `Authorization`. The
	// `device` profile leaves the request alone: its provider seals, signs and
	// supplies the User-Agent. Funnel requests are sealed by their own builders
	// and never pass through here.
	const wireRequest = (request: NativeAndroidRegistrationRequest): NativeAndroidRegistrationRequest => {
		if (attestationProfile !== 'unattested') return request
		const wire = buildNativeAndroidRegistrationWireBody(request.body, options.envelopeMaterial)
		return {
			...request,
			body: wire.body,
			sendAttestationPayload: false,
			userAgent: request.userAgent ?? funnelUserAgent()
		}
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
			funnelOptions()
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
			funnelOptions()
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
				environment: flowEnvironment(options.environment)
			})
			const abpropStartedAt = Date.now()
			const abpropHttp = await client(wireRequest(abpropRequest))
			logRegistrationStep('abprop', '/v2/reg_onboard_abprop', abpropHttp, abpropStartedAt, abpropHttp.body)
			await sendClientFunnel('enter_number', 'exist_check', 'exist_attempt')
			const existRequest = buildNativeAndroidExistRequest(common, {
				environment: flowEnvironment(options.environment),
				advertisingId: options.advertisingId,
				clientMetrics: options.onboardClientMetrics
			})
			const existStartedAt = Date.now()
			const existHttp = await client(wireRequest(existRequest))
			logRegistrationStep('exist', '/v2/exist', existHttp, existStartedAt, existHttp.body)
			// `exist_success` means the identity is fresh (`reason: incorrect`),
			// the state that lets the client proceed to /v2/code;
			// `exist_failure` means the server found it already registered (or
			// blocked). Only `incorrect` counts as fresh — any other outcome is
			// a failure, never a silent success (audit gap E).
			const existGate = parseNativeAndroidRegistrationBlockGate(existHttp.body)
			const existFresh = existGate.reason === 'incorrect'
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
		deviceProfile: mergedDeviceProfile,
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
					// A server-side block stops the flow BEFORE /v2/code (audit gap E):
					// the APK renders `custom_block_screen` verbatim and never hammers
					// the endpoint while blocked. A hard fail with a non-fresh reason
					// stops too; `reason: 'incorrect'` (fresh identity) and `status:
					// 'ok'` continue. The screen is preserved in the error data so the
					// caller can render exactly what the server sent.
					const gate = parseNativeAndroidRegistrationBlockGate(result.response)
					const blockedByReason = gate.status === 'fail' && gate.reason !== null && gate.reason !== 'incorrect'
					if (gate.customBlockScreen || blockedByReason) {
						throw new Boom(`registration blocked at ${step}`, {
							statusCode: 403,
							data: {
								step,
								endpoint: step === 'abprop' ? '/v2/reg_onboard_abprop' : '/v2/exist',
								status: gate.status,
								reason: gate.reason,
								customBlockScreen: gate.customBlockScreen
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
				environment: flowEnvironment(input.environment ?? options.environment)
			})
			const codeStartedAt = Date.now()
			const http = await client(wireRequest(request))
			logRegistrationStep('code', '/v2/code', http, codeStartedAt, http.body)
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
			// Attested hardware wins over the raffled fields (audit gap D): the
			// creds must name exactly the device the TEE-signed chain revealed.
			const device = mergedDeviceProfile() ?? deviceProfile

			const verifyScreen = lastRequestedMethod ? `verify_${lastRequestedMethod}` : 'enter_number'
			await sendClientFunnel(verifyScreen, 'submit_code', 'submit_code_attempt')
			const request = buildNativeAndroidRegisterRequest(common, {
				...input,
				authResponse: input.authResponse ?? pendingAuthChallenge
			})
			const registerStartedAt = Date.now()
			const http = await client(wireRequest(request))
			logRegistrationStep('register', '/v2/register', http, registerStartedAt, http.body)
			const response = parseNativeAndroidRegisterResponse(http.body)
			const creds =
				http.status >= 200 && http.status < 300 && response.status === 'ok'
					? buildPrimaryRegistrationAuthCreds({
							keys,
							common,
							register: response,
							account: options.account,
							device,
							appVersion: announcedAppVersion
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
