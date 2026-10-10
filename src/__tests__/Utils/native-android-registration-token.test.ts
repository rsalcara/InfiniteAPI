import { readFileSync } from 'fs'
import { dirname, join } from 'path'
import { fileURLToPath } from 'url'
import {
	buildClassicRegistrationToken,
	createClassicRegistrationTokenBuilder,
	NATIVE_ANDROID_REGISTRATION_PACKAGES,
	NATIVE_ANDROID_REGISTRATION_TOKEN_SALT_BASE64,
	type NativeAndroidRegistrationTokenMaterial
} from '../../Utils/native-android-registration-token'

const fixturesDir = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'native-android-registration-token')

/**
 * Capture-time material of the W4B 2.26.36.72 install whose real /v2/code
 * request was recorded on the wire (same build the MD5 in the fixtures was
 * taken from).
 */
const captureMaterial = (): NativeAndroidRegistrationTokenMaterial => ({
	packageName: NATIVE_ANDROID_REGISTRATION_PACKAGES.business,
	logoResource: readFileSync(join(fixturesDir, 'about_logo.png')),
	signingCertDer: readFileSync(join(fixturesDir, 'signing-cert.der')),
	classesDexMd5: Uint8Array.from(Buffer.from(readFileSync(join(fixturesDir, 'classes-dex.md5'), 'utf8').trim(), 'hex'))
})

/**
 * Material of the WhatsApp Messenger (consumer) 2.26.38.10 install
 * (`com.whatsapp`) used by the primary-device flow. The APK resolves the logo
 * as the `/res/drawable-xxhdpi-v4/about_logo.png` bucket shipped inside
 * `split_config.xhdpi.apk`; the cert is the OLDEST lineage entry ("Brian
 * Acton") returned by `getSigningCertificateHistory()[0]` after key rotation;
 * the dex MD5 is the raw MD5 of the `classes.dex` entry of the installed
 * base.apk.
 */
const consumerMaterial = (): NativeAndroidRegistrationTokenMaterial => ({
	packageName: NATIVE_ANDROID_REGISTRATION_PACKAGES.consumer,
	logoResource: readFileSync(join(fixturesDir, 'consumer', 'about_logo.png')),
	signingCertDer: readFileSync(join(fixturesDir, 'consumer', 'signing-cert.der')),
	classesDexMd5: Uint8Array.from(
		Buffer.from(readFileSync(join(fixturesDir, 'consumer', 'classes-dex.md5'), 'utf8').trim(), 'hex')
	)
})

describe('native android classic registration token', () => {
	it('reproduces the real wire token byte-for-byte (golden /v2/code capture)', () => {
		// Captured query: cc=55&token=hEjVbznrgA3o2tS3JoE4vuRVxVg=&in=1531997072
		expect(buildClassicRegistrationToken('1531997072', captureMaterial())).toBe('hEjVbznrgA3o2tS3JoE4vuRVxVg=')
	})

	it('pins the official PBKDF2 salt', () => {
		expect(Buffer.from(NATIVE_ANDROID_REGISTRATION_TOKEN_SALT_BASE64, 'base64')).toHaveLength(90)
		expect(NATIVE_ANDROID_REGISTRATION_TOKEN_SALT_BASE64).toBe(
			'PkTwKSZqUfAUyR0rPQ8hYJ0wNsQQ3dW1+3SCnyTXIfEAxxS75FwkDf47wNv/c8pP3p0GXKR6OOQmhyERwx74fw1RYSU10I4r1gyBVDbRJ40pidjM41G1I1oN'
		)
	})

	it('emits standard padded base64 of a 20-byte HMAC-SHA1 (Base64 flag 2 = NO_WRAP)', () => {
		const token = buildClassicRegistrationToken('1531997072', captureMaterial())
		expect(token).toMatch(/^[A-Za-z0-9+/]{27}=$/)
		expect(Buffer.from(token, 'base64')).toHaveLength(20)
	})

	it('is deterministic for the same input', () => {
		expect(buildClassicRegistrationToken('1531997072', captureMaterial())).toBe(
			buildClassicRegistrationToken('1531997072', captureMaterial())
		)
	})

	it('keys on the `in=` digits only', () => {
		const base = buildClassicRegistrationToken('1531997072', captureMaterial())
		expect(buildClassicRegistrationToken('551531997072', captureMaterial())).not.toBe(base)
		expect(buildClassicRegistrationToken('1531997073', captureMaterial())).not.toBe(base)
	})

	it('keys on the package name prefix of the PBKDF2 password', () => {
		const base = buildClassicRegistrationToken('1531997072', captureMaterial())
		const consumer = buildClassicRegistrationToken('1531997072', {
			...captureMaterial(),
			packageName: NATIVE_ANDROID_REGISTRATION_PACKAGES.consumer
		})
		expect(consumer).not.toBe(base)
	})

	it('keys on every APK material byte stream', () => {
		const material = captureMaterial()
		const base = buildClassicRegistrationToken('1531997072', material)
		expect(
			buildClassicRegistrationToken('1531997072', {
				...material,
				logoResource: Uint8Array.from([1, 2, 3])
			})
		).not.toBe(base)
		expect(
			buildClassicRegistrationToken('1531997072', {
				...material,
				signingCertDer: Uint8Array.from([1, 2, 3])
			})
		).not.toBe(base)
		expect(
			buildClassicRegistrationToken('1531997072', {
				...material,
				classesDexMd5: new Uint8Array(16)
			})
		).not.toBe(base)
	})

	it('rejects malformed input instead of minting a wrong token', () => {
		const material = captureMaterial()
		expect(() => buildClassicRegistrationToken('', material)).toThrow(/nationalNumber/)
		expect(() => buildClassicRegistrationToken('15 3199-7072', material)).toThrow(/nationalNumber/)
		expect(() => buildClassicRegistrationToken('+551531997072', material)).toThrow(/nationalNumber/)
		expect(() => buildClassicRegistrationToken('1531997072', { ...material, packageName: '' })).toThrow(/packageName/)
		expect(() => buildClassicRegistrationToken('1531997072', { ...material, logoResource: new Uint8Array() })).toThrow(
			/logoResource/
		)
		expect(() =>
			buildClassicRegistrationToken('1531997072', { ...material, signingCertDer: new Uint8Array() })
		).toThrow(/signingCertDer/)
		expect(() =>
			buildClassicRegistrationToken('1531997072', { ...material, classesDexMd5: new Uint8Array(15) })
		).toThrow(/classesDexMd5/)
	})

	it('binds fixed material through the builder wrapper', () => {
		const build = createClassicRegistrationTokenBuilder(captureMaterial())
		expect(build('1531997072')).toBe('hEjVbznrgA3o2tS3JoE4vuRVxVg=')
		expect(() =>
			createClassicRegistrationTokenBuilder({ ...captureMaterial(), classesDexMd5: new Uint8Array(3) })
		).toThrow(/classesDexMd5/)
	})
})

describe('native android classic registration token — consumer (WhatsApp Messenger) variant', () => {
	it('pins the fixture bytes taken from the com.whatsapp 2.26.38.10 install', () => {
		const material = consumerMaterial()
		// /res/drawable-xxhdpi-v4/about_logo.png (the hdpi/hdpi-v4 buckets sit in
		// the same split but the APK classpath order picks xxhdpi-v4 for this build).
		expect(material.logoResource).toHaveLength(60358)
		// Oldest signing lineage cert ("Brian Acton"), not the rotated "WhatsApp LLC" signer.
		expect(material.signingCertDer).toHaveLength(822)
		expect(Buffer.from(material.classesDexMd5).toString('hex')).toBe('2122b0e07d77d1ac1fe458d167c7cbc5')
		expect(material.packageName).toBe('com.whatsapp')
	})

	it('computes the consumer token for the real test MSISDN (1:1 chain)', () => {
		// Regression vector recomputed from the 2.26.38.10 install material.
		expect(buildClassicRegistrationToken('82956348194', consumerMaterial())).toBe('+C0t+Tlo8I7uXqwUmik5w1lvvCc=')
	})

	it('diverges from the business token for the same `in=` digits', () => {
		expect(buildClassicRegistrationToken('1531997072', consumerMaterial())).toBe('B+sKKrrUz4S/mlayTyhjAPfS+Bc=')
		expect(buildClassicRegistrationToken('1531997072', consumerMaterial())).not.toBe(
			buildClassicRegistrationToken('1531997072', captureMaterial())
		)
	})

	it('is deterministic on the consumer material', () => {
		expect(buildClassicRegistrationToken('82956348194', consumerMaterial())).toBe(
			buildClassicRegistrationToken('82956348194', consumerMaterial())
		)
	})

	it('rejects malformed consumer material instead of minting a wrong token', () => {
		expect(() =>
			buildClassicRegistrationToken('82956348194', { ...consumerMaterial(), classesDexMd5: new Uint8Array(15) })
		).toThrow(/classesDexMd5/)
		expect(() => buildClassicRegistrationToken('82956348194', { ...consumerMaterial(), packageName: '' })).toThrow(
			/packageName/
		)
	})
})
