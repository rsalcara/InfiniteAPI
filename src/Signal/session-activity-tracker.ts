import type { SignalKeyStoreWithTransaction } from '../Types'
import { intFromEnv } from '../Utils/env-utils'
import type { ILogger } from '../Utils/logger'

/**
 * Session activity tracker configuration
 */
export interface SessionActivityConfig {
	/** Flush interval in milliseconds (default: 60s) */
	flushIntervalMs: number
	/** Enable activity tracking (default: true) */
	enabled: boolean
}

/**
 * Default configuration for session activity tracking
 */
export const DEFAULT_SESSION_ACTIVITY_CONFIG: SessionActivityConfig = {
	// audit ENV-01: was `parseInt(... || '60000', 10)` — NaN under malformed
	// env vars (e.g. "60s") cascades into `setInterval(NaN)` → 1 ms loop.
	flushIntervalMs: intFromEnv(process.env.BAILEYS_SESSION_ACTIVITY_FLUSH_MS, 60_000, 1), // 1 minute
	enabled: process.env.BAILEYS_SESSION_ACTIVITY_ENABLED !== 'false'
}

/**
 * Session activity metadata stored in key store
 */
export interface SessionActivityMetadata {
	/** Last activity timestamp (Unix milliseconds) */
	lastActivityAt: number
	/** Session created timestamp (Unix milliseconds) */
	createdAt?: number
}

/**
 * Session Activity Tracker
 *
 * Tracks when sessions were last used (message sent/received) to enable
 * cleanup of inactive sessions.
 *
 * PERFORMANCE OPTIMIZATION:
 * - In-memory cache: Updates stored in Map (no disk I/O per message)
 * - Periodic flush: Writes to disk every 60s (configurable)
 * - Batch writes: All updates written in single transaction
 *
 * OVERHEAD: <0.1ms per message (just Map.set() in memory)
 *
 * @example
 * const tracker = makeSessionActivityTracker(keys, logger)
 * tracker.start()
 *
 * // On message send/receive:
 * tracker.recordActivity('5511999999999@s.whatsapp.net')
 *
 * // On cleanup:
 * const lastActivity = await tracker.getLastActivity('5511999999999@s.whatsapp.net')
 * if (Date.now() - lastActivity > 30_DAYS) {
 *   // Delete session
 * }
 */
export const makeSessionActivityTracker = (
	keys: SignalKeyStoreWithTransaction,
	logger: ILogger,
	config: SessionActivityConfig = DEFAULT_SESSION_ACTIVITY_CONFIG
) => {
	// In-memory cache: JID -> timestamp
	const activityCache = new Map<string, number>()

	// Dirty flag: tracks if cache has unflushed changes
	let isDirty = false

	// Flush interval timer
	let flushInterval: ReturnType<typeof setInterval> | null = null

	// Statistics
	const stats = {
		totalUpdates: 0,
		totalFlushes: 0,
		lastFlushAt: 0,
		lastFlushDuration: 0,
		cacheSize: 0
	}

	/**
	 * Record activity for a JID
	 * Updates in-memory cache only (fast, <0.1ms)
	 */
	const recordActivity = (jid: string): void => {
		if (!config.enabled) return

		const now = Date.now()
		activityCache.set(jid, now)
		isDirty = true
		stats.totalUpdates++
		stats.cacheSize = activityCache.size
	}

	/**
	 * Get last activity timestamp for a JID
	 * Checks in-memory cache first, then disk
	 */
	const getLastActivity = async (jid: string): Promise<number | undefined> => {
		if (!config.enabled) return undefined

		// Check cache first
		const cached = activityCache.get(jid)
		if (cached) return cached

		// Fallback to disk
		try {
			const key = `session-activity:${jid}`
			const data = await keys.get('session-activity' as any, [key])
			const metadata = data[key] as SessionActivityMetadata | undefined
			return metadata?.lastActivityAt
		} catch (error) {
			logger.warn({ error, jid }, 'Failed to get session activity from disk')
			return undefined
		}
	}

	/**
	 * Get all session activities (for cleanup)
	 * Returns Map of JID -> lastActivityAt
	 */
	const getAllActivities = async (): Promise<Map<string, number>> => {
		if (!config.enabled) return new Map()

		const result = new Map<string, number>()

		try {
			// Get all session activity keys from disk
			const allData = await keys.get('session-activity' as any, [])

			for (const [key, value] of Object.entries(allData)) {
				if (key.startsWith('session-activity:')) {
					const jid = key.replace('session-activity:', '')
					const metadata = value as SessionActivityMetadata
					if (metadata?.lastActivityAt) {
						result.set(jid, metadata.lastActivityAt)
					}
				}
			}

			// Merge with in-memory cache (cache is more recent)
			for (const [jid, timestamp] of activityCache.entries()) {
				result.set(jid, timestamp)
			}
		} catch (error) {
			logger.warn({ error }, 'Failed to get all session activities')
		}

		return result
	}

	/**
	 * Flush in-memory cache to disk
	 * Writes all pending updates in single transaction
	 */
	const flush = async (): Promise<void> => {
		if (!config.enabled || !isDirty || activityCache.size === 0) {
			return
		}

		const startTime = Date.now()

		try {
			// Prepare batch update
			const updates: { [key: string]: SessionActivityMetadata } = {}

			for (const [jid, timestamp] of activityCache.entries()) {
				const key = `session-activity:${jid}`
				updates[key] = {
					lastActivityAt: timestamp,
					createdAt: timestamp // First activity = creation time
				}
			}

			// Single transaction for all updates
			await keys.transaction(async () => {
				await keys.set({ 'session-activity': updates } as any)
			}, 'session-activity-flush')

			isDirty = false
			stats.totalFlushes++
			stats.lastFlushAt = Date.now()
			stats.lastFlushDuration = Date.now() - startTime

			logger.debug(
				{
					count: activityCache.size,
					duration: stats.lastFlushDuration
				},
				'💾 Session activity flushed to disk'
			)

			// Clear cache after successful flush
			activityCache.clear()
			stats.cacheSize = 0
		} catch (error) {
			logger.error({ error, count: activityCache.size }, 'Failed to flush session activity')
			// Keep cache for retry on next flush
		}
	}

	/**
	 * Start periodic flush
	 */
	const start = (): void => {
		if (!config.enabled) {
			logger.info('Session activity tracking is disabled')
			return
		}

		if (flushInterval) {
			logger.warn('Session activity tracker already started')
			return
		}

		logger.info(
			{
				flushIntervalMs: config.flushIntervalMs,
				flushIntervalSeconds: config.flushIntervalMs / 1000
			},
			'⏱️ Session activity tracker started'
		)

		// Flush immediately on start (recover any pending data)
		flush().catch(err => {
			logger.warn({ err }, 'Initial flush failed')
		})

		// Schedule periodic flush
		flushInterval = setInterval(() => {
			flush().catch(err => {
				logger.warn({ err }, 'Periodic flush failed')
			})
		}, config.flushIntervalMs)
	}

	/**
	 * Stop periodic flush and flush pending data
	 */
	const stop = async (): Promise<void> => {
		if (flushInterval) {
			clearInterval(flushInterval)
			flushInterval = null
		}

		// Final flush before stopping
		await flush()

		logger.info('Session activity tracker stopped')
	}

	/**
	 * Get tracker statistics
	 */
	const getStats = () => ({
		enabled: config.enabled,
		...stats
	})

	return {
		recordActivity,
		getLastActivity,
		getAllActivities,
		flush,
		start,
		stop,
		getStats
	}
}

/**
 * Session activity tracker type
 */
export type SessionActivityTracker = ReturnType<typeof makeSessionActivityTracker>
