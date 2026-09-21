import { Boom } from '@hapi/boom'
import { DisconnectReason } from '../Types'
import type {
	NativeAndroidRegistrationBridgeAttestation,
	NativeAndroidRegistrationBridgeContext
} from './native-android-registration-bridge-provider'
import type { NativeAndroidRegistrationRequest } from './native-android-registration-protocol'

export type NativeAndroidRegistrationHttpConfig = {
	/** Official endpoint host. Override is intended only for local laboratories. */
	baseUrl?: string
	appVariant: 'business' | 'consumer'
	phoneNumber: string
	login: string
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

export const createNativeAndroidRegistrationHttpClient = (
	config: NativeAndroidRegistrationHttpConfig,
	attestationProvider: (
		context: NativeAndroidRegistrationBridgeContext
	) => Promise<NativeAndroidRegistrationBridgeAttestation>
) => {
	if (!config.phoneNumber || !/^\d{8,15}$/.test(config.phoneNumber)) {
		throw new Error('native_android registration: phoneNumber is invalid')
	}

	if (!config.login) throw new Error('native_android registration: login is required')
	if (config.maxAttempts !== undefined && (config.maxAttempts < 1 || config.maxAttempts > 4)) {
		throw new Error('native_android registration: official retry count is between 1 and 4')
	}

	const fetchImpl = config.fetch ?? fetch
	const sleep = config.sleep ?? (async () => undefined)
	// Official registration host from W4B 2.26.36.72: C0d7.A0a (XOR 18).
	const baseUrl = config.baseUrl ?? 'https://v.whatsapp.net'

	return async (request: NativeAndroidRegistrationRequest): Promise<NativeAndroidRegistrationHttpResponse> => {
		const attested = await attestationProvider({
			endpoint: request.endpoint,
			appVariant: config.appVariant,
			phoneNumber: config.phoneNumber,
			login: config.login,
			...(config.profileId ? { profileId: config.profileId } : {}),
			...(config.packageName ? { packageName: config.packageName } : {}),
			body: request.body
		})

		// When the bridge executed the HTTP request inside the APK process,
		// the response is already available and no direct fetch is needed.
		if (attested.apkResponse) {
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
		for (let attempt = 1; attempt <= maxAttempts; ++attempt) {
			const controller = new AbortController()
			const timeout = setTimeout(() => controller.abort(), config.timeoutMs ?? 30_000)
			try {
				const response = await fetchImpl(`${baseUrl.replace(/\/$/, '')}${request.endpoint}`, {
					method: 'POST',
					redirect: 'error',
					headers: {
						'Content-Type': 'application/x-www-form-urlencoded',
						...(attested.authorization ? { Authorization: attested.authorization } : {})
					},
					body: attested.body ?? request.body,
					signal: controller.signal
				})
				const text = await response.text()
				let parsed: unknown
				try {
					parsed = JSON.parse(text)
				} catch {
					throw new Boom(`native_android registration returned invalid JSON (HTTP ${response.status})`, {
						statusCode: DisconnectReason.badSession
					})
				}

				if (!RETRYABLE_STATUS.has(response.status) || attempt === maxAttempts) {
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
