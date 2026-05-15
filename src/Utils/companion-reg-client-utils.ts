import type { WABrowserDescription } from '../Types'

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

const BROWSER_TO_COMPANION_WEB_CLIENT: Record<string, CompanionWebClientType> = {
	Chrome: CompanionWebClientType.CHROME,
	Edge: CompanionWebClientType.EDGE,
	Firefox: CompanionWebClientType.FIREFOX,
	IE: CompanionWebClientType.IE,
	Opera: CompanionWebClientType.OPERA,
	Safari: CompanionWebClientType.SAFARI
}

export const getCompanionWebClientType = ([os, browserName]: WABrowserDescription): CompanionWebClientType => {
	if (browserName === 'Desktop') {
		return os === 'Windows' ? CompanionWebClientType.UWP : CompanionWebClientType.ELECTRON
	}

	return BROWSER_TO_COMPANION_WEB_CLIENT[browserName] || CompanionWebClientType.OTHER_WEB_CLIENT
}

export const getCompanionPlatformId = (browser: WABrowserDescription): string => {
	return getCompanionWebClientType(browser).toString()
}

export const buildPairingQRData = (
	ref: string,
	noiseKeyB64: string,
	identityKeyB64: string,
	advB64: string,
	_browser: WABrowserDescription
): string => {
	// InfiniteAPI keeps the legacy 4-field QR payload (`<ref>,<noise>,<identity>,<adv>`)
	// because:
	// 1. The WhatsApp app QR scanner accepts the bare comma-joined form without the URL prefix.
	// 2. The upstream `URL#<...>,<platformId>` format produced `linked_devices#,<ref>` (extra
	//    leading comma after the fragment) and emitted platform 9 for `Browsers.android()`,
	//    breaking pair-code companions that must declare Chrome (1).
	// The browser argument is preserved for API parity with upstream.
	return [ref, noiseKeyB64, identityKeyB64, advB64].join(',')
}
