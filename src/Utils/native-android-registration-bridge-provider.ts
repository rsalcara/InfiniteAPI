import { Boom } from '@hapi/boom'
import { DisconnectReason } from '../Types'

export type NativeAndroidRegistrationBridgeProviderConfig = {
	url: string
	token?: string
	allowInsecureLoopbackAliases?: string[]
	timeoutMs?: number
	fetch?: typeof fetch
}

export type NativeAndroidRegistrationBridgeContext = {
	endpoint: '/v2/code' | '/v2/register' | '/v2/security' | '/v2/consent' | '/v2/device_confirm' | '/v2/autoconf'
	appVariant: 'business' | 'consumer'
	phoneNumber: string
	login: string
	profileId?: string
	packageName?: string
	/** UTF-8 query built by the official 1:1 protocol builder. */
	body: string
}

export type NativeAndroidRegistrationBridgeAttestation = {
	/** Official bridge attestation copied verbatim to the HTTP Authorization header. */
	authorization: string
	/** Optional bridge-produced body override. When absent the motor uses its own protocol body. */
	body?: string
	/** When the bridge executed the HTTP request inside the APK, this carries the response. */
	apkResponse?: { status: number; body: string }
}

const MAX_REQUEST_BYTES = 1_048_576
const MAX_RESPONSE_BYTES = 1_048_576

const isLoopbackHost = (hostname: string, aliases?: string[]): boolean => {
	const normalized = hostname.toLowerCase().replace(/^\[|\]$/g, '')
	return (
		normalized === 'localhost' ||
		normalized === '127.0.0.1' ||
		normalized === '::1' ||
		(aliases ?? []).some(alias => alias.toLowerCase() === normalized)
	)
}

export const createNativeAndroidRegistrationBridgeProvider = (
	config: NativeAndroidRegistrationBridgeProviderConfig
): ((context: NativeAndroidRegistrationBridgeContext) => Promise<NativeAndroidRegistrationBridgeAttestation>) => {
	if (!config?.url) throw new Error('native_android registration bridge provider requires a valid http(s) url')

	let bridgeUrl: URL
	try {
		bridgeUrl = new URL(config.url)
	} catch {
		throw new Error('native_android registration bridge provider url is not a valid URL')
	}

	if (bridgeUrl.protocol !== 'http:' && bridgeUrl.protocol !== 'https:') {
		throw new Error('native_android registration bridge provider requires a valid http(s) url')
	}

	if (bridgeUrl.protocol === 'http:' && !isLoopbackHost(bridgeUrl.hostname, config.allowInsecureLoopbackAliases)) {
		throw new Error('native_android registration bridge provider requires HTTPS for non-loopback urls')
	}

	const fetchImpl = config.fetch ?? fetch
	const timeoutMs = config.timeoutMs ?? 30_000

	return async context => {
		if (!context?.endpoint?.startsWith('/v2/')) {
			throw new Boom('native_android registration bridge received an invalid endpoint', {
				statusCode: DisconnectReason.badSession
			})
		}

		if (typeof context.body !== 'string' || Buffer.byteLength(context.body, 'utf8') > MAX_REQUEST_BYTES) {
			throw new Boom('native_android registration bridge body is empty or exceeds the size limit', {
				statusCode: DisconnectReason.badSession
			})
		}

		const controller = new AbortController()
		const timeout = setTimeout(() => controller.abort(), timeoutMs)
		try {
			const response = await fetchImpl(`${config.url.replace(/\/$/, '')}/registration/attestation`, {
				method: 'POST',
				redirect: 'error',
				headers: {
					'Content-Type': 'application/json',
					...(config.token ? { Authorization: `Bearer ${config.token}` } : {})
				},
				body: JSON.stringify({
					endpoint: context.endpoint,
					appVariant: context.appVariant,
					phoneNumber: context.phoneNumber,
					login: context.login,
					...(context.profileId ? { profileId: context.profileId } : {}),
					...(context.packageName ? { packageName: context.packageName } : {}),
					body: context.body
				}),
				signal: controller.signal
			})

			if (!response.ok) {
				await response.body?.cancel().catch(() => undefined)
				throw new Boom(`native_android registration bridge returned HTTP ${response.status}`, {
					statusCode: DisconnectReason.badSession
				})
			}

			const text = await response.text()
			if (Buffer.byteLength(text, 'utf8') > MAX_RESPONSE_BYTES) {
				throw new Boom('native_android registration bridge response exceeds size limit', {
					statusCode: DisconnectReason.badSession
				})
			}

			let data: { authorization?: unknown; body?: unknown; apkResponse?: unknown }
			try {
				data = JSON.parse(text)
			} catch {
				throw new Boom('native_android registration bridge returned invalid JSON', {
					statusCode: DisconnectReason.badSession
				})
			}

			if (typeof data.authorization !== 'string' || data.authorization.length === 0) {
				throw new Boom('native_android registration bridge did not provide attestation', {
					statusCode: DisconnectReason.badSession
				})
			}

			return {
				authorization: data.authorization,
				body: typeof data.body === 'string' ? data.body : undefined,
				apkResponse:
					typeof data.apkResponse === 'object' &&
					data.apkResponse !== null &&
					typeof (data.apkResponse as Record<string, unknown>).status === 'number' &&
					typeof (data.apkResponse as Record<string, unknown>).body === 'string'
						? (data.apkResponse as { status: number; body: string })
						: undefined
			}
		} catch (error) {
			if (error instanceof Error && error.name === 'AbortError') {
				throw new Boom('native_android registration bridge timed out', {
					statusCode: DisconnectReason.timedOut
				})
			}

			throw error
		} finally {
			clearTimeout(timeout)
		}
	}
}
