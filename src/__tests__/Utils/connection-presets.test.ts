import { DEFAULT_CONNECTION_CONFIG } from '../../Defaults'
import type { ConnectionPreset, SocketConfig } from '../../Types'
import { initAuthCreds } from '../../Utils/auth-utils'
import { getPairCodeCompanionIdentity, getQrCodeCompanionIdentity } from '../../Utils/companion-reg-client-utils'
import {
	PRESET_MIGRATION_LEGACY_BROWSER,
	resolveConnectionPresetConfig,
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
	})
})
