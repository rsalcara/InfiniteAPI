import { generateKeyPair, type KeyObject, randomBytes, sign, X509Certificate } from 'crypto'
import { mkdir, readFile, rename, writeFile } from 'fs/promises'
import { dirname, join } from 'path'
import { WABA_CLIENT_APP_ID } from '../Defaults'
import type { NativeAndroidAttestationProvider } from '../Types'

const nodeAttestationWrites = new Map<string, Promise<NodeX509AttestationArtifacts>>()

export type NodeX509AttestationStoreOptions = {
	storagePath: string
	/** Defaults to the WhatsApp Business application identifier. */
	clientAppId?: string
	ttlMs?: number
	now?: () => number
}

export type NodeX509AttestationArtifacts = {
	keyAttestation: Uint8Array
	gpia: Uint8Array
	clientAppId: string
	generatedAtMs: number
	expiresAtMs: number
}

type PersistedNodeAttestation = {
	schemaVersion: 1
	keyAttestationBase64: string
	clientAppId: string
	generatedAtMs: number
	expiresAtMs: number
}

const SHA256_WITH_RSA = '1.2.840.113549.1.1.11'
const COMMON_NAME = '2.5.4.3'

const encodeLength = (length: number) => {
	if (length < 0x80) return Buffer.from([length])
	const bytes: number[] = []
	for (let value = length; value > 0; value >>>= 8) bytes.unshift(value & 0xff)
	return Buffer.from([0x80 | bytes.length, ...bytes])
}

const der = (tag: number, ...contents: Uint8Array[]) => {
	const content = Buffer.concat(contents.map(value => Buffer.from(value)))
	return Buffer.concat([Buffer.from([tag]), encodeLength(content.length), content])
}

const sequence = (...contents: Uint8Array[]) => der(0x30, ...contents)
const set = (...contents: Uint8Array[]) => der(0x31, ...contents)
const nullValue = () => der(0x05, Buffer.alloc(0))
const utf8String = (value: string) => der(0x0c, Buffer.from(value, 'utf8'))
const bitString = (value: Uint8Array) => der(0x03, Buffer.from([0]), value)

const integer = (value: Uint8Array) => {
	let normalized = Buffer.from(value)
	while (normalized.length > 1 && normalized[0] === 0) normalized = normalized.subarray(1)
	if ((normalized[0] ?? 0) & 0x80) normalized = Buffer.concat([Buffer.from([0]), normalized])
	return der(0x02, normalized)
}

const encodeBase128 = (value: number) => {
	const bytes = [value & 0x7f]
	for (value >>>= 7; value > 0; value >>>= 7) bytes.unshift((value & 0x7f) | 0x80)
	return bytes
}

const objectIdentifier = (value: string) => {
	const components = value.split('.').map(Number)
	if (
		components.length < 2 ||
		components.some(component => !Number.isSafeInteger(component) || component < 0) ||
		components[0]! > 2 ||
		components[1]! > 39
	) {
		throw new Error(`invalid object identifier: ${value}`)
	}

	const bytes = [components[0]! * 40 + components[1]!]
	for (const component of components.slice(2)) bytes.push(...encodeBase128(component))
	return der(0x06, Buffer.from(bytes))
}

const algorithmIdentifier = () => sequence(objectIdentifier(SHA256_WITH_RSA), nullValue())
const name = (commonName: string) => sequence(set(sequence(objectIdentifier(COMMON_NAME), utf8String(commonName))))

const utcTime = (date: Date) => {
	const year = date.getUTCFullYear()
	if (year < 1950 || year >= 2050) throw new Error('test certificate date is outside UTCTime range')
	const value = [
		String(year % 100).padStart(2, '0'),
		String(date.getUTCMonth() + 1).padStart(2, '0'),
		String(date.getUTCDate()).padStart(2, '0'),
		String(date.getUTCHours()).padStart(2, '0'),
		String(date.getUTCMinutes()).padStart(2, '0'),
		String(date.getUTCSeconds()).padStart(2, '0'),
		'Z'
	].join('')
	return der(0x17, Buffer.from(value, 'ascii'))
}

const certificate = (options: {
	subjectCommonName: string
	issuerCommonName: string
	subjectPublicKey: KeyObject
	issuerPrivateKey: KeyObject
	notBefore: Date
	notAfter: Date
}) => {
	const signatureAlgorithm = algorithmIdentifier()
	const subjectPublicKeyInfo = options.subjectPublicKey.export({ format: 'der', type: 'spki' })
	const tbsCertificate = sequence(
		der(0xa0, integer(Buffer.from([2]))),
		integer(randomBytes(16)),
		signatureAlgorithm,
		name(options.issuerCommonName),
		sequence(utcTime(options.notBefore), utcTime(options.notAfter)),
		name(options.subjectCommonName),
		subjectPublicKeyInfo
	)
	const signature = sign('sha256', tbsCertificate, options.issuerPrivateKey)
	return sequence(tbsCertificate, signatureAlgorithm, bitString(signature))
}

const generateRsaKeyPair = () =>
	new Promise<{ publicKey: KeyObject; privateKey: KeyObject }>((resolve, reject) => {
		generateKeyPair('rsa', { modulusLength: 2048 }, (error, publicKey, privateKey) => {
			if (error) reject(error)
			else resolve({ publicKey, privateKey })
		})
	})

const generateCompatibilityChain = async (generatedAtMs: number, expiresAtMs: number) => {
	const [root, leaf] = await Promise.all([generateRsaKeyPair(), generateRsaKeyPair()])
	const notBefore = new Date(generatedAtMs - 60_000)
	const notAfter = new Date(expiresAtMs)
	const rootCertificate = certificate({
		subjectCommonName: 'InfiniteAPI Node root',
		issuerCommonName: 'InfiniteAPI Node root',
		subjectPublicKey: root.publicKey,
		issuerPrivateKey: root.privateKey,
		notBefore,
		notAfter
	})
	const leafCertificate = certificate({
		subjectCommonName: 'InfiniteAPI Node leaf',
		issuerCommonName: 'InfiniteAPI Node root',
		subjectPublicKey: leaf.publicKey,
		issuerPrivateKey: root.privateKey,
		notBefore,
		notAfter
	})

	// Match the root-first concatenated-DER shape used by the Android provider.
	return Buffer.concat([rootCertificate, leafCertificate])
}

const readDerObjectLength = (input: Uint8Array, offset: number) => {
	if (input[offset] !== 0x30) throw new Error(`expected DER SEQUENCE at offset ${offset}`)
	const firstLength = input[offset + 1]
	if (firstLength === undefined) throw new Error('truncated DER length')
	if ((firstLength & 0x80) === 0) return 2 + firstLength
	const byteCount = firstLength & 0x7f
	if (byteCount === 0 || byteCount > 4 || offset + 2 + byteCount > input.length) {
		throw new Error('invalid DER length')
	}

	let contentLength = 0
	for (let index = 0; index < byteCount; index++) {
		contentLength = contentLength * 256 + input[offset + 2 + index]!
	}

	return 2 + byteCount + contentLength
}

export const splitConcatenatedDerCertificates = (input: Uint8Array) => {
	const certificates: Buffer[] = []
	for (let offset = 0; offset < input.length; ) {
		const length = readDerObjectLength(input, offset)
		if (offset + length > input.length) throw new Error('truncated DER certificate')
		certificates.push(Buffer.from(input.subarray(offset, offset + length)))
		offset += length
	}

	return certificates
}

const toArtifacts = (value: PersistedNodeAttestation): NodeX509AttestationArtifacts => ({
	keyAttestation: Buffer.from(value.keyAttestationBase64, 'base64'),
	gpia: Buffer.alloc(0),
	clientAppId: value.clientAppId,
	generatedAtMs: value.generatedAtMs,
	expiresAtMs: value.expiresAtMs
})

const isReusablePersistedNodeAttestation = (
	value: PersistedNodeAttestation | undefined,
	clientAppId: string,
	currentTime: number
): value is PersistedNodeAttestation => {
	if (
		value?.schemaVersion !== 1 ||
		value.clientAppId !== clientAppId ||
		!Number.isSafeInteger(value.generatedAtMs) ||
		!Number.isSafeInteger(value.expiresAtMs) ||
		value.expiresAtMs <= currentTime ||
		typeof value.keyAttestationBase64 !== 'string' ||
		value.keyAttestationBase64.length === 0
	) {
		return false
	}

	try {
		const certificates = splitConcatenatedDerCertificates(Buffer.from(value.keyAttestationBase64, 'base64'))
		if (certificates.length !== 2) return false
		const root = new X509Certificate(certificates[0]!)
		const leaf = new X509Certificate(certificates[1]!)
		return root.verify(root.publicKey) && leaf.verify(root.publicKey)
	} catch {
		return false
	}
}

/**
 * Creates a persistent X.509 compatibility chain used by the built-in
 * native_android pairing provider. The chain is ordinary Node-generated X.509
 * and is intentionally described as such; no Android Keystore or external APK
 * is required.
 */
export const makeNodeX509AttestationStore = (options: NodeX509AttestationStoreOptions) => {
	const ttlMs = options.ttlMs ?? 10 * 60_000
	const now = options.now ?? Date.now
	const clientAppId = options.clientAppId ?? WABA_CLIENT_APP_ID
	let inFlight: Promise<NodeX509AttestationArtifacts> | undefined
	if (!/^\d{15}$/.test(clientAppId)) throw new Error('clientAppId must contain exactly 15 digits')
	if (!Number.isSafeInteger(ttlMs) || ttlMs <= 0) throw new Error('ttlMs must be a positive safe integer')

	const readOrCreate = async (): Promise<NodeX509AttestationArtifacts> => {
		const currentTime = now()
		let persisted: PersistedNodeAttestation | undefined
		try {
			persisted = JSON.parse(await readFile(options.storagePath, 'utf8')) as PersistedNodeAttestation
		} catch (error) {
			const code = (error as NodeJS.ErrnoException).code
			if (code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error
		}

		if (isReusablePersistedNodeAttestation(persisted, clientAppId, currentTime)) {
			return toArtifacts(persisted)
		}

		// X.509 UTCTime has one-second precision. Persist the exact rounded
		// expiry encoded in the certificate so cache reuse cannot cross the
		// certificate's real notAfter boundary.
		const expiresAtMs = Math.max(
			Math.floor((currentTime + ttlMs) / 1000) * 1000,
			Math.floor(currentTime / 1000) * 1000 + 1000
		)
		const generated: PersistedNodeAttestation = {
			schemaVersion: 1,
			keyAttestationBase64: (await generateCompatibilityChain(currentTime, expiresAtMs)).toString('base64'),
			clientAppId,
			generatedAtMs: currentTime,
			expiresAtMs
		}
		await mkdir(dirname(options.storagePath), { recursive: true })
		const temporaryPath = `${options.storagePath}.${process.pid}.${randomBytes(8).toString('hex')}.tmp`
		await writeFile(temporaryPath, JSON.stringify(generated), { encoding: 'utf8', mode: 0o600 })
		await rename(temporaryPath, options.storagePath)
		return toArtifacts(generated)
	}

	const readOrCreateSerialized = async (): Promise<NodeX509AttestationArtifacts> => {
		while (true) {
			const pending = nodeAttestationWrites.get(options.storagePath)
			if (pending) {
				await pending.catch(() => undefined)
				continue
			}

			const operation = readOrCreate()
			nodeAttestationWrites.set(options.storagePath, operation)
			try {
				return await operation
			} finally {
				if (nodeAttestationWrites.get(options.storagePath) === operation) {
					nodeAttestationWrites.delete(options.storagePath)
				}
			}
		}
	}

	return {
		current: (): Promise<NodeX509AttestationArtifacts> => {
			if (!inFlight) {
				inFlight = readOrCreateSerialized().finally(() => {
					inFlight = undefined
				})
			}

			return inFlight
		}
	}
}

export type NativeAndroidNodeAttestationProviderOptions = {
	storageDirectory?: string
	ttlMs?: number
	now?: () => number
}

/**
 * Builds the supported, self-contained Node provider used by the environment
 * runtime resolver. Each application variant keeps a separate persisted chain.
 */
export const makeNativeAndroidNodeAttestationProvider = (
	options: NativeAndroidNodeAttestationProviderOptions = {}
): NativeAndroidAttestationProvider => {
	const storageDirectory = options.storageDirectory ?? '.infiniteapi/native-android-attestation'
	const stores = new Map<string, ReturnType<typeof makeNodeX509AttestationStore>>()

	return async ({ appVariant, clientAppId }) => {
		if (!/^\d{15}$/.test(clientAppId)) {
			throw new Error('native_android: clientAppId must contain exactly 15 digits')
		}

		const storeKey = `${appVariant}-${clientAppId}`
		let store = stores.get(storeKey)
		if (!store) {
			store = makeNodeX509AttestationStore({
				storagePath: join(storageDirectory, `${storeKey}.json`),
				clientAppId,
				ttlMs: options.ttlMs,
				now: options.now
			})
			stores.set(storeKey, store)
		}

		const artifacts = await store.current()
		return {
			keyAttestation: artifacts.keyAttestation,
			gpia: artifacts.gpia,
			clientAppId: artifacts.clientAppId
		}
	}
}
