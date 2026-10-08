/**
 * Laboratório: teste real do registro primário nativo (requestCode → /v2/code,
 * verifyCode → /v2/register) 1:1 com W4B 2.26.36.72, sem bridge externa.
 *
 * A assinatura Keystore (`h=`) e a cadeia (`Authorization`) vêm do aparelho
 * físico pareado, via relay da própria plataforma (`POST /v1/companion-device/
 * registration/attestation`); o motor dono do protocolo: token oficial,
 * pacote de chaves device-0, ordem do fio e parser das respostas.
 *
 * Uso (na raiz do motor, com a stack local da plataforma no ar e o Connector
 * do Xiaomi pareado/conectado):
 *
 *   npx tsx local-tools/primary-registration-test.ts token
 *   npx tsx local-tools/primary-registration-test.ts attest
 *   npx tsx local-tools/primary-registration-test.ts request --number 15XXXXXXXXX [--method sms|voice]
 *   npx tsx local-tools/primary-registration-test.ts verify --code NNNNNN
 *
 * `token` valida a receita do token contra o vetor capturado do APK real.
 * `attest` exercita só a perna do relay (sem tocar na Meta).
 * `request`/`verify` são o teste real; o estado entre as fases fica em
 * `primary-registration-test-state.json` e as creds em
 * `primary-registration-creds.json`.
 */

import { randomBytes, randomUUID } from 'node:crypto'
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { createNativeAndroidRegistrationFlow } from '../src/Utils/native-android-registration-flow'
import { createNativeAndroidRegistrationSignalKeys, type NativeAndroidRegistrationSignalKeys } from '../src/Utils/native-android-registration-keys'
import { createNativeAndroidRegistrationBridgeProvider, createNativeAndroidRegistrationEnvironmentProvider } from '../src/Utils/native-android-registration-bridge-provider'
import { createNativeAndroidRegistrationRelayProvider } from '../src/Utils/native-android-registration-relay-provider'
import type { NativeAndroidRegistrationCommon } from '../src/Utils/native-android-registration-protocol'
import { buildClassicRegistrationToken, type NativeAndroidRegistrationTokenMaterial } from '../src/Utils/native-android-registration-token'

const toolsDir = dirname(fileURLToPath(import.meta.url))
// Material byte da captura real (o mesmo fixado pelo vetor do token nos testes);
// o about_logo.png é o drawable que a density do aparelho da captura resolveu.
const assetsDir = join(toolsDir, '..', 'src', '__tests__', 'Utils', 'fixtures', 'native-android-registration-token')
const statePath = join(toolsDir, 'primary-registration-test-state.json')
const credsPath = join(toolsDir, 'primary-registration-creds.json')

const RELAY_URL = process.env.REGISTRATION_RELAY_URL ?? 'http://127.0.0.1:8080/v1/companion-device'

/**
 * `fdid` = `phoneid_id` do APK (UUID v4 persistido, `C36321jF.Atg()`); valores
 * fora do formato UUID voltam `bad_format`/`param=fdid`. O `expid` é a
 * instalação; `id`/`backup_token` são os 20 bytes persistentes de uma
 * instalação nova (primeiro registro), exatamente como o APK os gera.
 */
const FDID = process.env.REGISTRATION_FDID ?? randomUUID()

/**
 * Chave pública estática do servidor de registro (X25519) — `X.BpZ.A00` no W4B
 * 2.26.36.72 / `X.En0.A00` no consumer (mesmo valor): selo do corpo `enc=`.
 */
const SERVER_PUBLIC_KEY = Uint8Array.from(
	Buffer.from(process.env.REGISTRATION_SERVER_KEY ?? 'jowPdMPrxdemhlxsPIQ4VrBhIczo6ndNIvtvEiUSMC0=', 'base64')
)

/**
 * Fetch com o conjunto de headers EXATO do APK (RetryingHttpClient):
 * Content-Type, Authorization, User-Agent, Accept-Encoding: identity — nada
 * mais. O fetch do Node acrescenta accept/sec-fetch-* que destoam do fio real.
 */
const officialFetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
	const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url)
	const headers = new Headers(init?.headers)
	const body = typeof init?.body === 'string' ? init.body : init?.body == null ? null : String(init.body)
	const doRequest = url.protocol === 'https:' ? httpsRequest : httpRequest
	return await new Promise<Response>((resolve, reject) => {
		const req = doRequest(url, {
			method: init?.method ?? 'GET',
			headers: {
				'Content-Type': headers.get('content-type') ?? 'application/x-www-form-urlencoded',
				...(headers.get('authorization') ? { Authorization: headers.get('authorization')! } : {}),
				...(headers.get('user-agent') ? { 'User-Agent': headers.get('user-agent')! } : {}),
				'Accept-Encoding': 'identity',
				...(body ? { 'Content-Length': String(Buffer.byteLength(body)) } : {})
			}
		}, res => {
			const chunks: Buffer[] = []
			res.on('data', chunk => chunks.push(Buffer.from(chunk)))
			res.on('end', () => {
				const text = Buffer.concat(chunks).toString('utf8')
				const status = res.statusCode ?? 0
				resolve({
					ok: status >= 200 && status < 300,
					status,
					text: async () => text
				} as unknown as Response)
			})
		})
		init?.signal?.addEventListener('abort', () => req.destroy(new Error('aborted')))
		req.on('error', reject)
		if (body) req.write(body)
		req.end()
	})
}

/**
 * Telemetria coerente com o aparelho que atesta (Claro BR, LTE, ~7,5 GB RAM,
 * dados do `getprop`/`meminfo` do Xiaomi). Campos vazios/omitidos são os que o
 * builder oficial já exclui do fio.
 */
const ENVIRONMENT = {
	mcc: '724',
	mnc: '05',
	sim_mcc: '724',
	sim_mnc: '05',
	sim_type: 1,
	airplane_mode_type: 0,
	cellular_strength: 4,
	roaming_type: 0,
	network_radio_type: 1,
	device_ram: 7.49,
	db: 0
}

const tokenMaterial = (): NativeAndroidRegistrationTokenMaterial => ({
	packageName: 'com.whatsapp.w4b',
	logoResource: readFileSync(join(assetsDir, 'about_logo.png')),
	signingCertDer: readFileSync(join(assetsDir, 'signing-cert.der')),
	classesDexMd5: Uint8Array.from(Buffer.from(readFileSync(join(assetsDir, 'classes-dex.md5'), 'utf8').trim(), 'hex'))
})

/**
 * O challenge da atestação é a chave pública estática do cliente (`authkey`):
 * `1Bt.A0I()` = `A0D().A02.A01` do APK (log "AuthKeyStore/failed to get client
 * static key pair"). Sem ele o Connector gera challenge aleatório e o servidor
 * recusa o vínculo atestação↔authkey.
 */
const attestationProvider = (clientStaticPublic?: Uint8Array) => {
	// --bridge <url>: caminho da identidade oficial completa. O hook dentro do
	// W4B real substitui o token (X.Mh2.A01), monta o envelope ENC=/H=, assina
	// na Keystore do APK (X.1Bv) e EXECUTA o HTTP lá dentro (TLS conscrypt +
	// UA oficial). O motor só recebe o apkResponse — discrimina identidade.
	const bridgeUrl = (args.get('bridge') ?? '').trim()
	if (bridgeUrl) {
		return createNativeAndroidRegistrationBridgeProvider({ url: bridgeUrl, timeoutMs: 120_000 })
	}

	return createNativeAndroidRegistrationRelayProvider({
		url: RELAY_URL,
		timeoutMs: 45_000,
		envelopeMaterial: { serverPublicKey: SERVER_PUBLIC_KEY },
		...(clientStaticPublic?.length ? { challenge: clientStaticPublic } : {})
	})
}

/**
 * Ambiente do /v2/code: com --bridge usa o ambiente REAL do aparelho (hook
 * `collectRegistrationEnvironment` — gpia fresco, blobs WAMSYS e telefonia
 * coerentes com quem atesta); sem bridge, o fixture da captura.
 */
const registrationEnvironment = async () => {
	const bridgeUrl = (args.get('bridge') ?? '').trim()
	if (bridgeUrl) {
		return await createNativeAndroidRegistrationEnvironmentProvider({ url: bridgeUrl, timeoutMs: 120_000 })('business')
	}
	return ENVIRONMENT
}

type SavedKeys = {
	clientStaticKeyPair: { private: string; public: string }
	identity: { private: string; public: string }
	signedPreKey: { keyId: number; keyPair: { private: string; public: string }; signature: string }
	registrationId: number
}

type SavedState = {
	createdAt: string
	method: 'sms' | 'voice'
	nationalNumber: string
	keys: SavedKeys
	common: {
		appVariant: 'business' | 'consumer'
		language: string
		country: string
		countryCallingCode: string
		nationalNumber: string
		fingerprintDeviceId: string
		expirationId: string
		identityId: string
		backupToken: string
	}
	authChallenge: string | null
	requestCodeResponse: unknown
}

const hex = (u: Uint8Array): string => Buffer.from(u).toString('hex')
const unhex = (s: string): Uint8Array => Uint8Array.from(Buffer.from(s, 'hex'))

const saveKeys = (keys: NativeAndroidRegistrationSignalKeys): SavedKeys => ({
	clientStaticKeyPair: { private: hex(keys.clientStaticKeyPair.private), public: hex(keys.clientStaticKeyPair.public) },
	identity: { private: hex(keys.identity.private), public: hex(keys.identity.public) },
	signedPreKey: {
		keyId: keys.signedPreKey.keyId,
		keyPair: { private: hex(keys.signedPreKey.keyPair.private), public: hex(keys.signedPreKey.keyPair.public) },
		signature: hex(keys.signedPreKey.signature)
	},
	registrationId: keys.registrationId
})

const loadKeys = (saved: SavedKeys): NativeAndroidRegistrationSignalKeys => ({
	clientStaticKeyPair: { private: unhex(saved.clientStaticKeyPair.private), public: unhex(saved.clientStaticKeyPair.public) },
	identity: { private: unhex(saved.identity.private), public: unhex(saved.identity.public) },
	signedPreKey: {
		keyId: saved.signedPreKey.keyId,
		keyPair: { private: unhex(saved.signedPreKey.keyPair.private), public: unhex(saved.signedPreKey.keyPair.public) },
		signature: unhex(saved.signedPreKey.signature)
	},
	registrationId: saved.registrationId
})

const jsonReplacer = (_key: string, value: unknown): unknown => {
	if (value instanceof Uint8Array) return { __hex: Buffer.from(value).toString('hex') }
	if (value && typeof value === 'object' && !Array.isArray(value)) {
		const out: Record<string, unknown> = {}
		for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
			if (v !== undefined) out[k] = v
		}
		return out
	}
	return value
}

const args = new Map<string, string>()
{
	const argv = process.argv.slice(3)
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i]!
		if (a.startsWith('--')) args.set(a.slice(2), argv[i + 1] ?? '')
	}
}

const command = process.argv[2]

const cmdToken = (): void => {
	const expected = 'hEjVbznrgA3o2tS3JoE4vuRVxVg='
	const actual = buildClassicRegistrationToken('1531997072', tokenMaterial())
	if (actual !== expected) {
		console.error(`TOKEN FALHOU: esperado ${expected}, obtido ${actual}`)
		process.exit(1)
	}
	console.log(`TOKEN OK: in=1531997072 → ${actual} (vetor capturado do APK real)`)
}

const cmdAttest = async (): Promise<void> => {
	const provider = attestationProvider()
	const startedAt = Date.now()
	const attestation = await provider({
		endpoint: '/v2/code',
		appVariant: 'business',
		phoneNumber: '5500000000000',
		login: '5500000000000@s.whatsapp.net',
		body: `platform=smba&smoke=${randomUUID()}`
	})
	console.log('ATESTATO OK via relay (%dms)', Date.now() - startedAt)
	console.log(
		JSON.stringify(
			{
				authorizationLength: attestation.authorization.length,
				hFromBody: attestation.body.slice(-80),
				userAgent: attestation.userAgent ?? null,
				deviceProfile: attestation.deviceProfile ?? null
			},
			null,
			2
		)
	)
}

const cmdRequest = async (): Promise<void> => {
	const number = (args.get('number') ?? '').replace(/\D/g, '')
	const method = (args.get('method') ?? 'sms') as 'sms' | 'voice'
	if (!/^\d{8,15}$/.test(number)) {
		console.error('uso: request --number <dígitos nacionais> [--method sms|voice]')
		process.exit(1)
	}
	if (method !== 'sms' && method !== 'voice') {
		console.error('method deve ser sms ou voice')
		process.exit(1)
	}

	const keys = createNativeAndroidRegistrationSignalKeys()
	// Diagnóstico: sobrepõe o `authkey` do corpo (chave pública estática) para
	// testar se o servidor valida o vínculo atestação↔authkey. Uso interno.
	const authkeyHex = (args.get('authkey-hex') ?? '').trim()
	if (authkeyHex) {
		if (!/^[0-9a-f]{64}$/i.test(authkeyHex)) {
			console.error('authkey-hex deve ter 64 hex chars (32 bytes)')
			process.exit(1)
		}
		keys.clientStaticKeyPair.public = unhex(authkeyHex)
	}
	const common = {
		appVariant: 'business',
		language: 'pt',
		country: 'BR',
		countryCallingCode: '55',
		nationalNumber: number,
		fingerprintDeviceId: FDID,
		expirationId: randomUUID(),
		identityId: randomBytes(20),
		backupToken: randomBytes(20)
	} satisfies Omit<NativeAndroidRegistrationCommon, 'keyBundle'>

	const flow = createNativeAndroidRegistrationFlow({
		common,
		keys,
		tokenMaterial: tokenMaterial(),
		attestationProvider: attestationProvider(keys.clientStaticKeyPair.public),
		environment: await registrationEnvironment(),
		http: { fetch: officialFetch }
	})

	const startedAt = Date.now()
	const result = await flow.requestCode({ method })
	console.log('WIRE-BODY', (result.request as { body?: string } | undefined)?.body ?? '(sem corpo)')
	console.log('REQUESTCODE http=%d tentativas=%d (%dms)', result.httpStatus, result.attempts, Date.now() - startedAt)
	console.log(JSON.stringify(result.response, jsonReplacer, 2))

	const state: SavedState = {
		createdAt: new Date().toISOString(),
		method,
		nationalNumber: number,
		keys: saveKeys(keys),
		common: {
			...common,
			identityId: hex(common.identityId),
			backupToken: hex(common.backupToken)
		},
		authChallenge: result.response.authChallenge ? hex(result.response.authChallenge) : null,
		requestCodeResponse: result.response
	}
	writeFileSync(statePath, JSON.stringify(state, jsonReplacer, 2))
	console.log(`estado salvo em ${statePath}`)
}

const cmdVerify = async (): Promise<void> => {
	const code = (args.get('code') ?? '').trim()
	if (!/^\d{4,8}$/.test(code)) {
		console.error('uso: verify --code <código recebido>')
		process.exit(1)
	}
	if (!existsSync(statePath)) {
		console.error(`sem estado anterior (${statePath}); rode o request primeiro`)
		process.exit(1)
	}

	const state = JSON.parse(readFileSync(statePath, 'utf8')) as SavedState
	const keys = loadKeys(state.keys)
	const common = {
		...state.common,
		identityId: unhex(state.common.identityId),
		backupToken: unhex(state.common.backupToken)
	}

	const flow = createNativeAndroidRegistrationFlow({
		common,
		keys,
		tokenMaterial: tokenMaterial(),
		attestationProvider: attestationProvider(keys.clientStaticKeyPair.public),
		environment: await registrationEnvironment(),
		http: { fetch: officialFetch }
	})

	const startedAt = Date.now()
	const result = await flow.verifyCode({
		code,
		...(state.authChallenge ? { authResponse: unhex(state.authChallenge) } : {})
	})
	console.log('VERIFYCODE http=%d tentativas=%d (%dms)', result.httpStatus, result.attempts, Date.now() - startedAt)
	console.log(JSON.stringify(result.response, jsonReplacer, 2))

	if (result.creds) {
		writeFileSync(credsPath, JSON.stringify(result.creds, jsonReplacer, 2))
		console.log(`REGISTRO OK — AuthenticationCreds salvas em ${credsPath}`)
	} else {
		console.log('registro não concluído (status != ok); nada de creds gerado')
	}
}

const main = async (): Promise<void> => {
	switch (command) {
		case 'token':
			return cmdToken()
		case 'attest':
			return cmdAttest()
		case 'request':
			return cmdRequest()
		case 'verify':
			return cmdVerify()
		default:
			console.error('comandos: token | attest | request --number <número> [--method sms|voice] | verify --code <código>')
			process.exit(1)
	}
}

main().catch(error => {
	console.error('FALHOU:', error instanceof Error ? `${error.message}` : error)
	process.exit(1)
})
