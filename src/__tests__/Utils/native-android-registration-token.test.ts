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
