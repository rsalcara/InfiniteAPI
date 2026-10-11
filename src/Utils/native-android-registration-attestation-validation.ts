import { createHash, X509Certificate, verify as cryptoVerify } from 'node:crypto'
import { Boom } from '@hapi/boom'
import { DisconnectReason } from '../Types'

/**
 * Pre-send validation of the device-produced registration proof (audit gap:
 * the relay accepted `H`/`Authorization` by string/size only). The checks are
 * local and cryptographic: they detect an incorrect proof before it reaches
 * the wire, but they cannot force the server to accept the installation.
 *
 * Ground truth (W4B 2.26.36.72 / decompiled `X/C15E` "blacknoise", smali
 * `RetryingHttpClient` p1057/p1180): the SAME binding material goes into the
 * signature (`A07([B[B)[B`) and the key chain (`A03(...)[B`), and the Keystore
 * key is generated with `setAttestationChallenge` =
 * `timestampSeconds (uint64 BE) || 0x1f || bindingMaterial`. The Connector
 * (`RegistrationAttestationSigner.generateStaticKey`) reproduces that byte
 * layout 1:1, so the attestation extension must carry exactly it.
 */

/** OID 1.3.6.1.4.1.11129.2.1.17 (key attestation extension), DER-encoded. */
const ATTESTATION_EXTENSION_OID = Buffer.from('060a2b06010401d679020111', 'hex')

/** Official challenge separator between the timestamp and the binding material. */
export const NATIVE_ANDROID_ATTESTATION_CHALLENGE_SEPARATOR = 0x1f

/** `putLong` timestamp prefix is 8 bytes + 1 separator byte (APK `allocate(len + 9)`). */
const CHALLENGE_PREFIX_BYTES = 9

export type NativeAndroidAttestationProofDiagnostics = {
	/** Number of X.509 certificates decoded from `Authorization`. */
	chainLength: number
	/** sha-256 (hex) of the raw `Authorization` bytes — correlates proof ↔ log. */
	chainHash: string
	/** sha-256 (hex) of the raw `H=` signature bytes. */
	signatureHash: string
	/** sha-256 (hex) of the key-attestation extension value. */
	attestationHash: string
	/** Package name found inside the attestation application id, when present. */
	attestedPackage: string | null
	/** Whether the attested application id contains the expected package name. */
	packageNameMatches: boolean
	/** Whether the attested application id contains the expected signing cert digest. */
	signingCertMatches: boolean
	/** Epoch milliseconds embedded in the attestation challenge. */
	challengeTimestampMs: number | null
	/** Age of that timestamp at validation time. */
	challengeAgeMs: number | null
	/** sha-256 (hex) of the self-signed chain root (trust-policy correlation). */
	rootFingerprint: string
}

export type NativeAndroidAttestationProofExpectation = {
	/** Exact bytes `H=` signs (`wire.payloadToSign`). */
	payloadToSign: Uint8Array
	/** `H=` value, base64url no padding (Android Base64 flag 11). */
	signature: string
	/** `Authorization` value, standard base64 with padding (flag 2). */
	authorization: string
	/** Binding material the challenge must end with (registration authkey). */
	challengeMaterial: Uint8Array
	/** Installation package the attestation application id should name. */
	packageName?: string
	/** sha-256 (hex) of the installation signing certificate to look for. */
	signingCertSha256?: string
	/** Testability seam; defaults to `Date.now()`. */
	now?: number
	/**
	 * `reject` throws on an attested install identity that does not match the
	 * expected package/cert; `report` (default) records it in the diagnostics
	 * so the sanitized correlation log can carry it.
	 */
	installIdentityPolicy?: 'reject' | 'report'
}

// Explicit annotation so `fail(...)` participates in never-call narrowing
// (TS only narrows through callees with an explicit type annotation).
const fail: (message: string) => never = (message: string): never => {
	throw new Boom(`native_android registration attestation: ${message}`, {
		statusCode: DisconnectReason.badSession
	})
}

const sha256Hex = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex')

/**
 * Decodes one DER TLV at `offset` and returns its bounds. Strict: indefinite
 * lengths and truncated values are proof corruptions, not recoverable input.
 */
const readDerTlv = (
	buffer: Buffer,
	offset: number
): { tag: number; start: number; contentStart: number; contentEnd: number; end: number } => {
	if (offset >= buffer.length) fail('truncated DER value')
	const tag = buffer[offset]!
	const lengthByte = buffer[offset + 1]
	if (lengthByte === undefined) fail('truncated DER length')
	let contentStart = offset + 2
	let length: number
	if (lengthByte < 0x80) {
		length = lengthByte
	} else {
		const lengthBytes = lengthByte & 0x7f
		if (lengthBytes === 0 || lengthBytes > 4) fail('unsupported DER length form')
		if (contentStart + lengthBytes > buffer.length) fail('truncated DER length')
		length = 0
		for (let index = 0; index < lengthBytes; ++index) {
			length = length * 256 + buffer[contentStart + index]!
		}
		contentStart += lengthBytes
	}
	const contentEnd = contentStart + length
	if (contentEnd > buffer.length) fail('truncated DER content')
	return { tag, start: offset, contentStart, contentEnd, end: contentEnd }
}

/** Walks a DER buffer as a sequence of sibling TLVs. */
const readDerChildren = (buffer: Buffer, start: number, end: number): ReturnType<typeof readDerTlv>[] => {
	const children: ReturnType<typeof readDerTlv>[] = []
	let offset = start
	while (offset < end) {
		const node = readDerTlv(buffer, offset)
		children.push(node)
		offset = node.end
	}
	return children
}

/**
 * Splits the `Authorization` payload into concatenated DER certificates
 * (the APK/Connector write `cert.encoded` back to back, `Base64` flag 2).
 */
export const splitConcatenatedDerCertificates = (bytes: Uint8Array): Uint8Array[] => {
	const buffer = Buffer.from(bytes)
	const certificates: Uint8Array[] = []
	let offset = 0
	while (offset < buffer.length) {
		const node = readDerTlv(buffer, offset)
		if (node.tag !== 0x30) fail('certificate entry is not a DER SEQUENCE')
		certificates.push(Uint8Array.from(buffer.subarray(node.start, node.end)))
		offset = node.end
	}
	return certificates
}

const base64Decode = (value: string, encoding: 'base64url' | 'base64', label: string): Uint8Array => {
	const decoded = Buffer.from(value, encoding)
	if (!decoded.length) fail(`${label} is empty`)
	return Uint8Array.from(decoded)
}

/**
 * Extracts the key-attestation extension of one certificate: the extension
 * value DER plus the `attestationChallenge` bytes (5th element of the
 * `KeyDescription` SEQUENCE in every keymaster/keymint revision).
 */
const readAttestationExtension = (
	certificate: X509Certificate
): { value: Buffer; challenge: Uint8Array } => {
	const raw = certificate.raw
	const oidOffset = raw.indexOf(ATTESTATION_EXTENSION_OID)
	if (oidOffset < 0) fail('key attestation extension is missing')
	// SEQUENCE { OID, [critical BOOLEAN], OCTET STRING value } — the value is
	// the first OCTET STRING TLV after the OID.
	let offset = oidOffset + ATTESTATION_EXTENSION_OID.length
	const critical = readDerTlv(raw, offset)
	if (critical.tag === 0x01) offset = critical.end
	const valueNode = readDerTlv(raw, offset)
	if (valueNode.tag !== 0x04) fail('key attestation extension has no value')
	const value = raw.subarray(valueNode.contentStart, valueNode.contentEnd)
	const description = readDerTlv(value, 0)
	if (description.tag !== 0x30) fail('attestation description is not a SEQUENCE')
	const fields = readDerChildren(value, description.contentStart, description.contentEnd)
	const challengeNode = fields[4]
	if (!challengeNode || challengeNode.tag !== 0x04) fail('attestation challenge is missing')
	return {
		value: Buffer.from(value),
		challenge: Uint8Array.from(value.subarray(challengeNode.contentStart, challengeNode.contentEnd))
	}
}

/**
 * Validates the challenge layout `timestampSeconds(uint64 BE) || 0x1f || material`
 * and returns the embedded timestamp in epoch milliseconds.
 */
export const validateNativeAndroidAttestationChallenge = (
	challenge: Uint8Array,
	material: Uint8Array,
	now: number
): { challengeTimestampMs: number; challengeAgeMs: number } => {
	if (challenge.length !== CHALLENGE_PREFIX_BYTES + material.length) {
		fail('attestation challenge length does not match the binding material')
	}

	if (challenge[8] !== NATIVE_ANDROID_ATTESTATION_CHALLENGE_SEPARATOR) {
		fail('attestation challenge is missing the official 0x1f separator')
	}

	for (let index = 0; index < material.length; ++index) {
		if (challenge[CHALLENGE_PREFIX_BYTES + index] !== material[index]) {
			fail('attestation challenge is not bound to the registration identity')
		}
	}

	const timestampSeconds = Number(Buffer.from(challenge.subarray(0, 8)).readBigUInt64BE(0))
	if (!Number.isSafeInteger(timestampSeconds) || timestampSeconds <= 0) {
		fail('attestation challenge timestamp is invalid')
	}

	const challengeTimestampMs = timestampSeconds * 1000
	return { challengeTimestampMs, challengeAgeMs: now - challengeTimestampMs }
}

/** Finds the leaf (the certificate that issues no other certificate in the set). */
const findLeafIndex = (certificates: X509Certificate[]): number => {
	for (let index = 0; index < certificates.length; ++index) {
		const subject = certificates[index]!.subject
		const issuesAnother = certificates.some((other, otherIndex) => {
			if (otherIndex === index) return false
			// A self-signed root names itself; it still counts as an issuer of
			// the rest through its subject, so compare against OTHER subjects.
			return other.subject !== subject && other.issuer === subject
		})
		if (!issuesAnother) return index
	}
	return fail('certificate chain has no leaf')
}

/**
 * Verifies a relay registration proof before it is placed on the wire:
 * 1. `Authorization` decodes to a coherent X.509 chain (links + signatures).
 * 2. `H=` verifies over the exact signed bytes with the leaf public key.
 * 3. The key-attestation extension carries the expected challenge binding
 *    (`timestamp || 0x1f || registration authkey`).
 * 4. The attested install identity is compared against the expected
 *    package/signing certificate (reject or report per policy).
 */
export const verifyNativeAndroidRegistrationAttestationProof = (
	expectation: NativeAndroidAttestationProofExpectation
): NativeAndroidAttestationProofDiagnostics => {
	if (!expectation.challengeMaterial?.length) fail('binding material is required')
	const now = expectation.now ?? Date.now()

	const chainBytes = base64Decode(expectation.authorization, 'base64', 'Authorization')
	const certificatesDer = splitConcatenatedDerCertificates(chainBytes)
	const certificates = certificatesDer.map(der => {
		try {
			return new X509Certificate(Buffer.from(der))
		} catch {
			return fail('certificate chain contains an unparseable certificate')
		}
	})
	if (certificates.length < 2) fail('certificate chain must contain at least leaf and root')

	// Chain links: every certificate must be issued by the next one.
	const ordered: X509Certificate[] = []
	let cursor = findLeafIndex(certificates)
	const visited = new Set<number>()
	while (cursor >= 0 && !visited.has(cursor)) {
		visited.add(cursor)
		ordered.push(certificates[cursor]!)
		const issuerIndex = certificates.findIndex(
			(candidate, index) => !visited.has(index) && candidate.subject === ordered[ordered.length - 1]!.issuer
		)
		cursor = issuerIndex
	}

	if (ordered.length !== certificates.length) fail('certificate chain is not a single lineage')
	for (let index = 0; index < ordered.length - 1; ++index) {
		const child = ordered[index]!
		const issuer = ordered[index + 1]!
		if (child.issuer !== issuer.subject || !child.verify(issuer.publicKey)) {
			fail('certificate chain link verification failed')
		}
	}

	const root = ordered[ordered.length - 1]!
	if (root.issuer !== root.subject) fail('certificate chain does not end in a self-signed root')

	const leaf = ordered[0]!
	const signature = base64Decode(expectation.signature, 'base64url', 'H')
	let signatureOk = false
	try {
		signatureOk = cryptoVerify('sha256', Buffer.from(expectation.payloadToSign), leaf.publicKey, signature)
	} catch {
		signatureOk = false
	}
	if (!signatureOk) fail('payload signature does not verify against the attested leaf key')

	const { value: attestationValue, challenge } = readAttestationExtension(leaf)
	const { challengeTimestampMs, challengeAgeMs } = validateNativeAndroidAttestationChallenge(
		challenge,
		expectation.challengeMaterial,
		now
	)

	// The attested application id lives inside the extension as UTF-8 package
	// bytes and raw signature digests; a byte search is schema-revision agnostic
	// and matches exactly what the server compares.
	const packageNameMatches = expectation.packageName
		? attestationValue.includes(Buffer.from(expectation.packageName, 'utf8'))
		: true
	const expectedDigest = expectation.signingCertSha256
		? Buffer.from(expectation.signingCertSha256.toLowerCase(), 'hex')
		: undefined
	const signingCertMatches = expectedDigest?.length
		? attestationValue.includes(expectedDigest)
		: true
	const packageMatch = /[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*){2,}/.exec(attestationValue.toString('latin1'))
	const attestedPackage = packageMatch?.[0] ?? null

	if (expectation.installIdentityPolicy === 'reject' && (!packageNameMatches || !signingCertMatches)) {
		fail('attested install identity does not match the registration token material')
	}

	return {
		chainLength: certificates.length,
		chainHash: sha256Hex(chainBytes),
		signatureHash: sha256Hex(signature),
		attestationHash: sha256Hex(attestationValue),
		attestedPackage,
		packageNameMatches,
		signingCertMatches,
		challengeTimestampMs,
		challengeAgeMs,
		rootFingerprint: root.fingerprint256
	}
}
