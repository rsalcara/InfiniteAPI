import { randomBytes } from 'node:crypto'
import type { proto } from '../../WAProto/index.js'
import type { AuthenticationCreds, Contact } from '../Types'
import { jidEncode } from '../WABinary/jid-utils'
import { Curve } from './crypto'
import type { NativeAndroidRegistrationSignalKeys } from './native-android-registration-keys'
import type { NativeAndroidRegistrationCommon } from './native-android-registration-protocol'
import type { NativeAndroidRegisterResponse } from './native-android-registration-response'

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
	account
}: NativeAndroidPrimaryRegistrationAuthInput): AuthenticationCreds => {
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

	const me: Contact = { id: jidEncode(digits, 's.whatsapp.net') }
	const lid = normalizeLidJid(register.lid)
	if (lid) me.lid = lid

	return {
		noiseKey: keys.clientStaticKeyPair,
		pairingEphemeralKeyPair: Curve.generateKeyPair(),
		signedIdentityKey: keys.identity,
		signedPreKey: keys.signedPreKey,
		registrationId: keys.registrationId,
		advSecretKey: randomBytes(32).toString('base64'),
		me,
		account,
		firstUnuploadedPreKeyId: 1,
		nextPreKeyId: 1,
		processedHistoryMessages: [],
		accountSyncCounter: 0,
		accountSettings: {
			unarchiveChats: false
		},
		platform: common.appVariant === 'business' ? 'smba' : 'android',
		registered: true,
		pairingCode: undefined,
		lastPropHash: undefined,
		routingInfo: register.edgeRoutingInfo ? Buffer.from(register.edgeRoutingInfo, 'base64') : undefined,
		additionalData: undefined
	}
}
