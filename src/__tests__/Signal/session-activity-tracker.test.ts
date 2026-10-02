import { jest } from '@jest/globals'
import P from 'pino'
import type { SessionActivityMetadata } from '../../Signal/session-activity-tracker'
import { makeSessionActivityTracker } from '../../Signal/session-activity-tracker'
import type { SignalKeyStoreWithTransaction } from '../../Types'

type MockedKeys = jest.Mocked<SignalKeyStoreWithTransaction>

const mockKeys: MockedKeys = {
	get: jest.fn<SignalKeyStoreWithTransaction['get']>() as MockedKeys['get'],
	set: jest.fn<SignalKeyStoreWithTransaction['set']>(),
	transaction: jest.fn(async (work: () => Promise<unknown>) => await work()) as unknown as MockedKeys['transaction'],
	isInTransaction: jest.fn<SignalKeyStoreWithTransaction['isInTransaction']>()
}

const logger = P({ level: 'silent' })

describe('SessionActivityTracker', () => {
	beforeEach(() => {
		jest.clearAllMocks()
		jest.useFakeTimers()
	})

	afterEach(() => {
		jest.useRealTimers()
	})

	describe('recordActivity', () => {
		it('should record activity in memory cache', () => {
			const config = { enabled: true, flushIntervalMs: 60000 }
			const tracker = makeSessionActivityTracker(mockKeys, logger, config)

			const jid = '5511999999999@s.whatsapp.net'

			tracker.recordActivity(jid)

			const stats = tracker.getStats()
			expect(stats.totalUpdates).toBe(1)
			expect(stats.cacheSize).toBe(1)
		})

		it('should update existing activity timestamp', () => {
			const config = { enabled: true, flushIntervalMs: 60000 }
			const tracker = makeSessionActivityTracker(mockKeys, logger, config)

			const jid = '5511999999999@s.whatsapp.net'

			tracker.recordActivity(jid)
			jest.advanceTimersByTime(5000) // 5 seconds later
			tracker.recordActivity(jid)

			const stats = tracker.getStats()
			expect(stats.totalUpdates).toBe(2)
			expect(stats.cacheSize).toBe(1) // Still one unique JID
		})

		it('should not record activity when disabled', () => {
			const config = { enabled: false, flushIntervalMs: 60000 }
			const tracker = makeSessionActivityTracker(mockKeys, logger, config)

			tracker.recordActivity('5511999999999@s.whatsapp.net')

			const stats = tracker.getStats()
			expect(stats.totalUpdates).toBe(0)
			expect(stats.cacheSize).toBe(0)
		})

		it('should handle multiple JIDs', () => {
			const config = { enabled: true, flushIntervalMs: 60000 }
			const tracker = makeSessionActivityTracker(mockKeys, logger, config)

			tracker.recordActivity('5511999999999@s.whatsapp.net')
			tracker.recordActivity('5511888888888@s.whatsapp.net')
			tracker.recordActivity('123456789@lid')

			const stats = tracker.getStats()
			expect(stats.totalUpdates).toBe(3)
			expect(stats.cacheSize).toBe(3)
		})
	})

	describe('getLastActivity', () => {
		it('should return activity from cache (cache hit)', async () => {
			const config = { enabled: true, flushIntervalMs: 60000 }
			const tracker = makeSessionActivityTracker(mockKeys, logger, config)

			const jid = '5511999999999@s.whatsapp.net'
			const beforeTime = Date.now()

			tracker.recordActivity(jid)

			const lastActivity = await tracker.getLastActivity(jid)
			expect(lastActivity).toBeGreaterThanOrEqual(beforeTime)
			expect(mockKeys.get).not.toHaveBeenCalled() // Cache hit, no DB call
		})

		it('should fallback to disk when not in cache (cache miss)', async () => {
			const config = { enabled: true, flushIntervalMs: 60000 }
			const tracker = makeSessionActivityTracker(mockKeys, logger, config)

			const jid = '5511999999999@s.whatsapp.net'
			const diskTimestamp = Date.now() - 10000

			// @ts-ignore
			mockKeys.get.mockResolvedValue({
				'session-activity:5511999999999@s.whatsapp.net': {
					lastActivityAt: diskTimestamp,
					createdAt: diskTimestamp
				} as SessionActivityMetadata
			})

			const lastActivity = await tracker.getLastActivity(jid)
			expect(lastActivity).toBe(diskTimestamp)
			expect(mockKeys.get).toHaveBeenCalledTimes(1)
		})

		it('should return undefined when activity not found', async () => {
			const config = { enabled: true, flushIntervalMs: 60000 }
			const tracker = makeSessionActivityTracker(mockKeys, logger, config)

			// @ts-ignore
			mockKeys.get.mockResolvedValue({})

			const lastActivity = await tracker.getLastActivity('nonexistent@s.whatsapp.net')
			expect(lastActivity).toBeUndefined()
		})

		it('should return undefined when disabled', async () => {
			const config = { enabled: false, flushIntervalMs: 60000 }
			const tracker = makeSessionActivityTracker(mockKeys, logger, config)

			const lastActivity = await tracker.getLastActivity('5511999999999@s.whatsapp.net')
			expect(lastActivity).toBeUndefined()
		})

		it('should handle disk read errors gracefully', async () => {
			const config = { enabled: true, flushIntervalMs: 60000 }
			const tracker = makeSessionActivityTracker(mockKeys, logger, config)

			// @ts-ignore
			mockKeys.get.mockRejectedValue(new Error('Disk read error'))

			const lastActivity = await tracker.getLastActivity('5511999999999@s.whatsapp.net')
			expect(lastActivity).toBeUndefined()
		})
	})

	describe('getAllActivities', () => {
		it('should return all activities from disk and cache', async () => {
			const config = { enabled: true, flushIntervalMs: 60000 }
			const tracker = makeSessionActivityTracker(mockKeys, logger, config)

			const now = Date.now()

			// Simulate disk data
			// @ts-ignore
			mockKeys.get.mockResolvedValue({
				'session-activity:5511999999999@s.whatsapp.net': {
					lastActivityAt: now - 10000,
					createdAt: now - 20000
				} as SessionActivityMetadata,
				'session-activity:5511888888888@s.whatsapp.net': {
					lastActivityAt: now - 5000,
					createdAt: now - 15000
				} as SessionActivityMetadata
			})

			// Add new activity to cache
			tracker.recordActivity('123456789@lid')

			const activities = await tracker.getAllActivities()

			expect(activities.size).toBe(3)
			expect(activities.has('5511999999999@s.whatsapp.net')).toBe(true)
			expect(activities.has('5511888888888@s.whatsapp.net')).toBe(true)
			expect(activities.has('123456789@lid')).toBe(true)
		})

		it('should prioritize cache over disk (cache is more recent)', async () => {
			const config = { enabled: true, flushIntervalMs: 60000 }
			const tracker = makeSessionActivityTracker(mockKeys, logger, config)

			const jid = '5511999999999@s.whatsapp.net'
			const diskTimestamp = Date.now() - 10000

			// Simulate old disk data
			// @ts-ignore
			mockKeys.get.mockResolvedValue({
				[`session-activity:${jid}`]: {
					lastActivityAt: diskTimestamp,
					createdAt: diskTimestamp
				} as SessionActivityMetadata
			})

			// Record new activity in cache
			const beforeCache = Date.now()
			tracker.recordActivity(jid)

			const activities = await tracker.getAllActivities()
			const cacheTimestamp = activities.get(jid)

			expect(cacheTimestamp).toBeGreaterThanOrEqual(beforeCache)
			expect(cacheTimestamp).not.toBe(diskTimestamp) // Cache wins
		})

		it('should return empty map when disabled', async () => {
			const config = { enabled: false, flushIntervalMs: 60000 }
			const tracker = makeSessionActivityTracker(mockKeys, logger, config)

			const activities = await tracker.getAllActivities()
			expect(activities.size).toBe(0)
		})

		it('should handle disk read errors gracefully', async () => {
			// Use real timers for this test
			jest.useRealTimers()

			const config = { enabled: true, flushIntervalMs: 60000 }
			const tracker = makeSessionActivityTracker(mockKeys, logger, config)

			// Simulate disk error
			// @ts-ignore
			mockKeys.get.mockRejectedValue(new Error('Disk read error'))

			// getAllActivities should return empty map (logs warning but doesn't throw)
			const activities = await tracker.getAllActivities()
			expect(activities).toBeInstanceOf(Map)
			expect(activities.size).toBe(0) // Current implementation doesn't return cache on disk error

			// Restore fake timers
			jest.useFakeTimers()
		})
	})

	describe('flush', () => {
		it('should flush cache to disk in batch', async () => {
			const config = { enabled: true, flushIntervalMs: 60000 }
			const tracker = makeSessionActivityTracker(mockKeys, logger, config)

			const jid1 = '5511999999999@s.whatsapp.net'
			const jid2 = '5511888888888@s.whatsapp.net'

			tracker.recordActivity(jid1)
			tracker.recordActivity(jid2)

			await tracker.flush()

			// Should call transaction once for batch write
			expect(mockKeys.transaction).toHaveBeenCalledTimes(1)
			expect(mockKeys.set).toHaveBeenCalledTimes(1)

			// Verify batch update structure
			const setCall = mockKeys.set.mock.calls[0]?.[0]
			// @ts-ignore
			expect(setCall['session-activity']).toBeDefined()
			// @ts-ignore
			expect(setCall['session-activity'][`session-activity:${jid1}`]).toBeDefined()
			// @ts-ignore
			expect(setCall['session-activity'][`session-activity:${jid2}`]).toBeDefined()
		})

		it('should clear cache after successful flush', async () => {
			const config = { enabled: true, flushIntervalMs: 60000 }
			const tracker = makeSessionActivityTracker(mockKeys, logger, config)

			tracker.recordActivity('5511999999999@s.whatsapp.net')

			await tracker.flush()

			const stats = tracker.getStats()
			expect(stats.cacheSize).toBe(0) // Cache cleared
			expect(stats.totalFlushes).toBe(1)
		})

		it('should not flush when cache is empty', async () => {
			const config = { enabled: true, flushIntervalMs: 60000 }
			const tracker = makeSessionActivityTracker(mockKeys, logger, config)

			await tracker.flush()

			expect(mockKeys.transaction).not.toHaveBeenCalled()
		})

		it('should not flush when disabled', async () => {
			const config = { enabled: false, flushIntervalMs: 60000 }
			const tracker = makeSessionActivityTracker(mockKeys, logger, config)

			await tracker.flush()

			expect(mockKeys.transaction).not.toHaveBeenCalled()
		})

		it('should keep cache on flush failure (retry on next flush)', async () => {
			const config = { enabled: true, flushIntervalMs: 60000 }
			const tracker = makeSessionActivityTracker(mockKeys, logger, config)

			tracker.recordActivity('5511999999999@s.whatsapp.net')

			// Simulate flush error
			mockKeys.transaction.mockRejectedValueOnce(new Error('Flush failed'))

			await tracker.flush()

			const stats = tracker.getStats()
			expect(stats.cacheSize).toBe(1) // Cache NOT cleared
			expect(stats.totalFlushes).toBe(0) // Flush failed
		})

		it('should update statistics after successful flush', async () => {
			const config = { enabled: true, flushIntervalMs: 60000 }
			const tracker = makeSessionActivityTracker(mockKeys, logger, config)

			tracker.recordActivity('5511999999999@s.whatsapp.net')

			const beforeFlush = Date.now()
			await tracker.flush()
			const afterFlush = Date.now()

			const stats = tracker.getStats()
			expect(stats.totalFlushes).toBe(1)
			expect(stats.lastFlushAt).toBeGreaterThanOrEqual(beforeFlush)
			expect(stats.lastFlushAt).toBeLessThanOrEqual(afterFlush)
			expect(stats.lastFlushDuration).toBeGreaterThanOrEqual(0)
		})
	})

	describe('start/stop lifecycle', () => {
		it('should start periodic flush', async () => {
			// Use real timers for this test
			jest.useRealTimers()

			const config = { enabled: true, flushIntervalMs: 60000 }
			const tracker = makeSessionActivityTracker(mockKeys, logger, config)

			// Record activity so there's something to flush
			tracker.recordActivity('5511999999999@s.whatsapp.net')

			tracker.start()

			// Wait for initial flush to complete
			await new Promise(resolve => setTimeout(resolve, 50))

			// Should attempt initial flush
			expect(mockKeys.transaction).toHaveBeenCalled()

			// Cleanup
			await tracker.stop()

			// Restore fake timers
			jest.useFakeTimers()
		})

		it('should flush periodically after start', async () => {
			const config = { enabled: true, flushIntervalMs: 60000 }
			const tracker = makeSessionActivityTracker(mockKeys, logger, config)

			tracker.start()
			jest.clearAllMocks()

			// Record activity
			tracker.recordActivity('5511999999999@s.whatsapp.net')

			// Advance time to trigger flush
			jest.advanceTimersByTime(60000)
			await Promise.resolve() // Let flush promise resolve

			expect(mockKeys.transaction).toHaveBeenCalled()
		})

		it('should not start when disabled', () => {
			const config = { enabled: false, flushIntervalMs: 60000 }
			const tracker = makeSessionActivityTracker(mockKeys, logger, config)

			tracker.start()

			expect(mockKeys.transaction).not.toHaveBeenCalled()
		})

		it('should not start twice (guard against multiple start calls)', () => {
			const config = { enabled: true, flushIntervalMs: 60000 }
			const tracker = makeSessionActivityTracker(mockKeys, logger, config)

			tracker.start()
			jest.clearAllMocks()

			// Second start should be ignored
			tracker.start()

			// Should not trigger another initial flush
			expect(mockKeys.transaction).not.toHaveBeenCalled()
		})

		it('should stop periodic flush and flush pending data', async () => {
			const config = { enabled: true, flushIntervalMs: 60000 }
			const tracker = makeSessionActivityTracker(mockKeys, logger, config)

			tracker.start()
			jest.clearAllMocks()

			// Record activity
			tracker.recordActivity('5511999999999@s.whatsapp.net')

			// Stop should flush pending data
			await tracker.stop()

			expect(mockKeys.transaction).toHaveBeenCalledTimes(1)
			expect(mockKeys.set).toHaveBeenCalled()
		})

		it('should stop periodic flush without error when no pending data', async () => {
			const config = { enabled: true, flushIntervalMs: 60000 }
			const tracker = makeSessionActivityTracker(mockKeys, logger, config)

			tracker.start()
			jest.clearAllMocks()

			await tracker.stop()

			// No flush needed (no pending data)
			expect(mockKeys.transaction).not.toHaveBeenCalled()
		})
	})

	describe('getStats', () => {
		it('should return current statistics', () => {
			const config = { enabled: true, flushIntervalMs: 60000 }
			const tracker = makeSessionActivityTracker(mockKeys, logger, config)

			tracker.recordActivity('5511999999999@s.whatsapp.net')
			tracker.recordActivity('5511888888888@s.whatsapp.net')

			const stats = tracker.getStats()

			expect(stats.enabled).toBe(true)
			expect(stats.totalUpdates).toBe(2)
			expect(stats.cacheSize).toBe(2)
			expect(stats.totalFlushes).toBe(0) // No flush yet
			expect(stats.lastFlushAt).toBe(0)
			expect(stats.lastFlushDuration).toBe(0)
		})

		it('should show disabled status', () => {
			const config = { enabled: false, flushIntervalMs: 60000 }
			const tracker = makeSessionActivityTracker(mockKeys, logger, config)

			const stats = tracker.getStats()
			expect(stats.enabled).toBe(false)
		})
	})

	describe('Performance', () => {
		it('should handle high-volume activity recording (1000 messages)', () => {
			const config = { enabled: true, flushIntervalMs: 60000 }
			const tracker = makeSessionActivityTracker(mockKeys, logger, config)

			const startTime = Date.now()

			// Simulate 1000 messages
			for (let i = 0; i < 1000; i++) {
				tracker.recordActivity(`5511${i.toString().padStart(9, '0')}@s.whatsapp.net`)
			}

			const duration = Date.now() - startTime

			const stats = tracker.getStats()
			expect(stats.totalUpdates).toBe(1000)
			expect(stats.cacheSize).toBe(1000)

			// Should be very fast (<100ms for 1000 updates)
			expect(duration).toBeLessThan(100)
		})

		it('should batch flush multiple activities in single transaction', async () => {
			const config = { enabled: true, flushIntervalMs: 60000 }
			const tracker = makeSessionActivityTracker(mockKeys, logger, config)

			// Record 100 activities
			for (let i = 0; i < 100; i++) {
				tracker.recordActivity(`5511${i.toString().padStart(9, '0')}@s.whatsapp.net`)
			}

			await tracker.flush()

			// Should use single transaction for all 100
			expect(mockKeys.transaction).toHaveBeenCalledTimes(1)
			expect(mockKeys.set).toHaveBeenCalledTimes(1)

			const stats = tracker.getStats()
			expect(stats.totalFlushes).toBe(1)
		})
	})

	describe('Edge Cases', () => {
		it('should handle JID with special characters', () => {
			const config = { enabled: true, flushIntervalMs: 60000 }
			const tracker = makeSessionActivityTracker(mockKeys, logger, config)

			const specialJids = [
				'5511999999999:1@s.whatsapp.net', // Device ID
				'123456789@lid', // LID
				'5511999999999:99@hosted', // Hosted device
				'123456789:5@hosted.lid' // Hosted LID
			]

			specialJids.forEach(jid => tracker.recordActivity(jid))

			const stats = tracker.getStats()
			expect(stats.cacheSize).toBe(4)
		})

		it('should handle rapid updates to same JID', () => {
			const config = { enabled: true, flushIntervalMs: 60000 }
			const tracker = makeSessionActivityTracker(mockKeys, logger, config)

			const jid = '5511999999999@s.whatsapp.net'

			// Rapid updates (10 in quick succession)
			for (let i = 0; i < 10; i++) {
				tracker.recordActivity(jid)
			}

			const stats = tracker.getStats()
			expect(stats.totalUpdates).toBe(10)
			expect(stats.cacheSize).toBe(1) // Still one JID
		})

		it('should handle flush during active recording', async () => {
			const config = { enabled: true, flushIntervalMs: 60000 }
			const tracker = makeSessionActivityTracker(mockKeys, logger, config)

			// Record activity
			tracker.recordActivity('5511999999999@s.whatsapp.net')

			// Flush clears the cache
			await tracker.flush()

			// Record new activity after flush
			tracker.recordActivity('5511888888888@s.whatsapp.net')

			// New activity should be in cache
			const stats = tracker.getStats()
			expect(stats.cacheSize).toBe(1) // Only the new one
		})
	})
})
