import { Boom } from '@hapi/boom'
import { randomUUID } from 'node:crypto'
import type { Agent } from 'node:http'
import { request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { DisconnectReason } from '../Types'
import logger from './logger'
import type {
	NativeAndroidRegistrationBridgeAttestation,
	NativeAndroidRegistrationBridgeContext
} from './native-android-registration-bridge-provider'
import type { NativeAndroidRegistrationRequest } from './native-android-registration-protocol'
import { safeRegistrationLog } from './safe-registration-log'

export type NativeAndroidRegistrationHttpConfig = {
	/** Official endpoint host. Override is intended only for local laboratories. */
	baseUrl?: string
	appVariant: 'business' | 'consumer'
	phoneNumber: string
	login: string
	/**
	 * Official user type, forwarded to the registration bridge. The bridge's
	 * in-APK `token` computation keys on `in=` for primary requests and on the
	 * `login=` digits for type 1, so it must know which flow it is attesting.
	 * Individual requests override this via `NativeAndroidRegistrationRequest`.
	 */
	registrationType?: 0 | 1
	profileId?: string
	packageName?: string
	maxAttempts?: number
	timeoutMs?: number
	fetch?: typeof fetch
	sleep?: (ms: number) => Promise<void>
}

export type NativeAndroidRegistrationHttpResponse = {
	status: number
	body: unknown
	attempts: number
}

const RETRYABLE_STATUS = new Set([408, 429, 500, 502, 503, 504])
const DEFAULT_BACKOFF_MS = [1_000, 2_000, 4_000]
// Audit M05 hard cap: registration answers are small JSON documents; a
// hostile/hostile-broken answer must not exhaust memory before the parse.
const MAX_REGISTRATION_RESPONSE_BYTES = 1048576

const readBoundedResponseText = async (response: Response): Promise<string> => {
	// The official-header fetch below pre-bounds its own accumulation; a
	// streaming Response must be capped here for the same reason.
	if (!response.body) return response.text()
	const reader = response.body.getReader()
	const chunks: Buffer[] = []
	let size = 0
	for (;;) {
		const { done, value } = await reader.read()
		if (done) break
		size += value.byteLength
		if (size > MAX_REGISTRATION_RESPONSE_BYTES) {
			await reader.cancel()
			throw new Boom('native_android registration returned an oversized response', {
				statusCode: DisconnectReason.badSession
			})
		}

		chunks.push(Buffer.from(value))
	}

	return Buffer.concat(chunks).toString('utf8')
}

/**
 * Fetch com o conjunto de headers do APK (RetryingHttpClient + stack
 * msys/Tigon): Content-Type, Authorization, User-Agent, `Accept: text/json`,
 * `WaMsysRequest: 1` e um `request_token` UUIDv4 por requisição — o mesmo
 * conjunto de `registrationHeaders` do whalibmob (Android), com `User-Agent`
 * e `WaMsysRequest` confirmados literalmente no smali do request builder
 * msys (GIq.1/IUw.1: `TigonRequestBuilder.addHeader("WaMsysRequest", "1")`
 * e o mapa de headers iterado após). O fetch padrão do Node/undici acrescenta
 * `accept`/`accept-encoding` que destoam do fio oficial; `Accept-Encoding:
 * identity` mantém a resposta em JSON puro (o servidor responde JSON
 * independente do Accept, como nas capturas do lab: `{"status":"ok"}`).
 *
 * `options.agent` despacha as requisições de registro por um proxy
 * (ex.: HttpsProxyAgent residencial) — a ativação por número saindo de IP de
 * datacenter é respondida com o custom_block_screen de segurança; o agente
 * vale SÓ para estas chamadas de validação, nunca para a conexão da
 * instância.
 */
export const createNativeAndroidRegistrationOfficialFetch =
	(options?: { agent?: Agent }): typeof fetch =>
	async (input, init) => {
		const agent = options?.agent
		const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url)
		const headers = new Headers(init?.headers)
		const body =
			typeof init?.body === 'string'
				? init.body
				: init?.body === null || init?.body === undefined
					? null
					: String(init.body)
		const doRequest = url.protocol === 'https:' ? httpsRequest : httpRequest
		return await new Promise<Response>((resolve, reject) => {
			const req = doRequest(
				url,
				{
					...(agent !== undefined ? { agent } : {}),
					method: init?.method ?? 'GET',
					headers: {
						'Content-Type': headers.get('content-type') ?? 'application/x-www-form-urlencoded',
						...(headers.get('authorization') ? { Authorization: headers.get('authorization')! } : {}),
						...(headers.get('user-agent') ? { 'User-Agent': headers.get('user-agent')! } : {}),
						Accept: 'text/json',
						WaMsysRequest: '1',
						// Fresh per request, the way the native client mints it.
						request_token: randomUUID(),
						'Accept-Encoding': 'identity',
						...(body ? { 'Content-Length': String(Buffer.byteLength(body)) } : {})
					}
				},
				res => {
					const chunks: Buffer[] = []
					let size = 0
					const declared = res.headers['content-length']
					if (
						declared !== undefined &&
						(!/^\d+$/.test(declared) || Number(declared) > MAX_REGISTRATION_RESPONSE_BYTES)
					) {
						res.destroy()
						reject(new Error('registration response exceeds limit'))
						return
					}

					res.on('data', chunk => {
						size += chunk.length
						if (size > MAX_REGISTRATION_RESPONSE_BYTES) {
							res.destroy()
							reject(new Error('registration response exceeds limit'))
							return
						}

						chunks.push(Buffer.from(chunk))
					})
					res.on('end', () => {
						const text = Buffer.concat(chunks).toString('utf8')
						const status = res.statusCode ?? 0
						resolve({
							ok: status >= 200 && status < 300,
							status,
							text: async () => text
						} as unknown as Response)
					})
				}
			)
			init?.signal?.addEventListener('abort', () => req.destroy(new Error('aborted')))
			req.on('error', reject)
			if (body) req.write(body)
			req.end()
		})
	}

export const createNativeAndroidRegistrationHttpClient = (
	config: NativeAndroidRegistrationHttpConfig,
	// Absent for the unattested registration profile: every request goes out
	// with its sealed `ENC=` body only, exactly like the whalibmob reference
	// with no attestation server attached (`attestBody` -> `EMPTY_BODY`).
	attestationProvider?: (
		context: NativeAndroidRegistrationBridgeContext
	) => Promise<NativeAndroidRegistrationBridgeAttestation>
) => {
	if (!config.phoneNumber || !/^\d{8,15}$/.test(config.phoneNumber)) {
		throw new Error('native_android registration: phoneNumber is invalid')
	}

	if (!config.login) throw new Error('native_android registration: login is required')
	if (config.timeoutMs !== undefined && (!Number.isInteger(config.timeoutMs) || config.timeoutMs < 1)) {
		throw new Error('native_android registration: timeoutMs must be a positive integer')
	}

	if (
		config.maxAttempts !== undefined &&
		(!Number.isInteger(config.maxAttempts) || config.maxAttempts < 1 || config.maxAttempts > 4)
	) {
		throw new Error('native_android registration: official retry count is between 1 and 4')
	}

	const fetchImpl = config.fetch ?? fetch
	// The official client backs off for real between retryable attempts; a no-op
	// default would burn all 4 attempts in milliseconds and amplify outages.
	const sleep = config.sleep ?? ((ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms)))
	// Official registration host from W4B 2.26.36.72: C0d7.A0a (XOR 18).
	const baseUrl = config.baseUrl ?? 'https://v.whatsapp.net'

	return async (request: NativeAndroidRegistrationRequest): Promise<NativeAndroidRegistrationHttpResponse> => {
		const registrationType = request.registrationType ?? config.registrationType
		// `sendAttestationPayload: false` is the APK's `HS5(false)` funnel flag
		// (RetryingHttpClient p8, `if-eqz v17, :cond_11`): the body is already
		// sealed and unsigned, so the attestation provider is never called and
		// the request goes out without `&H=` and without `Authorization`. The
		// unattested profile seals its body the same way and has no provider.
		const attested =
			request.sendAttestationPayload === false || !attestationProvider
				? null
				: await attestationProvider({
						endpoint: request.endpoint,
						appVariant: config.appVariant,
						phoneNumber: config.phoneNumber,
						login: config.login,
						...(registrationType !== undefined ? { registrationType } : {}),
						...(config.profileId ? { profileId: config.profileId } : {}),
						...(config.packageName ? { packageName: config.packageName } : {}),
						body: request.body
					})

		// When the bridge executed the HTTP request inside the APK process,
		// the response is already available and no direct fetch is needed.
		if (attested?.apkResponse) {
			const apkText = attested.apkResponse.body
			let apkParsed: unknown
			try {
				apkParsed = JSON.parse(apkText)
			} catch {
				throw new Boom(
					`native_android registration returned invalid JSON from APK (HTTP ${attested.apkResponse.status})`,
					{ statusCode: DisconnectReason.badSession }
				)
			}

			return { status: attested.apkResponse.status, body: apkParsed, attempts: 1 }
		}

		const maxAttempts = config.maxAttempts ?? 4
		let lastError: unknown
		const operationId = randomUUID()
		const started = Date.now()

		for (let attempt = 1; attempt <= maxAttempts; ++attempt) {
			const controller = new AbortController()
			const timeout = setTimeout(() => controller.abort(), config.timeoutMs ?? 30_000)
			try {
				const response = await fetchImpl(`${baseUrl.replace(/\/$/, '')}${request.endpoint}`, {
					method: 'POST',
					redirect: 'error',
					headers: {
						'Content-Type': 'application/x-www-form-urlencoded',
						...(attested?.authorization ? { Authorization: attested.authorization } : {}),
						// Without the provider (funnel routes) the request carries
						// its own User-Agent; the platform selector rejects none.
						...((attested?.userAgent ?? request.userAgent)
							? { 'User-Agent': (attested?.userAgent ?? request.userAgent)! }
							: {})
					},
					body: attested?.body ?? request.body,
					signal: controller.signal
				})
				const text = await readBoundedResponseText(response)
				let parsed: unknown
				try {
					parsed = JSON.parse(text)
				} catch {
					throw new Boom(`native_android registration returned invalid JSON (HTTP ${response.status})`, {
						statusCode: DisconnectReason.badSession
					})
				}

				if (!RETRYABLE_STATUS.has(response.status) || attempt === maxAttempts) {
					// Allowlisted metadata only (audit M10): never the request,
					// the response body or the provider result. The proof
					// diagnostics (audit gap F) correlate this HTTP attempt with
					// the attestation that signed it.
					const proof = attested?.attestation
					logger.debug(
						safeRegistrationLog({
							endpoint: request.endpoint,
							operationId,
							phase: 'http',
							attempts: attempt,
							durationMs: Date.now() - started,
							httpStatus: response.status,
							...(proof?.signatureHash !== undefined ? { proofHash: proof.signatureHash } : {}),
							...(proof?.attestedPackage !== undefined && proof?.attestedPackage !== null
								? { attestedPackage: proof.attestedPackage }
								: {}),
							...(typeof proof?.challengeAgeMs === 'number' ? { challengeAgeMs: proof.challengeAgeMs } : {})
						}),
						'native_android registration response'
					)
					return { status: response.status, body: parsed, attempts: attempt }
				}

				lastError = new Boom(`native_android registration returned retryable HTTP ${response.status}`, {
					statusCode: response.status
				})
			} catch (error) {
				lastError = error
				if (error instanceof Boom && RETRYABLE_STATUS.has(Number(error.output?.statusCode ?? 0))) {
					if (attempt === maxAttempts) break
				} else if (error instanceof Error && error.name === 'AbortError') {
					lastError = new Boom('native_android registration request timed out', {
						statusCode: DisconnectReason.timedOut
					})
					if (attempt === maxAttempts) break
				} else {
					throw error
				}
			} finally {
				clearTimeout(timeout)
			}

			await sleep(DEFAULT_BACKOFF_MS[Math.min(attempt - 1, DEFAULT_BACKOFF_MS.length - 1)]!)
		}

		throw lastError ?? new Boom('native_android registration request failed')
	}
}
