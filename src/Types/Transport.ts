import type { BinaryNode } from '../WABinary'

export type ConnectionTransportProfile = 'web' | 'native_android'

export type WebConnectionPreset = 'web_legacy' | 'web_windows_hybrid'
export type NativeAndroidConnectionPreset = 'native_android_consumer' | 'native_android_business'
export type ConnectionPreset = WebConnectionPreset | NativeAndroidConnectionPreset

/** Durable Web identity selected when the session is first opened. */
export type PersistedWebTransportIdentity = {
	schemaVersion: 1
	profile: 'web'
	preset: WebConnectionPreset
	browser: [string, string, string]
	syncFullHistory: boolean
}

export type NativeAndroidAppVersion = readonly [number, number, number, number]
export type NativeAndroidAppVariant = 'business' | 'consumer'

/** Immutable Build.* values captured together from one Android installation. */
export type NativeAndroidHardwareProfile = {
	profileId: string
	/** captured = exact Build.* tuple; catalog = internally coherent supported catalog tuple. */
	quality: 'captured' | 'catalog'
	commercialName: string
	fallback?: boolean
	manufacturer: string
	device: string
	deviceBoard: string
	deviceModelType: string
	osVersion: string
	osBuildNumber: string
	yearClass?: number
	memClass?: number
	oc?: boolean
}

/**
 * Concrete Android identity observed from a real device or controlled emulator.
 * Build.* values come from one verified hardware profile. Per-installation
 * identifiers are generated once with the official UUID encoding and persisted.
 */
export type NativeAndroidDeviceProfile = {
	profileId: string
	quality?: NativeAndroidHardwareProfile['quality']
	commercialName?: string
	fallback?: boolean
	manufacturer: string
	device: string
	osVersion: string
	osBuildNumber: string
	phoneId: string
	deviceExpId: string
	phoneIdTimestamp?: number
	perfDeviceId?: string
	mcc: string
	mnc: string
	localeLanguageIso6391: string
	localeCountryIso31661Alpha2: string
	deviceBoard?: string
	deviceModelType?: string
	yearClass?: number
	memClass?: number
	oc?: boolean
}

export type NativeAndroidPairingAttestation = {
	keyAttestation: Uint8Array
	gpia: Uint8Array | string
	/**
	 * The official fresh-QR flow emits the application-specific value as the
	 * fourth pair-device-sign child, after key_attestation and gpia.
	 */
	clientAppId: Uint8Array | string
}

/** Dynamic values read by the official app from its remote configuration. */
export type NativeAndroidHistorySyncProfile = {
	fullSyncDaysLimit: number
	fullSyncSizeMbLimit: number
	thumbnailSyncDaysLimit: number
	supportGroupHistory: boolean
	onDemandReady: boolean
	supportHatchHistory: boolean
	supportedBotChannelFbids: string[]
}

export type NativeAndroidProxyConfig = {
	/** The proxy is an egress boundary for the native transport. */
	type: 'http-connect' | 'https-connect' | 'socks4' | 'socks5'
	host: string
	port: number
	username?: string
	password?: string
	/** SOCKS5 resolves WhatsApp hostnames remotely by default. */
	resolveDns?: boolean
}

export type NativeAndroidConnectionEndpoint = {
	host: string
	port: number
	address?: string
	source?: 'configured' | 'history' | 'server' | 'dns' | 'hardcoded' | 'edge' | 'fallback'
	/**
	 * Official ConnectionSequence state that produced this endpoint. Server
	 * endpoints use state 2 (primary) or 8 (secondary).
	 */
	sequenceStep?: number
}

export type NativeAndroidAttestationProvider = (context: {
	stanza: BinaryNode
	profileId: string
	appVariant: NativeAndroidAppVariant
	clientAppId: string
	packageName: string
}) => Promise<NativeAndroidPairingAttestation>

export type NativeAndroidTransportConfig = {
	/** A second explicit gate in addition to transportProfile. */
	enabled: true
	host?: string
	port?: number
	/**
	 * Optional genuine ED routing bytes obtained from the official routing
	 * lifecycle. Existing persisted creds.routingInfo takes precedence.
	 */
	initialRoutingInfo?: Uint8Array
	appVersion: NativeAndroidAppVersion
	/** Concrete, explicitly selected app identity used for the first registration attempt. */
	appVariant: NativeAndroidAppVariant
	/**
	 * When true, pair-success platform is authoritative and may replace the
	 * initial app variant before pair-device-sign is sent. If the scanner
	 * rejects the advertised application before pair-success, orchestration
	 * must start a fresh attempt with the other variant; an emitted QR cannot
	 * be reclassified retroactively.
	 */
	autoDetectAppVariant?: boolean
	/** Optional per-app versions used when auto-detection changes the variant. */
	appVersions?: Partial<Record<NativeAndroidAppVariant, NativeAndroidAppVersion>>
	device: NativeAndroidDeviceProfile
	historySync: NativeAndroidHistorySyncProfile
	/**
	 * Directory used by the built-in Node X.509 compatibility provider.
	 * Ignored when a custom attestationProvider is supplied.
	 */
	attestationStorageDirectory?: string
	/**
	 * Optional custom provider override. When omitted, InfiniteAPI uses its
	 * built-in persistent Node X.509 compatibility provider.
	 */
	attestationProvider?: NativeAndroidAttestationProvider
	/** Optional server-provided endpoints, inserted at their official sequence state. */
	connectionEndpoints?: NativeAndroidConnectionEndpoint[]
	/** Maximum time allowed for one native DNS resolution before fallback advances. */
	dnsTimeoutMs?: number
	/** Safety ceiling for one native connection sequence; it never falls back to direct I/O. */
	sequenceTimeoutMs?: number
	/** Explicit egress proxy for native TCP. This is independent from SocketConfig.agent. */
	proxy?: NativeAndroidProxyConfig
	/** Optional official IP table supplied by the embedding application. No IPs are invented by the library. */
	hardcodedAddresses?: Record<string, string[]>
}

export type PersistedNativeAndroidIdentity = {
	schemaVersion: 1
	profile: 'native_android'
	/** Explicit runtime preset; inferred once when reopening legacy native sessions. */
	preset?: NativeAndroidConnectionPreset
	/** Missing on legacy native sessions, which always used the Business ID. */
	appVariant?: NativeAndroidAppVariant
	clientAppId?: string
	/** App build paired with this application identity; immutable after registration. */
	appVersion?: NativeAndroidAppVersion
	device: NativeAndroidDeviceProfile
	/**
	 * Successful-login counter sent as ClientPayload.lc. The official client
	 * reads the current value for the handshake and increments it only after
	 * the server's login-success node.
	 */
	connectionLc?: number
	/**
	 * Certified Noise responder static public key learned from a successful XX
	 * handshake. It is persisted for native Android IK reconnects and is never
	 * logged.
	 */
	serverStaticPublicKey?: Uint8Array
	/** Last successful native connection candidate, used by the history step. */
	connectionEndpoint?: NativeAndroidConnectionEndpoint
}
