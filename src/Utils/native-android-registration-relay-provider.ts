import { Boom } from '@hapi/boom'
import type { NativeAndroidAppVersion, NativeAndroidDeviceProfile } from '../Types'
import { DisconnectReason } from '../Types'
import { verifyNativeAndroidRegistrationAttestationProof } from './native-android-registration-attestation-validation'
import type {
	NativeAndroidRegistrationBridgeAttestation,
	NativeAndroidRegistrationBridgeContext
} from './native-android-registration-bridge-provider'
import {
	buildNativeAndroidRegistrationUserAgent,
	mapAttestedDeviceProfile
} from './native-android-registration-device-attestation'
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
	/**
	 * Static server key for the `ENC=` envelope. Omitted = the built-in official
	 * key (the APK seals every endpoint); the signed-plaintext fallback only
	 * happens when the seal throws.
	 */
	envelopeMaterial?: NativeAndroidRegistrationEnvelopeMaterial
	/**
	 * Explicit User-Agent override (e.g. the session's raffled identity). Takes
	 * precedence over the built UA; see the coherence note on `deviceProfile`.
	 */
	userAgent?: string
	/**
	 * Announced build for the derived User-Agent (audit gap A): pass
	 * `materialManifestAppVersion(material.manifest)` so the wire UA names the
	 * build whose token material signs this registration — the device is
	 * authoritative for hardware, never for the APK version.
	 */
	appVersion?: NativeAndroidAppVersion
	/**
	 * Raffled profile fallback used only when the device returns no profile.
	 * When a physical device attests, prefer its real profile: the Keystore
	 * chain is TEE-signed and reveals the true hardware, so a raffled UA next
	 * to a foreign device chain is cross-checkable.
	 */
	deviceProfile?: Pick<NativeAndroidDeviceProfile, 'manufacturer' | 'deviceModelType' | 'osVersion'>
	/**
	 * Binding material for the Keystore attestation challenge — the registration
	 * `authkey` (client static pubkey). REQUIRED on the primary path: the device
	 * wraps it as `timestampSeconds(uint64 BE) || 0x1f || material` into
	 * `setAttestationChallenge` (APK `X/C15E` "blacknoise", 1:1 in
	 * `RegistrationAttestationSigner.generateStaticKey`). Without material the
	 * device signs a random challenge and the attestation↔authkey binding never
	 * closes, so the relay refuses to run without it.
	 */
	challenge: Uint8Array
	/**
	 * Installation identity the attested application id should name (package +
	 * signing-certificate sha-256, both from the registration token material).
	 */
	installIdentity?: { packageName: string; signingCertSha256: string }
	/**
	 * `reject` throws when the attested install identity diverges from
	 * `installIdentity`; `report` (default) keeps the proof flowing and records
	 * the divergence in the attestation diagnostics for the correlation log.
	 */
	installIdentityPolicy?: 'reject' | 'report'
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

	// Fail-closed at construction: the primary registration path must carry the
	// authkey binding material into the Keystore challenge (audit gap — the
	// challenge used to be silently omitted when absent).
	if (!(config.challenge instanceof Uint8Array) || config.challenge.length === 0) {
		throw new Error('native_android registration relay provider requires the attestation binding material')
	}

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
 * the motor owns the protocol (token, query, `ENC=` envelope) and only the
 * Keystore signature (`H=`) and key chain (`Authorization`) come from the
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
		const challengeBase64 = Buffer.from(config.challenge).toString('base64')

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
				// packageName/appVariant name the app the proof is FOR: the relay
				// endpoint defaults to `com.whatsapp.w4b` when neither is present,
				// which silently ran consumer registrations as business.
				body: JSON.stringify({
					payloadBase64,
					challengeBase64,
					...(context.packageName ? { packageName: context.packageName } : {}),
					...(context.appVariant ? { appVariant: context.appVariant } : {})
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
			// Pre-send proof validation (audit gap): the parser above only
			// bounds the strings; this checks the signature over the exact
			// signed bytes, the certificate chain, the challenge binding and
			// the attested install identity BEFORE the request goes out.
			const attestation = verifyNativeAndroidRegistrationAttestationProof({
				payloadToSign: wire.payloadToSign,
				signature: data.h,
				authorization: data.authorization,
				challengeMaterial: config.challenge,
				...(config.installIdentity?.packageName ? { packageName: config.installIdentity.packageName } : {}),
				...(config.installIdentity?.signingCertSha256
					? { signingCertSha256: config.installIdentity.signingCertSha256 }
					: {}),
				installIdentityPolicy: config.installIdentityPolicy ?? 'report'
			})
			// The device is authoritative only for its Keystore material and its
			// real hardware: the version/platform pair is a property of the APK
			// build the token material comes from (server-side), and the server
			// rejects a token whose announced version is another build's
			// (`bad_token`). So the motor builds the UA — variant version and
			// platform token over the device's real Build.* fields — and the
			// device-supplied `userAgent` is only a last-resort fallback.
			const profile = mapAttestedDeviceProfile(data.deviceProfile) ?? config.deviceProfile
			const userAgent =
				config.userAgent ??
				(profile
					? buildNativeAndroidRegistrationUserAgent(profile, context.appVariant, config.appVersion)
					: data.userAgent)

			return {
				authorization: data.authorization,
				body: `${wire.body}&H=${data.h}`,
				attestation,
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
