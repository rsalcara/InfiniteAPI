import { DEFAULT_CONNECTION_CONFIG } from '../Defaults'
import type { SocketConfig, UserFacingSocketConfig, WAVersion } from '../Types'
import { attachAdminAbuseDetector } from '../Utils/admin-abuse-detector'
import { resolveUnmarkedLegacyWebBrowser, shouldPreserveUnmarkedLegacyWebIdentity } from '../Utils/connection-presets'
import { attachMeUsernameSync } from '../Utils/me-username-sync'
import {
	createMessageQuarantineRecorder,
	MsgRetryCounterSqliteAdapter,
	type MultiDbSqliteStore,
	UserDeviceCacheSqliteAdapter
} from '../Utils/multi-db-sqlite'
import { applyFetchAgentToRequestOptions } from '../Utils/proxy-route'
import type { VersionCacheLogger } from '../Utils/version-cache'
import { clearVersionCache, getCachedVersion, getVersionCacheStatus, refreshVersionCache } from '../Utils/version-cache'
import { makeCommunitiesSocket } from './communities'

/**
 * The message-store mirror (jid/jid_map, message/chat/receipts/media/
 * add-ons) wires itself automatically off `config.multiDbStore` inside
 * libsignal.ts/chats.ts. These three slots don't work that way: they're
 * consumed as `config.X || <in-memory default>` deep inside
 * messages-send.ts/messages-recv.ts/decode-wa-message.ts, so the SQLite
 * adapter has to be injected here — before any socket layer reads the
 * field — for it to ever be picked up instead of the in-memory default.
 * Never overrides a caller-supplied cache/hook (`??=`), and only engages
 * when `multiDbStore` is configured.
 */
const wireRemainingMsgstoreAdapters = (config: SocketConfig): void => {
	if (!config.multiDbStore) return
	const store = config.multiDbStore as MultiDbSqliteStore
	const msgstoreHandle = store.handle('msgstore.db')
	config.onMessageQuarantine ??= createMessageQuarantineRecorder({ store })
	config.msgRetryCounterCache ??= new MsgRetryCounterSqliteAdapter(msgstoreHandle)
	// Typed user_device tables authoritative by default (the mobile schema),
	// with the JSON mirror kept as fallback — same pattern as signalSourceOfTruth.
	config.userDevicesCache ??= new UserDeviceCacheSqliteAdapter(msgstoreHandle, { logger: config.logger })
}

/**
 * Adapts Baileys logger to VersionCacheLogger interface
 */
const createCacheLogger = (logger: any): VersionCacheLogger | undefined => {
	if (!logger) return undefined
	return {
		info: (obj: unknown, msg?: string) => logger.info(obj, msg),
		debug: (obj: unknown, msg?: string) => logger.debug(obj, msg),
		warn: (obj: unknown, msg?: string) => logger.warn(obj, msg)
	}
}

/**
 * Compares two WhatsApp versions
 * @returns true if versions are different
 */
const versionsAreDifferent = (v1: WAVersion, v2: WAVersion): boolean => {
	return v1[0] !== v2[0] || v1[1] !== v2[1] || v1[2] !== v2[2]
}

/**
 * Checks if a version change is critical (major or minor version changed)
 */
const isCriticalVersionChange = (oldVersion: WAVersion, newVersion: WAVersion): boolean => {
	// Major version change (index 0) or minor version change (index 1)
	return oldVersion[0] !== newVersion[0] || oldVersion[1] !== newVersion[1]
}

const mergeSocketConfig = (config: UserFacingSocketConfig): SocketConfig => {
	const mergedConfig: SocketConfig = {
		...DEFAULT_CONNECTION_CONFIG,
		...config
	}
	mergedConfig.options = applyFetchAgentToRequestOptions(mergedConfig.options ?? {}, mergedConfig.fetchAgent)
	const creds = config.auth.creds
	const transportProfile = config.transportProfile ?? DEFAULT_CONNECTION_CONFIG.transportProfile
	const isLegacyUnmarkedWebSession = shouldPreserveUnmarkedLegacyWebIdentity(
		creds,
		transportProfile,
		config.browser !== undefined
	)

	// Before Web identities were persisted the library defaulted to the Android
	// browser tuple. Preserve it only for registered, unmarked sessions whose
	// consumer did not provide a browser explicitly. New sessions use the
	// official Windows hybrid default.
	if (isLegacyUnmarkedWebSession && config.browser === undefined) {
		mergedConfig.browser = resolveUnmarkedLegacyWebBrowser(
			mergedConfig.browser ?? DEFAULT_CONNECTION_CONFIG.browser,
			process.env.BAILEYS_BROWSER
		)
	}

	return mergedConfig
}

const makeWASocketFromConfig = (newConfig: SocketConfig) => {
	wireRemainingMsgstoreAdapters(newConfig)

	const sock = makeCommunitiesSocket(newConfig)

	if (newConfig.detectAdminPromoteDemoteAbuse !== false) {
		attachAdminAbuseDetector(sock.ev, newConfig.logger, {
			windowMs: newConfig.adminPromoteDemoteWindowMs ?? 15 * 60 * 1000
		})
	}

	// Auto-propagate @username changes from inbound mex notifications
	// (re-shaped into `contacts.update` by `handleMexNotification`) into
	// `creds.me.username`, so the bound auth state stays in sync after
	// the user reserves / changes / deletes a handle on their primary
	// phone post-pair. Purely reactive (no stanzas).
	attachMeUsernameSync(sock.ev, sock.authState.creds, newConfig.logger)

	return sock
}

// export the last socket layer
const makeWASocket = (config: UserFacingSocketConfig) => makeWASocketFromConfig(mergeSocketConfig(config))

/**
 * Creates a WhatsApp socket connection with automatic version fetching
 * and periodic version checks (soft update - transparent to user).
 *
 * Features:
 * - **Shared cache**: 150 connections = 1 request (not 150)
 * - **Persistent cache**: Survives server restarts
 * - Fetches latest version on connect (uses cache if valid)
 * - Checks for new versions every 6 hours (configurable)
 * - Updates version on next natural reconnection (transparent)
 * - Emits 'version.update' event when new version is detected
 *
 * @example
 * ```typescript
 * // All connections share the same cached version
 * const sock = await makeWASocketAutoVersion({
 *     auth: state,
 *     versionCheckIntervalMs: 6 * 60 * 60 * 1000 // 6 hours (default)
 * })
 *
 * // Listen for version updates
 * sock.ev.on('version.update', ({ currentVersion, newVersion, isCritical }) => {
 *     console.log(`New version detected: ${newVersion.join('.')}`)
 *     // Version will be used on next reconnection automatically
 * })
 * ```
 */
export const makeWASocketAutoVersion = async (config: UserFacingSocketConfig) => {
	const mergedConfig = mergeSocketConfig(config)

	const logger = mergedConfig.logger
	const cacheLogger = createCacheLogger(logger)
	const checkIntervalMs = mergedConfig.versionCheckIntervalMs

	// Track version separately to avoid mutating config (Fix #7)
	let trackedVersion: WAVersion = [...mergedConfig.version] as WAVersion
	let versionCheckInterval: ReturnType<typeof setInterval> | null = null
	let isSocketClosed = false

	/**
	 * Cleans up the version check interval
	 */
	const cleanupInterval = () => {
		if (versionCheckInterval) {
			clearInterval(versionCheckInterval)
			versionCheckInterval = null
			logger?.debug('Stopped periodic version check')
		}
	}

	// Fetch latest version using SHARED CACHE
	// 150 connections starting = 1 request (deduplication)
	try {
		const { version, fromCache, age } = await getCachedVersion({
			cacheTtlMs: checkIntervalMs,
			logger: cacheLogger
		})

		logger?.info(
			{
				version,
				fromCache,
				ageMinutes: fromCache ? Math.round(age / 60000) : 0
			},
			fromCache ? 'Using cached WhatsApp Web version' : 'Fetched fresh WhatsApp Web version'
		)

		mergedConfig.version = version
		trackedVersion = [...version] as WAVersion
	} catch (error) {
		logger?.warn({ error, fallbackVersion: mergedConfig.version }, 'Error fetching version, using bundled version')
	}

	// Create the socket
	const sock = makeWASocketFromConfig(mergedConfig)

	// Listen for connection close to cleanup interval (Fix #1, #6)
	// This handles both explicit sock.end() and internal disconnections
	sock.ev.on('connection.update', update => {
		if (update.connection === 'close') {
			isSocketClosed = true
			cleanupInterval()
		} else if (update.connection === 'open') {
			isSocketClosed = false
		}
	})

	// Setup periodic version check if interval > 0
	if (checkIntervalMs > 0) {
		logger?.info({ intervalHours: checkIntervalMs / (60 * 60 * 1000) }, 'Starting periodic version check')

		versionCheckInterval = setInterval(async () => {
			// Skip if socket is closed (Fix #8 - race condition)
			if (isSocketClosed) {
				cleanupInterval()
				return
			}

			try {
				logger?.debug('Checking for WhatsApp Web version update...')

				// Check cache status first
				const cacheStatus = getVersionCacheStatus(checkIntervalMs)

				// Only refresh if cache is expired (one socket refreshes, others use cache)
				let newVersion: WAVersion
				let fetchSuccess = true

				if (cacheStatus.isExpired) {
					logger?.debug('Cache expired, refreshing...')
					const result = await refreshVersionCache({ logger: cacheLogger })
					newVersion = result.version
					fetchSuccess = result.success

					// Don't update to fallback version on transient network errors
					if (!fetchSuccess) {
						logger?.warn({ fallbackVersion: result.version }, 'Failed to fetch latest version, keeping current version')
						return // Skip version update on fetch failure
					}
				} else if (cacheStatus.version) {
					// Cache still valid, use cached version directly (no file I/O)
					newVersion = cacheStatus.version
				} else {
					// No cache available, skip this check
					return
				}

				// Double-check socket is still open after async operation (Fix #8)
				if (isSocketClosed) {
					cleanupInterval()
					return
				}

				if (versionsAreDifferent(trackedVersion, newVersion)) {
					const isCritical = isCriticalVersionChange(trackedVersion, newVersion)
					const previousVersion = trackedVersion

					logger?.info(
						{
							currentVersion: previousVersion,
							newVersion: newVersion,
							isCritical
						},
						'New WhatsApp Web version detected! Will use on next reconnection.'
					)

					// Update tracked version for next reconnection (Fix #7)
					trackedVersion = [...newVersion] as WAVersion

					// Emit event for user to handle (only if socket still open)
					if (!isSocketClosed) {
						sock.ev.emit('version.update', {
							currentVersion: previousVersion,
							newVersion: newVersion,
							isCritical
						})
					}
				} else {
					logger?.debug({ version: trackedVersion }, 'Version is up to date')
				}
			} catch (error) {
				logger?.warn({ error }, 'Error checking for version update')
			}
		}, checkIntervalMs)
	}

	return sock
}

// Export cache utilities for manual control
export { getCachedVersion, refreshVersionCache, clearVersionCache, getVersionCacheStatus }

export default makeWASocket
