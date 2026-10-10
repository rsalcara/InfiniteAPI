import { Curve } from '../../Utils/crypto'
import {
	createNativeAndroidRegistrationSignalKeys,
	type NativeAndroidRegistrationSignalKeys
} from '../../Utils/native-android-registration-keys'
import { validatePrimaryRegistrationBundle } from '../../Utils/registration-bundle-validation'

describe('registration-bundle-validation (audit M09)', () => {
	const clone = (keys: NativeAndroidRegistrationSignalKeys): NativeAndroidRegistrationSignalKeys => ({
		clientStaticKeyPair: { public: Buffer.from(keys.clientStaticKeyPair.public), private: Buffer.from(keys.clientStaticKeyPair.private) },
		identity: { public: Buffer.from(keys.identity.public), private: Buffer.from(keys.identity.private) },
		signedPreKey: {
			keyId: keys.signedPreKey.keyId,
			keyPair: {
				public: Buffer.from(keys.signedPreKey.keyPair.public),
				private: Buffer.from(keys.signedPreKey.keyPair.private)
			},
			signature: Buffer.from(keys.signedPreKey.signature)
		},
		registrationId: keys.registrationId
	})

	it('accepts the bundle produced by the official generator', () => {
		expect(() => validatePrimaryRegistrationBundle(createNativeAndroidRegistrationSignalKeys())).not.toThrow()
	})

	it('rejects a signed pre-key signature that does not match the identity', () => {
		const keys = clone(createNativeAndroidRegistrationSignalKeys())
		keys.signedPreKey.signature[0] = (keys.signedPreKey.signature[0] ?? 0) ^ 0xff
		expect(() => validatePrimaryRegistrationBundle(keys)).toThrow(
			'signed prekey signature does not match the Signal identity'
		)
	})

	it('rejects a signed pre-key signed by another identity', () => {
		const keys = clone(createNativeAndroidRegistrationSignalKeys())
		const foreign = Curve.generateKeyPair()
		keys.identity = foreign
		expect(() => validatePrimaryRegistrationBundle(keys)).toThrow(
			'signed prekey signature does not match the Signal identity'
		)
	})

	it('rejects an auth key whose halves do not match', () => {
		const keys = clone(createNativeAndroidRegistrationSignalKeys())
		const other = Curve.generateKeyPair()
		keys.clientStaticKeyPair.public = Buffer.from(other.public)
		expect(() => validatePrimaryRegistrationBundle(keys)).toThrow('auth key: public/private mismatch')
	})

	it('rejects out-of-range ids', () => {
		const zeroReg = clone(createNativeAndroidRegistrationSignalKeys())
		zeroReg.registrationId = 0
		expect(() => validatePrimaryRegistrationBundle(zeroReg)).toThrow('primary registration id: invalid integer')

		const zeroKeyId = clone(createNativeAndroidRegistrationSignalKeys())
		zeroKeyId.signedPreKey.keyId = 0
		expect(() => validatePrimaryRegistrationBundle(zeroKeyId)).toThrow('prekey id: invalid integer')
	})

	it('rejects a truncated signature', () => {
		const keys = clone(createNativeAndroidRegistrationSignalKeys())
		keys.signedPreKey.signature = keys.signedPreKey.signature.subarray(0, 63)
		expect(() => validatePrimaryRegistrationBundle(keys)).toThrow('signed prekey signature: invalid byte length')
	})
})
