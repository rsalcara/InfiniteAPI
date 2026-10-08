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
 *   npx tsx local-tools/primary-registration-test.ts request --number 15XXXXXXXXX [--method sms|voice] [--fresh]
 *   npx tsx local-tools/primary-registration-test.ts verify --code NNNNNN
 *
 * `token` valida a receita do token contra o vetor capturado do APK real.
 * `attest` exercita só a perna do relay (sem tocar na Meta).
 * `request`/`verify` são o teste real; o estado entre as fases fica em
 * `primary-registration-test-state.json`, a identidade PERMANENTE da
 * instalação em `primary-registration-identity.json` e as creds em
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
import type { NativeAndroidRegistrationCommon, NativeAndroidRequestCodeEnvironment } from '../src/Utils/native-android-registration-protocol'
import { buildClassicRegistrationToken, type NativeAndroidRegistrationTokenMaterial } from '../src/Utils/native-android-registration-token'

const toolsDir = dirname(fileURLToPath(import.meta.url))
// Material byte da captura real (o mesmo fixado pelo vetor do token nos testes);
// o about_logo.png é o drawable que a density do aparelho da captura resolveu.
const assetsDir = join(toolsDir, '..', 'src', '__tests__', 'Utils', 'fixtures', 'native-android-registration-token')
const statePath = join(toolsDir, 'primary-registration-test-state.json')
const credsPath = join(toolsDir, 'primary-registration-creds.json')
/**
 * Identidade PERMANENTE da instalação. O APK real nunca troca esses valores
 * entre tentativas de registro (provado na captura: expid/fdid/id/backup_token
 * e o pacote e_* idênticos em 17 requests com `status: ok`); o servidor compara
 * as tentativas pelo contexto de instalação — trocar tudo a cada request é o
 * padrão "dispositivo sintético" que derrubou o /v2/code para `blocked`.
 * `--fresh` simula uma instalação nova e recria o arquivo.
 */
const identityPath = join(toolsDir, 'primary-registration-identity.json')

const RELAY_URL = process.env.REGISTRATION_RELAY_URL ?? 'http://127.0.0.1:8080/v1/companion-device'

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
 * Ambiente estático EXATO da captura oficial de 2026-09-24 (17 requests com
 * `status: ok` naquele contexto). Valores de app-prefs que o hook não coleta
 * (recaptcha, mistyped, feo2…) saem daqui; o que o aparelho/bridge reporta em
 * tempo real (gpia, blobs WAMSYS, pid, RAM…) SOBRESCREVE estes defaults.
 * `REGISTRATION_ENVIRONMENT_JSON` aplica um merge final (persona de outro
 * aparelho, ex.: o Xiaomi 724/05 quando o teste for via relay).
 */
const ENVIRONMENT_DEFAULTS = {
	// App state / prefs do instalador oficial (constantes da captura).
	recaptcha: '{"stage":"ABPROP_DISABLED"}',
	db: 1,
	hasav: 2,
	mistyped: 7,
	feo2_query_status: 'error_security_exception',
	hasinrc: 1,
	simnum: 0,
	prefer_sms_over_flash: false,
	education_screen_displayed: false,
	backup_token_error: 'null_token',
	read_phone_permission_granted: 0,
	is_foa_fdid_app_installed: false,
	language_selector_time_spent: 0,
	language_selector_clicked_count: 0,
	offline_ab:
		'{"exposure":["android_eula_content_update|android_eula_content_update_prod|test"],"exp_hash":["7060|android_eula_content_update"],"metrics":{}}',
	rc: 0,
	// Persona do dispositivo da captura (emu64xa / T-Mobile). O bridge coleta
	// os vivos; relay/Xiaomi sobrescreve via REGISTRATION_ENVIRONMENT_JSON.
	mcc: '310',
	mnc: '260',
	sim_mcc: '310',
	sim_mnc: '260',
	sim_type: 1,
	sim_state: 5,
	airplane_mode_type: 0,
	cellular_strength: 4,
	roaming_type: 0,
	network_radio_type: 1,
	device_ram: 2.42,
	device_name: 'emu64xa',
	network_operator_name: 'T-Mobile',
	pid: 9703,
	// FCM do instalador da captura (o hook do bridge devolve o token real do
	// W4B em execução, que é o mesmo aparelho/app do caminho de hoje).
	push_token:
		'dM_R5BYSRn-LnQUTmChw1L:APA91bFEvoF-5hpjJDGcLf7VZph2CKeiXr3bysAdNia0lVwdEkb0Cod2hWpUHttURtCRJwBJQqE2zLuQ2WhzMvpw_DZnxPye7'
} satisfies Record<string, string | number | boolean>

/**
 * `client_metrics` do /v2/code: o APK serializa `{"attempts":N,...}` (19/37/38
 * na captura). O /v2/exist usa OUTRO produtor — `{"GMSVersion":263234032}` —
 * e vai por `onboardClientMetrics` no flow.
 */
const codeClientMetrics = (attempts: number): string =>
	JSON.stringify({ attempts, app_campaign_download_source: 'google-play|unknown', was_activated_from_stub: false })

const EXIST_CLIENT_METRICS = '{"GMSVersion":263234032}'

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
 * Ambiente do /v2/code: defaults da captura → `client_metrics` do attempt →
 * merge do operador (`REGISTRATION_ENVIRONMENT_JSON`) → o que o aparelho/bridge
 * reporta ao vivo (sempre por cima: gpia fresco, blobs WAMSYS e telefonia
 * coerentes com quem atesta).
 */
const registrationEnvironment = async (attempts: number) => {
	const operator = process.env.REGISTRATION_ENVIRONMENT_JSON
		? (JSON.parse(process.env.REGISTRATION_ENVIRONMENT_JSON) as Record<string, unknown>)
		: {}
	const base = {
		...ENVIRONMENT_DEFAULTS,
		client_metrics: codeClientMetrics(attempts),
		...operator
	} as NativeAndroidRequestCodeEnvironment
	const bridgeUrl = (args.get('bridge') ?? '').trim()
	if (!bridgeUrl) return base
	const live = await createNativeAndroidRegistrationEnvironmentProvider({ url: bridgeUrl, timeoutMs: 120_000 })('business')
	return { ...base, ...live }
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

type SavedIdentity = {
	createdAt: string
	fdid: string
	expid: string
	identityId: string
	backupToken: string
	advertisingId: string
	/** Contador de tentativas de /v2/code (o APK serializa em client_metrics). */
	attempts: number
	keys: SavedKeys
}

/**
 * Carrega (ou cria, uma única vez) a identidade permanente da instalação.
 * Tudo que o servidor usa para amarrar tentativas — chaves, expid, fdid,
 * id/backup_token, GAID — vive aqui e NÃO muda entre requests; `--fresh`
 * simula instalação nova.
 */
const loadOrCreateIdentity = (fresh: boolean): SavedIdentity => {
	if (!fresh && existsSync(identityPath)) {
		return JSON.parse(readFileSync(identityPath, 'utf8')) as SavedIdentity
	}
	const identity: SavedIdentity = {
		createdAt: new Date().toISOString(),
		fdid: process.env.REGISTRATION_FDID ?? randomUUID(),
		expid: randomUUID(),
		identityId: hex(randomBytes(20)),
		backupToken: hex(randomBytes(20)),
		advertisingId: randomUUID(),
		attempts: 0,
		keys: saveKeys(createNativeAndroidRegistrationSignalKeys())
	}
	writeFileSync(identityPath, JSON.stringify(identity, null, 2))
	console.log(`identidade nova da instalação salva em ${identityPath}`)
	return identity
}

const bumpAttempts = (identity: SavedIdentity): SavedIdentity => {
	identity.attempts += 1
	writeFileSync(identityPath, JSON.stringify(identity, null, 2))
	return identity
}

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
		console.error('uso: request --number <dígitos nacionais> [--method sms|voice] [--fresh]')
		process.exit(1)
	}
	if (method !== 'sms' && method !== 'voice') {
		console.error('method deve ser sms ou voice')
		process.exit(1)
	}

	// Identidade PERMANENTE da instalação: mesmas chaves/expid/fdid/id/
	// backup_token/GAID em todas as tentativas, 1:1 com o APK (o servidor
	// reprova o contexto "instalação nova a cada request"). `--fresh` = nova.
	const identity = loadOrCreateIdentity(args.has('fresh'))
	const keys = loadKeys(identity.keys)
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
		fingerprintDeviceId: identity.fdid,
		expirationId: identity.expid,
		identityId: unhex(identity.identityId),
		backupToken: unhex(identity.backupToken)
	} satisfies Omit<NativeAndroidRegistrationCommon, 'keyBundle'>

	bumpAttempts(identity)
	const flow = createNativeAndroidRegistrationFlow({
		common,
		keys,
		tokenMaterial: tokenMaterial(),
		attestationProvider: attestationProvider(keys.clientStaticKeyPair.public),
		environment: await registrationEnvironment(identity.attempts),
		advertisingId: identity.advertisingId,
		onboardClientMetrics: EXIST_CLIENT_METRICS,
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

const cmdOnboard = async (): Promise<void> => {
	const number = (args.get('number') ?? '').replace(/\D/g, '')
	if (!/^\d{8,15}$/.test(number)) {
		console.error('uso: onboard --number <dígitos nacionais> [--fresh]')
		process.exit(1)
	}

	// Pré-flight sozinho (abprop → exist): itera o schema do exist SEM tocar
	// o /v2/code — não consome o cooldown de voz nem conta no client_metrics
	// de attempts (o exist oficial manda só {"GMSVersion":...}).
	const identity = loadOrCreateIdentity(args.has('fresh'))
	const keys = loadKeys(identity.keys)
	const common = {
		appVariant: 'business',
		language: 'pt',
		country: 'BR',
		countryCallingCode: '55',
		nationalNumber: number,
		fingerprintDeviceId: identity.fdid,
		expirationId: identity.expid,
		identityId: unhex(identity.identityId),
		backupToken: unhex(identity.backupToken)
	} satisfies Omit<NativeAndroidRegistrationCommon, 'keyBundle'>

	const flow = createNativeAndroidRegistrationFlow({
		common,
		keys,
		tokenMaterial: tokenMaterial(),
		attestationProvider: attestationProvider(keys.clientStaticKeyPair.public),
		environment: await registrationEnvironment(identity.attempts),
		advertisingId: identity.advertisingId,
		onboardClientMetrics: EXIST_CLIENT_METRICS,
		http: { fetch: officialFetch }
	})

	const result = await flow.onboard()
	for (const step of ['abprop', 'exist'] as const) {
		const s = result[step]
		console.log(`--- ${step} http=%d ---`, s.httpStatus)
		console.log('BODY', s.request.body)
		console.log('RESP', JSON.stringify(s.response, jsonReplacer, 2))
	}
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
	// GAID/attempts/client_metrics vêm da MESMA identidade do request que
	// emitiu o desafio — o /v2/register tem de parecer a mesma instalação.
	const identity = loadOrCreateIdentity(false)

	const flow = createNativeAndroidRegistrationFlow({
		common,
		keys,
		tokenMaterial: tokenMaterial(),
		attestationProvider: attestationProvider(keys.clientStaticKeyPair.public),
		environment: await registrationEnvironment(identity.attempts),
		advertisingId: identity.advertisingId,
		onboardClientMetrics: EXIST_CLIENT_METRICS,
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
		case 'onboard':
			return cmdOnboard()
		case 'verify':
			return cmdVerify()
		default:
			console.error('comandos: token | attest | onboard --number <número> [--fresh] | request --number <número> [--method sms|voice] [--fresh] | verify --code <código>')
			process.exit(1)
	}
}

main().catch(error => {
	console.error('FALHOU:', error instanceof Error ? `${error.message}` : error)
	process.exit(1)
})
