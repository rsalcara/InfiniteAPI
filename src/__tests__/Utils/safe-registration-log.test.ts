import { createHash } from 'node:crypto'
import {
	registrationBlockScreenHash,
	safeRegistrationLog,
	type RegistrationLogMetadata
} from '../../Utils/safe-registration-log'
import {
	computeMaterialManifestHashes,
	computeRegistrationMaterialHash,
	NATIVE_ANDROID_REGISTRATION_PACKAGES,
	type NativeAndroidRegistrationTokenMaterial
} from '../../Utils/native-android-registration-token'

const BASE: RegistrationLogMetadata = {
	endpoint: '/v2/exist',
	operationId: 'native-android-registration',
	phase: 'exist',
	attempts: 1,
	durationMs: 12
}

const SHA = (fill: string) => fill.repeat(64)

describe('safe-registration-log allowlist (audit module M10)', () => {
	it('passes the gap F correlation fields through unchanged', () => {
		const logged = safeRegistrationLog({
			...BASE,
			httpStatus: 200,
			status: 'fail',
			reason: 'too_recent',
			blockScreenHash: SHA('a'),
			materialHash: SHA('b'),
			proofHash: SHA('c'),
			attestedPackage: 'com.whatsapp.w4b',
			challengeAgeMs: 42
		})
		expect(logged).toEqual({
			...BASE,
			httpStatus: 200,
			status: 'fail',
			reason: 'too_recent',
			blockScreenHash: SHA('a'),
			materialHash: SHA('b'),
			proofHash: SHA('c'),
			attestedPackage: 'com.whatsapp.w4b',
			challengeAgeMs: 42
		})
	})

	it('returns allowlisted fields only — anything else on the input is dropped', () => {
		const polluted = {
			...BASE,
			body: '{"status":"fail"}',
			customBlockScreen: { title: 'Baixe o app oficial' },
			creds: { some: 'secret' },
			error: new Error('boom'),
			material: Uint8Array.from([1, 2, 3])
		} as unknown as RegistrationLogMetadata
		const logged = safeRegistrationLog(polluted) as Record<string, unknown>
		expect(Object.keys(logged).sort()).toEqual(
			['attempts', 'durationMs', 'endpoint', 'operationId', 'phase'].sort()
		)
		expect(JSON.stringify(logged)).not.toContain('Baixe')
		expect(JSON.stringify(logged)).not.toContain('secret')
	})

	it('drops malformed external tokens instead of logging or throwing on them', () => {
		const logged = safeRegistrationLog({
			...BASE,
			status: 'WEIRD STATUS!',
			reason: 'too recent; drop table',
			attestedPackage: '<script>alert(1)</script>'
		})
		expect(logged.status).toBeUndefined()
		expect(logged.reason).toBeUndefined()
		expect(logged.attestedPackage).toBeUndefined()
	})

	it('drops malformed digests and non-integer challenge ages', () => {
		const logged = safeRegistrationLog({
			...BASE,
			blockScreenHash: 'not-hex',
			materialHash: SHA('A').toUpperCase(),
			proofHash: `${SHA('c')}00`,
			challengeAgeMs: 1.5
		})
		expect(logged.blockScreenHash).toBeUndefined()
		expect(logged.materialHash).toBeUndefined()
		expect(logged.proofHash).toBeUndefined()
		expect(logged.challengeAgeMs).toBeUndefined()
	})

	it('keeps a negative challenge age — it is the factual clock skew', () => {
		expect(safeRegistrationLog({ ...BASE, challengeAgeMs: -1500 }).challengeAgeMs).toBe(-1500)
	})

	it('keeps the pre-existing strict validation of caller invariants', () => {
		expect(() => safeRegistrationLog({ ...BASE, endpoint: '/api/login' })).toThrow('invalid log endpoint')
		expect(() => safeRegistrationLog({ ...BASE, phase: 'phase with spaces' })).toThrow('invalid log phase')
		expect(() => safeRegistrationLog({ ...BASE, attempts: -1 })).toThrow('invalid attempts')
		expect(() => safeRegistrationLog({ ...BASE, httpStatus: 99 })).toThrow('invalid HTTP status')
		expect(() => safeRegistrationLog({ ...BASE, category: 'bad category!' })).toThrow('invalid category')
	})
})

describe('registration block screen digest (audit gap F)', () => {
	const screen = { title: 'Baixe o app oficial do WhatsApp para continuar', code: 'too_recent' }

	it('digests the screen document without ever keeping its content', () => {
		const digest = registrationBlockScreenHash(screen)
		expect(digest).toMatch(/^[0-9a-f]{64}$/)
		expect(digest).toBe(createHash('sha256').update(JSON.stringify(screen), 'utf8').digest('hex'))
		// Same document (wire key order preserved by JSON.parse) → same digest;
		// another document → another digest.
		expect(registrationBlockScreenHash({ ...screen })).toBe(digest)
		expect(registrationBlockScreenHash({ title: 'Outra tela' })).not.toBe(digest)
	})

	it('reports absence as undefined, never as a digest of nothing', () => {
		expect(registrationBlockScreenHash(undefined)).toBeUndefined()
		expect(registrationBlockScreenHash(null)).toBeUndefined()
		expect(registrationBlockScreenHash({})).toBeUndefined()
	})
})

describe('token material correlation digest (audit gap F)', () => {
	const material: NativeAndroidRegistrationTokenMaterial = {
		packageName: NATIVE_ANDROID_REGISTRATION_PACKAGES.business,
		logoResource: Uint8Array.from([1, 2, 3]),
		signingCertDer: Uint8Array.from([4, 5]),
		// The raw 16-byte MD5 digest, exactly like the token material carries.
		classesDexMd5: Uint8Array.from({ length: 16 }, (_, index) => index)
	}

	it('is the digest over the three manifest hashes of the consumed bytes', () => {
		const digest = computeRegistrationMaterialHash(material)
		expect(digest).toMatch(/^[0-9a-f]{64}$/)
		const hashes = computeMaterialManifestHashes(material)
		expect(digest).toBe(
			createHash('sha256')
				.update(`${hashes.logoResource}|${hashes.signingCertDer}|${hashes.classesDexMd5}`, 'utf8')
				.digest('hex')
		)
		// Deterministic, and any swapped blob is a different material identity.
		expect(computeRegistrationMaterialHash({ ...material })).toBe(digest)
		expect(computeRegistrationMaterialHash({ ...material, logoResource: Uint8Array.from([9]) })).not.toBe(digest)
		expect(computeRegistrationMaterialHash({ ...material, classesDexMd5: Uint8Array.from([9]) })).not.toBe(digest)
	})
})
