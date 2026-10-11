import type { NativeAndroidAppVersion, NativeAndroidDeviceProfile } from '../Types'
import type {
	NativeAndroidRegistrationBridgeAttestation,
	NativeAndroidRegistrationBridgeContext
} from './native-android-registration-bridge-provider'
import {
	appendNativeAndroidRegistrationSignature,
	buildNativeAndroidRegistrationWireBody,
	encodeNativeAndroidRegistrationAuthorization,
	type NativeAndroidRegistrationEnvelopeMaterial
} from './native-android-registration-envelope'

/**
 * Device-side signing the motor cannot reproduce in Node: the Android Keystore
 * attestation signature over the wire payload (in-APK `signer.A07`) and the
 * attestation key chain for the Authorization header (in-APK `signer.A03`).
 * A normal app on the device implements these with its Keystore key; the
 * private key never leaves the device.
 */
export type NativeAndroidRegistrationDeviceSigner = {
	/** Keystore signature over the exact bytes the body carries (enc value or plain query). */
	signPayload(payload: Uint8Array): Promise<Uint8Array>
	/**
	 * Attestation key chain (certificate list). The APK builds it AFTER the
	 * payload signature — the Keystore issuance state advances per operation —
	 * so providers must not pre-compute or cache the chain.
	 */
	buildAuthorization(): Promise<Uint8Array>
}

export type NativeAndroidRegistrationUserAgentParts = {
	/** `Build.VERSION.RELEASE`, e.g. `14`. */
	androidVersion: string
	/** `Build.MANUFACTURER`, e.g. `Google`. */
	manufacturer: string
	/** `Build.MODEL`, e.g. `Pixel 7`. */
	model: string
}

/**
 * Official client build of W4B 2.26.36.72. The app registers and logs in with
 * the SAME build, so a registration-seeded identity carries this version and
 * every later ClientPayload.userAgent.appVersion matches the registration
 * User-Agent byte for byte.
 */
export const NATIVE_ANDROID_REGISTRATION_APP_VERSION: NativeAndroidAppVersion = [2, 26, 36, 72]
/**
 * Official client build of the consumer APK (com.whatsapp 2.26.40.7). Pinned
 * to the SAME build the consumer token material comes from
 * (`assets/native-registration-token/consumer/`): the token is signed over
 * that build's `classes.dex`, so a User-Agent announcing another version
 * describes a different client than the one the token proves and the server
 * answers `bad_token` ("a token that does not belong to the client sending
 * it"). Business keeps 2.26.36.72 for the same reason — that is the build its
 * material is read from and the pair that already registers.
 */
export const NATIVE_ANDROID_REGISTRATION_CONSUMER_APP_VERSION: NativeAndroidAppVersion = [2, 26, 40, 7]
/** Official client version embedded in the registration User-Agent. */
export const NATIVE_ANDROID_REGISTRATION_USER_AGENT_VERSION = NATIVE_ANDROID_REGISTRATION_APP_VERSION.join('.')
/** W4B platform token (`X.0d3.A00` uses the literal `SMBA`). */
export const NATIVE_ANDROID_REGISTRATION_USER_AGENT_PLATFORM = 'SMBA'

/**
 * The build a registration announces, per variant. Always the build the
 * variant's token material was extracted from — see the pairing note on
 * `NATIVE_ANDROID_REGISTRATION_CONSUMER_APP_VERSION`.
 */
export const nativeAndroidRegistrationAppVersion = (
	appVariant: 'consumer' | 'business' = 'business'
): NativeAndroidAppVersion =>
	appVariant === 'consumer'
		? NATIVE_ANDROID_REGISTRATION_CONSUMER_APP_VERSION
		: NATIVE_ANDROID_REGISTRATION_APP_VERSION

const sanitizeUserAgentPart = (value: string): string => value.replace(/[^,\.\w\-\(\)]/g, '_')

/**
 * Official registration User-Agent (`X.0d3.A00`, W4B 2.26.36.72):
 * `WhatsApp/2.26.36.72 SMBA/<release> Device/<manufacturer>-<model>`, each
 * device part sanitized with the APK's `[^,\.\w\-\(\)]` -> `_` rule. The
 * registration platform selector rejects requests without it. The consumer
 * build names itself `Android` (live native registration capture) — the
 * server reads the platform out of exactly this string.
 */
export const buildNativeAndroidRegistrationUserAgentFromParts = (
	parts: NativeAndroidRegistrationUserAgentParts,
	appVariant: 'consumer' | 'business' = 'business'
): string =>
	`WhatsApp/${nativeAndroidRegistrationAppVersion(appVariant).join('.')} ${appVariant === 'consumer' ? 'Android' : 'SMBA'}/${sanitizeUserAgentPart(
		parts.androidVersion
	)} Device/${sanitizeUserAgentPart(parts.manufacturer)}-${sanitizeUserAgentPart(parts.model)}`

/**
 * Builds the official User-Agent from the exact hardware profile the session
 * raffled (`createNativeAndroidDeviceProfile`), so the UA can never claim a
 * different model than the Build.* values the rest of the registration
 * reports: `osVersion` is `Build.VERSION.RELEASE`, `deviceModelType` is
 * `Build.MODEL`.
 */
export const buildNativeAndroidRegistrationUserAgent = (
	profile: Pick<NativeAndroidDeviceProfile, 'manufacturer' | 'deviceModelType' | 'osVersion'>,
	appVariant: 'consumer' | 'business' = 'business'
): string =>
	buildNativeAndroidRegistrationUserAgentFromParts(
		{
			// Missing Build.* fields fall back to "unknown", exactly like the APK's
			// NoSuchFieldError handling in X.0d3.A00.
			androidVersion: profile.osVersion ?? 'unknown',
			manufacturer: profile.manufacturer ?? 'unknown',
			model: profile.deviceModelType ?? 'unknown'
		},
		appVariant
	)

export type NativeAndroidRegistrationDeviceAttestationOptions = {
	signer: NativeAndroidRegistrationDeviceSigner
	/**
	 * Static server key for the `ENC=` envelope. Omitted = the built-in official
	 * key (the APK seals every endpoint); the signed-plaintext fallback only
	 * happens when the seal throws.
	 */
	envelopeMaterial?: NativeAndroidRegistrationEnvelopeMaterial
	/**
	 * The exact profile the session raffled (`createNativeAndroidDeviceProfile`).
	 * The official User-Agent is derived from it so the wire UA always matches
	 * the Build.* values the registration reports.
	 */
	deviceProfile?: Pick<NativeAndroidDeviceProfile, 'manufacturer' | 'deviceModelType' | 'osVersion'>
	/** Explicit User-Agent override; takes precedence over `deviceProfile`. */
	userAgent?: string
}

/**
 * Self-computed attestation provider: the motor owns the protocol (token,
 * query, `ENC=` envelope) and the device contributes only the Keystore
 * signatures. Implements the same contract as the registration bridge
 * provider, so the flow can run with either one — the bridge stays optional
 * and is no longer required for token or envelope work.
 */
export const createNativeAndroidRegistrationDeviceAttestationProvider = (
	options: NativeAndroidRegistrationDeviceAttestationOptions
): ((context: NativeAndroidRegistrationBridgeContext) => Promise<NativeAndroidRegistrationBridgeAttestation>) => {
	if (!options?.signer?.signPayload || !options.signer.buildAuthorization) {
		throw new Error('native_android registration device attestation requires a device signer')
	}

	return async context => {
		const wire = buildNativeAndroidRegistrationWireBody(context.body, options.envelopeMaterial)
		const signature = await options.signer.signPayload(wire.payloadToSign)
		if (!(signature instanceof Uint8Array) || signature.length === 0) throw new Error('empty device signature')
		const body = appendNativeAndroidRegistrationSignature(wire.body, signature)
		// Official order: sign first, build the key chain afterwards
		// (smali 2235886-2235893).
		const keyChain = await options.signer.buildAuthorization()
		if (!(keyChain instanceof Uint8Array) || keyChain.length === 0) throw new Error('empty attestation chain')
		const userAgent =
			options.userAgent ??
			(options.deviceProfile
				? buildNativeAndroidRegistrationUserAgent(options.deviceProfile, context.appVariant)
				: undefined)
		if (!userAgent) throw new Error('registration User-Agent is required')
		return {
			authorization: encodeNativeAndroidRegistrationAuthorization(keyChain),
			body,
			...(userAgent ? { userAgent } : {})
		}
	}
}
