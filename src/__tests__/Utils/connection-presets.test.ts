import { DEFAULT_CONNECTION_CONFIG, resolveDefaultBrowser } from '../../Defaults'
import type { ConnectionPreset, SocketConfig } from '../../Types'
import { initAuthCreds } from '../../Utils/auth-utils'
import { Browsers } from '../../Utils/browser-utils'
import { getPairCodeCompanionIdentity, getQrCodeCompanionIdentity } from '../../Utils/companion-reg-client-utils'
import {
	hasExplicitBaileysBrowserSelection,
	PRESET_MIGRATION_LEGACY_BROWSER,
	resolveConnectionPresetConfig,
	resolveUnmarkedLegacyWebBrowser,
	shouldPreserveUnmarkedLegacyWebIdentity,
	WINDOWS_HYBRID_BROWSER
} from '../../Utils/connection-presets'
import { resolveTransportSession } from '../../Utils/native-android-transport'
import { type InfiniteApiAuthStorage, resolveInfiniteApiRuntimeProfile } from '../../Utils/runtime-profile'

describe('connection identity presets', () => {
	it('uses the captured Windows hybrid identity by default', () => {
		expect(DEFAULT_CONNECTION_CONFIG.transportProfile).toBe('web')
		expect(DEFAULT_CONNECTION_CONFIG.browser).toEqual(WINDOWS_HYBRID_BROWSER)
		expect(DEFAULT_CONNECTION_CONFIG.syncFullHistory).toBe(true)
		expect(
			getQrCodeCompanionIdentity(
				DEFAULT_CONNECTION_CONFIG.browser,
				DEFAULT_CONNECTION_CONFIG.transportProfile,
				DEFAULT_CONNECTION_CONFIG.syncFullHistory
			)
		).toMatchObject({ platformId: '8', platformName: 'UWP', windowsHybrid: true })
		expect(
			getPairCodeCompanionIdentity(DEFAULT_CONNECTION_CONFIG.browser, DEFAULT_CONNECTION_CONFIG.syncFullHistory)
		).toMatchObject({ platformId: '2', platformName: 'EDGE', windowsHybrid: true })
	})

	it('uses the exact captured Windows tuple for unknown browser selectors', () => {
		const previous = process.env.BAILEYS_BROWSER
		process.env.BAILEYS_BROWSER = 'unknown-selector'

		try {
			expect(resolveDefaultBrowser()).toEqual(WINDOWS_HYBRID_BROWSER)
		} finally {
			if (previous === undefined) delete process.env.BAILEYS_BROWSER
			else process.env.BAILEYS_BROWSER = previous
		}
	})

	it.each([
		['windows', WINDOWS_HYBRID_BROWSER],
		['win_hybrid', WINDOWS_HYBRID_BROWSER],
		['desktop', WINDOWS_HYBRID_BROWSER],
		['chrome', Browsers.macOS('Chrome')],
		['macos', Browsers.macOS('Chrome')],
		['android', Browsers.android('14')],
		['android:15', Browsers.android('15')]
	] as const)('uses the same canonical parser for the explicit %s selector', (selector, expected) => {
		const previous = process.env.BAILEYS_BROWSER
		process.env.BAILEYS_BROWSER = selector

		try {
			expect(hasExplicitBaileysBrowserSelection(selector)).toBe(true)
			expect(resolveDefaultBrowser()).toEqual(expected)
		} finally {
			if (previous === undefined) delete process.env.BAILEYS_BROWSER
			else process.env.BAILEYS_BROWSER = previous
		}
	})

	it.each([
		['web_legacy', 'web', undefined],
		['web_windows_hybrid', 'web', undefined],
		['native_android_consumer', 'native_android', 'consumer'],
		['native_android_business', 'native_android', 'business']
	] as const)('resolves %s independently from auth storage', (preset, transportProfile, appVariant) => {
		const resolved = resolveConnectionPresetConfig(preset)

		expect(resolved.transportProfile).toBe(transportProfile)
		expect(resolved.nativeAndroidAppVariant).toBe(appVariant)
	})

	it.each([
		['multifile', 'json'],
		['sqlite', 'sqlite'],
		['multidb-sqlite', 'multi_db_sqlite']
	] as const)('keeps backend %s available for every preset', (storage, expectedStorage) => {
		const presets: ConnectionPreset[] = [
			'web_legacy',
			'web_windows_hybrid',
			'native_android_consumer',
			'native_android_business'
		]

		for (const connectionPreset of presets) {
			const profile = resolveInfiniteApiRuntimeProfile({
				INFINITEAPI_CONNECTION_PRESET: connectionPreset,
				INFINITEAPI_AUTH_STORAGE: storage
			})

			expect(profile.connectionPreset).toBe(connectionPreset)
			expect(profile.authStorage).toBe<InfiniteApiAuthStorage>(expectedStorage)
		}
	})

	it('rejects contradictory preset and legacy transport selectors', () => {
		expect(() =>
			resolveInfiniteApiRuntimeProfile({
				INFINITEAPI_CONNECTION_PRESET: 'web_windows_hybrid',
				INFINITEAPI_TRANSPORT: 'native_android'
			})
		).toThrow('conflicts with INFINITEAPI_TRANSPORT')
	})

	it('rejects a native variant with an explicitly selected Web preset without breaking legacy Web selectors', () => {
		expect(() =>
			resolveInfiniteApiRuntimeProfile({
				INFINITEAPI_CONNECTION_PRESET: 'web_windows_hybrid',
				NATIVE_ANDROID_APP_VARIANT: 'consumer'
			})
		).toThrow('conflicts with NATIVE_ANDROID_APP_VARIANT')
		expect(() =>
			resolveInfiniteApiRuntimeProfile({
				INFINITEAPI_TRANSPORT: 'web',
				NATIVE_ANDROID_APP_VARIANT: 'consumer'
			})
		).not.toThrow()
	})

	it('persists and reuses the first Web identity instead of converting it on reconnect', () => {
		const creds = initAuthCreds()
		const firstConfig: SocketConfig = {
			...DEFAULT_CONNECTION_CONFIG,
			browser: ['Windows', 'Desktop', '10'],
			syncFullHistory: true
		}
		const first = resolveTransportSession(firstConfig, creds)

		expect(first.credsChanged).toBe(true)
		expect(first.webIdentity).toMatchObject({
			preset: 'web_windows_hybrid',
			browser: ['Windows', 'Desktop', '10'],
			syncFullHistory: true
		})

		const reconnect = resolveTransportSession(
			{ ...firstConfig, browser: ['Mac OS', 'Chrome', '15'], syncFullHistory: false },
			creds
		)
		expect(reconnect.credsChanged).toBe(false)
		expect(reconnect.webIdentity).toEqual(first.webIdentity)
	})

	it('rejects a corrupt persisted Web identity instead of changing protocol fields', () => {
		const creds = initAuthCreds()
		creds.webTransportIdentity = {
			schemaVersion: 1,
			profile: 'web',
			preset: 'web_windows_hybrid',
			browser: ['Mac OS', 'Chrome', '15'],
			syncFullHistory: false
		}

		expect(() => resolveTransportSession({ ...DEFAULT_CONNECTION_CONFIG }, creds)).toThrow(
			'web_windows_hybrid identity does not match its browser and history settings'
		)
	})

	it.each([null, 'corrupt'])('rejects a present malformed Web identity marker: %p', marker => {
		const creds = initAuthCreds()
		;(creds as unknown as { webTransportIdentity: unknown }).webTransportIdentity = marker

		expect(() => resolveTransportSession({ ...DEFAULT_CONNECTION_CONFIG }, creds)).toThrow(
			'Web transport identity is invalid'
		)
	})

	it('rejects a legacy marker carrying a Windows hybrid identity', () => {
		const creds = initAuthCreds()
		creds.webTransportIdentity = {
			schemaVersion: 1,
			profile: 'web',
			preset: 'web_legacy',
			browser: [...WINDOWS_HYBRID_BROWSER],
			syncFullHistory: true
		}

		expect(() => resolveTransportSession({ ...DEFAULT_CONNECTION_CONFIG }, creds)).toThrow(
			'web_legacy identity does not match its browser and history settings'
		)
	})

	it('preserves the historical browser only for registered unmarked sessions without an explicit browser', () => {
		const creds = initAuthCreds()
		creds.registered = true

		expect(shouldPreserveUnmarkedLegacyWebIdentity(creds, 'web', false)).toBe(true)
		expect(shouldPreserveUnmarkedLegacyWebIdentity(creds, 'web', true)).toBe(false)
		expect(PRESET_MIGRATION_LEGACY_BROWSER).toEqual(['14', 'Android', ''])
		expect(hasExplicitBaileysBrowserSelection('chrome')).toBe(true)
		expect(hasExplicitBaileysBrowserSelection('android:15')).toBe(true)
		expect(hasExplicitBaileysBrowserSelection('typo')).toBe(false)
		expect(resolveUnmarkedLegacyWebBrowser(['Mac OS', 'Chrome', '15'], 'chrome')).toEqual(['Mac OS', 'Chrome', '15'])
		expect(resolveUnmarkedLegacyWebBrowser(WINDOWS_HYBRID_BROWSER, 'typo')).toEqual(PRESET_MIGRATION_LEGACY_BROWSER)
	})
})
