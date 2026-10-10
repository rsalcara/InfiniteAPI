import { randomBytes } from 'node:crypto'
import type { proto } from '../../WAProto/index.js'
import type { AuthenticationCreds, Contact, NativeAndroidDeviceProfile } from '../Types'
import { jidEncode } from '../WABinary/jid-utils'
import { Curve } from './crypto'
import { NATIVE_ANDROID_REGISTRATION_APP_VERSION } from './native-android-registration-device-attestation'
import {
	type NativeAndroidRegistrationSignalKeys,
	randomNativeAndroidPreKeyIdStart
} from './native-android-registration-keys'
import type { NativeAndroidRegistrationCommon } from './native-android-registration-protocol'
import type { NativeAndroidRegisterResponse } from './native-android-registration-response'
import { getNativeAndroidAppIdentity } from './native-android-transport'
import { validatePrimaryRegistrationBundle } from './registration-bundle-validation'

export type NativeAndroidPrimaryRegistrationAuthInput = {
	/**
	 * The exact device-0 Signal material uploaded at /v2/code. The APK keeps
	 * these same keys for the account: `authkey` is not a throwaway registration
	 * key but the client static half of the Noise IK handshake, so the motor's
	 * `noiseKey` MUST be this key pair (see AuthKeyStore `X\C1CB`, which serves
	 * both the registration `authkey` and `ClientFinish.static_`).
	 */
	keys: NativeAndroidRegistrationSignalKeys
	/** Registration identity fields; the key bundle itself is not needed here. */
	common: Omit<NativeAndroidRegistrationCommon, 'keyBundle'>
	/** Parsed /v2/register response. Only `status: 'ok'` completes a registration. */
	register: NativeAndroidRegisterResponse
	/**
	 * ADV signed device identity, when one is already available. The primary
	 * registration response carries no cert blob; callers that obtain the
	 * identity through another official path pass it here so it is persisted
	 * with the creds in one step.
	 */
	account?: proto.IADVSignedDeviceIdentity
	/**
	 * Hardware profile raffled for this registration. The full
	 * `nativeAndroidIdentity` is seeded with the creds, so every later login
	 * reuses exactly the app identity (clientAppId/appVersion) and device the
	 * registration declared — the official app registers and logs in as the
	 * same install. Required: without it the session would come out of
	 * registration unmarked and be classified as non-primary (audit A06).
	 */
	device: NativeAndroidDeviceProfile
}

/**
 * Normalizes the server's `lid` value into the engine's LID JID form
 * (`digits@lid`). Accepts the bare digits as well as already-formed JIDs with
 * or without a device suffix; anything non-numeric yields undefined instead of
 * a malformed JID.
 */
export const normalizeLidJid = (raw: string | null | undefined): string | undefined => {
	if (!raw) return undefined
	const bare = raw.split('@')[0]!.split(':')[0]!.trim()
	return /^\d+$/.test(bare) ? jidEncode(bare, 'lid') : undefined
}

/**
 * Builds the motor's `AuthenticationCreds` from a completed primary
 * phone-number registration — the local equivalent of the APK writing its
 * AuthKeyStore + me-state after a successful /v2/register.
 *
 * Semantics taken from the APK:
 * - `noiseKey` IS the registration `clientStaticKeyPair` (same-key model).
 * - `signedIdentityKey`/`signedPreKey`/`registrationId` are the registered
 *   Signal material; the signed pre-key signature already covers the Signal
 *   (0x05-prefixed) form, matching the uploaded `e_skey_sig`.
 * - `routingInfo` comes from `edge_routing_info`; the APK's Kotlin parser
 *   discards it because the native layer learns routing from the XMPP
 *   `edge_routing` notification, but the motor keeps it so the first connect
 *   can route even if that notification never fires.
 * - `pairingEphemeralKeyPair` and `advSecretKey` are fresh, exactly like
 *   `initAuthCreds()`: they belong to future companion pairing, never to the
 *   phone registration itself.
 */
export const buildPrimaryRegistrationAuthCreds = ({
	keys,
	common,
	register,
	account,
	device
}: NativeAndroidPrimaryRegistrationAuthInput): AuthenticationCreds => {
	// Fail-closed (audit M09): restored key material must be a valid bundle
	// before any cred is derived from it or any request echoes it back.
	validatePrimaryRegistrationBundle(keys)

	if (register.status !== 'ok') {
		throw new Error(
			`native_android registration: cannot build auth state from a /v2/register status of "${register.status}"` +
				(register.reason ? ` (reason: ${register.reason})` : '')
		)
	}

	const digits = `${common.countryCallingCode}${common.nationalNumber}`
	if (!/^\d{5,15}$/.test(digits)) {
		throw new Error('native_android registration: countryCallingCode + nationalNumber must yield the account digits')
	}

	// Fail-closed (audit A06): without a persisted device profile the session
	// would leave registration without `nativeAndroidIdentity`/`registrationSeeded`
	// and be misclassified as non-primary on every later connect.
	if (!device) {
		throw new Error('primary registration requires a persisted device profile')
	}

	// The official primary `me` is the bare account JID (device-0 is implicit);
	// the login builder writes ClientPayload.device_ = 0 explicitly, which the
	// engine mirrors in generateLoginNode (`device ?? 0`).
	const me: Contact = { id: jidEncode(digits, 's.whatsapp.net') }
	const lid = normalizeLidJid(register.lid)
	if (lid) me.lid = lid

	// Two independent draws, exactly like C10890eL.A02: `next_prekey_id` and the
	// signed pre-key id are both `nextInt(16777214) + 1`.
	const preKeyIdStart = randomNativeAndroidPreKeyIdStart()

	const appVariant = common.appVariant === 'business' ? ('business' as const) : ('consumer' as const)
	const nativeAndroidIdentity = {
		schemaVersion: 1 as const,
		profile: 'native_android' as const,
		preset: appVariant === 'consumer' ? ('native_android_consumer' as const) : ('native_android_business' as const),
		appVariant,
		clientAppId: getNativeAndroidAppIdentity(appVariant).clientAppId,
		// The official app registers and logs in with the same build, so the
		// seeded identity pins the registration version for every login.
		appVersion: NATIVE_ANDROID_REGISTRATION_APP_VERSION,
		device,
		connectionLc: 0,
		registrationSeeded: true,
		// APK pref `signal_protocol_store_is_new`, set when the Signal
		// identity is created and cleared only after the pre-key batches
		// are uploaded (see CYF/DSQ in W4B 2.26.36.72).
		signalProtocolStoreIsNew: true,
		loginsWithMessages: 0
	}

	return {
		noiseKey: keys.clientStaticKeyPair,
		pairingEphemeralKeyPair: Curve.generateKeyPair(),
		signedIdentityKey: keys.identity,
		signedPreKey: keys.signedPreKey,
		registrationId: keys.registrationId,
		advSecretKey: randomBytes(32).toString('base64'),
		me,
		account,
		firstUnuploadedPreKeyId: preKeyIdStart,
		nextPreKeyId: preKeyIdStart,
		processedHistoryMessages: [],
		accountSyncCounter: 0,
		accountSettings: {
			unarchiveChats: false
		},
		platform: appVariant === 'business' ? 'smba' : 'android',
		registered: true,
		pairingCode: undefined,
		lastPropHash: undefined,
		routingInfo: register.edgeRoutingInfo ? Buffer.from(register.edgeRoutingInfo, 'base64') : undefined,
		additionalData: undefined,
		nativeAndroidIdentity
	}
}
