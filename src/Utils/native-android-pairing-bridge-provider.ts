import { Boom } from '@hapi/boom'
import { Buffer } from 'node:buffer'
import type { NativeAndroidAttestationProvider, NativeAndroidPairingAttestation } from '../Types'
import { DisconnectReason } from '../Types'

export type NativeAndroidPairingBridgeProviderConfig = {
	/**
	 * Base URL of the genuine Android bridge. The bridge must expose
	 * `POST /pairing/attestation` and return Android Keystore plus GPIA material.
	 */
	url: string
	/** Optional bearer token when the bridge requires authentication. */
	token?: string
	/** Request timeout in milliseconds. Defaults to 40 seconds. */
	timeoutMs?: number
	/** Optional custom fetch implementation for testing. */
	fetch?: typeof fetch
}

type PairingBridgeResponse = {
	keyAttestationBase64?: unknown
	gpia?: unknown
	clientAppId?: unknown
}

const MAX_RESPONSE_BYTES = 1_048_576
const MAX_KEY_ATTESTATION_BYTES = 128 * 1024

const isLoopbackHost = (hostname: string): boolean => {
	const normalized = hostname.toLowerCase().replace(/^\[|\]$/g, '')
	return normalized === 'localhost' || normalized === '127.0.0.1' || normalized === '::1'
}

/**
 * Connects the fresh QR `pair-device-sign` flow to the genuine Android
 * installation. Unlike post-login GPIA, pairing requires two bound artifacts:
 * an AndroidKeyStore certificate chain and a Standard Integrity token.
 */
export const createNativeAndroidPairingBridgeProvider = (
	config: NativeAndroidPairingBridgeProviderConfig
): NativeAndroidAttestationProvider => {
	if (!config || typeof config.url !== 'string') {
		throw new Error('native_android pairing bridge requires a valid http(s) url')
	}

	let bridgeUrl: URL
	try {
		bridgeUrl = new URL(config.url)
	} catch {
		throw new Error('native_android pairing bridge url is not a valid URL')
	}

	if (bridgeUrl.protocol !== 'http:' && bridgeUrl.protocol !== 'https:') {
		throw new Error('native_android pairing bridge requires a valid http(s) url')
	}

	if (bridgeUrl.protocol === 'http:' && !isLoopbackHost(bridgeUrl.hostname)) {
		throw new Error('native_android pairing bridge requires HTTPS for non-loopback urls')
	}

	if (config.token !== undefined && typeof config.token !== 'string') {
		throw new Error('native_android pairing bridge token must be a string')
	}

	if (
		config.timeoutMs !== undefined &&
		(!Number.isSafeInteger(config.timeoutMs) || config.timeoutMs <= 0 || config.timeoutMs > 2_147_483_647)
	) {
		throw new Error('native_android pairing bridge timeoutMs must be an integer between 1 and 2147483647')
	}

	const fetchImpl = config.fetch ?? fetch
	const timeoutMs = config.timeoutMs ?? 40_000

	return async (context): Promise<NativeAndroidPairingAttestation> => {
		const identityPublicKey = context.identityPublicKey
		if (!identityPublicKey || identityPublicKey.byteLength === 0) {
			throw new Boom('native_android pairing bridge requires the companion identity public key', {
				statusCode: DisconnectReason.badSession
			})
		}

		const controller = new AbortController()
		const timeout = setTimeout(() => controller.abort(), timeoutMs)

		try {
			const response = await fetchImpl(`${config.url.replace(/\/$/, '')}/pairing/attestation`, {
				method: 'POST',
				redirect: 'error',
				headers: {
					'Content-Type': 'application/json',
					...(config.token ? { Authorization: `Bearer ${config.token}` } : {})
				},
				body: JSON.stringify({
					profileId: context.profileId,
					appVariant: context.appVariant,
					clientAppId: context.clientAppId,
					packageName: context.packageName,
					challenge: Buffer.from(identityPublicKey).toString('base64')
				}),
				signal: controller.signal
			})

			if (!response.ok) {
				await response.body?.cancel().catch(() => undefined)
				throw new Boom(`native_android pairing bridge returned HTTP ${response.status}`, {
					statusCode: DisconnectReason.badSession
				})
			}

			const text = await readBodyWithLimit(response, MAX_RESPONSE_BYTES)
			let data: PairingBridgeResponse
			try {
				data = JSON.parse(text) as PairingBridgeResponse
			} catch {
				throw new Boom('native_android pairing bridge returned invalid JSON', {
					statusCode: DisconnectReason.badSession
				})
			}

			if (typeof data.keyAttestationBase64 !== 'string' || data.keyAttestationBase64.length === 0) {
				throw new Boom('native_android pairing bridge returned an empty key attestation', {
					statusCode: DisconnectReason.badSession
				})
			}

			const keyAttestation = Buffer.from(data.keyAttestationBase64, 'base64')
			if (keyAttestation.byteLength === 0 || keyAttestation.byteLength > MAX_KEY_ATTESTATION_BYTES) {
				throw new Boom('native_android pairing bridge returned an invalid key attestation size', {
					statusCode: DisconnectReason.badSession
				})
			}

			if (typeof data.gpia !== 'string' || data.gpia.length === 0) {
				throw new Boom('native_android pairing bridge returned empty GPIA material', {
					statusCode: DisconnectReason.badSession
				})
			}

			if (data.clientAppId !== context.clientAppId) {
				throw new Boom('native_android pairing bridge returned an unexpected client-app-id', {
					statusCode: DisconnectReason.badSession
				})
			}

			return {
				keyAttestation,
				gpia: data.gpia,
				clientAppId: context.clientAppId
			}
		} catch (error) {
			if (error instanceof Error && error.name === 'AbortError') {
				throw new Boom('native_android pairing bridge provider timed out', {
					statusCode: DisconnectReason.timedOut
				})
			}

			throw error
		} finally {
			clearTimeout(timeout)
		}
	}
}

const readBodyWithLimit = async (response: Response, limit: number): Promise<string> => {
	const declaredLength = Number(response.headers?.get('content-length') ?? 0)
	if (Number.isFinite(declaredLength) && declaredLength > limit) {
		await response.body?.cancel().catch(() => undefined)
		throw new Boom('native_android pairing bridge response exceeds size limit', {
			statusCode: DisconnectReason.badSession
		})
	}

	const reader = response.body?.getReader()
	if (!reader) return response.text()

	const chunks: Uint8Array[] = []
	let total = 0
	for (;;) {
		const { done, value } = await reader.read()
		if (done) break
		total += value.byteLength
		if (total > limit) {
			await reader.cancel().catch(() => undefined)
			throw new Boom('native_android pairing bridge response exceeds size limit', {
				statusCode: DisconnectReason.badSession
			})
		}

		chunks.push(value)
	}

	const decoder = new TextDecoder()
	return chunks.map(chunk => decoder.decode(chunk, { stream: true })).join('') + decoder.decode()
}
