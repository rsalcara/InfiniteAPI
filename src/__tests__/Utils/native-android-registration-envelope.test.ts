import { createDecipheriv } from 'node:crypto'
import { Curve } from '../../Utils/crypto'
import {
	appendNativeAndroidRegistrationSignature,
	buildNativeAndroidRegistrationWireBody,
	encodeNativeAndroidRegistrationAuthorization,
	encodeNativeAndroidRegistrationSignature,
	sealNativeAndroidRegistrationEnvelope
} from '../../Utils/native-android-registration-envelope'

const QUERY = 'cc=55&token=hEjVbznrgA3o2tS3JoE4vuRVxVg%3D&in=1531997072&method=sms'

/** Mirrors the server-side decrypt of the `ENC=` body. */
const decryptEnvelope = (enc: string, serverPrivate: Uint8Array): string => {
	const combined = Buffer.from(enc, 'base64')
	const ephemeralPublic = combined.subarray(0, 32)
	const cipherText = combined.subarray(32)
	const aesKey = Curve.sharedKey(serverPrivate, ephemeralPublic)
	const decipher = createDecipheriv('aes-256-gcm', aesKey, new Uint8Array(12))
	decipher.setAuthTag(cipherText.subarray(cipherText.length - 16))
	return Buffer.concat([decipher.update(cipherText.subarray(0, cipherText.length - 16)), decipher.final()]).toString(
		'utf8'
	)
}

describe('native android registration envelope', () => {
	it('seals the query so the server-side decrypt recovers it exactly', () => {
		const server = Curve.generateKeyPair()
		const sealed = sealNativeAndroidRegistrationEnvelope(QUERY, { serverPublicKey: server.public })
		expect(sealed.encrypted).toBe(true)
		expect(sealed.body.startsWith('ENC=')).toBe(true)
		expect(decryptEnvelope(sealed.body.slice(4), server.private)).toBe(QUERY)
	})

	it('strips the Curve type byte: the enc prefix is exactly 32 bytes', () => {
		const server = Curve.generateKeyPair()
		const sealed = sealNativeAndroidRegistrationEnvelope(QUERY, { serverPublicKey: server.public })
		const combined = Buffer.from(sealed.body.slice(4), 'base64')
		// 32-byte ephemeral public || ciphertext || 16-byte tag
		expect(combined.length).toBe(32 + QUERY.length + 16)
	})

	it('uses the flag-11 encoding for enc (base64url alphabet, no padding)', () => {
		const server = Curve.generateKeyPair()
		const sealed = sealNativeAndroidRegistrationEnvelope(QUERY, { serverPublicKey: server.public })
		const enc = sealed.body.slice(4)
		// Flag 11 = URL_SAFE | NO_WRAP | NO_PADDING: base64url alphabet, no '='.
		expect(enc).toMatch(/^[A-Za-z0-9\-_]+$/)
		expect(enc).not.toContain('=')
	})

	it('signs the bare enc value, not the ENC= query fragment', () => {
		const server = Curve.generateKeyPair()
		const sealed = sealNativeAndroidRegistrationEnvelope(QUERY, { serverPublicKey: server.public })
		expect(Buffer.from(sealed.payloadToSign).toString('utf8')).toBe(sealed.body.slice(4))
	})

	it('uses a fresh X25519 ephemeral per request', () => {
		const server = Curve.generateKeyPair()
		const first = sealNativeAndroidRegistrationEnvelope(QUERY, { serverPublicKey: server.public })
		const second = sealNativeAndroidRegistrationEnvelope(QUERY, { serverPublicKey: server.public })
		expect(first.body).not.toBe(second.body)
		expect(decryptEnvelope(first.body.slice(4), server.private)).toBe(QUERY)
		expect(decryptEnvelope(second.body.slice(4), server.private)).toBe(QUERY)
	})

	it('rejects a server key that is not 32 bytes', () => {
		expect(() => sealNativeAndroidRegistrationEnvelope(QUERY, { serverPublicKey: new Uint8Array(31) })).toThrow(
			/serverPublicKey/
		)
	})

	it('falls back to the signed plain query when encryption is unavailable (APK parity)', () => {
		const fallback = buildNativeAndroidRegistrationWireBody(QUERY)
		expect(fallback.encrypted).toBe(false)
		expect(fallback.body).toBe(QUERY)
		expect(Buffer.from(fallback.payloadToSign).toString('utf8')).toBe(QUERY)

		const malformed = buildNativeAndroidRegistrationWireBody(QUERY, { serverPublicKey: new Uint8Array(3) })
		expect(malformed.encrypted).toBe(false)
		expect(malformed.body).toBe(QUERY)
	})

	it('appends the official &H= suffix with flag-11 encoding', () => {
		// 2 bytes -> 3 base64 chars + '=' padding; flag 11 = URL_SAFE | NO_WRAP |
		// NO_PADDING, so `+`/`/` become `-`/`_` and the `=` is stripped.
		expect(encodeNativeAndroidRegistrationSignature(Uint8Array.from([251, 255]))).toBe('-_8')
		expect(appendNativeAndroidRegistrationSignature('ENC=abc', Uint8Array.from([251, 255]))).toBe('ENC=abc&H=-_8')
	})

	it('keeps padding only on the Authorization key chain (flag 2)', () => {
		expect(encodeNativeAndroidRegistrationAuthorization(Uint8Array.from([251, 255]))).toBe('+/8=')
		expect(encodeNativeAndroidRegistrationAuthorization(Uint8Array.from([251, 255, 191]))).toBe('+/+/')
	})
})
