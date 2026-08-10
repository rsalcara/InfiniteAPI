/* eslint-disable max-depth, @typescript-eslint/no-unused-vars */
import { LRUCache } from 'lru-cache'
import type { LIDMapping, SignalKeyStoreWithTransaction } from '../Types'
import type { ILogger } from '../Utils/logger'
import { isAnyLidUser, isAnyPnUser, isHostedPnUser, jidDecode, jidNormalizedUser, WAJIDDomains } from '../WABinary'

export const LID_MAPPING_DESTROY_TIMEOUT_MS = 5_000
const MAX_ADMISSION_WAITERS = 256

// ============================================================================
// CONFIGURATION
// ============================================================================

/**
 * LID Mapping Store configuration
 * Configurable via environment variables with BAILEYS_LID_* prefix
 */
export interface LIDMappingConfig {
	/** Cache TTL in milliseconds (default: 3 days) */
	cacheTtlMs: number
	/** Maximum cache size (default: 50000 entries) */
	maxCacheSize: number
	/** Enable cache auto-purge (default: true) */
	cacheAutoPurge: boolean
	/** Update cache age on get (default: true) */
	updateAgeOnGet: boolean
	/** Enable Prometheus metrics (default: false) */
	enableMetrics: boolean
	/** Batch size for bulk operations (default: 975, matching Android's SQLite chunk) */
	batchSize: number
	/** Maximum number of mapping items waiting for the single writer (default: 5000) */
	maxPendingMappings?: number
	/** Retry attempts for failed operations (default: 3, max: 10) */
	retryAttempts: number
	/** Base retry delay in ms (default: 1000). Uses exponential backoff: delay * 2^(attempt-1) */
	retryDelayMs: number
	/** Enable debug logging (default: false) */
	debugLogging: boolean
}

/**
 * Load configuration from environment variables
 * Includes bounds validation to prevent DoS from malicious values
 */
export type ResolvedLIDMappingConfig = Omit<LIDMappingConfig, 'maxPendingMappings'> & { maxPendingMappings: number }

const CONFIG_BOUNDS = {
	cacheTtlMs: { min: 60_000, max: 30 * 24 * 60 * 60 * 1000, fallback: 3 * 24 * 60 * 60 * 1000 },
	maxCacheSize: { min: 100, max: 1_000_000, fallback: 50_000 },
	batchSize: { min: 1, max: 975, fallback: 975 },
	maxPendingMappings: { min: 100, max: 100_000, fallback: 5_000 },
	retryAttempts: { min: 1, max: 10, fallback: 3 },
	retryDelayMs: { min: 100, max: 60_000, fallback: 1_000 }
} as const

const clampFinite = (value: number, fallback: number, min: number, max: number): number => {
	const finiteValue = Number.isFinite(value) ? value : fallback
	return Math.trunc(Math.max(min, Math.min(max, finiteValue)))
}

const clampConfigValue = (
	key: keyof typeof CONFIG_BOUNDS,
	value: number,
	fallback: number = CONFIG_BOUNDS[key].fallback
): number => {
	const { min, max } = CONFIG_BOUNDS[key]
	return clampFinite(value, fallback, min, max)
}

export function loadLIDMappingConfig(): ResolvedLIDMappingConfig {
	const cacheTtlMs = parseInt(process.env.BAILEYS_LID_CACHE_TTL_MS || String(3 * 24 * 60 * 60 * 1000), 10)
	const maxCacheSize = parseInt(process.env.BAILEYS_LID_MAX_CACHE_SIZE || '50000', 10)
	const batchSize = parseInt(process.env.BAILEYS_LID_BATCH_SIZE || '975', 10)
	const maxPendingMappings = parseInt(process.env.BAILEYS_LID_MAX_PENDING_MAPPINGS || '5000', 10)
	const retryAttempts = parseInt(process.env.BAILEYS_LID_RETRY_ATTEMPTS || '3', 10)
	const retryDelayMs = parseInt(process.env.BAILEYS_LID_RETRY_DELAY_MS || '1000', 10)

	return {
		// Cache TTL: minimum 1 minute, maximum 30 days
		cacheTtlMs: clampConfigValue('cacheTtlMs', cacheTtlMs),
		// Cache size: minimum 100, maximum 1,000,000
		maxCacheSize: clampConfigValue('maxCacheSize', maxCacheSize),
		cacheAutoPurge: process.env.BAILEYS_LID_CACHE_AUTO_PURGE !== 'false',
		updateAgeOnGet: process.env.BAILEYS_LID_UPDATE_AGE_ON_GET !== 'false',
		enableMetrics: process.env.BAILEYS_LID_METRICS === 'true',
		// Batch size: minimum 1 (prevents infinite loop), maximum Android chunk size.
		batchSize: clampConfigValue('batchSize', batchSize),
		// Bounded admission: enough for bursts without allowing unbounded memory.
		maxPendingMappings: clampConfigValue('maxPendingMappings', maxPendingMappings),
		// Retry attempts: minimum 1, maximum 10
		retryAttempts: clampConfigValue('retryAttempts', retryAttempts),
		// Retry delay: minimum 100ms, maximum 60 seconds
		retryDelayMs: clampConfigValue('retryDelayMs', retryDelayMs),
		debugLogging: process.env.BAILEYS_LID_DEBUG === 'true'
	}
}

// ============================================================================
// STATISTICS
// ============================================================================

/**
 * Statistics for monitoring and debugging
 */
export interface LIDMappingStatistics {
	/** Total cache hits */
	cacheHits: number
	/** Total cache misses */
	cacheMisses: number
	/** Total database hits */
	dbHits: number
	/** Total database misses */
	dbMisses: number
	/** Total USync fetches */
	usyncFetches: number
	/** Total USync failures */
	usyncFailures: number
	/** Total mappings stored */
	mappingsStored: number
	/** Total invalid mappings rejected */
	invalidMappings: number
	/** Current cache size */
	cacheSize: number
	/** Cache hit rate (percentage) */
	cacheHitRate: number
	/** Total operations */
	totalOperations: number
	/** Failed operations */
	failedOperations: number
	/** Mapping items currently admitted but not completed */
	pendingMappings: number
	/** Writes rejected because the bounded admission queue could not accept them */
	rejectedWrites: number
	/** Number of writes that had to wait for bounded admission capacity */
	backpressureWaits: number
	/** Highest observed number of queued mapping items */
	maxPendingMappingsObserved: number
	/** Store creation timestamp */
	createdAt: number
	/** Last operation timestamp */
	lastOperationAt: number | null
}

// ============================================================================
// ERROR TYPES
// ============================================================================

/**
 * Custom error for LID mapping operations
 */
export class LIDMappingError extends Error {
	constructor(
		message: string,
		public readonly code: LIDMappingErrorCode,
		public readonly details?: Record<string, unknown>
	) {
		super(message)
		this.name = 'LIDMappingError'
	}
}

export enum LIDMappingErrorCode {
	INVALID_JID = 'INVALID_JID',
	INVALID_MAPPING = 'INVALID_MAPPING',
	DATABASE_ERROR = 'DATABASE_ERROR',
	USYNC_ERROR = 'USYNC_ERROR',
	CACHE_ERROR = 'CACHE_ERROR',
	DESTROYED = 'DESTROYED',
	BACKPRESSURE = 'BACKPRESSURE'
}

// ============================================================================
// MAIN CLASS
// ============================================================================

/**
 * Enterprise-grade LID Mapping Store
 *
 * Features:
 * - Environment variable configuration
 * - LRU cache with configurable TTL and size
 * - Comprehensive statistics and metrics
 * - Batch operations for bulk mappings
 * - Retry logic for failed operations
 * - Proper resource cleanup
 * - Prometheus metrics integration
 */
export class LIDMappingStore {
	private readonly mappingCache: LRUCache<string, string>
	private readonly keys: SignalKeyStoreWithTransaction
	private readonly logger: ILogger
	private readonly config: ResolvedLIDMappingConfig
	private destroyed = false
	private hardStopped = false
	private destroyPromise?: Promise<boolean>
	private cleanupPromise?: Promise<void>
	private resolveDrain?: () => void
	private writeQueueRunning = false
	private pendingWriteItems = 0
	private readonly writeQueue: Array<{
		pairs: LIDMapping[]
		resolve: (result: { stored: number; skipped: number; errors: number }) => void
		reject: (error: unknown) => void
	}> = []
	private readonly queueProgressWaiters: Array<{
		requiredItems: number
		resolve: () => void
		reject: (error: unknown) => void
	}> = []

	/**
	 * Operation counter for safe resource cleanup
	 * Tracks number of operations currently in progress to prevent UAF in destroy()
	 * Incremented at operation start, decremented at operation end
	 */
	private operationsInProgress = 0

	private pnToLIDFunc?: (jids: string[]) => Promise<LIDMapping[] | undefined>

	/**
	 * Request coalescing Maps - deduplicates concurrent lookups
	 *
	 * USAGE: Active in getLIDForPN() and getPNForLID() to deduplicate
	 * concurrent lookups for the same user. In message bursts, multiple
	 * concurrent calls share a single database lookup.
	 *
	 * MEMORY SAFETY: Cleared in destroy() to prevent memory leaks.
	 * Pending Promises complete but won't be returned to new callers.
	 *
	 * THREAD SAFETY: Protected by operationsInProgress counter (V4 fix).
	 * - Maps are only cleared when operationsInProgress === 0
	 * - Operations using coalesceRequest() MUST be wrapped with trackOperation()
	 * - This ensures maps won't be cleared while coalesceRequest() is accessing them
	 */
	private readonly inflightLIDLookups = new Map<string, Promise<string | null>>()
	private readonly inflightPNLookups = new Map<string, Promise<string | null>>()

	// Statistics tracking
	private stats: LIDMappingStatistics = {
		cacheHits: 0,
		cacheMisses: 0,
		dbHits: 0,
		dbMisses: 0,
		usyncFetches: 0,
		usyncFailures: 0,
		mappingsStored: 0,
		invalidMappings: 0,
		cacheSize: 0,
		cacheHitRate: 0,
		totalOperations: 0,
		failedOperations: 0,
		pendingMappings: 0,
		rejectedWrites: 0,
		backpressureWaits: 0,
		maxPendingMappingsObserved: 0,
		createdAt: Date.now(),
		lastOperationAt: null
	}

	constructor(
		keys: SignalKeyStoreWithTransaction,
		logger: ILogger,
		pnToLIDFunc?: (jids: string[]) => Promise<LIDMapping[] | undefined>,
		configOverride?: Partial<LIDMappingConfig>
	) {
		this.keys = keys
		this.pnToLIDFunc = pnToLIDFunc
		this.logger = logger
		const defaults = loadLIDMappingConfig()
		const overrideMaxPendingMappings = configOverride?.maxPendingMappings
		this.config = {
			...defaults,
			...configOverride,
			cacheTtlMs: clampConfigValue(
				'cacheTtlMs',
				configOverride?.cacheTtlMs ?? defaults.cacheTtlMs,
				defaults.cacheTtlMs
			),
			maxCacheSize: clampConfigValue(
				'maxCacheSize',
				configOverride?.maxCacheSize ?? defaults.maxCacheSize,
				defaults.maxCacheSize
			),
			batchSize: clampConfigValue('batchSize', configOverride?.batchSize ?? defaults.batchSize, defaults.batchSize),
			maxPendingMappings: clampConfigValue(
				'maxPendingMappings',
				overrideMaxPendingMappings ?? defaults.maxPendingMappings,
				defaults.maxPendingMappings
			),
			retryAttempts: clampConfigValue(
				'retryAttempts',
				configOverride?.retryAttempts ?? defaults.retryAttempts,
				defaults.retryAttempts
			),
			retryDelayMs: clampConfigValue(
				'retryDelayMs',
				configOverride?.retryDelayMs ?? defaults.retryDelayMs,
				defaults.retryDelayMs
			)
		}

		// Initialize LRU cache with configuration
		this.mappingCache = new LRUCache<string, string>({
			max: this.config.maxCacheSize,
			ttl: this.config.cacheTtlMs,
			ttlAutopurge: this.config.cacheAutoPurge,
			updateAgeOnGet: this.config.updateAgeOnGet
		})

		this.logger.debug({ config: this.config }, 'LIDMappingStore initialized')
	}

	// ========================================================================
	// CONFIGURATION & STATISTICS
	// ========================================================================

	/**
	 * Get current configuration
	 * Safe to call after destroy for debugging purposes
	 */
	getConfig(): ResolvedLIDMappingConfig {
		return { ...this.config }
	}

	/**
	 * Get current statistics
	 * Safe to call after destroy for final metrics collection
	 */
	getStatistics(): LIDMappingStatistics {
		const totalLookups = this.stats.cacheHits + this.stats.cacheMisses
		return {
			...this.stats,
			cacheSize: this.destroyed ? 0 : this.mappingCache.size,
			cacheHitRate: totalLookups > 0 ? (this.stats.cacheHits / totalLookups) * 100 : 0
		}
	}

	/**
	 * Check if store has been destroyed
	 */
	isDestroyed(): boolean {
		return this.destroyed
	}

	// ========================================================================
	// CACHE MANAGEMENT
	// ========================================================================

	/**
	 * Warm cache with pre-loaded mappings
	 * Useful for initialization with known mappings
	 */
	async warmCache(mappings: LIDMapping[]): Promise<{ loaded: number; skipped: number }> {
		this.checkDestroyed()
		let loaded = 0
		let skipped = 0

		for (const { lid, pn } of mappings) {
			if (!this.isValidMapping(lid, pn)) {
				skipped++
				continue
			}

			const lidDecoded = jidDecode(lid)
			const pnDecoded = jidDecode(pn)
			if (!lidDecoded || !pnDecoded) {
				skipped++
				continue
			}

			const pnUser = pnDecoded.user
			const lidUser = lidDecoded.user

			this.mappingCache.set(`pn:${pnUser}`, lidUser)
			this.mappingCache.set(`lid:${lidUser}`, pnUser)
			loaded++
		}

		this.logger.debug({ loaded, skipped }, 'Cache warmed with mappings')
		return { loaded, skipped }
	}

	/**
	 * Clear all cached mappings
	 */
	clearCache(): void {
		this.checkDestroyed()
		const previousSize = this.mappingCache.size
		this.mappingCache.clear()
		this.logger.debug({ previousSize }, 'Cache cleared')
	}

	/**
	 * Get cache info for monitoring
	 * Safe to call after destroy for final reporting
	 */
	getCacheInfo(): { size: number; maxSize: number; ttlMs: number } {
		return {
			size: this.destroyed ? 0 : this.mappingCache.size,
			maxSize: this.config.maxCacheSize,
			ttlMs: this.config.cacheTtlMs
		}
	}

	// ========================================================================
	// STORE OPERATIONS
	// ========================================================================

	/**
	 * Store LID-PN mapping - USER LEVEL
	 * Enhanced with batch operations and retry logic
	 *
	 * @param pairs - Array of LID-PN mappings to store
	 * @returns Statistics about the operation (stored, skipped, errors)
	 *
	 * Note: Return type changed from void to statistics object.
	 * Existing callers that ignore the return value remain compatible.
	 */
	async storeLIDPNMappings(pairs: LIDMapping[]): Promise<{ stored: number; skipped: number; errors: number }> {
		this.checkDestroyed()

		// The complete call is admitted atomically before validation/chunking.
		// Once admitted, every chunk is allowed to finish during graceful
		// teardown. New public calls still fail immediately via checkDestroyed().
		return this.trackOperation(async () => {
			const validPairs: LIDMapping[] = []
			let invalidSkipped = 0

			for (const pair of pairs) {
				if (!this.isValidMapping(pair.lid, pair.pn)) {
					this.logger.warn({ lid: pair.lid, pn: pair.pn }, 'Invalid LID-PN mapping rejected')
					this.stats.invalidMappings++
					invalidSkipped++
					continue
				}

				validPairs.push(pair)
			}

			const deduplicated = this.deduplicateMappings(validPairs)
			const duplicateSkipped = validPairs.length - deduplicated.length
			const result = { stored: 0, skipped: invalidSkipped + duplicateSkipped, errors: 0 }
			if (deduplicated.length === 0) return result

			const admissionChunkSize = Math.min(this.config.batchSize, this.config.maxPendingMappings)
			const admissionChunks = this.chunkArray(deduplicated, admissionChunkSize)
			for (let chunkIndex = 0; chunkIndex < admissionChunks.length; chunkIndex++) {
				const chunk = admissionChunks[chunkIndex]!
				const chunkResult = await this.enqueueMappingWrite(chunk, true)
				result.stored += chunkResult.stored
				result.skipped += chunkResult.skipped
				result.errors += chunkResult.errors

				// The history caller is intentionally backpressured until every
				// admitted chunk is durable. Yield between those chunks so the
				// WebSocket can decode pongs and the next history notifications
				// while preserving the bounded writer and transactional batches.
				if (chunkIndex < admissionChunks.length - 1) {
					await new Promise<void>(resolve => setImmediate(resolve))
				}
			}

			return result
		})
	}

	private async storeLIDPNMappingsNow(
		pairs: LIDMapping[]
	): Promise<{ stored: number; skipped: number; errors: number }> {
		// enqueueMappingWrite is private and only receives the pre-validated,
		// deduplicated chunks produced by storeLIDPNMappings.
		this.stats.totalOperations++
		this.stats.lastOperationAt = Date.now()

		const result = { stored: 0, skipped: 0, errors: 0 }

		// Step 1: Validate and collect cache misses
		const cacheMissPnUsers: string[] = []
		const pendingValidation = new Map<string, { pnUser: string; lidUser: string }>()

		for (const { lid, pn } of pairs) {
			const lidDecoded = jidDecode(lid)
			const pnDecoded = jidDecode(pn)

			if (!lidDecoded || !pnDecoded) {
				result.skipped++
				continue
			}

			const pnUser = pnDecoded.user
			const lidUser = lidDecoded.user

			// Check cache first
			const existingLidUser = this.mappingCache.get(`pn:${pnUser}`)

			if (existingLidUser !== undefined) {
				// Write-path cache probes are deliberately excluded from lookup
				// hit-rate metrics.
				if (existingLidUser === lidUser) {
					if (this.config.debugLogging) {
						this.logger.debug({ pnUser, lidUser }, 'LID mapping already exists, skipping')
					}

					result.skipped++
				} else {
					// Different mapping - will be stored
					pendingValidation.set(pnUser, { pnUser, lidUser })
				}
			} else {
				// Cache miss - queue for batch DB fetch
				cacheMissPnUsers.push(pnUser)
				pendingValidation.set(pnUser, { pnUser, lidUser })
			}
		}

		// Step 2: Batch fetch all cache misses from DB
		if (cacheMissPnUsers.length > 0) {
			const batches = this.chunkArray(cacheMissPnUsers, this.config.batchSize)

			for (let batchIndex = 0; batchIndex < batches.length; batchIndex++) {
				const batch = batches[batchIndex]!
				try {
					const stored = await this.retryOperation(() => this.keys.get('lid-mapping', batch), 'batch-get-mappings')

					// Update cache and validate against DB
					for (const pnUser of batch) {
						const existingLidUser = stored[pnUser]

						if (existingLidUser) {
							this.stats.dbHits++
							// Update cache with database value
							this.mappingCache.set(`pn:${pnUser}`, existingLidUser)
							this.mappingCache.set(`lid:${existingLidUser}`, pnUser)

							// Check if this mapping should be skipped
							const pending = pendingValidation.get(pnUser)
							if (existingLidUser === pending?.lidUser) {
								if (this.config.debugLogging) {
									this.logger.debug({ pnUser, lidUser: pending.lidUser }, 'LID mapping already exists in DB, skipping')
								}

								result.skipped++
								pendingValidation.delete(pnUser)
							}
						} else {
							this.stats.dbMisses++
						}
					}
				} catch (error) {
					this.logger.error({ error, batchSize: batch.length }, 'Failed to batch fetch existing mappings')
					result.errors += batch.length
					// Remove failed fetches from pending validation to avoid storing them
					for (const pnUser of batch) {
						pendingValidation.delete(pnUser)
					}
				}

				// better-sqlite3 executes synchronously beneath the async key-store
				// facade. Large history-sync mapping bursts would otherwise keep
				// the event loop occupied across every sub-batch, preventing WA
				// frames (including keep-alive pongs and subsequent FULL/RECENT
				// notifications) from being decoded until the whole burst ended.
				if (batchIndex < batches.length - 1) {
					await new Promise<void>(resolve => setImmediate(resolve))
				}
			}
		}

		// Step 3: Store new/updated mappings
		const validPairs = Array.from(pendingValidation.values())

		if (validPairs.length === 0) {
			return result
		}

		const storeBatches = this.chunkArray(validPairs, this.config.batchSize)

		for (let batchIndex = 0; batchIndex < storeBatches.length; batchIndex++) {
			const batch = storeBatches[batchIndex]!
			try {
				await this.retryOperation(async () => {
					const bucket: Record<string, string> = {}
					for (const { pnUser, lidUser } of batch) {
						bucket[pnUser] = lidUser
						bucket[`${lidUser}_reverse`] = pnUser
					}

					await this.keys.transaction(async () => {
						await this.keys.set({ 'lid-mapping': bucket })
					}, 'lid-mapping')

					// Cache is an after-commit view. Updating it inside the
					// transaction exposed mappings that could still roll back.
					// A timed-out destroy cannot cancel the physical key-store
					// transaction, so a late commit must not repopulate local
					// state that teardown has already invalidated.
					if (!this.destroyed) {
						for (const { pnUser, lidUser } of batch) {
							this.mappingCache.set(`pn:${pnUser}`, lidUser)
							this.mappingCache.set(`lid:${lidUser}`, pnUser)
						}
					}

					result.stored += batch.length
					this.stats.mappingsStored += batch.length
				}, 'store-mappings')
			} catch (error) {
				this.logger.error({ error, batchSize: batch.length }, 'Failed to store mapping batch')
				result.errors += batch.length
				this.stats.failedOperations++
			}

			// Yield between physical SQLite transactions so the socket can
			// continue consuming frames while a large history-sync mapping set
			// is persisted. The transaction itself remains atomic per sub-batch.
			if (batchIndex < storeBatches.length - 1) {
				await new Promise<void>(resolve => setImmediate(resolve))
			}
		}

		this.logger.trace(
			{ result, totalPairs: pairs.length, cacheMisses: cacheMissPnUsers.length },
			'Stored LID-PN mappings with batch optimization'
		)
		this.recordMetrics('store', result.stored)

		return result
	}

	/**
	 * Get LID for PN - Returns device-specific LID based on user mapping
	 *
	 * OPTIMIZATION: Uses request coalescing to deduplicate concurrent lookups
	 * for the same PN. In message bursts, multiple concurrent calls for the same
	 * user will share a single database lookup, reducing load and improving latency.
	 *
	 * Thread Safety: Protected by trackOperation() wrapper (V4 fix)
	 */
	async getLIDForPN(pn: string): Promise<string | null> {
		this.checkDestroyed()

		return this.trackOperation(async () => {
			// Early validation
			if (!isAnyPnUser(pn)) return null

			const decoded = jidDecode(pn)
			if (!decoded) return null

			const pnUser = decoded.user

			// Use request coalescing to deduplicate concurrent lookups
			// Safe because: wrapped in trackOperation() prevents resource cleanup
			return this.coalesceRequest(pnUser, this.inflightLIDLookups, async () => {
				const results = await this.getLIDsForPNs([pn])
				return results?.[0]?.lid || null
			})
		})
	}

	/**
	 * Port of upstream PR #2614 (`fix: nest profile picture tctoken and avoid
	 * usync on lookup`). Returns the LID for a PN ONLY if the mapping is
	 * already known (memory cache or on-disk store). Never triggers a USync
	 * lookup.
	 *
	 * Use this on hot paths where firing a USync just to opportunistically
	 * attach metadata (e.g. profile-picture tctoken) is undesired — both
	 * because the latency is wasted (the operation must still proceed if the
	 * mapping is unknown) AND because USync-on-look-up is a behavioral
	 * fingerprint WA Web / whatsmeow don't emit, so doing it makes our
	 * traffic profile stand out and may serve as a ban signal.
	 *
	 * Thread safety: wrapped in `checkDestroyed()` + `trackOperation()` —
	 * same contract every other public method on this store follows. Without
	 * these, the async `keys.get()` could race with `destroy()` (UAF on the
	 * key store) and a post-destroy call could silently return stale data.
	 * (PR #510 review — addresses cubic / copilot P2.)
	 */
	async getKnownLIDForPN(pn: string): Promise<string | null> {
		this.checkDestroyed()

		return this.trackOperation(async () => {
			if (!isAnyPnUser(pn)) return null

			const decoded = jidDecode(pn)
			if (!decoded) return null

			const pnUser = decoded.user
			let lidUser = this.mappingCache.get(`pn:${pnUser}`)
			if (!lidUser) {
				const stored = await this.keys.get('lid-mapping', [pnUser])
				const storedLidUser = stored[pnUser]
				if (typeof storedLidUser === 'string' && storedLidUser) {
					lidUser = storedLidUser
					this.mappingCache.set(`pn:${pnUser}`, lidUser)
					this.mappingCache.set(`lid:${lidUser}`, pnUser)
				}
			}

			if (!lidUser) return null

			const pnDevice = decoded.device !== undefined ? decoded.device : 0
			return `${lidUser}${pnDevice ? `:${pnDevice}` : ''}@${decoded.server === 'hosted' ? 'hosted.lid' : 'lid'}`
		})
	}

	/** Reverse lookup that only reads the local mapping cache/store. */
	async getKnownPNForLID(lid: string): Promise<string | null> {
		this.checkDestroyed()

		return this.trackOperation(async () => {
			if (!isAnyLidUser(lid)) return null

			const decoded = jidDecode(lid)
			if (!decoded) return null

			const lidUser = decoded.user
			let pnUser = this.mappingCache.get(`lid:${lidUser}`)
			if (!pnUser) {
				const stored = await this.keys.get('lid-mapping', [`${lidUser}_reverse`])
				const storedPnUser = stored[`${lidUser}_reverse`]
				if (typeof storedPnUser === 'string' && storedPnUser) {
					pnUser = storedPnUser
					this.mappingCache.set(`lid:${lidUser}`, pnUser)
					this.mappingCache.set(`pn:${pnUser}`, lidUser)
				}
			}

			if (!pnUser) return null

			const pnServer = decoded.server === 'hosted.lid' ? 'hosted' : 's.whatsapp.net'
			return `${pnUser}${decoded.device ? `:${decoded.device}` : ''}@${pnServer}`
		})
	}

	/**
	 * Get LIDs for multiple PNs - Optimized batch operation
	 *
	 * Note: PNs that fail database lookup are silently skipped and queued for
	 * USync retry. Check statistics.failedOperations for failure counts.
	 * The returned array may be smaller than input if some lookups failed.
	 */
	async getLIDsForPNs(pns: string[]): Promise<LIDMapping[] | null> {
		this.checkDestroyed()

		// Track operation to prevent UAF during destroy()
		return this.trackOperation(async () => {
			this.stats.totalOperations++
			this.stats.lastOperationAt = Date.now()

			const usyncFetch: { [_: string]: number[] } = {}
			const successfulPairs: { [_: string]: LIDMapping } = {}
			const failedPns = new Set<string>()
			const pendingByPnUser = new Map<string, Array<{ pn: string; decoded: ReturnType<typeof jidDecode> }>>()

			for (const pn of pns) {
				if (!isAnyPnUser(pn)) continue

				const decoded = jidDecode(pn)
				if (!decoded) continue

				const pnUser = decoded.user
				const cachedLidUser = this.mappingCache.get(`pn:${pnUser}`)

				if (cachedLidUser) {
					this.stats.cacheHits++
					const lidUser = cachedLidUser.toString()
					if (!lidUser) {
						this.logger.warn({ pn, lidUser }, 'Invalid or empty LID user')
						continue
					}

					const pnDevice = decoded.device ?? 0
					const deviceSpecificLid = this.buildDeviceSpecificJid(
						lidUser,
						pnDevice,
						decoded.server === 'hosted' ? 'hosted.lid' : 'lid'
					)

					if (this.config.debugLogging) {
						this.logger.trace({ pn, deviceSpecificLid, pnDevice }, 'getLIDForPN: mapping found')
					}

					successfulPairs[pn] = { lid: deviceSpecificLid, pn }
					continue
				}

				this.stats.cacheMisses++
				const pendingForUser = pendingByPnUser.get(pnUser) ?? []
				pendingForUser.push({ pn, decoded })
				pendingByPnUser.set(pnUser, pendingForUser)
			}

			if (pendingByPnUser.size > 0) {
				const pnUsers = [...pendingByPnUser.keys()]
				const dbFailedPnUsers = new Set<string>()

				for (const batch of this.chunkArray(pnUsers, this.config.batchSize)) {
					try {
						const stored = await this.retryOperation(() => this.keys.get('lid-mapping', batch), 'get-lid-for-pn')

						for (const pnUser of batch) {
							const lidUser = stored[pnUser]
							if (lidUser) {
								this.stats.dbHits++
								this.mappingCache.set(`pn:${pnUser}`, lidUser)
								this.mappingCache.set(`lid:${lidUser}`, pnUser)
							} else {
								this.stats.dbMisses++
							}
						}
					} catch (error) {
						this.logger.error({ error, batch }, 'Failed to get LID mapping batch from database')
						this.stats.failedOperations += batch.length
						batch.forEach(pnUser => dbFailedPnUsers.add(pnUser))
					}
				}

				for (const [pnUser, items] of pendingByPnUser.entries()) {
					const lidUser = this.mappingCache.get(`pn:${pnUser}`)
					for (const { pn, decoded } of items) {
						if (lidUser && decoded) {
							const lidUserString = lidUser.toString()
							if (!lidUserString) {
								this.logger.warn({ pn, lidUser }, 'Invalid or empty LID user')
								continue
							}

							const pnDevice = decoded.device ?? 0
							const deviceSpecificLid = this.buildDeviceSpecificJid(
								lidUserString,
								pnDevice,
								decoded.server === 'hosted' ? 'hosted.lid' : 'lid'
							)

							if (this.config.debugLogging) {
								this.logger.trace({ pn, deviceSpecificLid, pnDevice }, 'getLIDForPN: mapping found')
							}

							successfulPairs[pn] = { lid: deviceSpecificLid, pn }
							continue
						}

						if (dbFailedPnUsers.has(pnUser)) {
							failedPns.add(pn)
						}

						if (!decoded) continue

						// Need to fetch from USync
						if (this.config.debugLogging) {
							this.logger.trace({ pnUser }, 'No LID mapping found, queuing for USync')
						}

						const device = decoded.device || 0
						let normalizedPn = jidNormalizedUser(pn)
						if (isHostedPnUser(normalizedPn)) {
							normalizedPn = `${pnUser}@s.whatsapp.net`
						}

						if (!usyncFetch[normalizedPn]) {
							usyncFetch[normalizedPn] = [device]
						} else {
							usyncFetch[normalizedPn]?.push(device)
						}
					}
				}
			}

			// Fetch from USync if needed
			if (Object.keys(usyncFetch).length > 0) {
				await this.fetchFromUSync(usyncFetch, successfulPairs)
			}

			// Log warning if some PNs failed lookup
			if (failedPns.size > 0) {
				this.logger.warn(
					{ failedCount: failedPns.size, totalRequested: pns.length },
					'Some PNs failed during getLIDsForPNs - results may be incomplete'
				)
			}

			this.recordMetrics('get-lid', Object.keys(successfulPairs).length)
			return Object.keys(successfulPairs).length > 0 ? Object.values(successfulPairs) : null
		}) // End trackOperation
	}

	/**
	 * Get PN for LID - USER LEVEL with device construction
	 *
	 * OPTIMIZATION: Uses request coalescing to deduplicate concurrent lookups
	 * for the same LID. In message bursts, multiple concurrent calls for the same
	 * user will share a single database lookup, reducing load and improving latency.
	 *
	 * Thread Safety: Protected by trackOperation() wrapper (V4 fix)
	 */
	async getPNForLID(lid: string): Promise<string | null> {
		this.checkDestroyed()

		return this.trackOperation(async () => {
			// Early validation
			if (!isAnyLidUser(lid)) return null

			const decoded = jidDecode(lid)
			if (!decoded) return null

			const lidUser = decoded.user

			// Use request coalescing to deduplicate concurrent lookups
			// Safe because: wrapped in trackOperation() prevents resource cleanup
			return this.coalesceRequest(lidUser, this.inflightPNLookups, async () => {
				const results = await this.getPNsForLIDs([lid])
				return results?.[0]?.pn || null
			})
		})
	}

	/**
	 * Get PNs for multiple LIDs - Optimized batch operation
	 */
	async getPNsForLIDs(lids: string[]): Promise<LIDMapping[] | null> {
		this.checkDestroyed()

		// Track operation to prevent UAF during destroy()
		return this.trackOperation(async () => {
			this.stats.totalOperations++
			this.stats.lastOperationAt = Date.now()

			const successfulPairs: { [_: string]: LIDMapping } = {}
			const failedLids = new Set<string>()
			const pendingByLidUser = new Map<string, Array<{ lid: string; decoded: ReturnType<typeof jidDecode> }>>()

			const addResolvedPair = (lid: string, decoded: ReturnType<typeof jidDecode>, pnUser: string): void => {
				const lidDevice = decoded?.device ?? 0
				const server = decoded?.domainType === WAJIDDomains.HOSTED_LID ? 'hosted' : 's.whatsapp.net'
				const pnJid = this.buildDeviceSpecificJid(pnUser, lidDevice, server)

				if (this.config.debugLogging) {
					this.logger.trace({ lid, pnJid }, 'Found reverse mapping')
				}

				successfulPairs[lid] = { lid, pn: pnJid }
			}

			for (const lid of lids) {
				if (!isAnyLidUser(lid)) continue

				const decoded = jidDecode(lid)
				if (!decoded) continue

				const lidUser = decoded.user
				const cachedPnUser = this.mappingCache.get(`lid:${lidUser}`)

				if (cachedPnUser && typeof cachedPnUser === 'string') {
					this.stats.cacheHits++
					addResolvedPair(lid, decoded, cachedPnUser)
					continue
				}

				this.stats.cacheMisses++
				const pendingForUser = pendingByLidUser.get(lidUser) ?? []
				pendingForUser.push({ lid, decoded })
				pendingByLidUser.set(lidUser, pendingForUser)
			}

			if (pendingByLidUser.size > 0) {
				const reverseKeys = [...pendingByLidUser.keys()].map(lidUser => `${lidUser}_reverse`)
				const dbFailedReverseKeys = new Set<string>()

				for (const batch of this.chunkArray(reverseKeys, this.config.batchSize)) {
					try {
						const stored = await this.retryOperation(() => this.keys.get('lid-mapping', batch), 'get-pn-for-lid')

						for (const reverseKey of batch) {
							const lidUser = reverseKey.replace(/_reverse$/, '')
							const pnUser = stored[reverseKey]
							if (pnUser && typeof pnUser === 'string') {
								this.stats.dbHits++
								this.mappingCache.set(`lid:${lidUser}`, pnUser)
								this.mappingCache.set(`pn:${pnUser}`, lidUser)
							} else {
								this.stats.dbMisses++
							}
						}
					} catch (error) {
						this.logger.error({ error, batch }, 'Failed to get PN mapping batch from database')
						this.stats.failedOperations += batch.length
						batch.forEach(reverseKey => dbFailedReverseKeys.add(reverseKey))
					}
				}

				for (const [lidUser, items] of pendingByLidUser.entries()) {
					const pnUser = this.mappingCache.get(`lid:${lidUser}`)
					for (const { lid, decoded } of items) {
						if (pnUser && typeof pnUser === 'string') {
							addResolvedPair(lid, decoded, pnUser)
							continue
						}

						if (dbFailedReverseKeys.has(`${lidUser}_reverse`)) {
							failedLids.add(lid)
						}

						if (this.config.debugLogging) {
							this.logger.trace({ lidUser }, 'No reverse mapping found')
						}
					}
				}
			}

			if (failedLids.size > 0) {
				this.logger.warn(
					{ failedCount: failedLids.size, totalRequested: lids.length },
					'Some LIDs failed during getPNsForLIDs - results may be incomplete'
				)
			}

			this.recordMetrics('get-pn', Object.keys(successfulPairs).length)
			return Object.keys(successfulPairs).length > 0 ? Object.values(successfulPairs) : null
		}) // End trackOperation
	}

	/**
	 * Check if a mapping exists for a PN
	 */
	async hasMappingForPN(pn: string): Promise<boolean> {
		this.checkDestroyed()

		// Track operation to prevent UAF during destroy()
		return this.trackOperation(async () => {
			if (!isAnyPnUser(pn)) return false

			const decoded = jidDecode(pn)
			if (!decoded) return false

			const pnUser = decoded.user

			// Check cache first
			if (this.mappingCache.has(`pn:${pnUser}`)) {
				return true
			}

			// Check database
			try {
				const stored = await this.keys.get('lid-mapping', [pnUser])
				return !!stored[pnUser]
			} catch {
				return false
			}
		}) // End trackOperation
	}

	/**
	 * Delete mapping from cache only (does not affect persistent storage)
	 * Use this to force a fresh lookup on next access
	 * @param pn - The phone number JID to remove from cache
	 * @returns true if the PN was valid and cache was cleared
	 */
	async deleteMappingFromCache(pn: string): Promise<boolean> {
		this.checkDestroyed()

		// Track operation to prevent UAF during destroy()
		return this.trackOperation(async () => {
			if (!isAnyPnUser(pn)) return false

			const decoded = jidDecode(pn)
			if (!decoded) return false

			const pnUser = decoded.user
			const lidUser = this.mappingCache.get(`pn:${pnUser}`)

			// Remove from cache only - persistent storage maintains history
			this.mappingCache.delete(`pn:${pnUser}`)
			if (lidUser) {
				this.mappingCache.delete(`lid:${lidUser}`)
			}

			this.logger.debug({ pnUser }, 'Mapping deleted from cache')
			return true
		}) // End trackOperation
	}

	/**
	 * @deprecated Use deleteMappingFromCache instead - name clarifies cache-only behavior
	 */
	async deleteMapping(pn: string): Promise<boolean> {
		return this.deleteMappingFromCache(pn)
	}

	// ========================================================================
	// CLEANUP
	// ========================================================================

	/**
	 * Destroy the store and clean up resources
	 * CRITICAL: Call this when done to prevent memory leaks
	 *
	 * Sets destroyed=true to reject new work, waits for active operations to
	 * drain, then releases caches. The bounded result lets socket shutdown
	 * return without destroying the auth transaction capability underneath an
	 * active mapping write. Call waitForDestroy() before releasing that
	 * capability when this returns false.
	 *
	 * @returns true when cleanup completed within the shutdown budget; false
	 * when cleanup continues in the background waiting for active operations.
	 */
	destroy(): Promise<boolean> {
		if (this.destroyPromise) return this.destroyPromise

		this.destroyed = true
		this.logger.debug('🗑️ Draining LIDMappingStore before cleanup')

		const drainPromise = this.isFullyDrained()
			? Promise.resolve()
			: new Promise<void>(resolve => {
					this.resolveDrain = resolve
				})

		if (!this.isFullyDrained()) {
			this.logger.info(
				{
					operationsInProgress: this.operationsInProgress,
					queuedJobs: this.writeQueue.length,
					pendingMappings: this.pendingWriteItems
				},
				'waiting for admitted LID mapping writes before cleanup'
			)
		}

		this.cleanupPromise = drainPromise.then(() => {
			this.resolveDrain = undefined
			this.clearResources()
			this.logger.debug('✅ LIDMappingStore drained and destroyed successfully')
		})

		this.destroyPromise = new Promise<boolean>(resolve => {
			const timeout = setTimeout(() => {
				this.hardStopped = true
				const discardedJobs = this.writeQueue.length
				const discardedMappings = this.writeQueue.reduce((total, job) => total + job.pairs.length, 0)
				this.logger.warn(
					{
						operationsInProgress: this.operationsInProgress,
						discardedJobs,
						discardedMappings,
						timeoutMs: LID_MAPPING_DESTROY_TIMEOUT_MS
					},
					'LID mapping cleanup exceeded the socket shutdown budget; invalidating queued writes'
				)
				this.rejectQueuedWrites(
					new LIDMappingError('LIDMappingStore teardown timed out', LIDMappingErrorCode.DESTROYED, {
						discardedJobs,
						discardedMappings
					})
				)
				this.maybeResolveDrain()
				resolve(false)
			}, LID_MAPPING_DESTROY_TIMEOUT_MS)
			timeout.unref?.()

			void this.cleanupPromise!.then(() => {
				clearTimeout(timeout)
				resolve(true)
			})
		})

		return this.destroyPromise
	}

	/**
	 * Wait for the actual resource cleanup after a bounded destroy() timed out.
	 * Socket teardown uses this barrier before destroying the auth key store.
	 */
	async waitForDestroy(): Promise<void> {
		if (!this.destroyPromise) {
			await this.destroy()
		}

		await this.cleanupPromise
	}

	private clearResources(): void {
		this.mappingCache.clear()
		this.inflightLIDLookups.clear()
		this.inflightPNLookups.clear()
	}

	// ========================================================================
	// PRIVATE HELPERS
	// ========================================================================

	private deduplicateMappings(pairs: LIDMapping[]): LIDMapping[] {
		const byPn = new Map<string, { pair: LIDMapping; lidUser: string; index: number }>()
		const pnByLid = new Map<string, string>()

		for (let index = 0; index < pairs.length; index++) {
			const pair = pairs[index]!
			const pnUser = jidDecode(pair.pn)?.user ?? pair.pn
			const lidUser = jidDecode(pair.lid)?.user ?? pair.lid

			const previousForPn = byPn.get(pnUser)
			if (previousForPn) {
				pnByLid.delete(previousForPn.lidUser)
			}

			const previousPnForLid = pnByLid.get(lidUser)
			if (previousPnForLid) {
				byPn.delete(previousPnForLid)
			}

			byPn.set(pnUser, { pair, lidUser, index })
			pnByLid.set(lidUser, pnUser)
		}

		return [...byPn.values()].sort((left, right) => left.index - right.index).map(({ pair }) => pair)
	}

	private async processWriteQueue(): Promise<void> {
		if (this.writeQueueRunning) return
		this.writeQueueRunning = true
		try {
			while (this.writeQueue.length > 0 && !this.hardStopped) {
				const job = this.writeQueue.shift()!
				try {
					const result = await this.trackOperation(() => this.storeLIDPNMappingsNow(job.pairs), true)
					job.resolve(result)
				} catch (error) {
					job.reject(error)
				} finally {
					this.pendingWriteItems -= job.pairs.length
					this.stats.pendingMappings = this.pendingWriteItems
					this.notifyQueueProgress()
				}
			}
		} finally {
			this.writeQueueRunning = false
			if (this.hardStopped) {
				this.rejectQueuedWrites(
					new LIDMappingError('LIDMappingStore has been destroyed', LIDMappingErrorCode.DESTROYED)
				)
			} else if (this.writeQueue.length > 0) {
				void this.processWriteQueue()
			}

			this.maybeResolveDrain()
		}
	}

	private rejectQueuedWrites(error: unknown): void {
		while (this.writeQueue.length > 0) {
			const job = this.writeQueue.shift()!
			this.pendingWriteItems -= job.pairs.length
			job.reject(error)
		}

		this.pendingWriteItems = Math.max(0, this.pendingWriteItems)
		this.stats.pendingMappings = this.pendingWriteItems
		this.rejectQueueProgressWaiters(error)
	}

	private async enqueueMappingWrite(
		pairs: LIDMapping[],
		admittedBeforeDestroy = false
	): Promise<{ stored: number; skipped: number; errors: number }> {
		this.checkWriteAdmission(admittedBeforeDestroy)
		if (pairs.length > this.config.maxPendingMappings) {
			this.stats.rejectedWrites++
			throw new LIDMappingError(
				'mapping chunk exceeds maxPendingMappings and can never be admitted',
				LIDMappingErrorCode.BACKPRESSURE,
				{ chunkSize: pairs.length, maxPendingMappings: this.config.maxPendingMappings }
			)
		}

		let reserved = false
		try {
			if (
				this.queueProgressWaiters.length > 0 ||
				this.pendingWriteItems + pairs.length > this.config.maxPendingMappings
			) {
				this.stats.backpressureWaits++
				await this.waitForQueueProgress(pairs.length, admittedBeforeDestroy)
				reserved = true
			} else {
				this.reservePendingMappings(pairs.length)
				reserved = true
			}

			this.checkWriteAdmission(admittedBeforeDestroy)
		} catch (error) {
			if (reserved) {
				this.releasePendingMappings(pairs.length)
				this.notifyQueueProgress()
			}

			throw error
		}

		return new Promise((resolve, reject) => {
			this.writeQueue.push({ pairs, resolve, reject })
			this.notifyQueueProgress()
			void this.processWriteQueue()
		})
	}

	private waitForQueueProgress(requiredItems: number, admittedBeforeDestroy = false): Promise<void> {
		this.checkWriteAdmission(admittedBeforeDestroy)
		if (this.queueProgressWaiters.length >= MAX_ADMISSION_WAITERS) {
			this.stats.rejectedWrites++
			throw new LIDMappingError('LID mapping admission waiter limit reached', LIDMappingErrorCode.BACKPRESSURE, {
				maxWaiters: MAX_ADMISSION_WAITERS,
				requiredItems
			})
		}

		return new Promise((resolve, reject) => {
			this.queueProgressWaiters.push({ requiredItems, resolve, reject })
			this.notifyQueueProgress()
		})
	}

	private checkWriteAdmission(admittedBeforeDestroy: boolean): void {
		if (this.hardStopped || (this.destroyed && !admittedBeforeDestroy)) {
			throw new LIDMappingError('LIDMappingStore has been destroyed', LIDMappingErrorCode.DESTROYED)
		}
	}

	private notifyQueueProgress(): void {
		const waiter = this.queueProgressWaiters[0]
		if (!waiter || this.pendingWriteItems + waiter.requiredItems > this.config.maxPendingMappings) return

		this.queueProgressWaiters.shift()
		this.reservePendingMappings(waiter.requiredItems)
		waiter.resolve()
	}

	private reservePendingMappings(count: number): void {
		this.pendingWriteItems += count
		this.stats.pendingMappings = this.pendingWriteItems
		this.stats.maxPendingMappingsObserved = Math.max(this.stats.maxPendingMappingsObserved, this.pendingWriteItems)
	}

	private releasePendingMappings(count: number): void {
		this.pendingWriteItems = Math.max(0, this.pendingWriteItems - count)
		this.stats.pendingMappings = this.pendingWriteItems
	}

	private rejectQueueProgressWaiters(error: unknown): void {
		for (const waiter of this.queueProgressWaiters.splice(0)) {
			waiter.reject(error)
		}
	}

	private isFullyDrained(): boolean {
		return this.operationsInProgress === 0 && this.writeQueue.length === 0 && !this.writeQueueRunning
	}

	private maybeResolveDrain(): void {
		if (this.destroyed && this.isFullyDrained()) {
			this.resolveDrain?.()
			this.resolveDrain = undefined
		}
	}

	/**
	 * Check if store has been destroyed and throw if so
	 *
	 * NOTE: This is a fail-fast guard with TOCTOU window.
	 * Critical operations must use trackOperation() wrapper for atomic safety.
	 */
	private checkDestroyed(): void {
		if (this.destroyed) {
			throw new LIDMappingError('LIDMappingStore has been destroyed', LIDMappingErrorCode.DESTROYED)
		}
	}

	/**
	 * Track operation lifecycle for safe resource cleanup
	 * Wraps operation execution with counter increment/decrement
	 *
	 * CRITICAL SAFETY: Prevents UAF by tracking active operations.
	 * destroy() will NOT clean resources if operations are in progress.
	 *
	 * @param operation - Async operation to execute
	 * @returns Promise with operation result
	 */
	private async trackOperation<T>(operation: () => Promise<T>, allowDuringDestroy = false): Promise<T> {
		// Increment counter BEFORE starting operation
		this.operationsInProgress++

		try {
			// Recheck destroyed after incrementing counter
			// This ensures we fail fast if destroyed between checkDestroyed() and here
			if (this.hardStopped || (this.destroyed && !allowDuringDestroy)) {
				throw new LIDMappingError('LIDMappingStore has been destroyed', LIDMappingErrorCode.DESTROYED)
			}

			return await operation()
		} finally {
			// ALWAYS decrement counter, even on error
			this.operationsInProgress--
			this.maybeResolveDrain()
		}
	}

	/**
	 * Validate a LID-PN mapping pair
	 * Checks that one is a LID and the other is a PN (in either order)
	 */
	private isValidMapping(lid: string, pn: string): boolean {
		return (isAnyLidUser(lid) && isAnyPnUser(pn)) || (isAnyPnUser(lid) && isAnyLidUser(pn))
	}

	/**
	 * Build device-specific JID
	 */
	private buildDeviceSpecificJid(user: string, device: number, server: string): string {
		return `${user}${device ? `:${device}` : ''}@${server}`
	}

	/**
	 * Chunk array into smaller arrays for batch processing
	 */
	private chunkArray<T>(array: T[], size: number): T[][] {
		const chunks: T[][] = []
		for (let i = 0; i < array.length; i += size) {
			chunks.push(array.slice(i, i + size))
		}

		return chunks
	}

	/**
	 * Retry an operation with exponential backoff
	 * Supports both Promise and Awaitable return types
	 *
	 * Delay pattern: baseDelay * 2^(attempt-1)
	 * - Attempt 1: immediate
	 * - Attempt 2: baseDelay * 1 (e.g., 1000ms)
	 * - Attempt 3: baseDelay * 2 (e.g., 2000ms)
	 * - Attempt 4: baseDelay * 4 (e.g., 4000ms)
	 *
	 * Configure via: BAILEYS_LID_RETRY_ATTEMPTS (default: 3)
	 *                BAILEYS_LID_RETRY_DELAY_MS (default: 1000)
	 */
	private async retryOperation<T>(operation: () => T | Promise<T>, operationName: string): Promise<T> {
		let lastError: Error | undefined

		for (let attempt = 1; attempt <= this.config.retryAttempts; attempt++) {
			try {
				return await operation()
			} catch (error) {
				lastError = error instanceof Error ? error : new Error(String(error))

				if (attempt < this.config.retryAttempts) {
					const delay = this.config.retryDelayMs * Math.pow(2, attempt - 1)
					this.logger.warn(
						{ operationName, attempt, maxAttempts: this.config.retryAttempts, delay },
						'Operation failed, retrying'
					)
					await this.sleep(delay)
				}
			}
		}

		throw new LIDMappingError(
			`Operation ${operationName} failed after ${this.config.retryAttempts} attempts: ${lastError?.message}`,
			LIDMappingErrorCode.DATABASE_ERROR,
			{ operationName, lastError: lastError?.message }
		)
	}

	/**
	 * Sleep for specified milliseconds
	 */
	private sleep(ms: number): Promise<void> {
		return new Promise(resolve => setTimeout(resolve, ms))
	}

	/**
	 * Fetch mappings from USync
	 */
	private async fetchFromUSync(
		usyncFetch: { [pn: string]: number[] },
		successfulPairs: { [pn: string]: LIDMapping }
	): Promise<void> {
		if (!this.pnToLIDFunc) {
			this.logger.warn('No pnToLIDFunc provided, cannot fetch from USync')
			return
		}

		this.stats.usyncFetches++

		try {
			const result = await this.pnToLIDFunc(Object.keys(usyncFetch))

			if (result && result.length > 0) {
				await this.storeLIDPNMappings(result)

				for (const pair of result) {
					const pnDecoded = jidDecode(pair.pn)
					const pnUser = pnDecoded?.user
					if (!pnUser) continue

					const lidUser = jidDecode(pair.lid)?.user
					if (!lidUser) continue

					const devices = usyncFetch[pair.pn]
					if (!devices) continue

					for (const device of devices) {
						const server = device === 99 ? 'hosted.lid' : 'lid'
						const deviceSpecificLid = this.buildDeviceSpecificJid(lidUser, device, server)

						const pnServer = device === 99 ? 'hosted' : 's.whatsapp.net'
						const deviceSpecificPn = this.buildDeviceSpecificJid(pnUser, device, pnServer)

						if (this.config.debugLogging) {
							this.logger.trace({ pn: pair.pn, deviceSpecificLid, device }, 'USync fetch successful')
						}

						successfulPairs[deviceSpecificPn] = { lid: deviceSpecificLid, pn: deviceSpecificPn }
					}
				}
			} else {
				this.stats.usyncFailures++
			}
		} catch (error) {
			this.logger.error({ error }, 'USync fetch failed')
			this.stats.usyncFailures++
			this.stats.failedOperations++
		}
	}

	/**
	 * Request coalescing helper - deduplicates concurrent lookups for same key
	 *
	 * SAFETY GUARANTEES:
	 * - No UAF (Use-After-Free): Caller must use trackOperation() wrapper, which prevents
	 *   resource cleanup during execution via operationsInProgress counter
	 * - No TOCTOU: Destroyed check done once at operation start (no redundant rechecks)
	 * - Thread-safe: Maps protected by operationsInProgress (V4) and usage contract (V5)
	 *
	 * USAGE REQUIREMENTS:
	 * - MUST be called from within trackOperation() (enforced by V5 documentation)
	 * - Caller MUST have called checkDestroyed() before entering tracked operation
	 * - DO NOT call directly from unwrapped operations
	 *
	 * @param key - Lookup key (e.g., pnUser for LID lookup)
	 * @param map - The inflight Map to use
	 * @param fetchFn - Function to execute if no inflight request exists
	 * @returns Promise that resolves to the result
	 */
	private async coalesceRequest<T>(key: string, map: Map<string, Promise<T>>, fetchFn: () => Promise<T>): Promise<T> {
		// Check if request is already in-flight
		const existing = map.get(key)
		if (existing) {
			// Return cached Promise - safe because:
			// 1. Caller already checked destroyed (via checkDestroyed() in parent operation)
			// 2. Operation is protected by trackOperation() (resources won't be freed)
			// 3. Rechecking here would add TOCTOU window without benefit
			return existing
		}

		// Create new request
		const promise = fetchFn()
		map.set(key, promise)

		try {
			const result = await promise
			return result
		} finally {
			// Always cleanup from Map after completion (success or failure)
			map.delete(key)
		}
	}

	/**
	 * Record metrics if enabled (with buffer support for async loading)
	 * Note: Actual metric recording is not yet implemented
	 */
	private recordMetrics(operation: string, count: number): void {
		// Metrics implementation pending - currently a no-op
		// When implemented, should record LID mapping operations to Prometheus
		// For now, we don't buffer since there's no actual recording function
	}
}
