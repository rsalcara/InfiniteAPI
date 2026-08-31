import { Boom } from '@hapi/boom'
import type { NativeAndroidGpiaChallenge, NativeAndroidGpiaResponse } from '../Types'
import { DisconnectReason } from '../Types'

export type NativeAndroidBridgeProviderConfig = {
	/**
	 * Base URL of the external bridge service. The service must expose
	 * `POST /integrity/gpia` and return `{ jws: string }`.
	 */
	url: string
	/** Optional bearer token when the bridge requires authentication. */
	token?: string
	/** Request timeout in milliseconds. Defaults to 25 seconds. */
	timeoutMs?: number
	/** Optional custom fetch implementation for testing. */
	fetch?: typeof fetch
}

const MAX_BRIDGE_RESPONSE_BYTES = 1_048_576

/**
 * Connects the InfiniteAPI GPIA lifecycle to an external bridge service that
 * has a genuine Android installation with Google Play Services. The bridge is
 * responsible for obtaining a legitimate Play Integrity token bound to the
 * challenge nonce. InfiniteAPI never fabricates, caches, or replays tokens.
 */
export const createNativeAndroidBridgeProvider = (
	config: NativeAndroidBridgeProviderConfig
): ((challenge: NativeAndroidGpiaChallenge) => Promise<NativeAndroidGpiaResponse>) => {
	if (!config || typeof config.url !== 'string' || !config.url.startsWith('http')) {
		throw new Error('native_android bridge provider requires a valid http(s) url')
	}

	if (config.token !== undefined && typeof config.token !== 'string') {
		throw new Error('native_android bridge provider token must be a string')
	}

	if (config.timeoutMs !== undefined && (!Number.isFinite(config.timeoutMs) || config.timeoutMs <= 0)) {
		throw new Error('native_android bridge provider timeoutMs must be a positive number')
	}

	if (config.timeoutMs !== undefined && config.timeoutMs > 2_147_483_647) {
		throw new Error('native_android bridge provider timeoutMs exceeds the Node timer range')
	}

	try {
		new URL(config.url)
	} catch {
		throw new Error('native_android bridge provider url is not a valid URL')
	}

	const fetchImpl = config.fetch ?? fetch
	const timeoutMs = config.timeoutMs ?? 25_000

	return async (challenge: NativeAndroidGpiaChallenge): Promise<NativeAndroidGpiaResponse> => {
		if (challenge.signal.aborted) {
			throw new Error('native_android bridge request aborted before dispatch')
		}

		const controller = new AbortController()
		const onAbort = () => controller.abort()
		challenge.signal.addEventListener('abort', onAbort, { once: true })
		let timedOut = false
		const timeout = setTimeout(() => {
			timedOut = true
			controller.abort()
		}, timeoutMs)

		try {
			const response = await fetchImpl(`${config.url.replace(/\/$/, '')}/integrity/gpia`, {
				method: 'POST',
				headers: {
					'Content-Type': 'application/json',
					...(config.token ? { Authorization: `Bearer ${config.token}` } : {})
				},
				body: JSON.stringify({
					kind: 'gpia',
					nonce: challenge.nonce,
					requestHash: challenge.requestHash,
					cloudProjectNumber: challenge.cloudProjectNumber,
					profileId: challenge.profileId,
					appVariant: challenge.appVariant,
					clientAppId: challenge.clientAppId,
					packageName: challenge.packageName
				}),
				signal: controller.signal
			})

			if (!response.ok) {
				throw new Error(`native_android bridge returned HTTP ${response.status}`)
			}

			const contentLength = Number(response.headers?.get('content-length') ?? 0)
			if (contentLength > MAX_BRIDGE_RESPONSE_BYTES) {
				throw new Error('native_android bridge response exceeds size limit')
			}

			const data = (await response.json()) as { jws?: unknown }
			if (typeof data.jws === 'string' && data.jws.length > MAX_BRIDGE_RESPONSE_BYTES) {
				throw new Error('native_android bridge response exceeds size limit')
			}

			if (typeof data.jws !== 'string' || data.jws.length === 0) {
				throw new Error('native_android bridge returned an invalid jws')
			}

			return { jws: data.jws }
		} catch (error) {
			if (timedOut && error instanceof Error && error.name === 'AbortError') {
				throw new Boom('native_android bridge provider timed out', {
					statusCode: DisconnectReason.timedOut
				})
			}

			throw error
		} finally {
			clearTimeout(timeout)
			challenge.signal.removeEventListener('abort', onAbort)
		}
	}
}
