import { Boom } from '@hapi/boom'
import type { NativeAndroidAttestationProvider, NativeAndroidPairingAttestation } from '../Types'

export type NativeAndroidProviderBridgeOptions = {
	baseUrl: string
	bearerToken?: string
	expectedPackageName?: string
	timeoutMs?: number
	minValidityMs?: number
	fetchImplementation?: typeof fetch
	now?: () => number
}

type BridgeAttestationResponse = {
	keyAttestationBase64?: unknown
	gpiaBase64?: unknown
	clientAppId?: unknown
	packageName?: unknown
	appVariant?: unknown
	targetPackageName?: unknown
	generatedAtMs?: unknown
	expiresAtMs?: unknown
}

const decodeBase64 = (value: unknown, field: string, allowEmpty: boolean) => {
	if (typeof value !== 'string' || (!allowEmpty && value.length === 0)) {
		throw new Boom(`native_android provider: ${field} is missing`, { statusCode: 502 })
	}

	if (value.length > 128 * 1024 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) {
		throw new Boom(`native_android provider: ${field} is not valid base64`, { statusCode: 502 })
	}

	const decoded = Buffer.from(value, 'base64')
	if (!allowEmpty && decoded.length === 0) {
		throw new Boom(`native_android provider: ${field} decoded to an empty value`, { statusCode: 502 })
	}

	return decoded
}

const normalizeBaseUrl = (value: string) => {
	let url: URL
	try {
		url = new URL(value)
	} catch {
		throw new Boom('native_android provider: baseUrl is invalid', { statusCode: 400 })
	}

	if (url.protocol !== 'http:' && url.protocol !== 'https:') {
		throw new Boom('native_android provider: baseUrl must use http or https', { statusCode: 400 })
	}

	url.pathname = url.pathname.replace(/\/+$/, '')
	url.search = ''
	url.hash = ''

	return url
}

export const makeNativeAndroidBridgeAttestationProvider = (
	options: NativeAndroidProviderBridgeOptions
): NativeAndroidAttestationProvider => {
	const baseUrl = normalizeBaseUrl(options.baseUrl)
	const timeoutMs = options.timeoutMs ?? 10_000
	const minValidityMs = options.minValidityMs ?? 30_000
	const fetchImplementation = options.fetchImplementation ?? globalThis.fetch
	const now = options.now ?? Date.now
	const expectedProviderPackageName = options.expectedPackageName ?? 'com.rsalcara.infiniteapi.attestation'

	if (typeof fetchImplementation !== 'function') {
		throw new Boom('native_android provider: fetch is unavailable', { statusCode: 500 })
	}

	if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
		throw new Boom('native_android provider: timeoutMs must be a positive safe integer', { statusCode: 400 })
	}

	if (!Number.isSafeInteger(minValidityMs) || minValidityMs < 0) {
		throw new Boom('native_android provider: minValidityMs must be a non-negative safe integer', {
			statusCode: 400
		})
	}

	return async ({ profileId, appVariant, clientAppId, packageName }): Promise<NativeAndroidPairingAttestation> => {
		const controller = new AbortController()
		const timeout = setTimeout(() => controller.abort(), timeoutMs)
		let response: Response
		try {
			response = await fetchImplementation(new URL('/v1/attestation', baseUrl), {
				method: 'POST',
				headers: {
					'content-type': 'application/json',
					...(options.bearerToken ? { authorization: `Bearer ${options.bearerToken}` } : {})
				},
				body: JSON.stringify({ profileId, appVariant, clientAppId, packageName }),
				signal: controller.signal
			})
		} catch (error) {
			const reason = error instanceof Error ? error.message : String(error)
			throw new Boom(`native_android provider request failed: ${reason}`, { statusCode: 502 })
		} finally {
			clearTimeout(timeout)
		}

		if (!response.ok) {
			const detail = (await response.text()).slice(0, 512)
			throw new Boom(
				`native_android provider rejected attestation request: HTTP ${response.status}${detail ? `: ${detail}` : ''}`,
				{ statusCode: 502 }
			)
		}

		let payload: BridgeAttestationResponse
		try {
			payload = (await response.json()) as BridgeAttestationResponse
		} catch {
			throw new Boom('native_android provider returned invalid JSON', { statusCode: 502 })
		}

		if (typeof payload.packageName !== 'string' || payload.packageName !== expectedProviderPackageName) {
			throw new Boom(
				`native_android provider package mismatch: expected ${expectedProviderPackageName}, received ${String(payload.packageName)}`,
				{ statusCode: 502 }
			)
		}

		if (payload.appVariant !== undefined && payload.appVariant !== appVariant) {
			throw new Boom(`native_android provider returned an unexpected app variant: ${String(payload.appVariant)}`, {
				statusCode: 502
			})
		}

		if (payload.targetPackageName !== undefined && payload.targetPackageName !== packageName) {
			throw new Boom(
				`native_android provider target package mismatch: expected ${packageName}, received ${String(payload.targetPackageName)}`,
				{ statusCode: 502 }
			)
		}

		if (
			typeof payload.expiresAtMs !== 'number' ||
			!Number.isSafeInteger(payload.expiresAtMs) ||
			payload.expiresAtMs < now() + minValidityMs
		) {
			throw new Boom('native_android provider returned an expired or insufficiently fresh attestation', {
				statusCode: 502
			})
		}

		if (payload.clientAppId !== clientAppId) {
			throw new Boom(`native_android provider returned an unexpected client-app-id for ${appVariant}`, {
				statusCode: 502
			})
		}

		return {
			keyAttestation: decodeBase64(payload.keyAttestationBase64, 'keyAttestationBase64', false),
			gpia: decodeBase64(payload.gpiaBase64, 'gpiaBase64', true),
			clientAppId
		}
	}
}
