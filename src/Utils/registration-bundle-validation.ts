import * as curve from 'libsignal/src/curve'
import { generateSignalPubKey } from './crypto'
import { assertBytes, assertInteger, assertPrimaryRegistrationId, assertX25519Pair } from './identity-invariants'
import type { NativeAndroidRegistrationSignalKeys } from './native-android-registration-keys'

/**
 * `Curve.verify` (crypto.ts) only reports thrown errors, but the vendored
 * libsignal `verifySignature` returns `false` instead of throwing (curve.js
 * `return isInit ? true : curveJs.verify(...)`), so that helper accepts every
 * well-formed signature. The registration bundle must really verify, so the
 * returned boolean is evaluated here. Correcting the shared helper is not part
 * of PR #8: the noise handshake and the pair-success ADV check consume it.
 */
const verifySignedPreKeySignature = (
	identityPublic: Uint8Array,
	message: Uint8Array,
	signature: Uint8Array
): boolean => {
	try {
		return curve.verifySignature(generateSignalPubKey(identityPublic), message, signature) === true
	} catch {
		return false
	}
}

/**
 * Audit module M09 (`registration-bundle-validation.ts`, dossier manifest
 * sha-256 13181130…): fail-closed validation of the device-0 Signal bundle,
 * before any request is built or any restored key material is used.
 */
export function validatePrimaryRegistrationBundle(keys: NativeAndroidRegistrationSignalKeys): void {
	assertX25519Pair(keys.clientStaticKeyPair, 'auth key')
	assertX25519Pair(keys.identity, 'Signal identity')
	assertX25519Pair(keys.signedPreKey.keyPair, 'signed prekey')
	assertPrimaryRegistrationId(keys.registrationId)
	assertInteger(keys.signedPreKey.keyId, 1, 0xffffff, 'signed prekey id')
	assertBytes(keys.signedPreKey.signature, 64, 'signed prekey signature')
	if (
		!verifySignedPreKeySignature(
			keys.identity.public,
			generateSignalPubKey(keys.signedPreKey.keyPair.public),
			keys.signedPreKey.signature
		)
	) {
		throw new Error('signed prekey signature does not match the Signal identity')
	}
}
