import { X509Certificate } from 'crypto'
import { mkdtemp, readFile, rm } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { WABA_CLIENT_APP_ID } from '../../Defaults'
import { makeNodeX509StudyStore, splitConcatenatedDerCertificates } from '../../Utils/native-android-node-x509-study'

describe('native Android local Node X.509 fixture', () => {
	it('creates a structurally valid root-first chain and persists it across provider restarts', async () => {
		const directory = await mkdtemp(join(tmpdir(), 'infiniteapi-node-x509-'))
		const storagePath = join(directory, 'attestation.json')
		let now = Date.UTC(2026, 6, 24, 12, 0, 0)

		try {
			const firstStore = makeNodeX509StudyStore({
				acknowledgeStudyOnly: true,
				storagePath,
				ttlMs: 60_000,
				now: () => now
			})
			const first = await firstStore.current()
			const certificates = splitConcatenatedDerCertificates(first.keyAttestation)
			expect(certificates).toHaveLength(2)

			const root = new X509Certificate(certificates[0]!)
			const leaf = new X509Certificate(certificates[1]!)
			expect(root.subject).toContain('InfiniteAPI local test root')
			expect(leaf.subject).toContain('InfiniteAPI local Node test leaf')
			expect(root.verify(root.publicKey)).toBe(true)
			expect(leaf.verify(root.publicKey)).toBe(true)
			expect(first.clientAppId).toBe(WABA_CLIENT_APP_ID)
			expect(Buffer.from(first.gpia as Uint8Array)).toHaveLength(0)

			now += 10_000
			const restartedStore = makeNodeX509StudyStore({
				acknowledgeStudyOnly: true,
				storagePath,
				ttlMs: 60_000,
				now: () => now
			})
			const afterRestart = await restartedStore.current()
			expect(Buffer.from(afterRestart.keyAttestation)).toEqual(Buffer.from(first.keyAttestation))

			const persisted = JSON.parse(await readFile(storagePath, 'utf8')) as Record<string, unknown>
			expect(persisted).not.toHaveProperty('privateKey')
			expect(persisted).not.toHaveProperty('privateKeyPem')
		} finally {
			await rm(directory, { force: true, recursive: true })
		}
	})

	it('rotates an expired chain instead of reusing it', async () => {
		const directory = await mkdtemp(join(tmpdir(), 'infiniteapi-node-x509-'))
		const storagePath = join(directory, 'attestation.json')
		let now = Date.UTC(2026, 6, 24, 12, 0, 0)

		try {
			const store = makeNodeX509StudyStore({
				acknowledgeStudyOnly: true,
				storagePath,
				ttlMs: 1_000,
				now: () => now
			})
			const first = await store.current()
			now += 1_001
			const rotated = await store.current()
			expect(Buffer.from(rotated.keyAttestation)).not.toEqual(Buffer.from(first.keyAttestation))
		} finally {
			await rm(directory, { force: true, recursive: true })
		}
	})

	it('replaces structurally invalid persisted content', async () => {
		const directory = await mkdtemp(join(tmpdir(), 'infiniteapi-node-x509-'))
		const storagePath = join(directory, 'attestation.json')
		const now = Date.UTC(2026, 6, 24, 12, 0, 0)

		try {
			await import('fs/promises').then(({ writeFile }) =>
				writeFile(
					storagePath,
					JSON.stringify({
						schemaVersion: 1,
						keyAttestationBase64: Buffer.from('not-a-certificate').toString('base64'),
						clientAppId: WABA_CLIENT_APP_ID,
						generatedAtMs: now,
						expiresAtMs: now + 60_000
					})
				)
			)
			const store = makeNodeX509StudyStore({
				acknowledgeStudyOnly: true,
				storagePath,
				now: () => now
			})
			const repaired = await store.current()
			expect(splitConcatenatedDerCertificates(repaired.keyAttestation)).toHaveLength(2)
		} finally {
			await rm(directory, { force: true, recursive: true })
		}
	})

	it('rejects malformed concatenated DER', () => {
		expect(() => splitConcatenatedDerCertificates(Buffer.from([0x30, 0x82, 0x01]))).toThrow('invalid DER length')
		expect(() => splitConcatenatedDerCertificates(Buffer.from([0x31, 0x00]))).toThrow('expected DER SEQUENCE')
	})

	it('uses the single audited WABA application identifier', async () => {
		const directory = await mkdtemp(join(tmpdir(), 'infiniteapi-node-x509-'))
		try {
			const result = await makeNodeX509StudyStore({
				acknowledgeStudyOnly: true,
				storagePath: join(directory, 'attestation.json')
			}).current()
			expect(result.clientAppId).toBe('473039703209605')
		} finally {
			await rm(directory, { force: true, recursive: true })
		}
	})
})
