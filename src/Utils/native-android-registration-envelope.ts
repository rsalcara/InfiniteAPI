import { createCipheriv } from 'node:crypto'
import { Curve } from './crypto'

/**
 * Official registration body envelope (`enc=`) from W4B 2.26.36.72
 * `RetryingHttpClient` (smali 2235833-2235869), reproduced 1:1:
 *
 * 1. Fresh X25519 ephemeral key pair (`Avp.A01()`).
 * 2. ECDH against the static server public key (`Avo.$new(BpZ.A00.value, 5)`
 *    -> 32-byte Curve25519 material) yields a 32-byte AES key.
 * 3. AES-256-GCM over the UTF-8 query with a 12-byte ZERO IV: the APK passes
 *    an unfilled byte array to `GCMParameterSpec(128, iv)`. A random IV makes
 *    the server-side decrypt fail as `missing_param` for the first required
 *    body parameter. The 16-byte GCM tag is appended by `Cipher.doFinal`.
 * 4. combined = ephemeral public key WITHOUT the leading 0x05 Curve type byte
 *    (smali copies range [1, len)) || (ciphertext || tag).
 * 5. enc = `Base64.encodeToString(combined, 11)`. Android flag 11 is
 *    NO_PADDING(1) | NO_WRAP(2) | CRLF(8): standard alphabet, no padding, no
 *    line wrap. The same flag mapping is proven by the classic `token` wire
 *    vector (flag 2 = NO_WRAP = padded standard, see
 *    native-android-registration-token.ts).
 * 6. Wire body = `enc=` + enc; `h=` signs UTF-8(enc) and is appended as
 *    `&h=`; on any encryption failure the APK falls back to sending the plain
 *    query signed as-is — `buildNativeAndroidRegistrationWireBody` mirrors
 *    that fallback exactly.
 */

export type NativeAndroidRegistrationEnvelopeMaterial = {
	/** Static server X25519 public key (`BpZ.A00.value`), 32 bytes. */
	serverPublicKey: Uint8Array
}

export type NativeAndroidRegistrationWireBody = {
	/** Body to POST before the `&h=` suffix: `enc=...` or the plain query. */
	body: string
	/** Exact UTF-8 bytes `h=` signs: the bare enc value, or the plain query. */
	payloadToSign: Uint8Array
	/** False on the APK's signed-plaintext fallback. */
	encrypted: boolean
}

/**
 * `Base64.encodeToString(bytes, 11)` semantics: flag 11 =
 * URL_SAFE | NO_WRAP | NO_PADDING (android.util.Base64), so the alphabet is
 * base64url (`-`/`_`) with no padding — the exact `enc=`/`h=` wire form the
 * APK produces (hook.js 1174/1188).
 */
export const encodeNativeAndroidRegistrationSignature = (bytes: Uint8Array): string =>
	Buffer.from(bytes).toString('base64url')

/**
 * `Base64.encodeToString(bytes, 2)` semantics (NO_WRAP): standard alphabet
 * with padding — the Authorization key-chain encoding.
 */
export const encodeNativeAndroidRegistrationAuthorization = (bytes: Uint8Array): string =>
	Buffer.from(bytes).toString('base64')

/**
 * Builds the official `enc=` envelope for one query. Throws when the material
 * or crypto fails; callers wanting the APK's silent fallback use
 * `buildNativeAndroidRegistrationWireBody`.
 */
export const sealNativeAndroidRegistrationEnvelope = (
	query: string,
	material: NativeAndroidRegistrationEnvelopeMaterial
): NativeAndroidRegistrationWireBody => {
	if (material?.serverPublicKey?.length !== 32) {
		throw new Error('native_android registration envelope: serverPublicKey must be 32 bytes')
	}

	const ephemeral = Curve.generateKeyPair()
	const aesKey = Curve.sharedKey(ephemeral.private, material.serverPublicKey)
	const cipher = createCipheriv('aes-256-gcm', aesKey, new Uint8Array(12))
	const queryBytes = Buffer.from(query, 'utf8')
	const cipherText = Buffer.concat([cipher.update(queryBytes), cipher.final(), cipher.getAuthTag()])
	const combined = Buffer.concat([Buffer.from(ephemeral.public), cipherText])
	const enc = encodeNativeAndroidRegistrationSignature(combined)
	return { body: `enc=${enc}`, payloadToSign: Buffer.from(enc, 'utf8'), encrypted: true }
}

/**
 * Full body protection exactly as the APK's request builder: try the envelope,
 * fall back to the signed plain query on any failure. `h=` is appended by
 * `appendNativeAndroidRegistrationSignature` once the device-side signature
 * arrives.
 */
export const buildNativeAndroidRegistrationWireBody = (
	query: string,
	material?: NativeAndroidRegistrationEnvelopeMaterial
): NativeAndroidRegistrationWireBody => {
	try {
		if (!material) throw new Error('native_android registration envelope: material is required')
		return sealNativeAndroidRegistrationEnvelope(query, material)
	} catch {
		return { body: query, payloadToSign: Buffer.from(query, 'utf8'), encrypted: false }
	}
}

/** Appends the official `&h=` suffix once `h=` has been device-signed. */
export const appendNativeAndroidRegistrationSignature = (body: string, signature: Uint8Array): string =>
	`${body}&h=${encodeNativeAndroidRegistrationSignature(signature)}`
