import type { ConnectionTransportProfile, WABrowserDescription } from '../Types'

export enum CompanionWebClientType {
	UNKNOWN = 0,
	CHROME = 1,
	EDGE = 2,
	FIREFOX = 3,
	IE = 4,
	OPERA = 5,
	SAFARI = 6,
	ELECTRON = 7,
	UWP = 8,
	OTHER_WEB_CLIENT = 9
}

// Use a Map (not a plain object) to avoid prototype-pollution lookups
// where browser names like `toString` or `constructor` would return inherited
// function values instead of CompanionWebClientType. Keys are lowercased and
// the input is lowercased on lookup to handle every casing (Chrome/chrome/CHROME,
// IE/ie/Ie/iE) consistently — matching the normalize-then-lookup pattern used by
// the existing browser-utils helper `getPlatformId`.
const BROWSER_TO_COMPANION_WEB_CLIENT = new Map<string, CompanionWebClientType>([
	['chrome', CompanionWebClientType.CHROME],
	['edge', CompanionWebClientType.EDGE],
	['firefox', CompanionWebClientType.FIREFOX],
	['ie', CompanionWebClientType.IE],
	['opera', CompanionWebClientType.OPERA],
	['safari', CompanionWebClientType.SAFARI],
	// Android must declare Chrome (1) for pair-code companions; see the matching
	// `pairPlatformId` override in src/Socket/socket.ts.
	['android', CompanionWebClientType.CHROME]
])

export const getCompanionWebClientType = ([os, browserName]: WABrowserDescription): CompanionWebClientType => {
	if (browserName === 'Desktop') {
		return os === 'Windows' ? CompanionWebClientType.UWP : CompanionWebClientType.ELECTRON
	}

	const key = typeof browserName === 'string' ? browserName.trim().toLowerCase() : ''
	return BROWSER_TO_COMPANION_WEB_CLIENT.get(key) ?? CompanionWebClientType.OTHER_WEB_CLIENT
}

export const getCompanionPlatformId = (browser: WABrowserDescription): string => {
	return getCompanionWebClientType(browser).toString()
}

export interface PairCodeCompanionIdentity {
	platformId: string
	platformName: string
	platformDisplay: string
	windowsHybrid: boolean
}

/**
 * Resolves the identity sent in link_code_companion_reg.
 *
 * Pair Code registration stays on the configured Web-client identity even
 * when DeviceProps advertises WIN_HYBRID/UWP for full history. The WhatsApp
 * server rejects UWP=8 in companion_hello with IQ 400; a Windows Edge client
 * must send EDGE=2 here while DeviceProps independently uses UWP=21.
 */
export const getPairCodeCompanionIdentity = (
	browser: WABrowserDescription,
	syncFullHistory: boolean
): PairCodeCompanionIdentity => {
	const windowsHybrid = syncFullHistory && browser[0].trim().toLowerCase() === 'windows'
	const androidBrowser = browser[1]?.trim().toLowerCase() === 'android'
	const platformType = getCompanionWebClientType(browser)

	return {
		platformId: platformType.toString(),
		platformName: CompanionWebClientType[platformType],
		platformDisplay: androidBrowser ? 'Chrome (Mac OS)' : `${browser[1]} (${browser[0]})`,
		windowsHybrid
	}
}

export const buildPairingQRData = (
	ref: string,
	noiseKeyB64: string,
	identityKeyB64: string,
	advB64: string,
	browser: WABrowserDescription,
	transportProfile: ConnectionTransportProfile = 'web',
	syncFullHistory = false
): string => {
	// InfiniteAPI keeps the legacy 4-field QR payload (`<ref>,<noise>,<identity>,<adv>`)
	// because:
	// 1. The WhatsApp app QR scanner accepts the bare comma-joined form without the URL prefix.
	// 2. The upstream `URL#<...>,<platformId>` format produced `linked_devices#,<ref>` (extra
	//    leading comma after the fragment) and emitted platform 9 for `Browsers.android()`,
	//    breaking pair-code companions that must declare Chrome (1).
	const payloadFields = [ref, noiseKeyB64, identityKeyB64, advB64]

	// The official Windows companion QR includes the Web-client platform enum
	// as its fifth field. UWP is 8 in this enum (distinct from UWP=21 in
	// DeviceProps). Without it the phone accepts the link as a generic legacy
	// Web companion and may omit the Windows full/recent history-sync flow.
	if (transportProfile === 'web' && syncFullHistory && browser[0].trim().toLowerCase() === 'windows') {
		payloadFields.push(getCompanionWebClientType([browser[0], 'Desktop', browser[2]]).toString())
		return `https://wa.me/settings/linked_devices#${payloadFields.join(',')}`
	}

	const payload = payloadFields.join(',')

	// The official Android companion scanner presents the linked-devices URL form.
	// Web keeps its historical bare payload byte-for-byte unchanged.
	return transportProfile === 'native_android' ? `https://wa.me/settings/linked_devices#${payload}` : payload
}
