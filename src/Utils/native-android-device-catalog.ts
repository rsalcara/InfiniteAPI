import { randomUUID } from 'crypto'
import type { NativeAndroidDeviceProfile, NativeAndroidHardwareProfile } from '../Types'

export const GENERIC_NATIVE_ANDROID_FALLBACK_PROFILE_ID = 'google-emulator-android12-se1a-220826-008'

const samsung = (
	profileId: string,
	commercialName: string,
	deviceModelType: string,
	osVersion: string,
	osBuildNumber: string
): NativeAndroidHardwareProfile => ({
	profileId,
	quality: 'catalog',
	commercialName,
	manufacturer: 'samsung',
	device: deviceModelType,
	deviceBoard: deviceModelType,
	deviceModelType,
	osVersion,
	osBuildNumber,
	oc: false
})

/**
 * Supported, internally coherent model/version/base-build tuples. Unlike the
 * captured fallback profile, their full Build.* tuple was not captured from
 * every physical model, so their provenance remains explicit as `catalog`.
 */
export const SAMSUNG_NATIVE_ANDROID_HARDWARE_PROFILES = [
	samsung('samsung-galaxy-s26-ultra', 'Galaxy S26 Ultra', 'SM-S948B', '16', 'WP1A.250812.016'),
	samsung('samsung-galaxy-s26-plus', 'Galaxy S26+', 'SM-S946B', '16', 'WP1A.250812.016'),
	samsung('samsung-galaxy-s26', 'Galaxy S26', 'SM-S941B', '16', 'WP1A.250812.016'),
	samsung('samsung-galaxy-s25-ultra', 'Galaxy S25 Ultra', 'SM-S938B', '15', 'VP1A.240812.016'),
	samsung('samsung-galaxy-s25-plus', 'Galaxy S25+', 'SM-S936B', '15', 'VP1A.240812.016'),
	samsung('samsung-galaxy-s25', 'Galaxy S25', 'SM-S931B', '15', 'VP1A.240812.016'),
	samsung('samsung-galaxy-s24-ultra', 'Galaxy S24 Ultra', 'SM-S928B', '14', 'UP1A.231005.007'),
	samsung('samsung-galaxy-s24-plus', 'Galaxy S24+', 'SM-S926B', '14', 'UP1A.231005.007'),
	samsung('samsung-galaxy-s24', 'Galaxy S24', 'SM-S921B', '14', 'UP1A.231005.007'),
	samsung('samsung-galaxy-s23-ultra', 'Galaxy S23 Ultra', 'SM-S918B', '13', 'TP1A.220624.014'),
	samsung('samsung-galaxy-s23-plus', 'Galaxy S23+', 'SM-S916B', '13', 'TP1A.220624.014'),
	samsung('samsung-galaxy-s23', 'Galaxy S23', 'SM-S911B', '13', 'TP1A.220624.014'),
	samsung('samsung-galaxy-s22-ultra', 'Galaxy S22 Ultra', 'SM-S908B', '12', 'SP1A.210812.016'),
	samsung('samsung-galaxy-s22-plus', 'Galaxy S22+', 'SM-S906B', '12', 'SP1A.210812.016'),
	samsung('samsung-galaxy-s22', 'Galaxy S22', 'SM-S901B', '12', 'SP1A.210812.016'),
	samsung('samsung-galaxy-s21-ultra', 'Galaxy S21 Ultra', 'SM-G998B', '11', 'RP1A.200720.012'),
	samsung('samsung-galaxy-s21-plus', 'Galaxy S21+', 'SM-G996B', '11', 'RP1A.200720.012'),
	samsung('samsung-galaxy-s21', 'Galaxy S21', 'SM-G991B', '11', 'RP1A.200720.012'),
	samsung('samsung-galaxy-s20-ultra', 'Galaxy S20 Ultra', 'SM-G988B', '10', 'QP1A.190711.020'),
	samsung('samsung-galaxy-s20-plus', 'Galaxy S20+', 'SM-G985F', '10', 'QP1A.190711.020'),
	samsung('samsung-galaxy-s20', 'Galaxy S20', 'SM-G980F', '10', 'QP1A.190711.020')
] as const satisfies readonly NativeAndroidHardwareProfile[]

/** Exact Build.* tuple captured from the controlled Android 12 companion. */
export const CAPTURED_NATIVE_ANDROID_HARDWARE_PROFILES = [
	{
		profileId: GENERIC_NATIVE_ANDROID_FALLBACK_PROFILE_ID,
		quality: 'captured',
		commercialName: 'Generic Android emulator',
		fallback: true,
		manufacturer: 'Google',
		device: 'emulator64_x86_64_arm64',
		deviceBoard: 'goldfish_x86_64',
		deviceModelType: 'sdk_gphone64_x86_64',
		osVersion: '12',
		osBuildNumber: 'sdk_gphone64_x86_64-userdebug 12 SE1A.220826.008 10564458 dev-keys',
		yearClass: 2016,
		memClass: 192,
		oc: true
	}
] as const satisfies readonly NativeAndroidHardwareProfile[]

export const NATIVE_ANDROID_HARDWARE_CATALOG = [
	...SAMSUNG_NATIVE_ANDROID_HARDWARE_PROFILES,
	...CAPTURED_NATIVE_ANDROID_HARDWARE_PROFILES
] as const satisfies readonly NativeAndroidHardwareProfile[]

/** Backwards-compatible captured-only export. */
export const VERIFIED_NATIVE_ANDROID_HARDWARE_PROFILES = CAPTURED_NATIVE_ANDROID_HARDWARE_PROFILES

export type NativeAndroidDeviceContext = {
	mcc: string
	mnc: string
	localeLanguageIso6391: string
	localeCountryIso31661Alpha2: string
}

const uuidToDeviceExpId = (uuid: string) => Buffer.from(uuid.replace(/-/g, ''), 'hex').toString('base64url')

const validateCatalog = (catalog: readonly NativeAndroidHardwareProfile[]) => {
	if (catalog.length === 0) throw new Error('native_android: hardware catalog is empty')

	const ids = new Set<string>()
	for (const profile of catalog) {
		for (const field of [
			'profileId',
			'commercialName',
			'manufacturer',
			'device',
			'deviceBoard',
			'deviceModelType',
			'osVersion',
			'osBuildNumber'
		] as const) {
			if (!profile[field]?.trim()) {
				throw new Error(`native_android: hardware profile ${profile.profileId || '<unknown>'} has no ${field}`)
			}
		}

		if (profile.quality !== 'captured' && profile.quality !== 'catalog') {
			throw new Error(`native_android: hardware profile ${profile.profileId} has invalid quality`)
		}

		if (ids.has(profile.profileId)) {
			throw new Error(`native_android: duplicate hardware profile ${profile.profileId}`)
		}

		const expectedBuildPrefix: Record<string, string> = {
			'10': 'Q',
			'11': 'R',
			'12': 'S',
			'13': 'T',
			'14': 'U',
			'15': 'V',
			'16': 'W'
		}
		const buildPrefix = expectedBuildPrefix[profile.osVersion]
		if (profile.quality === 'catalog' && buildPrefix && !profile.osBuildNumber.startsWith(buildPrefix)) {
			throw new Error(
				`native_android: hardware profile ${profile.profileId} has an incoherent Android/build combination`
			)
		}

		ids.add(profile.profileId)
	}
}

validateCatalog(NATIVE_ANDROID_HARDWARE_CATALOG)

export const createNativeAndroidDeviceProfile = (
	context: NativeAndroidDeviceContext,
	profileId?: string,
	randomIndex: (length: number) => number = length => Math.floor(Math.random() * length)
): NativeAndroidDeviceProfile => {
	const selectable = NATIVE_ANDROID_HARDWARE_CATALOG.filter(profile => !profile.fallback)
	const hardware = profileId
		? NATIVE_ANDROID_HARDWARE_CATALOG.find(profile => profile.profileId === profileId)
		: selectable[randomIndex(selectable.length)]

	if (!hardware) {
		throw new Error(`native_android: unknown hardware profile ${profileId || '<random>'}`)
	}

	return {
		...hardware,
		phoneId: randomUUID(),
		phoneIdTimestamp: Date.now(),
		perfDeviceId: randomUUID(),
		deviceExpId: uuidToDeviceExpId(randomUUID()),
		...context
	}
}

export const createNativeAndroidFallbackDeviceProfile = (
	context: NativeAndroidDeviceContext
): NativeAndroidDeviceProfile => createNativeAndroidDeviceProfile(context, GENERIC_NATIVE_ANDROID_FALLBACK_PROFILE_ID)

export const shouldFallbackNativeAndroidProfile = (input: {
	registered: boolean
	hasAccount?: boolean
	hasMe?: boolean
	serverFailureReason: number
	profileId: string
}) =>
	!input.registered &&
	!input.hasAccount &&
	!input.hasMe &&
	input.serverFailureReason === 400 &&
	input.profileId !== GENERIC_NATIVE_ANDROID_FALLBACK_PROFILE_ID

export const isNativeAndroidCatalogProfile = (profileId: string) =>
	NATIVE_ANDROID_HARDWARE_CATALOG.some(profile => profile.profileId === profileId)

export const assertValidNativeAndroidHardwareCatalog = (catalog: readonly NativeAndroidHardwareProfile[]) =>
	validateCatalog(catalog)
