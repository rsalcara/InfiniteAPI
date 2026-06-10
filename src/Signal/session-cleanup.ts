/* eslint-disable max-depth, @typescript-eslint/no-unused-vars */
import { DEFAULT_SESSION_CLEANUP_CONFIG } from '../Defaults'
import type { SessionCleanupConfig, SessionCleanupStats, SignalKeyStoreWithTransaction } from '../Types'
import type { ILogger } from '../Utils/logger'
import { jidDecode } from '../WABinary'
import type { LIDMappingStore } from './lid-mapping'
import type { SessionActivityTracker } from './session-activity-tracker'

// Re-export for backward compatibility
export type { SessionCleanupConfig, SessionCleanupStats }

/**
 * Session metadata for cleanup decisions
 */
interface SessionMetadata {
	jid: string
	isLID: boolean
	isPrimary: boolean
	lastActivityMs?: number
	createdAtMs?: number
	hasLIDMapping?: boolean
}

/**
 * Creates a session cleanup manager
 *
 * SAFETY GUARANTEES:
 * - Does NOT affect WebSocket connections (only local database)
 * - Does NOT cause message loss (Signal Protocol auto-recreates sessions)
 * - Runs in low-traffic hours (configurable, default 3am)
 * - Atomic transactions (all-or-nothing)
 * - Comprehensive logging and statistics
 *
 * CLEANUP RULES:
 * 1. Secondary devices (Web, Desktop) - Inactive > X days (default: 15)
 * 2. Primary devices - Inactive > Y days (default: 30)
 * 3. LID orphans (no PN mapping) - Inactive > Z hours (default: 24)
 *
 * @param keys - Signal key store with transaction support
 * @param lidMapping - LID mapping store for orphan detection
 * @param sessionActivityTracker - Session activity tracker for timestamp-based cleanup
 * @param logger - Structured logger instance
 * @param config - Cleanup configuration (uses defaults from env)
 */
export const makeSessionCleanup = (
	keys: SignalKeyStoreWithTransaction,
	lidMapping: LIDMappingStore,
	sessionActivityTracker: SessionActivityTracker | null,
	logger: ILogger,
	config: SessionCleanupConfig = DEFAULT_SESSION_CLEANUP_CONFIG
) => {
	let cleanupInterval: ReturnType<typeof setInterval> | null = null
	let initialTimeout: ReturnType<typeof setTimeout> | null = null
	let lastCleanupAt = 0
	let cleanupRunning = false
	let startupCleanupPromise: Promise<void> | null = null

	/**
	 * Get all sessions from database
	 * Returns array of session keys (signal addresses)
	 */
	const getAllSessionKeys = async (): Promise<string[]> => {
		try {
			// Get all sessions from key store
			// Signal addresses format: "user_domain.device"
			const sessions = await keys.get('session', [])
			return Object.keys(sessions)
		} catch (error) {
			logger.error({ error }, 'Failed to get all session keys')
			return []
		}
	}

	/**
	 * Parse session metadata from signal address
	 * Signal address format: "user_domain.device"
	 * Examples:
	 *   "5511999999999_0.0" → PN primary device
	 *   "5511999999999_0.1" → PN secondary device
	 *   "123456789_2.0" → LID primary device
	 */
	const parseSessionMetadata = async (signalAddr: string): Promise<SessionMetadata | null> => {
		try {
			// Parse signal address: "user_domain.device"
			const [userWithDomain, deviceStr] = signalAddr.split('.')
			if (!userWithDomain) return null

			const [user, domainStr] = userWithDomain.split('_')
			if (!user) return null

			const device = parseInt(deviceStr || '0', 10)
			const domain = parseInt(domainStr || '0', 10)

			// Determine if LID (domain 2 or 6) or PN (domain 0 or 5)
			const isLID = domain === 2 || domain === 6
			const isPrimary = device === 0

			// Construct JID for mapping lookup
			let jid: string
			if (isLID) {
				jid = `${user}@lid`
			} else {
				jid = `${user}${device > 0 ? `:${device}` : ''}@s.whatsapp.net`
			}

			// Check if LID has PN mapping
			let hasLIDMapping: boolean | undefined
			if (isLID) {
				const pn = await lidMapping.getPNForLID(jid)
				hasLIDMapping = !!pn
			}

			return {
				jid,
				isLID,
				isPrimary,
				hasLIDMapping
			}
		} catch (error) {
			logger.warn({ error, signalAddr }, 'Failed to parse session metadata')
			return null
		}
	}

	/**
	 * Determine if session should be cleaned up
	 */
	const shouldCleanupSession = (metadata: SessionMetadata, now: number): { cleanup: boolean; reason: string } => {
		// Rule 1: LID orphans (no PN mapping) after X hours
		if (metadata.isLID && metadata.hasLIDMapping === false) {
			const thresholdMs = config.lidOrphanHours * 60 * 60 * 1000

			// Check if lastActivity is old enough
			if (metadata.lastActivityMs) {
				const inactiveDuration = now - metadata.lastActivityMs
				if (inactiveDuration > thresholdMs) {
					return {
						cleanup: true,
						reason: `LID orphan without PN mapping, inactive for ${Math.floor(inactiveDuration / 3600000)}h (threshold: ${config.lidOrphanHours}h)`
					}
				}
			} else {
				// No activity tracked - consider it old
				return {
					cleanup: true,
					reason: `LID orphan without PN mapping, no activity tracked (threshold: ${config.lidOrphanHours}h)`
				}
			}

			return { cleanup: false, reason: 'LID orphan but not inactive long enough' }
		}

		// Rule 2: Secondary devices inactive > X days
		if (!metadata.isPrimary && metadata.lastActivityMs) {
			const thresholdMs = config.secondaryDeviceInactiveDays * 24 * 60 * 60 * 1000
			const inactiveDuration = now - metadata.lastActivityMs

			if (inactiveDuration > thresholdMs) {
				return {
					cleanup: true,
					reason: `Secondary device inactive for ${Math.floor(inactiveDuration / 86400000)} days (threshold: ${config.secondaryDeviceInactiveDays} days)`
				}
			}

			return { cleanup: false, reason: `Secondary device active within ${config.secondaryDeviceInactiveDays} days` }
		}

		// Rule 3: Primary devices inactive > Y days
		if (metadata.isPrimary && metadata.lastActivityMs) {
			const thresholdMs = config.primaryDeviceInactiveDays * 24 * 60 * 60 * 1000
			const inactiveDuration = now - metadata.lastActivityMs

			if (inactiveDuration > thresholdMs) {
				return {
					cleanup: true,
					reason: `Primary device inactive for ${Math.floor(inactiveDuration / 86400000)} days (threshold: ${config.primaryDeviceInactiveDays} days)`
				}
			}

			return { cleanup: false, reason: `Primary device active within ${config.primaryDeviceInactiveDays} days` }
		}

		// No lastActivity tracked - don't cleanup yet (grace period)
		return { cleanup: false, reason: 'No activity tracked yet' }
	}

	/**
	 * Run session cleanup
	 * Returns statistics about cleanup operation
	 */
	const runCleanup = async (): Promise<SessionCleanupStats> => {
		const startTime = Date.now()
		const stats: SessionCleanupStats = {
			totalScanned: 0,
			secondaryDevicesDeleted: 0,
			primaryDevicesDeleted: 0,
			lidOrphansDeleted: 0,
			totalDeleted: 0,
			durationMs: 0,
			errors: 0
		}

		if (!config.enabled) {
			logger.info('Session cleanup is disabled')
			return stats
		}

		if (cleanupRunning) {
			logger.warn('Session cleanup already running, skipping')
			return stats
		}

		cleanupRunning = true
		logger.info('🧹 Starting session cleanup')

		try {
			// Get all session keys
			const sessionKeys = await getAllSessionKeys()
			stats.totalScanned = sessionKeys.length

			logger.info({ totalSessions: sessionKeys.length }, 'Scanning sessions for cleanup')

			// Get all activity timestamps (if tracker available)
			const activityMap = sessionActivityTracker
				? await sessionActivityTracker.getAllActivities()
				: new Map<string, number>()

			logger.debug({ trackedActivities: activityMap.size }, 'Loaded session activity timestamps')

			// Prepare bulk deletion
			const sessionsToDelete: string[] = []
			const deletionReasons: { [key: string]: string } = {}

			// Process each session
			for (const signalAddr of sessionKeys) {
				try {
					const metadata = await parseSessionMetadata(signalAddr)
					if (!metadata) {
						stats.errors++
						continue
					}

					// Add lastActivity from tracker
					metadata.lastActivityMs = activityMap.get(metadata.jid)

					const { cleanup, reason } = shouldCleanupSession(metadata, Date.now())

					if (cleanup) {
						sessionsToDelete.push(signalAddr)
						deletionReasons[signalAddr] = reason

						// Update statistics
						if (metadata.isLID && !metadata.hasLIDMapping) {
							stats.lidOrphansDeleted++
						} else if (!metadata.isPrimary) {
							stats.secondaryDevicesDeleted++
						} else {
							stats.primaryDevicesDeleted++
						}

						logger.debug(
							{
								jid: metadata.jid,
								signalAddr,
								reason,
								isLID: metadata.isLID,
								isPrimary: metadata.isPrimary
							},
							'Session marked for deletion'
						)
					}
				} catch (error) {
					logger.warn({ error, signalAddr }, 'Error processing session for cleanup')
					stats.errors++
				}
			}

			// Bulk delete sessions
			if (sessionsToDelete.length > 0) {
				logger.info({ count: sessionsToDelete.length }, '🗑️ Deleting orphaned/inactive sessions')

				try {
					// Prepare session updates (set to null = delete)
					const sessionUpdates: { [key: string]: null } = {}
					sessionsToDelete.forEach(addr => {
						sessionUpdates[addr] = null
					})

					// Single atomic transaction for all deletions.
					// audit P2-SIG-01 TODO: this lock namespace ('session-cleanup')
					// is disjoint from the per-record `transactWith({ records:
					// [{type:'session', id}] })` locks used by encrypt/decrypt.
					// A concurrent decrypt for an address we are about to delete
					// can therefore run alongside this cleanup — usually benign
					// (the decrypt's `transactWith` holds the record lock
					// while it operates and our DELETE just makes the next call
					// build a fresh session), but in the worst case the decrypt
					// reads the session record mid-DELETE and gets back a
					// torn / empty session. Fixing this properly means either
					//   (a) tearing this batch into per-address `transactWith`
					//       calls so each delete acquires the correct record
					//       lock, or
					//   (b) gating the entire cleanup inside a process-wide
					//       lock that also blocks decrypt.
					// (a) is the right shape but inflates wall-clock from one
					// statement to N. Out of scope for this PR; documented for
					// the follow-up.
					await keys.transaction(async () => {
						await keys.set({ session: sessionUpdates })
					}, 'session-cleanup')

					stats.totalDeleted = sessionsToDelete.length

					logger.info(
						{
							deleted: stats.totalDeleted,
							lidOrphans: stats.lidOrphansDeleted,
							secondaryDevices: stats.secondaryDevicesDeleted,
							primaryDevices: stats.primaryDevicesDeleted,
							errors: stats.errors
						},
						'✅ Session cleanup completed successfully'
					)
				} catch (error) {
					logger.error({ error, count: sessionsToDelete.length }, '❌ Failed to delete sessions')
					stats.errors++
				}
			} else {
				logger.info('No sessions to cleanup')
			}

			lastCleanupAt = Date.now()
			stats.durationMs = Date.now() - startTime

			return stats
		} catch (error) {
			logger.error({ error }, '❌ Session cleanup failed')
			stats.errors++
			stats.durationMs = Date.now() - startTime
			return stats
		} finally {
			cleanupRunning = false
		}
	}

	/**
	 * Calculate milliseconds until next cleanup time
	 * Ensures cleanup runs at configured hour (default: 3am)
	 */
	const msUntilNextCleanup = (): number => {
		const now = new Date()
		const next = new Date()
		next.setHours(config.cleanupHour, 0, 0, 0)

		// If we're past cleanup hour today, schedule for tomorrow
		if (now.getHours() >= config.cleanupHour) {
			next.setDate(next.getDate() + 1)
		}

		return next.getTime() - now.getTime()
	}

	/**
	 * Start periodic session cleanup
	 * Runs at configured hour (default: 3am daily)
	 */
	const start = () => {
		if (!config.enabled) {
			logger.info('Session cleanup is disabled')
			return
		}

		if (cleanupInterval) {
			logger.warn('Session cleanup already started')
			return
		}

		logger.info(
			{
				enabled: config.enabled,
				intervalHours: config.intervalMs / (60 * 60 * 1000),
				cleanupHour: config.cleanupHour,
				secondaryDeviceInactiveDays: config.secondaryDeviceInactiveDays,
				primaryDeviceInactiveDays: config.primaryDeviceInactiveDays,
				lidOrphanHours: config.lidOrphanHours,
				cleanupOnStartup: config.cleanupOnStartup,
				autoCleanCorrupted: config.autoCleanCorrupted
			},
			'🧹 Session cleanup scheduler started'
		)

		// Run immediate cleanup on startup if enabled
		if (config.cleanupOnStartup) {
			logger.info('🚀 Running cleanup on startup...')
			startupCleanupPromise = runCleanup()
				.catch(err => {
					logger.error({ err }, 'Cleanup on startup failed')
				})
				.then(() => {
					startupCleanupPromise = null // Clear after completion
				})
		}

		// Schedule first cleanup at configured hour
		const msUntilFirst = msUntilNextCleanup()
		logger.info(
			{ msUntilFirst, nextCleanup: new Date(Date.now() + msUntilFirst).toISOString() },
			'⏰ First cleanup scheduled'
		)

		initialTimeout = setTimeout(async () => {
			initialTimeout = null // Clear reference after execution

			// Wait for startup cleanup to complete (if still running)
			if (startupCleanupPromise) {
				logger.debug('Waiting for startup cleanup to complete before scheduled cleanup...')
				await startupCleanupPromise
			}

			// Run first cleanup
			await runCleanup()

			// Schedule recurring cleanup
			cleanupInterval = setInterval(async () => {
				await runCleanup()
			}, config.intervalMs)
		}, msUntilFirst)
	}

	/**
	 * Stop periodic session cleanup
	 */
	const stop = () => {
		if (initialTimeout) {
			clearTimeout(initialTimeout)
			initialTimeout = null
		}

		if (cleanupInterval) {
			clearInterval(cleanupInterval)
			cleanupInterval = null
			logger.info('Session cleanup scheduler stopped')
		}
	}

	/**
	 * Get cleanup statistics
	 */
	const getStats = () => ({
		enabled: config.enabled,
		lastCleanupAt,
		cleanupRunning,
		config
	})

	return {
		start,
		stop,
		runCleanup,
		getStats
	}
}

/**
 * Session cleanup manager type
 */
export type SessionCleanupManager = ReturnType<typeof makeSessionCleanup>
