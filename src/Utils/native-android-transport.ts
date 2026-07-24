import { Boom } from '@hapi/boom'
import type {
	AuthenticationCreds,
	ConnectionTransportProfile,
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

export const validateNativeAndroidConfig = (config: NativeAndroidTransportConfig) => {
	if (config.enabled !== true) {
		throw new Boom('native_android: explicit enabled=true gate is required', { statusCode: 400 })
	}

	if (config.appVersion.length !== 4) {
		throw new Boom('native_android: appVersion must contain the four official Android components', { statusCode: 400 })
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

	// Native QR pairing historically persisted account + me + the durable native
	// identity without setting registered. Recover only that unambiguous state;
	// an unmarked Web session remains protected by the isolation check below.
	if (!creds.registered && persisted?.profile === 'native_android' && creds.account && creds.me) {
		creds.registered = true
		recoveredRegisteredMarker = true
	}

	if (!hasCompletedPairing && !config.nativeAndroid.attestationProvider) {
		throw new Boom('native_android: a genuine attestationProvider is required before starting a fresh QR pairing', {
			statusCode: 400
		})
	}

	if (hasCompletedPairing && !persisted) {
		throw new Boom(
			'transport isolation: an existing unmarked Web session cannot be converted automatically to native_android',
			{ statusCode: 400 }
		)
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
		creds.nativeAndroidIdentity = {
			schemaVersion: 1,
			profile: 'native_android',
			device: { ...config.nativeAndroid.device }
		}
	}

	return {
		profile,
		nativeAndroid: {
			...config.nativeAndroid,
			device: { ...(persisted?.device || config.nativeAndroid.device) }
		},
		credsChanged: !persisted || recoveredRegisteredMarker
	}
}

export const appendNativeAndroidPairingAttestation = (
	reply: BinaryNode,
	attestation: NativeAndroidPairingAttestation
) => {
	if (!(attestation.keyAttestation instanceof Uint8Array) || attestation.keyAttestation.byteLength === 0) {
		throw new Boom('native_android: attestation provider returned an empty key_attestation', { statusCode: 400 })
	}

	if (
		attestation.clientAppId !== undefined &&
		((typeof attestation.clientAppId === 'string' && attestation.clientAppId.length === 0) ||
			(attestation.clientAppId instanceof Uint8Array && attestation.clientAppId.byteLength === 0))
	) {
		throw new Boom('native_android: attestation provider returned an empty client-app-id', { statusCode: 400 })
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

	if (attestation.clientAppId !== undefined) {
		pairDeviceSign.content.push({
			tag: 'client-app-id',
			attrs: {},
			content:
				typeof attestation.clientAppId === 'string' ? attestation.clientAppId : Buffer.from(attestation.clientAppId)
		})
	}
}
