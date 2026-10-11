import { Boom } from '@hapi/boom'
import { DisconnectReason } from '../Types'
import type { NativeAndroidAttestationProofDiagnostics } from './native-android-registration-attestation-validation'
import type {
	NativeAndroidRegistrationEndpoint,
	NativeAndroidRequestCodeEnvironment
} from './native-android-registration-protocol'

export type NativeAndroidRegistrationBridgeProviderConfig = {
	url: string
	token?: string
	allowInsecureLoopbackAliases?: string[]
	timeoutMs?: number
	fetch?: typeof fetch
}

export type NativeAndroidRegistrationBridgeContext = {
	endpoint: NativeAndroidRegistrationEndpoint
	appVariant: 'business' | 'consumer'
	phoneNumber: string
	login: string
	/**
	 * Official user type: 0 (or absent) is the primary phone flow; 1 is the
	 * WA_TWO_FA_CONTACT_POINT flow whose token is keyed on the `login` digits.
	 */
	registrationType?: 0 | 1
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
	/** Official client User-Agent for the wire. When absent the client sends none. */
	userAgent?: string
	/**
	 * Real hardware profile reported by the attesting device (Build.* fields),
	 * when a physical device produced the material. Lets the caller keep the
	 * wire UA coherent with the TEE-signed key chain.
	 */
	deviceProfile?: Record<string, string>
	/**
	 * Pre-send proof validation diagnostics (signature, chain, challenge
	 * binding, attested install identity). Present when a validating provider
	 * produced the proof; feeds the sanitized correlation log.
	 */
	attestation?: NativeAndroidAttestationProofDiagnostics
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

const validateBridgeConfig = (config: NativeAndroidRegistrationBridgeProviderConfig): void => {
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
}

export const createNativeAndroidRegistrationBridgeProvider = (
	config: NativeAndroidRegistrationBridgeProviderConfig
): ((context: NativeAndroidRegistrationBridgeContext) => Promise<NativeAndroidRegistrationBridgeAttestation>) => {
	validateBridgeConfig(config)

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
					...(context.registrationType !== undefined ? { registrationType: context.registrationType } : {}),
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

/**
 * Keys whose hook values arrive pre-percent-encoded from the native WAMSYS
 * map (COP.A0T -> CJT.A07). Decoding them back to bytes here lets the protocol
 * builder encode exactly once at serialization, so the wire never carries a
 * double-encoded `%`.
 */
const NATIVE_BLOB_ENV_KEYS = new Set(['_gs', '_ga', 'aid', '_gp', '_gg', '_ge', '_gi'])

/** Explicitly-absent install-source diagnostics keep their null. */
const NULLABLE_ENV_KEYS = new Set(['initiating_package', 'install_source_consistent'])

/**
 * The environment keys the APK actually serializes (the protocol builder's
 * `NativeAndroidRequestCodeEnvironment`). Anything else the hook sends is a
 * diagnostic and never reaches the wire.
 */
const KNOWN_ENV_KEYS = new Set([
	...NATIVE_BLOB_ENV_KEYS,
	'mcc',
	'mnc',
	'sim_mcc',
	'sim_mnc',
	'sim_type',
	'airplane_mode_type',
	'cellular_strength',
	'roaming_type',
	'network_radio_type',
	'device_ram',
	'pid',
	'rc',
	'hasinrc',
	'gpia',
	'db',
	'hasav',
	'mistyped',
	'simnum',
	'recaptcha',
	'prefer_sms_over_flash',
	'client_metrics',
	'education_screen_displayed',
	'feo2_query_status',
	'reason',
	'installer_package',
	'package_source',
	'installing_package',
	...NULLABLE_ENV_KEYS,
	'push_token',
	'backup_token_error',
	'language_selector_time_spent',
	'language_selector_clicked_count',
	'read_phone_permission_granted',
	'is_foa_fdid_app_installed',
	'device_name',
	'sim_state',
	'offline_ab',
	'network_operator_name'
])

/** Inverse of the hook's percent encoder: `%XX` escapes become raw bytes. */
export const percentDecodeRegistrationBytes = (value: string): Uint8Array => {
	const bytes: number[] = []
	for (let index = 0; index < value.length; ++index) {
		const char = value[index]!
		if (char === '%' && index + 2 < value.length) {
			const hex = value.slice(index + 1, index + 3)
			if (/^[0-9a-fA-F]{2}$/.test(hex)) {
				bytes.push(Number.parseInt(hex, 16))
				index += 2
				continue
			}
		}

		bytes.push(...Buffer.from(char, 'utf8'))
	}

	return Uint8Array.from(bytes)
}

/**
 * Converts the bridge's flat environment JSON into the builder's environment
 * type: native-map blobs become raw bytes (single encode at serialization),
 * telephony/device scalars pass through untouched, unknown keys are dropped.
 */
export const mapBridgeRegistrationEnvironment = (raw: Record<string, unknown>): NativeAndroidRequestCodeEnvironment => {
	const environment: Record<string, unknown> = {}
	for (const [key, value] of Object.entries(raw)) {
		if (!KNOWN_ENV_KEYS.has(key)) continue
		if (value === undefined) continue
		if (value === null) {
			if (NULLABLE_ENV_KEYS.has(key)) environment[key] = null
			continue
		}

		if (NATIVE_BLOB_ENV_KEYS.has(key)) {
			if (typeof value === 'string') environment[key] = percentDecodeRegistrationBytes(value)
			continue
		}

		if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
			environment[key] = value
		}
	}

	return environment as NativeAndroidRequestCodeEnvironment
}

export type NativeAndroidRegistrationEnvironmentProviderOptions = {
	/**
	 * `authkey` do registro (o `metadata.A0I()` do APK). O device o devolve em
	 * Base64 URL_SAFE|NO_WRAP como `requestHash` do Play Integrity Standard que
	 * produz o campo `gpia` — 1:1 com o `gpia-param-prepare` oficial
	 * (C42288Ijh case 16 → HXY.A02), que amarra o token ao authkey enviado.
	 */
	challenge?: Uint8Array
}

export type NativeAndroidRegistrationEnvironmentProvider = (
	appVariant: 'business' | 'consumer',
	options?: NativeAndroidRegistrationEnvironmentProviderOptions
) => Promise<NativeAndroidRequestCodeEnvironment>

/**
 * Fetches the real-device registration environment from the bridge
 * (POST /registration/environment, answered by the in-APK
 * `collectRegistrationEnvironment` hook). The result feeds the /v2/code
 * builder verbatim; absent fields stay absent — nothing is fabricated.
 */
export const createNativeAndroidRegistrationEnvironmentProvider = (
	config: NativeAndroidRegistrationBridgeProviderConfig
): NativeAndroidRegistrationEnvironmentProvider => {
	validateBridgeConfig(config)

	const fetchImpl = config.fetch ?? fetch
	const timeoutMs = config.timeoutMs ?? 30_000

	return async (appVariant, options) => {
		if (appVariant !== 'business' && appVariant !== 'consumer') {
			throw new Boom('native_android registration environment requires an app variant', {
				statusCode: DisconnectReason.badSession
			})
		}

		const controller = new AbortController()
		const timeout = setTimeout(() => controller.abort(), timeoutMs)
		try {
			const response = await fetchImpl(`${config.url.replace(/\/$/, '')}/registration/environment`, {
				method: 'POST',
				redirect: 'error',
				headers: {
					'Content-Type': 'application/json',
					...(config.token ? { Authorization: `Bearer ${config.token}` } : {})
				},
				body: JSON.stringify({
					appVariant,
					...(options?.challenge?.length
						? { challengeBase64: Buffer.from(options.challenge).toString('base64') }
						: {})
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

			let data: { environment?: unknown }
			try {
				data = JSON.parse(text)
			} catch {
				throw new Boom('native_android registration bridge returned invalid JSON', {
					statusCode: DisconnectReason.badSession
				})
			}

			const environment = data.environment
			if (typeof environment !== 'object' || environment === null || Array.isArray(environment)) {
				throw new Boom('native_android registration bridge did not provide an environment', {
					statusCode: DisconnectReason.badSession
				})
			}

			return mapBridgeRegistrationEnvironment(environment as Record<string, unknown>)
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
