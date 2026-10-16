import { jest } from '@jest/globals'
import P from 'pino'
import type { LIDMappingStore } from '../../Signal/lid-mapping'
import type { SessionActivityTracker } from '../../Signal/session-activity-tracker'
import { makeSessionCleanup } from '../../Signal/session-cleanup'
import type { SignalKeyStoreWithTransaction } from '../../Types'

type MockedKeys = jest.Mocked<SignalKeyStoreWithTransaction>

const mockKeys: MockedKeys = {
	get: jest.fn<SignalKeyStoreWithTransaction['get']>() as MockedKeys['get'],
	set: jest.fn<SignalKeyStoreWithTransaction['set']>(),
	transaction: jest.fn(async (work: () => Promise<unknown>) => await work()) as unknown as MockedKeys['transaction'],
	isInTransaction: jest.fn<SignalKeyStoreWithTransaction['isInTransaction']>()
}

const mockLidMapping: jest.Mocked<Pick<LIDMappingStore, 'getPNForLID'>> = {
	getPNForLID: jest.fn<LIDMappingStore['getPNForLID']>()
}

const mockActivityTracker: jest.Mocked<Pick<SessionActivityTracker, 'getAllActivities'>> = {
	getAllActivities: jest.fn<SessionActivityTracker['getAllActivities']>()
}

// makeSessionCleanup only touches the mocked members; the full class types are
// required by its signature.
const lidMappingStore = mockLidMapping as unknown as LIDMappingStore
const activityTracker = mockActivityTracker as unknown as SessionActivityTracker

const logger = P({ level: 'silent' })

describe('SessionCleanup', () => {
	const HOUR_MS = 3600000
	const DAY_MS = 86400000

	beforeEach(() => {
		jest.clearAllMocks()
	})

	describe('LID Orphan Cleanup (24h threshold)', () => {
		const config = {
			enabled: true,
			intervalMs: 86400000,
			cleanupHour: 3,
			secondaryDeviceInactiveDays: 15,
			primaryDeviceInactiveDays: 30,
			lidOrphanHours: 24,
			cleanupOnStartup: false,
			autoCleanCorrupted: false
		}

		it('should delete LID orphan after 24h of inactivity', async () => {
			const now = Date.now()
			const lastActivity = now - 25 * HOUR_MS // 25 hours ago

			// Mock sessions: 1 LID orphan
			// @ts-ignore
			mockKeys.get.mockResolvedValue({
				'123456789_2.0': Buffer.from('session-data')
			})

			// Mock: No PN mapping (orphan)
			mockLidMapping.getPNForLID.mockResolvedValue(null)

			// Mock: Activity 25h ago
			mockActivityTracker.getAllActivities.mockResolvedValue(new Map([['123456789@lid', lastActivity]]))

			const cleanup = makeSessionCleanup(mockKeys, lidMappingStore, activityTracker, logger, config)

			const stats = await cleanup.runCleanup()

			expect(stats.lidOrphansDeleted).toBe(1)
			expect(stats.totalDeleted).toBe(1)
			expect(mockKeys.set).toHaveBeenCalledWith({
				session: { '123456789_2.0': null }
			})
		})

		it('should NOT delete LID orphan before 24h', async () => {
			const now = Date.now()
			const lastActivity = now - 23 * HOUR_MS // 23 hours ago

			// @ts-ignore
			mockKeys.get.mockResolvedValue({
				'123456789_2.0': Buffer.from('session-data')
			})

			mockLidMapping.getPNForLID.mockResolvedValue(null)

			mockActivityTracker.getAllActivities.mockResolvedValue(new Map([['123456789@lid', lastActivity]]))

			const cleanup = makeSessionCleanup(mockKeys, lidMappingStore, activityTracker, logger, config)

			const stats = await cleanup.runCleanup()

			expect(stats.lidOrphansDeleted).toBe(0)
			expect(stats.totalDeleted).toBe(0)
			expect(mockKeys.set).not.toHaveBeenCalled()
		})

		it('should delete LID orphan with no activity tracking', async () => {
			// @ts-ignore
			mockKeys.get.mockResolvedValue({
				'123456789_2.0': Buffer.from('session-data')
			})

			mockLidMapping.getPNForLID.mockResolvedValue(null)

			// No activity tracked
			mockActivityTracker.getAllActivities.mockResolvedValue(new Map())

			const cleanup = makeSessionCleanup(mockKeys, lidMappingStore, activityTracker, logger, config)

			const stats = await cleanup.runCleanup()

			expect(stats.lidOrphansDeleted).toBe(1)
			expect(stats.totalDeleted).toBe(1)
		})

		it('should NOT delete LID with valid PN mapping', async () => {
			const now = Date.now()
			const lastActivity = now - 25 * HOUR_MS

			// @ts-ignore
			mockKeys.get.mockResolvedValue({
				'123456789_2.0': Buffer.from('session-data')
			})

			// Has PN mapping - not orphan
			mockLidMapping.getPNForLID.mockResolvedValue('5511999999999@s.whatsapp.net')

			mockActivityTracker.getAllActivities.mockResolvedValue(new Map([['123456789@lid', lastActivity]]))

			const cleanup = makeSessionCleanup(mockKeys, lidMappingStore, activityTracker, logger, config)

			const stats = await cleanup.runCleanup()

			expect(stats.lidOrphansDeleted).toBe(0)
			expect(stats.totalDeleted).toBe(0)
		})
	})

	describe('Secondary Device Cleanup (15 days threshold)', () => {
		const config = {
			enabled: true,
			intervalMs: 86400000,
			cleanupHour: 3,
			secondaryDeviceInactiveDays: 15,
			primaryDeviceInactiveDays: 30,
			lidOrphanHours: 24,
			cleanupOnStartup: false,
			autoCleanCorrupted: false
		}

		it('should delete secondary device (Web/Desktop) after 15 days', async () => {
			const now = Date.now()
			const lastActivity = now - 16 * DAY_MS // 16 days ago

			// Mock: Secondary device (device ID = 1)
			// @ts-ignore
			mockKeys.get.mockResolvedValue({
				'5511999999999_0.1': Buffer.from('session-data')
			})

			mockActivityTracker.getAllActivities.mockResolvedValue(
				new Map([['5511999999999:1@s.whatsapp.net', lastActivity]])
			)

			const cleanup = makeSessionCleanup(mockKeys, lidMappingStore, activityTracker, logger, config)

			const stats = await cleanup.runCleanup()

			expect(stats.secondaryDevicesDeleted).toBe(1)
			expect(stats.totalDeleted).toBe(1)
		})

		it('should NOT delete secondary device before 15 days', async () => {
			const now = Date.now()
			const lastActivity = now - 14 * DAY_MS // 14 days ago

			// @ts-ignore
			mockKeys.get.mockResolvedValue({
				'5511999999999_0.1': Buffer.from('session-data')
			})

			mockActivityTracker.getAllActivities.mockResolvedValue(
				new Map([['5511999999999:1@s.whatsapp.net', lastActivity]])
			)

			const cleanup = makeSessionCleanup(mockKeys, lidMappingStore, activityTracker, logger, config)

			const stats = await cleanup.runCleanup()

			expect(stats.secondaryDevicesDeleted).toBe(0)
			expect(stats.totalDeleted).toBe(0)
		})

		it('should NOT delete secondary device without activity tracking', async () => {
			// @ts-ignore
			mockKeys.get.mockResolvedValue({
				'5511999999999_0.1': Buffer.from('session-data')
			})

			// No activity tracked - grace period
			mockActivityTracker.getAllActivities.mockResolvedValue(new Map())

			const cleanup = makeSessionCleanup(mockKeys, lidMappingStore, activityTracker, logger, config)

			const stats = await cleanup.runCleanup()

			expect(stats.secondaryDevicesDeleted).toBe(0)
			expect(stats.totalDeleted).toBe(0)
		})
	})

	describe('Primary Device Cleanup (30 days threshold)', () => {
		const config = {
			enabled: true,
			intervalMs: 86400000,
			cleanupHour: 3,
			secondaryDeviceInactiveDays: 15,
			primaryDeviceInactiveDays: 30,
			lidOrphanHours: 24,
			cleanupOnStartup: false,
			autoCleanCorrupted: false
		}

		it('should delete primary device after 30 days', async () => {
			const now = Date.now()
			const lastActivity = now - 31 * DAY_MS // 31 days ago

			// Mock: Primary device (device ID = 0)
			// @ts-ignore
			mockKeys.get.mockResolvedValue({
				'5511999999999_0.0': Buffer.from('session-data')
			})

			mockActivityTracker.getAllActivities.mockResolvedValue(new Map([['5511999999999@s.whatsapp.net', lastActivity]]))

			const cleanup = makeSessionCleanup(mockKeys, lidMappingStore, activityTracker, logger, config)

			const stats = await cleanup.runCleanup()

			expect(stats.primaryDevicesDeleted).toBe(1)
			expect(stats.totalDeleted).toBe(1)
		})

		it('should NOT delete primary device before 30 days', async () => {
			const now = Date.now()
			const lastActivity = now - 29 * DAY_MS // 29 days ago

			// @ts-ignore
			mockKeys.get.mockResolvedValue({
				'5511999999999_0.0': Buffer.from('session-data')
			})

			mockActivityTracker.getAllActivities.mockResolvedValue(new Map([['5511999999999@s.whatsapp.net', lastActivity]]))

			const cleanup = makeSessionCleanup(mockKeys, lidMappingStore, activityTracker, logger, config)

			const stats = await cleanup.runCleanup()

			expect(stats.primaryDevicesDeleted).toBe(0)
			expect(stats.totalDeleted).toBe(0)
		})
	})

	describe('Boundary Conditions', () => {
		const config = {
			enabled: true,
			intervalMs: 86400000,
			cleanupHour: 3,
			secondaryDeviceInactiveDays: 15,
			primaryDeviceInactiveDays: 30,
			lidOrphanHours: 24,
			cleanupOnStartup: false,
			autoCleanCorrupted: false
		}

		it('should handle exactly 24h for LID orphan (boundary)', async () => {
			const fixedNow = 1700000000000 // Fixed timestamp to avoid race conditions
			const lastActivity = fixedNow - 24 * HOUR_MS // Exactly 24h

			// Mock Date.now() to return consistent value
			const originalDateNow = Date.now
			Date.now = jest.fn(() => fixedNow)

			try {
				// @ts-ignore
				mockKeys.get.mockResolvedValue({
					'123456789_2.0': Buffer.from('session-data')
				})

				mockLidMapping.getPNForLID.mockResolvedValue(null)

				mockActivityTracker.getAllActivities.mockResolvedValue(new Map([['123456789@lid', lastActivity]]))

				const cleanup = makeSessionCleanup(mockKeys, lidMappingStore, activityTracker, logger, config)

				const stats = await cleanup.runCleanup()

				// Exactly 24h should NOT delete (> threshold, not >=)
				expect(stats.lidOrphansDeleted).toBe(0)
			} finally {
				// Restore original Date.now
				Date.now = originalDateNow
			}
		})

		it('should handle empty session list', async () => {
			// @ts-ignore
			mockKeys.get.mockResolvedValue({})

			const cleanup = makeSessionCleanup(mockKeys, lidMappingStore, activityTracker, logger, config)

			const stats = await cleanup.runCleanup()

			expect(stats.totalScanned).toBe(0)
			expect(stats.totalDeleted).toBe(0)
		})

		it('should handle null sessionActivityTracker gracefully', async () => {
			// eslint-disable-next-line @typescript-eslint/no-unused-vars
			const _ = Date.now()

			// @ts-ignore
			mockKeys.get.mockResolvedValue({
				'123456789_2.0': Buffer.from('session-data')
			})

			mockLidMapping.getPNForLID.mockResolvedValue(null)

			// Pass null tracker
			const cleanup = makeSessionCleanup(mockKeys, lidMappingStore, null, logger, config)

			const stats = await cleanup.runCleanup()

			// Should still work, but with no activity data
			expect(stats.totalScanned).toBe(1)
			// LID orphan with no activity tracking gets deleted
			expect(stats.lidOrphansDeleted).toBe(1)
		})
	})

	describe('Mixed Scenarios', () => {
		const config = {
			enabled: true,
			intervalMs: 86400000,
			cleanupHour: 3,
			secondaryDeviceInactiveDays: 15,
			primaryDeviceInactiveDays: 30,
			lidOrphanHours: 24,
			cleanupOnStartup: false,
			autoCleanCorrupted: false
		}

		it('should delete multiple sessions of different types', async () => {
			const now = Date.now()

			// @ts-ignore
			mockKeys.get.mockResolvedValue({
				'123456789_2.0': Buffer.from('lid-orphan'),
				'5511999999999_0.1': Buffer.from('secondary-inactive'),
				'5511888888888_0.0': Buffer.from('primary-inactive'),
				'5511777777777_0.0': Buffer.from('primary-active')
			})

			mockLidMapping.getPNForLID.mockImplementation(async (lid: string) => {
				if (lid === '123456789@lid') return null // Orphan
				return '5511999999999@s.whatsapp.net'
			})

			mockActivityTracker.getAllActivities.mockResolvedValue(
				new Map([
					['123456789@lid', now - 25 * HOUR_MS], // LID orphan: 25h ago
					['5511999999999:1@s.whatsapp.net', now - 16 * DAY_MS], // Secondary: 16 days ago
					['5511888888888@s.whatsapp.net', now - 31 * DAY_MS], // Primary: 31 days ago
					['5511777777777@s.whatsapp.net', now - 5 * DAY_MS] // Primary: 5 days ago (active)
				])
			)

			const cleanup = makeSessionCleanup(mockKeys, lidMappingStore, activityTracker, logger, config)

			const stats = await cleanup.runCleanup()

			expect(stats.totalScanned).toBe(4)
			expect(stats.lidOrphansDeleted).toBe(1)
			expect(stats.secondaryDevicesDeleted).toBe(1)
			expect(stats.primaryDevicesDeleted).toBe(1)
			expect(stats.totalDeleted).toBe(3)
		})
	})

	// Audit C-01: the scheduler must never outlive stop(), and its timers must
	// not keep the process alive.
	describe('Scheduler lifecycle', () => {
		const config = {
			enabled: true,
			intervalMs: DAY_MS,
			cleanupHour: 3,
			secondaryDeviceInactiveDays: 15,
			primaryDeviceInactiveDays: 30,
			lidOrphanHours: 24,
			cleanupOnStartup: false,
			autoCleanCorrupted: false
		}

		const trackTimers = () => {
			const created: Array<{ kind: 'timeout' | 'interval'; handle: NodeJS.Timeout; fn: () => unknown }> = []
			const originalTimeout = global.setTimeout
			const originalInterval = global.setInterval
			const timeoutSpy = jest.spyOn(global, 'setTimeout').mockImplementation(((fn: () => void, ms?: number) => {
				const handle = originalTimeout(fn, ms)
				created.push({ kind: 'timeout', handle, fn })
				return handle
			}) as typeof setTimeout)
			const intervalSpy = jest.spyOn(global, 'setInterval').mockImplementation(((fn: () => void, ms?: number) => {
				const handle = originalInterval(fn, ms)
				created.push({ kind: 'interval', handle, fn })
				return handle
			}) as typeof setInterval)
			return {
				created,
				restore: () => {
					timeoutSpy.mockRestore()
					intervalSpy.mockRestore()
					for (const { handle } of created) {
						clearTimeout(handle)
						clearInterval(handle)
					}
				}
			}
		}

		it('arms a single unref-ed first-run timer even if start() is called twice', () => {
			const timers = trackTimers()
			try {
				const cleanup = makeSessionCleanup(mockKeys, lidMappingStore, activityTracker, logger, config)
				cleanup.start()
				cleanup.start()
				expect(timers.created).toHaveLength(1)
				expect(timers.created[0]!.handle.hasRef()).toBe(false)
				cleanup.stop()
			} finally {
				timers.restore()
			}
		})

		it('does not arm the recurring interval when stop() runs during the first cleanup', async () => {
			const timers = trackTimers()
			try {
				let releaseFirstRun!: () => void
				// @ts-ignore
				mockKeys.get.mockImplementation(
					() =>
						new Promise(resolve => {
							releaseFirstRun = () => resolve({})
						})
				)
				mockActivityTracker.getAllActivities.mockResolvedValue(new Map())
				const cleanup = makeSessionCleanup(mockKeys, lidMappingStore, activityTracker, logger, config)
				cleanup.start()

				// Run the scheduled first cleanup now; it blocks inside runCleanup().
				const firstRun = timers.created[0]!
				clearTimeout(firstRun.handle)
				const firstRunDone = firstRun.fn()
				await new Promise(resolve => setImmediate(resolve))

				cleanup.stop()
				releaseFirstRun()
				await firstRunDone

				expect(timers.created.filter(timer => timer.kind === 'interval')).toHaveLength(0)
			} finally {
				timers.restore()
			}
		})

		it('keeps start() a no-op while the first cleanup is still running', async () => {
			const timers = trackTimers()
			try {
				let releaseFirstRun!: () => void
				// @ts-ignore
				mockKeys.get.mockImplementation(
					() =>
						new Promise(resolve => {
							releaseFirstRun = () => resolve({})
						})
				)
				mockActivityTracker.getAllActivities.mockResolvedValue(new Map())
				const cleanup = makeSessionCleanup(mockKeys, lidMappingStore, activityTracker, logger, config)
				cleanup.start()

				const firstRun = timers.created[0]!
				clearTimeout(firstRun.handle)
				const firstRunDone = firstRun.fn()
				await new Promise(resolve => setImmediate(resolve))

				cleanup.start()
				expect(timers.created).toHaveLength(1)

				releaseFirstRun()
				await firstRunDone
				const intervals = timers.created.filter(timer => timer.kind === 'interval')
				expect(intervals).toHaveLength(1)
				expect(intervals[0]!.handle.hasRef()).toBe(false)
				cleanup.stop()
			} finally {
				timers.restore()
			}
		})
	})

	describe('Configuration', () => {
		it('should respect disabled cleanup', async () => {
			const config = {
				enabled: false,
				intervalMs: 86400000,
				cleanupHour: 3,
				secondaryDeviceInactiveDays: 15,
				primaryDeviceInactiveDays: 30,
				lidOrphanHours: 24,
				cleanupOnStartup: false,
				autoCleanCorrupted: false
			}

			// @ts-ignore
			mockKeys.get.mockResolvedValue({
				'123456789_2.0': Buffer.from('session-data')
			})

			const cleanup = makeSessionCleanup(mockKeys, lidMappingStore, activityTracker, logger, config)

			const stats = await cleanup.runCleanup()

			expect(stats.totalScanned).toBe(0)
			expect(mockKeys.get).not.toHaveBeenCalled()
		})

		it('should respect custom thresholds', async () => {
			const customConfig = {
				enabled: true,
				intervalMs: 86400000,
				cleanupHour: 3,
				secondaryDeviceInactiveDays: 5, // Custom: 5 days
				primaryDeviceInactiveDays: 10, // Custom: 10 days
				lidOrphanHours: 12, // Custom: 12 hours
				cleanupOnStartup: false,
				autoCleanCorrupted: false
			}

			const now = Date.now()

			// @ts-ignore
			mockKeys.get.mockResolvedValue({
				'123456789_2.0': Buffer.from('lid-orphan'),
				'5511999999999_0.1': Buffer.from('secondary')
			})

			mockLidMapping.getPNForLID.mockResolvedValue(null)

			mockActivityTracker.getAllActivities.mockResolvedValue(
				new Map([
					['123456789@lid', now - 13 * HOUR_MS], // 13h ago
					['5511999999999:1@s.whatsapp.net', now - 6 * DAY_MS] // 6 days ago
				])
			)

			const cleanup = makeSessionCleanup(mockKeys, lidMappingStore, activityTracker, logger, customConfig)

			const stats = await cleanup.runCleanup()

			expect(stats.lidOrphansDeleted).toBe(1) // 13h > 12h threshold
			expect(stats.secondaryDevicesDeleted).toBe(1) // 6d > 5d threshold
			expect(stats.totalDeleted).toBe(2)
		})
	})
})
