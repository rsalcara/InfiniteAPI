import { createHash } from 'node:crypto'
import { Curve } from '../../Utils/crypto'
import {
	assertBytes,
	assertInteger,
	assertPrimaryRegistrationId,
	assertRegistrationAuthBinding,
	assertX25519Pair,
	encodePreKeyId,
	publicKeyHash,
	restoreChallenge,
	saveChallenge
} from '../../Utils/identity-invariants'

describe('identity-invariants (audit M01)', () => {
	it('accepts exact-size Uint8Array and Buffer values', () => {
		expect(() => assertBytes(new Uint8Array(32), 32, 'k')).not.toThrow()
		expect(() => assertBytes(Buffer.alloc(32), 32, 'k')).not.toThrow()
	})

	it('rejects wrong sizes and non-byte values', () => {
		expect(() => assertBytes(new Uint8Array(31), 32, 'k')).toThrow('k: invalid byte length')
		expect(() => assertBytes(undefined, 32, 'k')).toThrow('k: invalid byte length')
		expect(() => assertBytes('x'.repeat(32), 32, 'k')).toThrow('k: invalid byte length')
	})

	it('enforces integer bounds', () => {
		expect(() => assertInteger(5, 1, 10, 'v')).not.toThrow()
		expect(() => assertInteger(0, 1, 10, 'v')).toThrow('v: invalid integer')
		expect(() => assertInteger(11, 1, 10, 'v')).toThrow('v: invalid integer')
		expect(() => assertInteger(1.5, 1, 10, 'v')).toThrow('v: invalid integer')
		expect(() => assertInteger(Number.NaN, 1, 10, 'v')).toThrow('v: invalid integer')
	})

	it('verifies a real X25519 pair derives its public half', () => {
		const pair = Curve.generateKeyPair()
		expect(() => assertX25519Pair(pair, 'pair')).not.toThrow()
	})

	it('rejects a public half that the private half does not derive', () => {
		const pair = Curve.generateKeyPair()
		const other = Curve.generateKeyPair()
		expect(() => assertX25519Pair({ public: other.public, private: pair.private }, 'pair')).toThrow(
			'pair: public/private mismatch'
		)
	})

	it('rejects malformed pair halves', () => {
		const pair = Curve.generateKeyPair()
		expect(() => assertX25519Pair({ public: pair.public.subarray(0, 31), private: pair.private }, 'pair')).toThrow(
			'pair.public: invalid byte length'
		)
		expect(() => assertX25519Pair({ public: pair.public, private: pair.private.subarray(0, 31) }, 'pair')).toThrow(
			'pair.private: invalid byte length'
		)
	})

	it('hashes public keys with sha256', () => {
		const pair = Curve.generateKeyPair()
		expect(publicKeyHash(pair.public)).toBe(createHash('sha256').update(pair.public).digest('hex'))
		expect(() => publicKeyHash(pair.public.subarray(0, 31))).toThrow('public key: invalid byte length')
	})

	it('binds the wire authkey to the persisted static key', () => {
		const pair = Curve.generateKeyPair()
		expect(() => assertRegistrationAuthBinding(pair, pair.public)).not.toThrow()
		const other = Curve.generateKeyPair()
		expect(() => assertRegistrationAuthBinding(pair, other.public)).toThrow(
			'registration authkey differs from login static key'
		)
	})

	it('encodes pre-key ids as 24-bit big endian', () => {
		expect(Array.from(encodePreKeyId(0x010203))).toEqual([1, 2, 3])
		expect(Array.from(encodePreKeyId(1))).toEqual([0, 0, 1])
		expect(Array.from(encodePreKeyId(0xffffff))).toEqual([255, 255, 255])
		expect(() => encodePreKeyId(0)).toThrow('prekey id: invalid integer')
		expect(() => encodePreKeyId(0x1000000)).toThrow('prekey id: invalid integer')
	})

	it('enforces the official 31-bit registration id range', () => {
		expect(() => assertPrimaryRegistrationId(1)).not.toThrow()
		expect(() => assertPrimaryRegistrationId(2147483646)).not.toThrow()
		expect(() => assertPrimaryRegistrationId(0)).toThrow('primary registration id: invalid integer')
		expect(() => assertPrimaryRegistrationId(2147483647)).toThrow('primary registration id: invalid integer')
	})

	it('round-trips a challenge through its persisted form', () => {
		const raw = Uint8Array.of(1, 2, 3, 250)
		const saved = saveChallenge(raw)
		expect(saved.encoding).toBe('base64url')
		expect(Array.from(restoreChallenge(saved))).toEqual(Array.from(raw))
	})

	it('rejects empty and non-canonical challenges', () => {
		expect(() => saveChallenge(new Uint8Array(0))).toThrow('empty challenge')
		expect(() => restoreChallenge({ encoding: 'base64url', data: 'AB' })).toThrow('noncanonical challenge')
		expect(() => restoreChallenge({ encoding: 'base64url', data: 'a+b' })).toThrow('invalid challenge format')
		expect(() => restoreChallenge({ encoding: 'base64url', data: '' })).toThrow('invalid challenge format')
	})
})
