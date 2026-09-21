import type { KeyPair } from '../Types'
import { Curve, signedKeyPair } from './crypto'
import { encodeBigEndian, generateRegistrationId } from './generics'

export type NativeAndroidRegistrationSignalKeys = {
	/** X25519 client-static/auth key persisted separately by the APK. */
	clientStaticKeyPair: KeyPair
	identity: KeyPair
	signedPreKey: {
		keyId: number
		keyPair: KeyPair
		signature: Uint8Array
	}
	registrationId: number
}

export type NativeAndroidRegistrationKeyBundle = {
	authkey: Uint8Array
	e_ident: Uint8Array
	e_keytype: Uint8Array
	e_regid: Uint8Array
	e_skey_id: Uint8Array
	e_skey_val: Uint8Array
	e_skey_sig: Uint8Array
}

/**
 * Builds the Signal material used by the official phone-number registration
 * request. This is device-0 material: it is not a companion identity and must
 * never be mixed with an existing QR/pair-code auth state.
 */
export const createNativeAndroidRegistrationSignalKeys = (): NativeAndroidRegistrationSignalKeys => {
	const clientStaticKeyPair = Curve.generateKeyPair()
	const identity = Curve.generateKeyPair()
	const keyId = 1
	// signedKeyPair signs the 0x05-prefixed Signal form (`generateSignalPubKey`),
	// which is what W4B 2.26.36.72 stores in the signed pre-key protobuf.
	const signedPreKey = signedKeyPair(identity, keyId)

	const registrationId = generateRegistrationId()

	if (!signedPreKey.signature || signedPreKey.signature.byteLength === 0) {
		throw new Error('native_android registration: signed pre-key signature is unavailable')
	}

	if (registrationId <= 0 || registrationId > 0x3fff) {
		throw new Error('native_android registration: invalid Signal registration id')
	}

	return {
		clientStaticKeyPair,
		identity,
		signedPreKey: {
			keyId,
			keyPair: signedPreKey.keyPair,
			signature: Buffer.from(signedPreKey.signature)
		},
		registrationId
	}
}

/**
 * Mirrors `RegistrationKeyBundleHelper.addKeyBundleParams`: `CFQ.A00` in
 * WhatsApp Business 2.26.36.72. The APK takes `authkey` from the public half
 * of its persisted `client_static_keypair` (`C25561Bt.A0D().A02.A01`) and
 * `e_ident` from the Signal identity (`C25511Bo.A0c`). They are deliberately
 * distinct keys. The signed pre-key signature is mandatory; without it the
 * official client does not add a bundle.
 */
export const buildNativeAndroidRegistrationKeyBundle = ({
	clientStaticKeyPair,
	identity,
	signedPreKey,
	registrationId
}: NativeAndroidRegistrationSignalKeys): NativeAndroidRegistrationKeyBundle => {
	if (signedPreKey.signature.byteLength === 0) {
		throw new Error('native_android registration: signed pre-key signature is required')
	}

	return {
		authkey: clientStaticKeyPair.public,
		e_ident: identity.public,
		e_keytype: Uint8Array.from([5]),
		e_regid: encodeBigEndian(registrationId, 4),
		// W4B 2.26.36.72 serializes signed-pre-key IDs as 24-bit big endian
		// (`AbstractC36251jI.A04`), unlike the 32-bit registration ID.
		e_skey_id: encodeBigEndian(signedPreKey.keyId, 3),
		// Registration transmits the raw 32-byte Curve public key. The APK
		// strips the 0x05 Signal prefix (`C09200bT.A03/A04`) before CJT.A04.
		e_skey_val: signedPreKey.keyPair.public,
		e_skey_sig: signedPreKey.signature
	}
}
