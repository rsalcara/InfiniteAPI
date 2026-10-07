import { Boom } from '@hapi/boom'
import type { NativeAndroidDeviceProfile } from '../Types'
import { DisconnectReason } from '../Types'
import type {
	NativeAndroidRegistrationBridgeAttestation,
	NativeAndroidRegistrationBridgeContext
} from './native-android-registration-bridge-provider'
import { buildNativeAndroidRegistrationUserAgent } from './native-android-registration-device-attestation'
import {
	buildNativeAndroidRegistrationWireBody,
	type NativeAndroidRegistrationEnvelopeMaterial
} from './native-android-registration-envelope'

export type NativeAndroidRegistrationRelayProviderConfig = {
	/**
	 * Platform base URL exposing the companion relay
	 * (`POST <url>/registration/attestation`), the same host the Connector
	 * WebSocket uses. The platform fans the request out to the paired physical
	 * device, which signs with its Android Keystore and answers automatically.
	 */
	url: string
	token?: string
	allowInsecureLoopbackAliases?: string[]
	timeoutMs?: number
	fetch?: typeof fetch
	/** Static server key for the `enc=` envelope; omitted sends the signed-plaintext fallback. */
	envelopeMaterial?: NativeAndroidRegistrationEnvelopeMaterial
	/**
	 * Explicit User-Agent override (e.g. the session's raffled identity). Takes
	 * precedence over the physical device's own UA; see the coherence note on
	 * `deviceProfile`.
	 */
	userAgent?: string
	/**
	 * Raffled profile fallback used only when the relay returns no device UA.
	 * When a physical device attests, prefer its real profile: the Keystore
	 * chain is TEE-signed and reveals the true hardware, so a raffled UA next
	 * to a foreign device chain is cross-checkable.
	 */
	deviceProfile?: Pick<NativeAndroidDeviceProfile, 'manufacturer' | 'deviceModelType' | 'osVersion'>
	/**
	 * Attestation challenge bound into the Keystore key generation (the APK's
	 * `metadata.A0I()` client static pubkey on the official wire). Omitting it
	 * lets the device fall back to its random 32-byte challenge, exactly like
	 * the APK does when no metadata is available.
	 */
	challenge?: Uint8Array
}

const MAX_REQUEST_BYTES = 1_048_576
const MAX_RESPONSE_BYTES = 1_048_576
const MAX_H_LENGTH = 512
const MAX_AUTHORIZATION_LENGTH = 16_384

const isLoopbackHost = (hostname: string, aliases?: string[]): boolean => {
	const normalized = hostname.toLowerCase().replace(/^\[|\]$/g, '')
	return (
		normalized === 'localhost' ||
		normalized === '127.0.0.1' ||
		normalized === '::1' ||
		(aliases ?? []).some(alias => alias.toLowerCase() === normalized)
	)
}

const validateRelayConfig = (config: NativeAndroidRegistrationRelayProviderConfig): void => {
	if (!config?.url) throw new Error('native_android registration relay provider requires a valid http(s) url')

	let relayUrl: URL
	try {
		relayUrl = new URL(config.url)
	} catch {
		throw new Error('native_android registration relay provider url is not a valid URL')
	}

	if (relayUrl.protocol !== 'http:' && relayUrl.protocol !== 'https:') {
		throw new Error('native_android registration relay provider requires a valid http(s) url')
	}

	if (relayUrl.protocol === 'http:' && !isLoopbackHost(relayUrl.hostname, config.allowInsecureLoopbackAliases)) {
		throw new Error('native_android registration relay provider requires HTTPS for non-loopback urls')
	}
}

type RelayRegistrationResponse = {
	h?: unknown
	authorization?: unknown
	userAgent?: unknown
	deviceProfile?: unknown
}

type RelayAttestationPayload = {
	h: string
	authorization: string
	userAgent?: string
	deviceProfile?: Record<string, string>
}

const parseRelayResponse = (text: string): RelayAttestationPayload => {
	let data: RelayRegistrationResponse
	try {
		data = JSON.parse(text)
	} catch {
		throw new Boom('native_android registration relay returned invalid JSON', {
			statusCode: DisconnectReason.badSession
		})
	}

	if (typeof data.h !== 'string' || data.h.length === 0 || data.h.length > MAX_H_LENGTH) {
		throw new Boom('native_android registration relay did not provide the payload signature', {
			statusCode: DisconnectReason.badSession
		})
	}

	if (
		typeof data.authorization !== 'string' ||
		data.authorization.length === 0 ||
		data.authorization.length > MAX_AUTHORIZATION_LENGTH
	) {
		throw new Boom('native_android registration relay did not provide attestation', {
			statusCode: DisconnectReason.badSession
		})
	}

	return {
		h: data.h,
		authorization: data.authorization,
		userAgent: typeof data.userAgent === 'string' && data.userAgent.length > 0 ? data.userAgent : undefined,
		deviceProfile:
			typeof data.deviceProfile === 'object' && data.deviceProfile !== null
				? (data.deviceProfile as Record<string, string>)
				: undefined
	}
}

/**
 * Self-computed attestation provider backed by the paired physical device:
 * the motor owns the protocol (token, query, `enc=` envelope) and only the
 * Keystore signature (`h=`) and key chain (`Authorization`) come from the
 * device, via the platform's companion relay. The device answers without any
 * user interaction — the Connector app signs on message receipt.
 *
 * The returned `h` and `authorization` are copied VERBATIM from the device:
 * they were produced by the APK's own `Base64.encodeToString(sig, 11)` /
 * `Base64.encodeToString(chain, 2)` calls, so the wire encoding is the
 * official flag-11 / flag-2 form without a Node re-encode step.
 */
export const createNativeAndroidRegistrationRelayProvider = (
	config: NativeAndroidRegistrationRelayProviderConfig
): ((context: NativeAndroidRegistrationBridgeContext) => Promise<NativeAndroidRegistrationBridgeAttestation>) => {
	validateRelayConfig(config)

	const fetchImpl = config.fetch ?? fetch
	const timeoutMs = config.timeoutMs ?? 30_000

	return async context => {
		if (typeof context?.body !== 'string' || Buffer.byteLength(context.body, 'utf8') > MAX_REQUEST_BYTES) {
			throw new Boom('native_android registration relay body is empty or exceeds the size limit', {
				statusCode: DisconnectReason.badSession
			})
		}

		const wire = buildNativeAndroidRegistrationWireBody(context.body, config.envelopeMaterial)

		const payloadBase64 = Buffer.from(wire.payloadToSign).toString('base64')
		const challengeBase64 = config.challenge?.length ? Buffer.from(config.challenge).toString('base64') : undefined

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
					payloadBase64,
					...(challengeBase64 ? { challengeBase64 } : {})
				}),
				signal: controller.signal
			})

			if (!response.ok) {
				await response.body?.cancel().catch(() => undefined)
				throw new Boom(`native_android registration relay returned HTTP ${response.status}`, {
					statusCode: DisconnectReason.badSession
				})
			}

			const text = await response.text()
			if (Buffer.byteLength(text, 'utf8') > MAX_RESPONSE_BYTES) {
				throw new Boom('native_android registration relay response exceeds size limit', {
					statusCode: DisconnectReason.badSession
				})
			}

			const data = parseRelayResponse(text)
			const userAgent =
				config.userAgent ??
				data.userAgent ??
				(config.deviceProfile ? buildNativeAndroidRegistrationUserAgent(config.deviceProfile) : undefined)

			return {
				authorization: data.authorization,
				body: `${wire.body}&h=${data.h}`,
				...(userAgent ? { userAgent } : {}),
				...(data.deviceProfile ? { deviceProfile: data.deviceProfile } : {})
			}
		} catch (error) {
			if (error instanceof Error && error.name === 'AbortError') {
				throw new Boom('native_android registration relay timed out', {
					statusCode: DisconnectReason.timedOut
				})
			}

			throw error
		} finally {
			clearTimeout(timeout)
		}
	}
}
