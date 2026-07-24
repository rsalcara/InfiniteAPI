import { Boom } from '@hapi/boom'
import type { ConnectionTransportProfile, NativeAndroidAttestationProvider } from '../Types'
import { makeNativeAndroidBridgeAttestationProvider } from './native-android-provider-bridge'

export type InfiniteApiAuthStorage = 'json' | 'sqlite' | 'multi_db_sqlite'

export type InfiniteApiRuntimeProfile = {
	transportProfile: ConnectionTransportProfile
	authStorage: InfiniteApiAuthStorage
	attestationProvider?: NativeAndroidAttestationProvider
}

export type InfiniteApiRuntimeProfileDefaults = {
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
	if (normalized === 'json') return 'json'
	if (normalized === 'sqlite') return 'sqlite'
	if (normalized === 'multi_db_sqlite' || normalized === 'multidb') return 'multi_db_sqlite'
	throw new Boom(`invalid INFINITEAPI_AUTH_STORAGE: ${value}`, { statusCode: 400 })
}

/**
 * Resolves the deployment preset without changing the library's established
 * Web defaults. A future distribution may pass native_android/multi_db_sqlite
 * as defaults only after the full native lifecycle has passed.
 */
export const resolveInfiniteApiRuntimeProfile = (
	env: NodeJS.ProcessEnv = process.env,
	defaults: InfiniteApiRuntimeProfileDefaults = {}
): InfiniteApiRuntimeProfile => {
	const transportProfile = parseTransport(env.INFINITEAPI_TRANSPORT, defaults.transportProfile ?? 'web')
	const authStorage = parseStorage(env.INFINITEAPI_AUTH_STORAGE, defaults.authStorage ?? 'multi_db_sqlite')

	if (transportProfile === 'web') {
		return { transportProfile, authStorage }
	}

	const baseUrl = env.INFINITEAPI_ANDROID_PROVIDER_URL?.trim()
	if (!baseUrl) {
		throw new Boom(
			'native_android requires INFINITEAPI_ANDROID_PROVIDER_URL; set INFINITEAPI_TRANSPORT=web for the established fallback',
			{ statusCode: 400 }
		)
	}

	return {
		transportProfile,
		authStorage,
		attestationProvider: makeNativeAndroidBridgeAttestationProvider({
			baseUrl,
			bearerToken: env.INFINITEAPI_ANDROID_PROVIDER_TOKEN?.trim() || undefined,
			expectedPackageName: env.INFINITEAPI_ANDROID_PROVIDER_PACKAGE?.trim() || undefined
		})
	}
}
