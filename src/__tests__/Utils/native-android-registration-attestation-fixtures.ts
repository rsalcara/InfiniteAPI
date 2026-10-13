import { readFileSync } from 'fs'
import { createPrivateKey, type KeyObject, sign } from 'node:crypto'
import { dirname, join } from 'path'
import { fileURLToPath } from 'url'

/**
 * Pre-generated Keystore-equivalent proof material (openssl, prime256v1):
 * `leaf-cert.der` is issued by the self-signed `root-cert.der` and embeds the
 * key-attestation extension (OID 1.3.6.1.4.1.11129.2.1.17) whose challenge is
 * `timestampSeconds(1759996800) || 0x1f || FIXTURE_ATTESTATION_MATERIAL`;
 * `plain-cert.der` is the same key/cert WITHOUT the extension (negative case).
 */
const fixturesDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'attestation')

const leafCertDer = Uint8Array.from(readFileSync(join(fixturesDir, 'leaf-cert.der')))
const rootCertDer = Uint8Array.from(readFileSync(join(fixturesDir, 'root-cert.der')))
const plainCertDer = Uint8Array.from(readFileSync(join(fixturesDir, 'plain-cert.der')))
const leafKey: KeyObject = createPrivateKey(readFileSync(join(fixturesDir, 'leaf-key.pem')))

/** Binding material the fixture attestation challenge ends with (0x01..0x20). */
export const FIXTURE_ATTESTATION_MATERIAL = Uint8Array.from(Array.from({ length: 32 }, (_, index) => index + 1))

/**
 * Fake signing-certificate sha-256 embedded in the fixture attestation
 * application id (next to the `com.whatsapp.w4b` package bytes).
 */
export const FIXTURE_SIGNING_CERT_SHA256 = 'a0a1a2a3a4a5a6a7a8a9aaabacadaeafb0b1b2b3b4b5b6b7b8b9babbbcbdbebf'

const concatChain = (leaf: Uint8Array): string =>
	Buffer.concat([Buffer.from(leaf), Buffer.from(rootCertDer)]).toString('base64')

/** `Authorization` of the attested fixture chain (leaf first), flag-2 base64. */
export const FIXTURE_AUTHORIZATION = concatChain(leafCertDer)

/** Same chain whose leaf has NO attestation extension (flag-2 base64). */
export const FIXTURE_PLAIN_AUTHORIZATION = concatChain(plainCertDer)

/**
 * Signs the exact bytes `H=` covers with the fixture leaf key and returns the
 * official wire encodings: `H=` base64url without padding (flag 11) and the
 * `Authorization` chain, standard base64 with padding (flag 2).
 */
export const signFixtureProof = (payloadToSign: Uint8Array): { h: string; authorization: string } => ({
	h: sign('sha256', Buffer.from(payloadToSign), leafKey).toString('base64url'),
	authorization: FIXTURE_AUTHORIZATION
})
