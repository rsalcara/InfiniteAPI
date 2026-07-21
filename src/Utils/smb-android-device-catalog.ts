import { randomInt } from 'crypto'
import type { SmbAndroidDeviceMetadata } from '../Types'

/**
 * Coherent Samsung model / launch-Android / base Build.ID tuples.
 *
 * Model codes and launch Android versions were checked against Samsung's
 * product/support material. Build IDs are the matching Android base IDs
 * observed on the corresponding Galaxy generation; only verified entries are
 * eligible for selection.
 */
export const SMB_ANDROID_DEVICE_CATALOG: readonly SmbAndroidDeviceMetadata[] = Object.freeze([
	{
		catalogId: 'galaxy-s26-ultra-eu',
		commercialName: 'Galaxy S26 Ultra',
		manufacturer: 'samsung',
		device: 'SM-S948B',
		osVersion: '16',
		osBuildNumber: 'BP2A.250605.031.A3',
		verified: true
	},
	{
		catalogId: 'galaxy-s26-plus-eu',
		commercialName: 'Galaxy S26+',
		manufacturer: 'samsung',
		device: 'SM-S947B',
		osVersion: '16',
		osBuildNumber: 'BP2A.250605.031.A3',
		verified: true
	},
	{
		catalogId: 'galaxy-s26-eu',
		commercialName: 'Galaxy S26',
		manufacturer: 'samsung',
		device: 'SM-S942B',
		osVersion: '16',
		osBuildNumber: 'BP2A.250605.031.A3',
		verified: true
	},
	{
		catalogId: 'galaxy-s25-ultra-eu',
		commercialName: 'Galaxy S25 Ultra',
		manufacturer: 'samsung',
		device: 'SM-S938B',
		osVersion: '15',
		osBuildNumber: 'AP3A.240905.015.A2',
		verified: true
	},
	{
		catalogId: 'galaxy-s25-plus-eu',
		commercialName: 'Galaxy S25+',
		manufacturer: 'samsung',
		device: 'SM-S936B',
		osVersion: '15',
		osBuildNumber: 'AP3A.240905.015.A2',
		verified: true
	},
	{
		catalogId: 'galaxy-s25-eu',
		commercialName: 'Galaxy S25',
		manufacturer: 'samsung',
		device: 'SM-S931B',
		osVersion: '15',
		osBuildNumber: 'AP3A.240905.015.A2',
		verified: true
	},
	{
		catalogId: 'galaxy-s24-ultra-eu',
		commercialName: 'Galaxy S24 Ultra',
		manufacturer: 'samsung',
		device: 'SM-S928B',
		osVersion: '14',
		osBuildNumber: 'UP1A.231005.007',
		verified: true
	},
	{
		catalogId: 'galaxy-s24-plus-eu',
		commercialName: 'Galaxy S24+',
		manufacturer: 'samsung',
		device: 'SM-S926B',
		osVersion: '14',
		osBuildNumber: 'UP1A.231005.007',
		verified: true
	},
	{
		catalogId: 'galaxy-s24-eu',
		commercialName: 'Galaxy S24',
		manufacturer: 'samsung',
		device: 'SM-S921B',
		osVersion: '14',
		osBuildNumber: 'UP1A.231005.007',
		verified: true
	},
	{
		catalogId: 'galaxy-s23-ultra-eu',
		commercialName: 'Galaxy S23 Ultra',
		manufacturer: 'samsung',
		device: 'SM-S918B',
		osVersion: '13',
		osBuildNumber: 'TP1A.220624.014',
		verified: true
	},
	{
		catalogId: 'galaxy-s23-plus-eu',
		commercialName: 'Galaxy S23+',
		manufacturer: 'samsung',
		device: 'SM-S916B',
		osVersion: '13',
		osBuildNumber: 'TP1A.220624.014',
		verified: true
	},
	{
		catalogId: 'galaxy-s23-eu',
		commercialName: 'Galaxy S23',
		manufacturer: 'samsung',
		device: 'SM-S911B',
		osVersion: '13',
		osBuildNumber: 'TP1A.220624.014',
		verified: true
	},
	{
		catalogId: 'galaxy-s22-ultra-eu',
		commercialName: 'Galaxy S22 Ultra',
		manufacturer: 'samsung',
		device: 'SM-S908B',
		osVersion: '12',
		osBuildNumber: 'SP1A.210812.016',
		verified: true
	},
	{
		catalogId: 'galaxy-s22-plus-eu',
		commercialName: 'Galaxy S22+',
		manufacturer: 'samsung',
		device: 'SM-S906B',
		osVersion: '12',
		osBuildNumber: 'SP1A.210812.016',
		verified: true
	},
	{
		catalogId: 'galaxy-s22-eu',
		commercialName: 'Galaxy S22',
		manufacturer: 'samsung',
		device: 'SM-S901B',
		osVersion: '12',
		osBuildNumber: 'SP1A.210812.016',
		verified: true
	},
	{
		catalogId: 'galaxy-s21-ultra-eu',
		commercialName: 'Galaxy S21 Ultra',
		manufacturer: 'samsung',
		device: 'SM-G998B',
		osVersion: '11',
		osBuildNumber: 'RP1A.200720.012',
		verified: true
	},
	{
		catalogId: 'galaxy-s21-plus-eu',
		commercialName: 'Galaxy S21+',
		manufacturer: 'samsung',
		device: 'SM-G996B',
		osVersion: '11',
		osBuildNumber: 'RP1A.200720.012',
		verified: true
	},
	{
		catalogId: 'galaxy-s21-eu',
		commercialName: 'Galaxy S21',
		manufacturer: 'samsung',
		device: 'SM-G991B',
		osVersion: '11',
		osBuildNumber: 'RP1A.200720.012',
		verified: true
	},
	{
		catalogId: 'galaxy-s20-ultra-eu',
		commercialName: 'Galaxy S20 Ultra',
		manufacturer: 'samsung',
		device: 'SM-G988B',
		osVersion: '10',
		osBuildNumber: 'QP1A.190711.020',
		verified: true
	},
	{
		catalogId: 'galaxy-s20-plus-eu',
		commercialName: 'Galaxy S20+',
		manufacturer: 'samsung',
		device: 'SM-G985F',
		osVersion: '10',
		osBuildNumber: 'QP1A.190711.020',
		verified: true
	},
	{
		catalogId: 'galaxy-s20-eu',
		commercialName: 'Galaxy S20',
		manufacturer: 'samsung',
		device: 'SM-G980F',
		osVersion: '10',
		osBuildNumber: 'QP1A.190711.020',
		verified: true
	}
])

const BUILD_PREFIX_BY_ANDROID_VERSION: Readonly<Record<string, string>> = {
	'10': 'QP1A.',
	'11': 'RP1A.',
	'12': 'SP1A.',
	'13': 'TP1A.',
	'14': 'UP1A.',
	'15': 'AP3A.',
	'16': 'BP2A.'
}

const EXPECTED_MODEL_BY_COMMERCIAL_NAME: Readonly<Record<string, string>> = Object.fromEntries(
	SMB_ANDROID_DEVICE_CATALOG.map(profile => [profile.commercialName, profile.device])
)

export const validateSmbAndroidDeviceCatalog = (
	catalog: readonly SmbAndroidDeviceMetadata[]
): readonly SmbAndroidDeviceMetadata[] => {
	if (catalog.length === 0) throw new Error('SMB_ANDROID device catalog must contain at least one verified profile')

	const ids = new Set<string>()
	for (const profile of catalog) {
		const required = [
			profile.catalogId,
			profile.commercialName,
			profile.manufacturer,
			profile.device,
			profile.osVersion,
			profile.osBuildNumber
		]
		if (required.some(value => typeof value !== 'string' || !value.trim())) {
			throw new Error(`SMB_ANDROID device profile ${profile.catalogId || '<missing-id>'} is incomplete`)
		}
		if (profile.verified !== true) throw new Error(`SMB_ANDROID device profile ${profile.catalogId} is not verified`)
		if (ids.has(profile.catalogId)) throw new Error(`Duplicate SMB_ANDROID device profile id: ${profile.catalogId}`)
		ids.add(profile.catalogId)

		if (profile.manufacturer !== 'samsung' || !/^SM-[GS]\d{3}[BF]$/.test(profile.device)) {
			throw new Error(`SMB_ANDROID device profile ${profile.catalogId} has an incoherent Samsung model identity`)
		}
		if (EXPECTED_MODEL_BY_COMMERCIAL_NAME[profile.commercialName] !== profile.device) {
			throw new Error(
				`SMB_ANDROID device profile ${profile.catalogId} does not match the verified model code for ${profile.commercialName}`
			)
		}
		const generation = /Galaxy S(\d{2})/.exec(profile.commercialName)?.[1]
		const expectedLaunchAndroid = generation ? String(Number(generation) - 10) : undefined
		if (profile.osVersion !== expectedLaunchAndroid) {
			throw new Error(
				`SMB_ANDROID device profile ${profile.catalogId} has Android ${profile.osVersion}; ${profile.commercialName} requires launch Android ${expectedLaunchAndroid}`
			)
		}
		const buildPrefix = BUILD_PREFIX_BY_ANDROID_VERSION[profile.osVersion]
		if (!buildPrefix || !profile.osBuildNumber.startsWith(buildPrefix)) {
			throw new Error(
				`SMB_ANDROID device profile ${profile.catalogId} has build ${profile.osBuildNumber} incompatible with Android ${profile.osVersion}`
			)
		}
	}

	return catalog
}

export const selectVerifiedSmbAndroidDeviceProfile = (
	catalog: readonly SmbAndroidDeviceMetadata[] = SMB_ANDROID_DEVICE_CATALOG,
	selectIndex: (upperBound: number) => number = randomInt
): SmbAndroidDeviceMetadata => {
	const verifiedCatalog = validateSmbAndroidDeviceCatalog(catalog).filter(profile => profile.verified === true)
	if (verifiedCatalog.length === 0) throw new Error('SMB_ANDROID device catalog has no verified profiles')

	const selectedIndex = selectIndex(verifiedCatalog.length)
	if (!Number.isInteger(selectedIndex) || selectedIndex < 0 || selectedIndex >= verifiedCatalog.length) {
		throw new Error(`SMB_ANDROID device selector returned invalid index ${selectedIndex}`)
	}

	return { ...verifiedCatalog[selectedIndex]! }
}
