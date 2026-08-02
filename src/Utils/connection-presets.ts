import { Boom } from '@hapi/boom'
import type {
	AuthenticationCreds,
	ConnectionPreset,
	ConnectionTransportProfile,
	NativeAndroidAppVariant,
	PersistedWebTransportIdentity,
	WABrowserDescription,
	WebConnectionPreset
} from '../Types'

export type ConnectionPresetConfig = {
	preset: ConnectionPreset
	transportProfile: ConnectionTransportProfile
	browser?: WABrowserDescription
	syncFullHistory: boolean
	nativeAndroidAppVariant?: NativeAndroidAppVariant
}

/** Identity captured from the official Windows companion. */
export const WINDOWS_HYBRID_BROWSER: WABrowserDescription = ['Windows', 'Desktop', '10']

/** Stable generic Web identity for explicitly selected legacy sessions. */
export const LEGACY_WEB_BROWSER: WABrowserDescription = ['Mac OS', 'Chrome', '15']

/** Previous InfiniteAPI default, used only to avoid converting unmarked sessions during upgrade. */
export const PRESET_MIGRATION_LEGACY_BROWSER: WABrowserDescription = ['14', 'Android', '']

export const BAILEYS_BROWSER_WINDOWS_SELECTORS = ['windows', 'win_hybrid', 'desktop'] as const
export const BAILEYS_BROWSER_MACOS_SELECTORS = ['chrome', 'macos'] as const

export type BaileysBrowserSelection =
	| { family: 'windows' }
	| { family: 'macos' }
	| { family: 'android'; apiLevel: string }

/** Canonical parser shared by defaults and legacy-session migration. */
export const parseBaileysBrowserSelection = (value: string | undefined): BaileysBrowserSelection | undefined => {
	const normalized = value?.trim().toLowerCase()
	if (!normalized) return undefined
	if ((BAILEYS_BROWSER_WINDOWS_SELECTORS as readonly string[]).includes(normalized)) return { family: 'windows' }
	if ((BAILEYS_BROWSER_MACOS_SELECTORS as readonly string[]).includes(normalized)) return { family: 'macos' }
	if (normalized === 'android') return { family: 'android', apiLevel: '14' }
	if (normalized.startsWith('android:')) return { family: 'android', apiLevel: normalized.split(':')[1] || '14' }
	return undefined
}

/** Recognized environment selectors that intentionally overrode the historical browser default. */
export const hasExplicitBaileysBrowserSelection = (value: string | undefined): boolean =>
	parseBaileysBrowserSelection(value) !== undefined

export const resolveUnmarkedLegacyWebBrowser = (
	resolvedBrowser: WABrowserDescription,
	value: string | undefined
): WABrowserDescription =>
	hasExplicitBaileysBrowserSelection(value) ? [...resolvedBrowser] : [...PRESET_MIGRATION_LEGACY_BROWSER]

const WEB_CONNECTION_PRESET_CONFIGS: Record<
	WebConnectionPreset,
	Pick<ConnectionPresetConfig, 'transportProfile' | 'browser' | 'syncFullHistory'>
> = {
	web_legacy: {
		transportProfile: 'web',
		browser: LEGACY_WEB_BROWSER,
		syncFullHistory: false
	},
	web_windows_hybrid: {
		transportProfile: 'web',
		browser: WINDOWS_HYBRID_BROWSER,
		syncFullHistory: true
	}
}

const browserEquals = (left: WABrowserDescription, right: WABrowserDescription): boolean =>
	left.every((value, index) => value.trim().toLowerCase() === right[index]?.trim().toLowerCase())

export const resolveConnectionPresetConfig = (preset: ConnectionPreset): ConnectionPresetConfig => {
	switch (preset) {
		case 'web_legacy':
		case 'web_windows_hybrid': {
			const web = WEB_CONNECTION_PRESET_CONFIGS[preset]
			return {
				preset,
				...web,
				browser: [...web.browser!]
			}
		}

		case 'native_android_consumer':
			return {
				preset,
				transportProfile: 'native_android',
				syncFullHistory: true,
				nativeAndroidAppVariant: 'consumer'
			}
		case 'native_android_business':
			return {
				preset,
				transportProfile: 'native_android',
				syncFullHistory: true,
				nativeAndroidAppVariant: 'business'
			}
	}
}

export const inferWebConnectionPreset = (
	browser: WABrowserDescription,
	syncFullHistory: boolean
): WebConnectionPreset => {
	for (const preset of ['web_legacy', 'web_windows_hybrid'] as const) {
		const expected = WEB_CONNECTION_PRESET_CONFIGS[preset]
		if (expected.syncFullHistory === syncFullHistory && browserEquals(browser, expected.browser!)) return preset
	}

	// Existing custom Web identities remain legacy rather than being silently
	// promoted to the Windows-specific protocol profile.
	return 'web_legacy'
}

export const makePersistedWebTransportIdentity = (
	browser: WABrowserDescription,
	syncFullHistory: boolean
): PersistedWebTransportIdentity => ({
	schemaVersion: 1,
	profile: 'web',
	preset: inferWebConnectionPreset(browser, syncFullHistory),
	browser: [...browser],
	syncFullHistory
})

export const validatePersistedWebTransportIdentity = (identity: PersistedWebTransportIdentity): void => {
	if (identity.schemaVersion !== 1 || identity.profile !== 'web') {
		throw new Boom('Web transport identity has an unsupported schema or profile', { statusCode: 400 })
	}

	if (identity.preset !== 'web_legacy' && identity.preset !== 'web_windows_hybrid') {
		throw new Boom('Web transport identity has an invalid preset', { statusCode: 400 })
	}

	if (
		!Array.isArray(identity.browser) ||
		identity.browser.length !== 3 ||
		identity.browser.some(value => typeof value !== 'string') ||
		identity.browser[0].trim().length === 0 ||
		identity.browser[1].trim().length === 0
	) {
		throw new Boom('Web transport identity has an invalid browser tuple', { statusCode: 400 })
	}

	if (typeof identity.syncFullHistory !== 'boolean') {
		throw new Boom('Web transport identity has an invalid syncFullHistory value', { statusCode: 400 })
	}

	if (inferWebConnectionPreset(identity.browser, identity.syncFullHistory) !== identity.preset) {
		throw new Boom(`${identity.preset} identity does not match its browser and history settings`, { statusCode: 400 })
	}
}

export const shouldPreserveUnmarkedLegacyWebIdentity = (
	creds: AuthenticationCreds,
	transportProfile: ConnectionTransportProfile,
	browserWasExplicit: boolean
): boolean =>
	transportProfile === 'web' &&
	!browserWasExplicit &&
	(creds.registered || Boolean(creds.account && creds.me)) &&
	!creds.nativeAndroidIdentity &&
	!creds.webTransportIdentity
