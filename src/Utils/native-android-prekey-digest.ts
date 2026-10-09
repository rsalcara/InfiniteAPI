import { createHash } from 'crypto'
import type { BinaryNode } from '../WABinary'
import { getBinaryNodeChild, getBinaryNodeChildren } from '../WABinary'

/**
 * Byte-level port of the official `<digest>` verification
 * (W4B 2.26.36.72 `RecvPreKeyMessageListener/onGetPreKeyDigest`, DT6.run —
 * the node shape is parsed in AbstractC37821ly.A02 case 1).
 *
 * The server answers `iq get xmlns=encrypt` with:
 *   <digest>
 *     <registration>4B BE</registration>   local registration id
 *     <type>1B</type>                       5 = KEY_BUNDLE_TYPE
 *     <skey><id>3B BE</id></skey>           current signed pre-key id
 *     <list><id>3B BE</id>…</list>          one-time prekey ids the server holds
 *     <hash>20B SHA1 | 32B SHA-256</hash>   digest of the stored key material
 *     [<pq_list><id>3B BE</id>…</pq_list>]
 *     [<pq_last_resort_key><id>3B BE</id></pq_last_resort_key>]
 *   </digest>
 *
 * Compare order exactly as DT6.run:
 *   1. `<registration>` vs local registration id          → A0O(5) on mismatch
 *   2. `<skey><id>` vs local signed pre-key id            → A0O(5) on mismatch
 *   3. every `<list>` id must exist in the local store    → A0O on missing key
 *   4. SHA1 over identityPub || skeyPub || skeySig
 *      || prekey pubs in SERVER-LIST order vs `<hash>`    → A0O(3) on mismatch
 *
 * Key bytes are the RAW 32-byte Curve publics (no 0x05 prefix): the official
 * hash input strips the Signal prefix (`C09320bg.A04` drops byte 0 of the
 * serialized key) and the register/upload wire values are raw 32 too
 * (`e_ident`/`e_skey_val`/`<value>`), so the server hashes the same bytes.
 *
 * PQ (Kyber) digests: when `<pq_last_resort_key>` is present the official
 * client switches to SHA-256 and appends the Kyber key material it holds.
 * The motor does not carry Kyber prekeys, so that digest cannot be
 * reproduced — it fails like the official missing-material path (A0O(5))
 * instead of silently passing an unverified hash.
 */

export type NativeAndroidPreKeyDigest = {
	type: number
	registrationId: number
	signedPreKeyId: number
	/** One-time prekey ids the server holds, decoded from 3-byte BE, in server order. */
	serverPreKeyIds: number[]
	/** 20-byte SHA1 digest, or 32-byte SHA-256 when the PQ variant is active. */
	hash: Uint8Array
	pqPreKeyIds: number[] | null
	pqLastResortKeyId: number | null
}

/** Local key material needed to reproduce the server digest. */
export type NativeAndroidPreKeyDigestLocalState = {
	registrationId: number
	signedPreKeyId: number
	/** Raw 32-byte Signal identity public (`creds.signedIdentityKey.public`). */
	identityPublicKey: Uint8Array
	/** Raw 32-byte signed pre-key public (`creds.signedPreKey.keyPair.public`). */
	signedPreKeyPublic: Uint8Array
	signedPreKeySignature: Uint8Array
	/** Local one-time prekeys by id → raw 32-byte public. */
	preKeys: ReadonlyMap<number, Uint8Array>
}

export type NativeAndroidPreKeyDigestFailure = {
	ok: false
	/**
	 * DT6 failure taxonomy (C08 acceptance: registro=5; signed/type/key ausente/hash=3):
	 * 'registration-mismatch' = A0O(5); 'signed-pre-key-mismatch' |
	 * 'missing-local-pre-key' | 'hash-mismatch' = A0O(3).
	 */
	reason:
		| 'malformed-digest'
		| 'registration-mismatch'
		| 'signed-pre-key-mismatch'
		| 'missing-local-pre-key'
		| 'hash-mismatch'
		| 'unsupported-pq-digest'
	/** Argument of the official `A0O(int)` re-upload trigger for this failure. */
	officialCode: number
	detail?: Record<string, unknown>
}

export type NativeAndroidPreKeyDigestVerdict = { ok: true } | NativeAndroidPreKeyDigestFailure

const KEY_BUNDLE_TYPE = 5
const DIGEST_SHA1_LENGTH = 20
const DIGEST_SHA256_LENGTH = 32

const hasPqLastResortKey = (pqLastResortKeyId: number | null): boolean => pqLastResortKeyId !== null

const nodeBytes = (node: BinaryNode | undefined): Uint8Array | null => {
	const content = node?.content
	if (Buffer.isBuffer(content) || content instanceof Uint8Array) return content
	return null
}

const decodeBigEndian = (bytes: Uint8Array): number => {
	let value = 0
	for (const byte of bytes) value = value * 256 + byte
	return value
}

/**
 * Parses the `<digest>` children exactly like AbstractC37821ly.A02 case 1:
 * mandatory `registration`/`type`/`skey/id`/`list`/`hash`, optional
 * `pq_list`/`pq_last_resort_key`. Returns `null` when a mandatory child is
 * missing or a fixed-width field has the wrong length (the official parser
 * throws in the same cases).
 */
export const parseNativeAndroidPreKeyDigestNode = (
	digestNode: BinaryNode | undefined
): NativeAndroidPreKeyDigest | null => {
	if (!digestNode) return null

	const registration = nodeBytes(getBinaryNodeChild(digestNode, 'registration'))
	const type = nodeBytes(getBinaryNodeChild(digestNode, 'type'))
	const signedPreKeyIdBytes = nodeBytes(getBinaryNodeChild(getBinaryNodeChild(digestNode, 'skey'), 'id'))
	const hash = nodeBytes(getBinaryNodeChild(digestNode, 'hash'))
	if (registration?.length !== 4) return null
	if (type?.length !== 1) return null
	if (signedPreKeyIdBytes?.length !== 3) return null

	const listNode = getBinaryNodeChild(digestNode, 'list')
	if (!listNode) return null
	const serverPreKeyIds: number[] = []
	for (const entry of getBinaryNodeChildren(listNode, 'id')) {
		const bytes = nodeBytes(entry)
		if (bytes?.length !== 3) return null
		serverPreKeyIds.push(decodeBigEndian(bytes))
	}

	const pqListNode = getBinaryNodeChild(digestNode, 'pq_list')
	let pqPreKeyIds: number[] | null = null
	if (pqListNode) {
		pqPreKeyIds = []
		for (const entry of getBinaryNodeChildren(pqListNode, 'id')) {
			const bytes = nodeBytes(entry)
			if (bytes?.length !== 3) return null
			pqPreKeyIds.push(decodeBigEndian(bytes))
		}
	}

	const pqLastResortNode = getBinaryNodeChild(digestNode, 'pq_last_resort_key')
	let pqLastResortKeyId: number | null = null
	if (pqLastResortNode) {
		const bytes = nodeBytes(getBinaryNodeChild(pqLastResortNode, 'id'))
		if (bytes?.length !== 3) return null
		pqLastResortKeyId = decodeBigEndian(bytes)
	}

	// DT6 reads 20 bytes from `<hash>` when no `pq_last_resort_key` is present
	// and 32 when it is — the digest variant is decided by that node.
	const expectedHashLength = hasPqLastResortKey(pqLastResortKeyId) ? DIGEST_SHA256_LENGTH : DIGEST_SHA1_LENGTH
	if (hash?.length !== expectedHashLength) return null

	return {
		type: decodeBigEndian(type),
		registrationId: decodeBigEndian(registration),
		signedPreKeyId: decodeBigEndian(signedPreKeyIdBytes),
		serverPreKeyIds,
		hash,
		pqPreKeyIds,
		pqLastResortKeyId
	}
}

/**
 * SHA1 (classic variant) over
 * `identityPub || skeyPub || skeySig || prekeyPub…` in SERVER-LIST order —
 * the exact `MessageDigest.update` sequence of DT6. Raw 32-byte key material
 * on both sides (see module doc).
 */
export const computeNativeAndroidPreKeyDigestHash = (
	state: NativeAndroidPreKeyDigestLocalState,
	serverPreKeyIds: readonly number[]
): Uint8Array => {
	const md = createHash('sha1')
	md.update(state.identityPublicKey)
	md.update(state.signedPreKeyPublic)
	md.update(state.signedPreKeySignature)
	for (const id of serverPreKeyIds) {
		const pub = state.preKeys.get(id)
		if (!pub) {
			throw new Error(`native_android: prekey ${id} missing from local store while hashing digest`)
		}

		md.update(pub)
	}

	return md.digest()
}

/**
 * Content compare of the server digest against local key material (DT6).
 * Every failure means the same thing as the official `A0O(int)` path: the
 * server's view of our keys diverged, so keys are marked unsent and the
 * upload batches run again.
 */
export const verifyNativeAndroidPreKeyDigest = (
	digest: NativeAndroidPreKeyDigest | null,
	state: NativeAndroidPreKeyDigestLocalState
): NativeAndroidPreKeyDigestVerdict => {
	if (!digest) {
		return { ok: false, reason: 'malformed-digest', officialCode: 12 }
	}

	if (digest.type !== KEY_BUNDLE_TYPE) {
		// DT6 gates the whole compare on the bundle type byte; anything else
		// falls straight into the A0O re-upload path.
		return { ok: false, reason: 'malformed-digest', officialCode: 3, detail: { type: digest.type } }
	}

	if (digest.registrationId !== state.registrationId) {
		return {
			ok: false,
			reason: 'registration-mismatch',
			officialCode: 5,
			detail: { server: digest.registrationId, local: state.registrationId }
		}
	}

	if (digest.signedPreKeyId !== state.signedPreKeyId) {
		return {
			ok: false,
			reason: 'signed-pre-key-mismatch',
			officialCode: 3,
			detail: { server: digest.signedPreKeyId, local: state.signedPreKeyId }
		}
	}

	for (const id of digest.serverPreKeyIds) {
		if (!state.preKeys.has(id)) {
			return { ok: false, reason: 'missing-local-pre-key', officialCode: 3, detail: { preKeyId: id } }
		}
	}

	if (hasPqLastResortKey(digest.pqLastResortKeyId)) {
		// The official hash adds the Kyber material when `pq_last_resort_key`
		// is present. The motor holds no Kyber keys and cannot reproduce it —
		// fail like the official missing-material path rather than compare a
		// hash we cannot compute.
		return {
			ok: false,
			reason: 'unsupported-pq-digest',
			officialCode: 5,
			detail: { pqLastResortKeyId: digest.pqLastResortKeyId, pqPreKeyCount: digest.pqPreKeyIds?.length ?? 0 }
		}
	}

	const computed = computeNativeAndroidPreKeyDigestHash(state, digest.serverPreKeyIds)
	if (computed.length !== digest.hash.length || !Buffer.from(computed).equals(Buffer.from(digest.hash))) {
		return { ok: false, reason: 'hash-mismatch', officialCode: 3 }
	}

	return { ok: true }
}
