import { Boom } from '@hapi/boom'
import { NATIVE_ANDROID_APP_IDENTITIES, WABA_CLIENT_APP_ID } from '../Defaults'
import type {
	AuthenticationCreds,
	ConnectionTransportProfile,
	NativeAndroidAppVariant,
	NativeAndroidDeviceProfile,
	NativeAndroidPairingAttestation,
	NativeAndroidTransportConfig,
	SocketConfig
} from '../Types'
import type { BinaryNode } from '../WABinary'
import {
	GENERIC_NATIVE_ANDROID_FALLBACK_PROFILE_ID,
	isNativeAndroidCatalogProfile
} from './native-android-device-catalog'
import { makeNativeAndroidNodeAttestationProvider } from './native-android-node-attestation'

const PROFILE_FIELDS: ReadonlyArray<keyof NativeAndroidDeviceProfile> = [
	'profileId',
	'quality',
	'commercialName',
	'fallback',
	'manufacturer',
	'device',
	'osVersion',
	'osBuildNumber',
	'phoneId',
	'deviceExpId',
	'phoneIdTimestamp',
	'perfDeviceId',
	'mcc',
	'mnc',
	'localeLanguageIso6391',
	'localeCountryIso31661Alpha2',
	'deviceBoard',
	'deviceModelType',
	'yearClass',
	'memClass',
	'oc'
]

const requiredString = (value: unknown, field: string) => {
	if (typeof value !== 'string' || value.trim().length === 0) {
		throw new Boom(`native_android: device profile field ${field} is required`, { statusCode: 400 })
	}
}

export const getNativeAndroidAppIdentity = (variant: NativeAndroidAppVariant) => NATIVE_ANDROID_APP_IDENTITIES[variant]

export const detectNativeAndroidAppVariant = (
	platform: string | null | undefined
): NativeAndroidAppVariant | undefined => {
	switch (platform?.trim().toLowerCase()) {
		case 'smba':
		case 'smbi':
			return 'business'
		case 'android':
		case 'iphone':
			return 'consumer'
		default:
			return undefined
	}
}

export const validateNativeAndroidConfig = (config: NativeAndroidTransportConfig) => {
	if (config.enabled !== true) {
		throw new Boom('native_android: explicit enabled=true gate is required', { statusCode: 400 })
	}

	if (!Array.isArray(config.appVersion) || config.appVersion.length !== 4) {
		throw new Boom('native_android: appVersion must contain the four official Android components', { statusCode: 400 })
	}

	const appVariant = config.appVariant
	if (appVariant !== 'business' && appVariant !== 'consumer') {
		throw new Boom('native_android: explicit appVariant must be business or consumer', { statusCode: 400 })
	}

	for (const [variant, version] of Object.entries(config.appVersions || {})) {
		if (
			(variant !== 'business' && variant !== 'consumer') ||
			!Array.isArray(version) ||
			version.length !== 4 ||
			version.some(component => !Number.isSafeInteger(component) || component < 0)
		) {
			throw new Boom(`native_android: appVersions.${variant} is invalid`, { statusCode: 400 })
		}
	}

	if (config.autoDetectAppVariant === true && (!config.appVersions?.business || !config.appVersions?.consumer)) {
		throw new Boom('native_android: automatic app fallback requires official business and consumer appVersions', {
			statusCode: 400
		})
	}

	if (config.initialRoutingInfo && config.initialRoutingInfo.byteLength > 0xffffff) {
		throw new Boom('native_android: initialRoutingInfo exceeds the ED header limit', { statusCode: 400 })
	}

	if (!config.historySync || typeof config.historySync !== 'object') {
		throw new Boom('native_android: a genuine historySync profile is required', { statusCode: 400 })
	}

	for (const [field, value] of [
		['fullSyncDaysLimit', config.historySync.fullSyncDaysLimit],
		['fullSyncSizeMbLimit', config.historySync.fullSyncSizeMbLimit],
		['thumbnailSyncDaysLimit', config.historySync.thumbnailSyncDaysLimit]
	] as const) {
		if (!Number.isSafeInteger(value) || value < 0) {
			throw new Boom(`native_android: historySync.${field} must be a non-negative safe integer`, {
				statusCode: 400
			})
		}
	}

	for (const field of ['supportGroupHistory', 'onDemandReady', 'supportHatchHistory'] as const) {
		if (typeof config.historySync[field] !== 'boolean') {
			throw new Boom(`native_android: historySync.${field} must be boolean`, { statusCode: 400 })
		}
	}

	if (
		!Array.isArray(config.historySync.supportedBotChannelFbids) ||
		config.historySync.supportedBotChannelFbids.some(value => typeof value !== 'string' || value.length === 0)
	) {
		throw new Boom('native_android: historySync.supportedBotChannelFbids is invalid', { statusCode: 400 })
	}

	for (const component of config.appVersion) {
		if (component === undefined || !Number.isSafeInteger(component) || component < 0) {
			throw new Boom('native_android: appVersion contains an invalid component', { statusCode: 400 })
		}
	}

	const { device } = config
	if (!device || typeof device !== 'object' || Array.isArray(device)) {
		throw new Boom('native_android: a complete device profile is required', { statusCode: 400 })
	}

	for (const field of [
		'profileId',
		'manufacturer',
		'device',
		'osVersion',
		'osBuildNumber',
		'phoneId',
		'deviceExpId',
		'localeLanguageIso6391',
		'localeCountryIso31661Alpha2'
	] as const) {
		requiredString(device[field], field)
	}

	if (!/^\d{3}$/.test(device.mcc)) {
		throw new Boom('native_android: mcc must contain exactly three digits', { statusCode: 400 })
	}

	if (!/^\d{2,3}$/.test(device.mnc)) {
		throw new Boom('native_android: mnc must contain two or three digits', { statusCode: 400 })
	}

	if (!/^[a-z]{2,3}$/i.test(device.localeLanguageIso6391)) {
		throw new Boom('native_android: localeLanguageIso6391 is invalid', { statusCode: 400 })
	}

	if (!/^[A-Z]{2}$/.test(device.localeCountryIso31661Alpha2)) {
		throw new Boom('native_android: localeCountryIso31661Alpha2 must be an uppercase ISO-3166 alpha-2 code', {
			statusCode: 400
		})
	}
}

const DYNAMIC_IDENTITY_FIELDS = new Set<keyof NativeAndroidDeviceProfile>([
	'phoneId',
	'deviceExpId',
	'phoneIdTimestamp',
	'perfDeviceId'
])

const profilesMatch = (left: NativeAndroidDeviceProfile, right: NativeAndroidDeviceProfile) =>
	PROFILE_FIELDS.every(field => DYNAMIC_IDENTITY_FIELDS.has(field) || left[field] === right[field])

export type ResolvedTransportSession = {
	profile: ConnectionTransportProfile
	nativeAndroid?: NativeAndroidTransportConfig
	credsChanged: boolean
}

/**
 * Applies the fail-closed session isolation rules before opening a socket.
 * Existing Web credentials have no marker and remain untouched.
 */
export const resolveTransportSession = (config: SocketConfig, creds: AuthenticationCreds): ResolvedTransportSession => {
	const profile = config.transportProfile || 'web'
	const persisted = creds.nativeAndroidIdentity

	if (profile === 'web') {
		if (persisted?.profile === 'native_android') {
			throw new Boom('transport isolation: native_android credentials cannot be opened by the Web transport', {
				statusCode: 400
			})
		}

		return { profile, credsChanged: false }
	}

	if (profile !== 'native_android') {
		throw new Boom(`unsupported transport profile: ${String(profile)}`, { statusCode: 400 })
	}

	if (!config.nativeAndroid) {
		throw new Boom('native_android: configuration is required', { statusCode: 400 })
	}

	validateNativeAndroidConfig(config.nativeAndroid)
	const hasCompletedPairing = creds.registered || Boolean(creds.account && creds.me)
	let recoveredRegisteredMarker = false
	let migratedAppIdentity = false

	// Native QR pairing historically persisted account + me + the durable native
	// identity without setting registered. Recover only that unambiguous state;
	// an unmarked Web session remains protected by the isolation check below.
	if (!creds.registered && persisted?.profile === 'native_android' && creds.account && creds.me) {
		creds.registered = true
		recoveredRegisteredMarker = true
	}

	const attestationProvider =
		config.nativeAndroid.attestationProvider ??
		(!hasCompletedPairing
			? makeNativeAndroidNodeAttestationProvider({
					storageDirectory: config.nativeAndroid.attestationStorageDirectory
				})
			: undefined)

	if (hasCompletedPairing && !persisted) {
		throw new Boom(
			'transport isolation: an existing unmarked Web session cannot be converted automatically to native_android',
			{ statusCode: 400 }
		)
	}

	if (persisted && (!persisted.appVariant || !persisted.clientAppId)) {
		// Every native session created before app-variant support used WABA.
		persisted.appVariant = 'business'
		persisted.clientAppId = WABA_CLIENT_APP_ID
		persisted.appVersion = config.nativeAndroid.appVersions?.business ?? config.nativeAndroid.appVersion
		migratedAppIdentity = true
	}

	const configuredVariant = config.nativeAndroid.appVariant
	// A registered session owns its persisted application identity. Environment
	// changes only select the identity for future registrations; they never
	// convert or prevent reconnecting an existing Consumer/Business companion.
	if (!hasCompletedPairing && persisted?.appVariant && persisted.appVariant !== configuredVariant) {
		const configuredIdentity = getNativeAndroidAppIdentity(configuredVariant)
		persisted.appVariant = configuredVariant
		persisted.clientAppId = configuredIdentity.clientAppId
		persisted.appVersion = config.nativeAndroid.appVersions?.[configuredVariant] ?? config.nativeAndroid.appVersion
		migratedAppIdentity = true
	}

	if (
		persisted &&
		persisted.device.profileId !== GENERIC_NATIVE_ANDROID_FALLBACK_PROFILE_ID &&
		!(
			isNativeAndroidCatalogProfile(persisted.device.profileId) &&
			isNativeAndroidCatalogProfile(config.nativeAndroid.device.profileId)
		) &&
		!profilesMatch(persisted.device, config.nativeAndroid.device)
	) {
		throw new Boom(
			`native_android: configured profile ${config.nativeAndroid.device.profileId} does not match persisted profile ${persisted.device.profileId}`,
			{ statusCode: 400 }
		)
	}

	if (!persisted) {
		const appIdentity = getNativeAndroidAppIdentity(configuredVariant)
		creds.nativeAndroidIdentity = {
			schemaVersion: 1,
			profile: 'native_android',
			appVariant: configuredVariant,
			clientAppId: appIdentity.clientAppId,
			appVersion: config.nativeAndroid.appVersions?.[configuredVariant] ?? config.nativeAndroid.appVersion,
			device: { ...config.nativeAndroid.device }
		}
	}

	const effectiveVariant = persisted?.appVariant ?? configuredVariant
	const effectiveVersion =
		persisted?.appVersion ?? config.nativeAndroid.appVersions?.[effectiveVariant] ?? config.nativeAndroid.appVersion
	return {
		profile,
		nativeAndroid: {
			...config.nativeAndroid,
			attestationProvider,
			appVariant: effectiveVariant,
			appVersion: effectiveVersion,
			device: { ...(persisted?.device || config.nativeAndroid.device) }
		},
		credsChanged: !persisted || recoveredRegisteredMarker || migratedAppIdentity
	}
}

/**
 * Resolves the primary application's identity from pair-success, before the
 * pair-device-sign response is constructed. Registered sessions never enter
 * this path and therefore cannot change application identity on reconnect.
 */
export const resolveNativeAndroidPairingAppVariant = (
	config: NativeAndroidTransportConfig,
	creds: AuthenticationCreds,
	pairingPlatform: string | null | undefined
) => {
	if (creds.registered || (creds.account && creds.me)) {
		throw new Boom('native_android: application variant cannot be changed after registration', {
			statusCode: 409
		})
	}

	const configuredVariant = config.appVariant ?? 'business'
	const detectedVariant = detectNativeAndroidAppVariant(pairingPlatform)
	if (!detectedVariant) {
		if (config.autoDetectAppVariant === true) {
			throw new Boom(
				`native_android: pair-success did not identify a supported primary application (platform=${pairingPlatform || 'missing'}); refusing to guess`,
				{ statusCode: 409 }
			)
		}

		return {
			variant: configuredVariant,
			identity: getNativeAndroidAppIdentity(configuredVariant),
			fallbackApplied: false,
			detected: false
		}
	}

	if (detectedVariant !== configuredVariant && config.autoDetectAppVariant !== true) {
		throw new Boom(
			`native_android: QR belongs to a ${detectedVariant} account, but the companion is configured as ${configuredVariant}`,
			{ statusCode: 409 }
		)
	}

	const identity = getNativeAndroidAppIdentity(detectedVariant)
	config.appVariant = detectedVariant
	config.appVersion = config.appVersions?.[detectedVariant] ?? config.appVersion
	if (!creds.nativeAndroidIdentity) {
		throw new Boom('native_android: durable identity is missing during pair-success', { statusCode: 500 })
	}

	creds.nativeAndroidIdentity.appVariant = detectedVariant
	creds.nativeAndroidIdentity.clientAppId = identity.clientAppId
	creds.nativeAndroidIdentity.appVersion = config.appVersions?.[detectedVariant] ?? config.appVersion

	return {
		variant: detectedVariant,
		identity,
		fallbackApplied: detectedVariant !== configuredVariant,
		detected: true
	}
}

export const appendNativeAndroidPairingAttestation = (
	reply: BinaryNode,
	attestation: NativeAndroidPairingAttestation,
	expectedClientAppId: string = WABA_CLIENT_APP_ID
) => {
	if (!(attestation.keyAttestation instanceof Uint8Array) || attestation.keyAttestation.byteLength === 0) {
		throw new Boom('native_android: attestation provider returned an empty key_attestation', { statusCode: 400 })
	}

	const clientAppId =
		typeof attestation.clientAppId === 'string'
			? attestation.clientAppId
			: Buffer.from(attestation.clientAppId).toString('utf8')
	if (clientAppId !== expectedClientAppId) {
		throw new Boom('native_android: attestation provider returned an unexpected client-app-id', {
			statusCode: 400
		})
	}

	const pairDeviceSign = Array.isArray(reply.content)
		? reply.content.find(
				(child): child is BinaryNode =>
					typeof child === 'object' &&
					child !== null &&
					!Buffer.isBuffer(child) &&
					'tag' in child &&
					child.tag === 'pair-device-sign'
			)
		: undefined

	if (!pairDeviceSign || !Array.isArray(pairDeviceSign.content)) {
		throw new Boom('native_android: pair-device-sign reply is malformed', { statusCode: 500 })
	}

	pairDeviceSign.content.push(
		{ tag: 'key_attestation', attrs: {}, content: Buffer.from(attestation.keyAttestation) },
		{
			tag: 'gpia',
			attrs: {},
			content: typeof attestation.gpia === 'string' ? attestation.gpia : Buffer.from(attestation.gpia)
		}
	)

	pairDeviceSign.content.push({
		tag: 'client-app-id',
		attrs: {},
		content: expectedClientAppId
	})
}
