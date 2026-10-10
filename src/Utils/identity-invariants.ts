import { createHash, createPrivateKey, createPublicKey, timingSafeEqual } from 'node:crypto'

/**
 * Audit module M01 (`identity-invariants.ts`, dossier manifest sha-256
 * b2424929…): mathematical validation, limits and challenge format for the
 * registration identity. Used at load time, before HTTP and at the wire
 * binding. X25519 alone does not verify Signal signatures — the signed
 * pre-key check lives in `registration-bundle-validation.ts` (M09).
 */
export type CurvePair = { public: Uint8Array; private: Uint8Array }

export type SavedChallenge = { encoding: 'base64url'; data: string }

export function assertBytes(value: unknown, size: number, label: string): asserts value is Uint8Array {
	if (!(value instanceof Uint8Array) || value.length !== size) throw new Error(`${label}: invalid byte length`)
}

export function assertInteger(value: unknown, min: number, max: number, label: string): asserts value is number {
	if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max) {
		throw new Error(`${label}: invalid integer`)
	}
}

/**
 * Verifies the pair is real X25519 material: the private half must derive the
 * public half (RFC 8410 PKCS#8 wrapper, zeroed after use).
 */
export function assertX25519Pair(pair: CurvePair, label: string): void {
	assertBytes(pair.public, 32, `${label}.public`)
	assertBytes(pair.private, 32, `${label}.private`)
	const der = Buffer.concat([Buffer.from('302e020100300506032b656e04220420', 'hex'), pair.private])
	try {
		const key = createPrivateKey({ key: der, format: 'der', type: 'pkcs8' })
		const spki = createPublicKey(key).export({ format: 'der', type: 'spki' })
		if (!timingSafeEqual(spki.subarray(-32), pair.public)) throw new Error(`${label}: public/private mismatch`)
	} finally {
		der.fill(0)
	}
}

export function publicKeyHash(value: Uint8Array): string {
	assertBytes(value, 32, 'public key')
	return createHash('sha256').update(value).digest('hex')
}

/**
 * The wire authkey must be the public half of the persisted registration
 * static key (C28938Clv.A00 / C1CB.A0D/A0I): registering one key and
 * connecting with another is a hard failure.
 */
export function assertRegistrationAuthBinding(pair: CurvePair, actualWirePublic: Uint8Array): void {
	assertX25519Pair(pair, 'registration auth')
	assertBytes(actualWirePublic, 32, 'wire authkey')
	if (!timingSafeEqual(pair.public, actualWirePublic))
		throw new Error('registration authkey differs from login static key')
}

/** 3-byte big-endian pre-key id, the `AbstractC36751jx` wire encoding. */
export function encodePreKeyId(id: number): Uint8Array {
	assertInteger(id, 1, 0xffffff, 'prekey id')
	return Uint8Array.of((id >>> 16) & 255, (id >>> 8) & 255, id & 255)
}

/** Official 31-bit range: `SecureRandom.nextInt(2147483646) + 1` (C10890eL). */
export function assertPrimaryRegistrationId(id: number): void {
	assertInteger(id, 1, 2147483646, 'primary registration id')
}

export function saveChallenge(raw: Uint8Array): SavedChallenge {
	if (!(raw instanceof Uint8Array) || raw.length === 0) throw new Error('empty challenge')
	return { encoding: 'base64url', data: Buffer.from(raw).toString('base64url') }
}

export function restoreChallenge(saved: SavedChallenge): Uint8Array {
	if (saved.encoding !== 'base64url' || !/^[A-Za-z0-9_-]+$/.test(saved.data))
		throw new Error('invalid challenge format')
	const raw = Buffer.from(saved.data, 'base64url')
	if (raw.length === 0 || raw.toString('base64url') !== saved.data) throw new Error('noncanonical challenge')
	return raw
}
