import { Boom } from '@hapi/boom'
import { resolve } from 'path'
import type {
	ConnectionPreset,
	ConnectionTransportProfile,
	NativeAndroidAppVariant,
	NativeAndroidAttestationProvider,
	WABrowserDescription
} from '../Types'
import { resolveConnectionPresetConfig } from './connection-presets'
import { makeNativeAndroidNodeAttestationProvider } from './native-android-node-attestation'

export type InfiniteApiAuthStorage = 'json' | 'sqlite' | 'multi_db_sqlite'

export type InfiniteApiRuntimeProfile = {
	connectionPreset: ConnectionPreset
	transportProfile: ConnectionTransportProfile
	authStorage: InfiniteApiAuthStorage
	browser?: WABrowserDescription
	syncFullHistory: boolean
	nativeAndroidAppVariant?: NativeAndroidAppVariant
	attestationProvider?: NativeAndroidAttestationProvider
}

export type InfiniteApiRuntimeProfileDefaults = {
	connectionPreset?: ConnectionPreset
	transportProfile?: ConnectionTransportProfile
	authStorage?: InfiniteApiAuthStorage
}

const parseTransport = (value: string | undefined, fallback: ConnectionTransportProfile) => {
	const normalized = value?.trim().toLowerCase()
	if (!normalized) return fallback
	if (normalized === 'web') return 'web'
	if (normalized === 'native_android' || normalized === 'native-android') return 'native_android'
	throw new Boom(`invalid INFINITEAPI_TRANSPORT: ${value}`, { statusCode: 400 })
}

const parseStorage = (value: string | undefined, fallback: InfiniteApiAuthStorage) => {
	const normalized = value?.trim().toLowerCase().replace(/-/g, '_')
	if (!normalized) return fallback
	if (normalized === 'json' || normalized === 'multifile' || normalized === 'multi_file') return 'json'
	if (normalized === 'sqlite' || normalized === 'mono' || normalized === 'mono_sqlite') return 'sqlite'
	if (normalized === 'multi_db_sqlite' || normalized === 'multidb' || normalized === 'multidb_sqlite') {
		return 'multi_db_sqlite'
	}

	throw new Boom(`invalid INFINITEAPI_AUTH_STORAGE: ${value}`, { statusCode: 400 })
}

const parsePreset = (value: string | undefined): ConnectionPreset | undefined => {
	const normalized = value?.trim().toLowerCase().replace(/-/g, '_')
	if (!normalized) return undefined
	if (
		normalized === 'web_legacy' ||
		normalized === 'web_windows_hybrid' ||
		normalized === 'native_android_consumer' ||
		normalized === 'native_android_business'
	) {
		return normalized
	}

	throw new Boom(`invalid INFINITEAPI_CONNECTION_PRESET: ${value}`, { statusCode: 400 })
}

const parseNativeVariant = (value: string | undefined): NativeAndroidAppVariant => {
	const normalized = value?.trim().toLowerCase()
	if (!normalized || normalized === 'business') return 'business'
	if (normalized === 'consumer') return 'consumer'
	throw new Boom(`invalid NATIVE_ANDROID_APP_VARIANT: ${value}`, { statusCode: 400 })
}

/**
 * Resolves protocol identity and auth storage independently. Legacy
 * INFINITEAPI_TRANSPORT/NATIVE_ANDROID_APP_VARIANT variables remain accepted;
 * INFINITEAPI_CONNECTION_PRESET is the unambiguous preferred selector.
 */
export const resolveInfiniteApiRuntimeProfile = (
	env: NodeJS.ProcessEnv = process.env,
	defaults: InfiniteApiRuntimeProfileDefaults = {}
): InfiniteApiRuntimeProfile => {
	const authStorage = parseStorage(env.INFINITEAPI_AUTH_STORAGE, defaults.authStorage ?? 'multi_db_sqlite')
	const explicitPreset = parsePreset(env.INFINITEAPI_CONNECTION_PRESET)
	const explicitTransport = env.INFINITEAPI_TRANSPORT
		? parseTransport(env.INFINITEAPI_TRANSPORT, defaults.transportProfile ?? 'web')
		: undefined
	let connectionPreset = explicitPreset ?? defaults.connectionPreset

	if (!connectionPreset) {
		const transportProfile = explicitTransport ?? defaults.transportProfile ?? 'web'
		connectionPreset =
			transportProfile === 'web'
				? 'web_windows_hybrid'
				: parseNativeVariant(env.NATIVE_ANDROID_APP_VARIANT) === 'consumer'
					? 'native_android_consumer'
					: 'native_android_business'
	}

	const presetConfig = resolveConnectionPresetConfig(connectionPreset)
	if (explicitTransport && explicitTransport !== presetConfig.transportProfile) {
		throw new Boom(
			`INFINITEAPI_CONNECTION_PRESET=${connectionPreset} conflicts with INFINITEAPI_TRANSPORT=${env.INFINITEAPI_TRANSPORT}`,
			{ statusCode: 400 }
		)
	}

	if (presetConfig.nativeAndroidAppVariant && env.NATIVE_ANDROID_APP_VARIANT) {
		const explicitVariant = parseNativeVariant(env.NATIVE_ANDROID_APP_VARIANT)
		if (explicitVariant !== presetConfig.nativeAndroidAppVariant) {
			throw new Boom(
				`INFINITEAPI_CONNECTION_PRESET=${connectionPreset} conflicts with NATIVE_ANDROID_APP_VARIANT=${env.NATIVE_ANDROID_APP_VARIANT}`,
				{ statusCode: 400 }
			)
		}
	}

	if (presetConfig.transportProfile === 'web') {
		return {
			connectionPreset,
			transportProfile: 'web',
			authStorage,
			browser: presetConfig.browser,
			syncFullHistory: presetConfig.syncFullHistory
		}
	}

	const storageDirectory = resolve(
		env.INFINITEAPI_NATIVE_ANDROID_STATE_DIR?.trim() || '.infiniteapi/native-android-attestation'
	)

	return {
		connectionPreset,
		transportProfile: 'native_android',
		authStorage,
		syncFullHistory: presetConfig.syncFullHistory,
		nativeAndroidAppVariant: presetConfig.nativeAndroidAppVariant,
		attestationProvider: makeNativeAndroidNodeAttestationProvider({
			storageDirectory
		})
	}
}
