import { createHmac } from 'node:crypto'

/**
 * Wamsys `gpia` blob — the value the official APK writes to the `gpia` field
 * of `/v2/code`. Shape pinned from the captured official material (2026-10-11
 * wire experiment, 399-char blob minted by `JniBridge`/wamsys inside the APK):
 *
 *   protobuf: field 1 (LEN, 231B) + field 3 (LEN, 63B)  →  299 bytes
 *   encoding: base64url WITHOUT padding                  →  399 chars
 *
 * Both sub-blobs start with `0x01` in every captured sample (a version/type
 * prefix; the rest is high-entropy opaque data). The registration server gates
 * on this exact shape: the same /v2/code request answers the app-identity
 * block ("Baixe o app oficial") for a missing `gpia` or for the Play Integrity
 * JWS (558-char dotted JWS), and answers the normal protocol for this blob.
 *
 * 2026-10-11 wire probes against v.whatsapp.net on a clean number also showed
 * the ECDSA half (field 3) is NOT validated: a byte-for-byte corrupted
 * signature over the real payload answers exactly like the real blob
 * (`no_routes`, i.e. past the gate). The signature exists as format, not as a
 * checked credential — which is what lets the engine MINT this artifact in
 * software (`mintWamsysGpiaBlob`) instead of replaying captured material.
 */

/** Opaque payload of protobuf field 1 (observed length in the official blob). */
export const NATIVE_ANDROID_GPIA_PAYLOAD_LENGTH = 231
/** Signature leg of protobuf field 3 (observed length in the official blob). */
export const NATIVE_ANDROID_GPIA_SIGNATURE_LENGTH = 63
/** Version/type byte both sub-blobs start with in every captured sample. */
export const NATIVE_ANDROID_GPIA_LEG_PREFIX = 0x01

export type NativeAndroidWamsysGpia = {
	payload: Uint8Array
	signature: Uint8Array
}

/** base64url WITHOUT padding — the exact alphabet the APK emits. */
const encodeGpiaBlob = (bytes: Uint8Array): string => Buffer.from(bytes).toString('base64url')

/**
 * Decodes a wamsys `gpia` blob into its two protobuf legs. Throws when the
 * shape is not the official one (wrong byte length, wrong field tags or wrong
 * leg lengths) so callers can never smuggle a foreign artifact (Play Integrity
 * JWS, truncated capture) into the field.
 */
export const parseWamsysGpiaBlob = (blob: string): NativeAndroidWamsysGpia => {
	const bytes = new Uint8Array(Buffer.from(blob, 'base64url'))
	if (bytes.length !== 299) {
		throw new Error(`wamsys gpia: expected 299 bytes, got ${bytes.length}`)
	}
	// field 1: tag 0x0A + length varint 231 = 0xE7 0x01 (two bytes).
	// field 3: tag 0x1A at offset 234 (3 header bytes + 231 payload), length
	// varint 63 = 0x3F (one byte).
	if (bytes[0] !== 0x0a || bytes[234] !== 0x1a) {
		throw new Error('wamsys gpia: unexpected protobuf field tags')
	}
	if (bytes[1] !== 0xe7 || bytes[2] !== 0x01 || bytes[235] !== 0x3f) {
		throw new Error('wamsys gpia: unexpected protobuf length prefix')
	}
	return {
		payload: bytes.slice(3, 3 + NATIVE_ANDROID_GPIA_PAYLOAD_LENGTH),
		signature: bytes.slice(3 + NATIVE_ANDROID_GPIA_PAYLOAD_LENGTH + 2)
	}
}

/**
 * Builds the blob back from its two legs. Inverse of {@link parseWamsysGpiaBlob}
 * (`build(parse(blob))` is byte-identical for any official blob).
 */
export const buildWamsysGpiaBlob = (gpia: NativeAndroidWamsysGpia): string => {
	const { payload, signature } = gpia
	if (payload.length !== NATIVE_ANDROID_GPIA_PAYLOAD_LENGTH) {
		throw new Error(`wamsys gpia: payload must be ${NATIVE_ANDROID_GPIA_PAYLOAD_LENGTH} bytes, got ${payload.length}`)
	}
	if (signature.length !== NATIVE_ANDROID_GPIA_SIGNATURE_LENGTH) {
		throw new Error(`wamsys gpia: signature must be ${NATIVE_ANDROID_GPIA_SIGNATURE_LENGTH} bytes, got ${signature.length}`)
	}
	const bytes = new Uint8Array(299)
	bytes[0] = 0x0a
	bytes[1] = 0xe7
	bytes[2] = 0x01
	bytes.set(payload, 3)
	bytes[234] = 0x1a
	bytes[235] = 0x3f
	bytes.set(signature, 236)
	return encodeGpiaBlob(bytes)
}

/**
 * Deterministic high-entropy expansion of a seed into `length` bytes.
 * Counter-mode HMAC-SHA512 (64-byte blocks) — stable across calls for the same
 * seed, unrelated across installs, matching the observed binding of the real
 * artifact (identical for the whole registration of one install, never seen
 * reused across devices).
 */
const expandSeed = (seed: Uint8Array, length: number, info: string): Uint8Array => {
	const out = new Uint8Array(length)
	let written = 0
	for (let counter = 0; written < length; counter++) {
		const block = createHmac('sha512', seed).update(`${info}:${counter}`).digest()
		const take = Math.min(block.length, length - written)
		out.set(block.subarray(0, take), written)
		written += take
	}
	return out
}

/**
 * Mints a wamsys `gpia` in software — no captured material, no external
 * attestor. Deterministic per seed: the same install identity always gets the
 * same blob (the real artifact behaves the same way within one registration),
 * and a different install never collides.
 *
 * Both legs carry the official `0x01` prefix followed by seed-derived opaque
 * bytes. Callers pass the install's persistent identity (e.g.
 * `fingerprintDeviceId` + `identityId`) as the seed.
 *
 * `payloadTemplate`, when given, pins field 1 to captured bytes instead of
 * derived ones (field 3 stays minted — the server never validates it). That is
 * the conservative mode while the payload-content probe is still open.
 */
export const mintWamsysGpiaBlob = (
	seed: Uint8Array,
	options?: { payloadTemplate?: Uint8Array }
): string => {
	if (seed.length === 0) {
		throw new Error('wamsys gpia: seed must not be empty')
	}
	const template = options?.payloadTemplate
	if (template && template.length !== NATIVE_ANDROID_GPIA_PAYLOAD_LENGTH) {
		throw new Error(
			`wamsys gpia: payload template must be ${NATIVE_ANDROID_GPIA_PAYLOAD_LENGTH} bytes, got ${template.length}`
		)
	}
	const payload = new Uint8Array(NATIVE_ANDROID_GPIA_PAYLOAD_LENGTH)
	if (template) {
		payload.set(template)
	} else {
		payload.set(expandSeed(seed, NATIVE_ANDROID_GPIA_PAYLOAD_LENGTH - 1, 'gpia-payload'), 1)
		payload[0] = NATIVE_ANDROID_GPIA_LEG_PREFIX
	}
	const signature = new Uint8Array(NATIVE_ANDROID_GPIA_SIGNATURE_LENGTH)
	signature.set(expandSeed(seed, NATIVE_ANDROID_GPIA_SIGNATURE_LENGTH - 1, 'gpia-signature'), 1)
	signature[0] = NATIVE_ANDROID_GPIA_LEG_PREFIX
	return buildWamsysGpiaBlob({ payload, signature })
}
