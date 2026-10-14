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
	/**
	 * Companion static identity public key. The official Android client uses
	 * these bytes as the GPIA request hash and inside its KeyStore attestation
	 * challenge; they are ephemeral to the fresh-pairing handshake.
	 */
	identityPublicKey?: Uint8Array
}) => Promise<NativeAndroidPairingAttestation>

export type NativeAndroidIntegrityChallengeKind = 'gpia' | 'safetynet'

export type NativeAndroidIntegrityPolicy = 'audit' | 'enforce'

export type NativeAndroidIntegrityChallengeStatus =
	| 'not_requested'
	| 'pending'
	| 'response_sent'
	| 'unavailable'
	| 'failed'
	| 'unsupported'

export type PersistedNativeAndroidIntegrityChallenge = {
	status: Exclude<NativeAndroidIntegrityChallengeStatus, 'not_requested'>
	/** Epoch milliseconds when the latest challenge of this kind was observed. */
	observedAt: number
	/** Epoch milliseconds of the latest local state transition. */
	updatedAt: number
	/** Present only after the response bytes were written to the transport. */
	responseSentAt?: number
	/** Policy in effect for this transition; the current runtime policy remains authoritative. */
	policyApplied: NativeAndroidIntegrityPolicy
}

/**
 * Durable integrity metadata. It deliberately contains no nonce, token,
 * attestation material or serialized protocol node.
 */
export type PersistedNativeAndroidIntegrityState = {
	schemaVersion: 1
	gpia?: PersistedNativeAndroidIntegrityChallenge
	safetynet?: PersistedNativeAndroidIntegrityChallenge
}

/**
 * Post-login integrity challenge delivered by WhatsApp to an Android client.
 * The nonce is intentionally transient: InfiniteAPI never persists or logs it.
 */
type NativeAndroidIntegrityChallengeBase = {
	/** Raw server attribute; transient and never persisted or logged. */
	nonce: string
	/** Standard Play Integrity field. The APK assigns the server nonce verbatim. */
	requestHash: string
	/** Meta project number captured from APK 2.26.27.83. */
	cloudProjectNumber: 293955441834
	profileId: string
	appVariant: NativeAndroidAppVariant
	clientAppId: string
	packageName: string
	/** Aborted when a newer challenge supersedes this one or the socket closes. */
	signal: AbortSignal
}

export type NativeAndroidGpiaChallenge = NativeAndroidIntegrityChallengeBase & {
	kind: 'gpia'
}

export type NativeAndroidSafetyNetChallenge = NativeAndroidIntegrityChallengeBase & {
	kind: 'safetynet'
}

export type NativeAndroidIntegrityChallenge = NativeAndroidGpiaChallenge | NativeAndroidSafetyNetChallenge

/**
 * Challenge-bound token produced by the genuine Android installation. The
 * provider never controls the protocol stanza; InfiniteAPI builds the audited
 * GPIA (`<ib><gpia><jws>`) or SafetyNet (`<ib><integrity_payload>`) wire
 * internally, according to the challenge kind.
 */
export type NativeAndroidIntegrityResponse = {
	jws: string
}

/**
 * Backward-compatible name for the pre-SafetyNet provider contract.
 */
export type NativeAndroidGpiaResponse = NativeAndroidIntegrityResponse

export type NativeAndroidGpiaIntegrityProvider = (
	challenge: NativeAndroidGpiaChallenge
) => Promise<NativeAndroidIntegrityResponse>

export type NativeAndroidSafetyNetIntegrityProvider = (
	challenge: NativeAndroidSafetyNetChallenge
) => Promise<NativeAndroidIntegrityResponse>

/**
 * Deprecated: GPIA-only provider contract. SafetyNet support must be declared
 * separately through `safetyNetIntegrityProvider`.
 */
export type NativeAndroidIntegrityProvider = NativeAndroidGpiaIntegrityProvider

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
	/**
	 * `audit` records challenges without changing normal egress. `enforce`
	 * blocks only new user-message/call egress after an unsatisfied challenge;
	 * ACKs, retries and recovery traffic remain available. Defaults to `audit`.
	 */
	integrityPolicy?: NativeAndroidIntegrityPolicy
	/**
	 * Optional genuine post-login GPIA provider. This must run in the attested
	 * installation that owns the session; a Node-generated or replayed token is
	 * not valid.
	 */
	integrityProvider?: NativeAndroidGpiaIntegrityProvider
	/**
	 * Explicit SafetyNet capability. When omitted, SafetyNet challenges remain
	 * fail-closed and never invoke the GPIA provider.
	 */
	safetyNetIntegrityProvider?: NativeAndroidSafetyNetIntegrityProvider
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
	/** Durable metadata only; never contains nonce, token or attestation bytes. */
	integrity?: PersistedNativeAndroidIntegrityState
	/**
	 * Set only when these credentials were seeded by a primary phone-number
	 * registration (device-0, /v2/register). Companion pairing (QR / pair-code)
	 * never sets it, so its login semantics stay exactly as before.
	 */
	registrationSeeded?: boolean
	/**
	 * APK pref `signal_protocol_store_is_new` (C018408o.A1H): written true when
	 * the Signal identity is created (`SignalCoordinator/createIdentityKeysAnd-
	 * SignedPreKeys`) and cleared false only after MyPreKeysManager finishes
	 * uploading the pre-key batches. While true the official passive decision
	 * stays true (no pre-acks, PAA off).
	 */
	signalProtocolStoreIsNew?: boolean
	/**
	 * APK pref `logins_with_messages`: counts short-connect logins that kept
	 * processing messages past the app's 15-minute window. Official shortConnect
	 * is `(c2dm_reg_id || fbns_token) && logins_with_messages < 3`.
	 */
	loginsWithMessages?: number
	/**
	 * APK `login_failed` (C0GB.A0K): set when a non-retryable login failure hits
	 * a registration-seeded primary (the official type-0 chain of
	 * HandlerC08360a1). `connect()` refuses while set and only a new successful
	 * registration clears it (FHW.A01), 1:1 with the app.
	 */
	loginFailed?: boolean
	/** Failure reason recorded alongside `loginFailed` (the APK stores the int). */
	loginFailedReason?: number
	/**
	 * Official failure category classified from the `<failure>` node (0 default,
	 * 2/13/14/15 ban family, 3 expired, 4 retryable 5xx, 5 underage, 7 permanent
	 * ban, 11 violation). Persisted alongside `loginFailedReason` so a later
	 * `connect()` gate can report the real category instead of collapsing every
	 * terminal failure into type 0 (audit C10).
	 */
	loginFailedType?: number
	/**
	 * APK pref `previously_logged_out_from_primary`: set once the primary is
	 * definitively logged out by a terminal failure (HandlerC08360a1).
	 */
	previouslyLoggedOutFromPrimary?: boolean
}
