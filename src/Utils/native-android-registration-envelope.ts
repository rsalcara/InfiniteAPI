import { createCipheriv } from 'node:crypto'
import { Curve } from './crypto'

/**
 * Official registration body envelope (`ENC=`) from W4B 2.26.36.72
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
 *    URL_SAFE(8) | NO_WRAP(2) | NO_PADDING(1): base64url alphabet, no
 *    padding, no line wrap. The same flag mapping is proven by the classic
 *    `token` wire vector (flag 2 = NO_WRAP = padded standard, see
 *    native-android-registration-token.ts).
 * 6. Wire body = `ENC=` + enc; `H=` signs UTF-8(enc) and is appended as
 *    `&H=`. The param names are UPPERCASE: `BqN.A02`/`BqN.A03` resolve to
 *    `CDw.A05`/`CDw.A09`, XOR-0x12 obfuscated constants decoding to "ENC"
 *    and "H" (CDw.1.smali 323/339 + decoder A00). Lowercase `enc=`/`h=`
 *    reaches the server as body params it cannot see and surfaces as
 *    `missing_param` for the first required body parameter. Every endpoint
 *    seals: `DKX.A1W` is a constant `true` in 2.26.38.10 (the `isEncrypted`
 *    predicate of `RetryingHttpClient.A00`), so the plain query is only the
 *    APK's exception path ("encryption failed, using plain query string") —
 *    `buildNativeAndroidRegistrationWireBody` mirrors that: seal with the
 *    built-in server key by default, fall back only when the seal throws.
 */

export type NativeAndroidRegistrationEnvelopeMaterial = {
	/** Static server X25519 public key (`BpZ.A00.value`), 32 bytes. */
	serverPublicKey: Uint8Array
}

/**
 * The official server key, byte-identical across the APK `H8U.A00` literal
 * (consumer 2.26.38.10/2.26.37.6), `AbstractC34152F0o.A00` (2.26.37.6) and
 * whalibmob `constants.js` `REGISTRATION_PUBLIC_KEY`. It is a protocol
 * constant — same for every device and number — so the motor carries it and
 * the envelope needs no external material.
 */
export const NATIVE_ANDROID_REGISTRATION_SERVER_PUBLIC_KEY: Uint8Array = Uint8Array.from([
	0x8e, 0x8c, 0x0f, 0x74, 0xc3, 0xeb, 0xc5, 0xd7, 0xa6, 0x86, 0x5c, 0x6c, 0x3c, 0x84, 0x38, 0x56,
	0xb0, 0x61, 0x21, 0xcc, 0xe8, 0xea, 0x77, 0x4d, 0x22, 0xfb, 0x6f, 0x12, 0x25, 0x12, 0x30, 0x2d
])

export const nativeAndroidRegistrationDefaultEnvelopeMaterial = (): NativeAndroidRegistrationEnvelopeMaterial => ({
	serverPublicKey: NATIVE_ANDROID_REGISTRATION_SERVER_PUBLIC_KEY
})

export type NativeAndroidRegistrationWireBody = {
	/** Body to POST before the `&H=` suffix: `ENC=...` or the plain query. */
	body: string
	/** Exact UTF-8 bytes `H=` signs: the bare enc value, or the plain query. */
	payloadToSign: Uint8Array
	/** False on the APK's signed-plaintext fallback. */
	encrypted: boolean
}

/**
 * `Base64.encodeToString(bytes, 11)` semantics: flag 11 =
 * URL_SAFE | NO_WRAP | NO_PADDING (android.util.Base64), so the alphabet is
 * base64url (`-`/`_`) with no padding — the exact `ENC=`/`H=` wire form the
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
 * Builds the official `ENC=` envelope for one query. Throws when the material
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
	return { body: `ENC=${enc}`, payloadToSign: Buffer.from(enc, 'utf8'), encrypted: true }
}

/**
 * Full body protection exactly as the APK's request builder: seal with the
 * official server key (or the caller's material), fall back to the signed
 * plain query only when the seal throws — the APK's exception path. `H=` is
 * appended by `appendNativeAndroidRegistrationSignature` once the device-side
 * signature arrives.
 */
export const buildNativeAndroidRegistrationWireBody = (
	query: string,
	material?: NativeAndroidRegistrationEnvelopeMaterial
): NativeAndroidRegistrationWireBody => {
	try {
		return sealNativeAndroidRegistrationEnvelope(
			query,
			material ?? nativeAndroidRegistrationDefaultEnvelopeMaterial()
		)
	} catch {
		return { body: query, payloadToSign: Buffer.from(query, 'utf8'), encrypted: false }
	}
}

/** Appends the official `&H=` suffix once `H=` has been device-signed. */
export const appendNativeAndroidRegistrationSignature = (body: string, signature: Uint8Array): string =>
	`${body}&H=${encodeNativeAndroidRegistrationSignature(signature)}`
