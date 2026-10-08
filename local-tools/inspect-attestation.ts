/**
 * Diagnóstico da atestação do Connector sem tocar no servidor da Meta:
 * pede um material via relay (payload fumarento, nenhum SMS/disparo) e abre a
 * chain DER para mostrar o que o aparelho REALMENTE assa na atestação:
 *
 *  - o `attestationChallenge` (BE epoch 8B ‖ 0x1f ‖ suffix 32B) — o suffix tem
 *    que casar o `authkey` do corpo (chave pública estática do cliente);
 *  - os pacotes citados na extensão (attestationApplicationId);
 *  - qual aparelho respondeu (userAgent/deviceProfile).
 *
 * Uso: npx tsx local-tools/inspect-attestation.ts
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { createNativeAndroidRegistrationRelayProvider } from '../src/Utils/native-android-registration-relay-provider'

const toolsDir = dirname(fileURLToPath(import.meta.url))
const statePath = join(toolsDir, 'primary-registration-test-state.json')

const RELAY_URL = process.env.REGISTRATION_RELAY_URL ?? 'http://127.0.0.1:8080/v1/companion-device'
const SERVER_PUBLIC_KEY = Uint8Array.from(
	Buffer.from('jowPdMPrxdemhlxsPIQ4VrBhIczo6ndNIvtvEiUSMC0=', 'base64')
)

type DerCert = { offset: number; length: number; bytes: Buffer }

const splitDerChain = (chain: Buffer): DerCert[] => {
	const certs: DerCert[] = []
	let offset = 0
	while (offset + 2 <= chain.length && chain[offset] === 0x30) {
		const lenByte = chain[offset + 1]!
		let length = 0
		let header = 2
		if (lenByte < 0x80) {
			length = lenByte
		} else {
			const count = lenByte & 0x7f
			for (let i = 0; i < count; i++) length = (length << 8) | chain[offset + 2 + i]!
			header = 2 + count
		}
		certs.push({ offset, length: header + length, bytes: chain.subarray(offset, offset + header + length) })
		offset += header + length
	}
	return certs
}

/** Procura `04 29 <epoch BE 8B> 1F <32B>` (OCTET STRING do attestationChallenge). */
const findAttestationChallenges = (der: Buffer): { epoch: number; suffix: Buffer; at: number }[] => {
	const hits: { epoch: number; suffix: Buffer; at: number }[] = []
	for (let i = 0; i + 43 <= der.length; i++) {
		if (der[i] !== 0x04 || der[i + 1] !== 0x29 || der[i + 10] !== 0x1f) continue
		const epoch = Number(der.readBigUInt64BE(i + 2))
		if (epoch < 1_500_000_000 || epoch > 2_200_000_000) continue
		hits.push({ epoch, suffix: der.subarray(i + 11, i + 43), at: i })
	}
	return hits
}

const findAscii = (der: Buffer, needle: string): boolean => der.includes(Buffer.from(needle, 'ascii'))

const main = async (): Promise<void> => {
	const provider = createNativeAndroidRegistrationRelayProvider({
		url: RELAY_URL,
		timeoutMs: 45_000,
		envelopeMaterial: { serverPublicKey: SERVER_PUBLIC_KEY }
	})

	const attestation = await provider({
		endpoint: '/v2/code',
		appVariant: 'business',
		phoneNumber: '5500000000000',
		login: '5500000000000@s.whatsapp.net',
		body: `platform=smba&smoke=${Date.now()}`
	})

	const chain = Buffer.from(attestation.authorization, 'base64')
	const certs = splitDerChain(chain)
	const leaf = certs[0]?.bytes ?? Buffer.alloc(0)

	const stateAuthkey = (() => {
		try {
			const state = JSON.parse(readFileSync(statePath, 'utf8'))
			return Buffer.from(String(state.keys.clientStaticKeyPair.public ?? ''), 'hex')
		} catch {
			return Buffer.alloc(0)
		}
	})()

	const challenges = certs.flatMap((cert, index) =>
		findAttestationChallenges(cert.bytes).map(hit => ({ ...hit, certIndex: index }))
	)

	console.log('=== MATERIAL ===')
	console.log('authorization bytes:', chain.length, 'certs:', certs.length, 'sizes:', certs.map(c => c.bytes.length).join('+'))
	console.log('h (assinatura) chars:', attestation.body.slice(-120))
	console.log('userAgent:', (attestation as { userAgent?: string }).userAgent ?? '(none)')
	console.log('deviceProfile:', JSON.stringify((attestation as { deviceProfile?: unknown }).deviceProfile ?? null))

	console.log('=== ATTESTATION CHALLENGE ===')
	for (const hit of challenges) {
		console.log(`cert[${hit.certIndex}] (0=raiz ... ${certs.length - 1}=folha)`)
		console.log('epoch:', hit.epoch, new Date(hit.epoch * 1000).toISOString())
		console.log('suffix(32B) hex:', hit.suffix.toString('hex'))
		if (stateAuthkey.length) {
			console.log('authkey do estado hex:', stateAuthkey.toString('hex'))
			console.log('CASA com authkey?', hit.suffix.equals(stateAuthkey) ? 'SIM' : 'NAO (mismatch!)')
		}
	}
	if (!challenges.length) console.log('nenhum challenge encontrado no formato 04 29 ... 1F ...')

	console.log('=== PACOTES NA CHAIN ===')
	for (const pkg of ['com.whatsapp.w4b', 'com.whatsapp', 'br.com.infiniteapi.connector']) {
		console.log(pkg, '->', findAscii(chain, pkg) ? 'presente' : 'ausente')
	}
}

void main().catch(error => {
	console.error('FALHOU:', error instanceof Error ? error.message : error)
	process.exit(1)
})
