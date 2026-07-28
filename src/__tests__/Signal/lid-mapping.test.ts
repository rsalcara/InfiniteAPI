import { jest } from '@jest/globals'
import P from 'pino'
import { LIDMappingStore } from '../../Signal/lid-mapping'
import type { LIDMapping, SignalDataTypeMap, SignalKeyStoreWithTransaction } from '../../Types'

const HOSTED_DEVICE_ID = 99

const mockKeys: jest.Mocked<SignalKeyStoreWithTransaction> = {
	get: jest.fn<SignalKeyStoreWithTransaction['get']>() as any,
	set: jest.fn<SignalKeyStoreWithTransaction['set']>(),
	transaction: jest.fn<SignalKeyStoreWithTransaction['transaction']>(async (work: () => any) => await work()) as any,
	isInTransaction: jest.fn<SignalKeyStoreWithTransaction['isInTransaction']>()
}
const logger = P({ level: 'silent' })

describe('LIDMappingStore', () => {
	const mockPnToLIDFunc = jest.fn<(jids: string[]) => Promise<LIDMapping[] | undefined>>()
	let lidMappingStore: LIDMappingStore

	beforeEach(() => {
		jest.clearAllMocks()
		lidMappingStore = new LIDMappingStore(mockKeys, logger, mockPnToLIDFunc)
	})

	describe('getPNForLID', () => {
		it('should correctly map a standard LID with a hosted device ID back to a standard PN with a hosted device', async () => {
			const lidWithHostedDevice = `12345:${HOSTED_DEVICE_ID}@lid`
			const pnUser = '54321'

			// @ts-ignore
			mockKeys.get.mockResolvedValue({ [`12345_reverse`]: pnUser } as SignalDataTypeMap['lid-mapping'])

			const result = await lidMappingStore.getPNForLID(lidWithHostedDevice)
			expect(result).toBe(`${pnUser}:${HOSTED_DEVICE_ID}@s.whatsapp.net`)
		})

		it('should return null if no reverse mapping is found', async () => {
			const lid = 'nonexistent@lid'

			// @ts-ignore
			mockKeys.get.mockResolvedValue({} as SignalDataTypeMap['lid-mapping']) // Simulate not found in DB

			const result = await lidMappingStore.getPNForLID(lid)
			expect(result).toBeNull()
		})
	})

	describe('getLIDsForPNs', () => {
		it('should resolve multiple PNs in a single batch', async () => {
			const pnOne = '11111@s.whatsapp.net'
			const pnTwo = '22222:5@s.whatsapp.net'

			// @ts-ignore
			mockKeys.get.mockResolvedValue({ '11111': 'aaaaa', '22222': 'bbbbb' } as SignalDataTypeMap['lid-mapping'])

			const result = await lidMappingStore.getLIDsForPNs([pnOne, pnTwo])

			expect(result).toEqual(
				expect.arrayContaining([
					{ pn: pnOne, lid: 'aaaaa@lid' },
					{ pn: pnTwo, lid: 'bbbbb:5@lid' }
				])
			)
		})
	})

	describe('getPNsForLIDs', () => {
		it('should resolve multiple LIDs in a single batch', async () => {
			const lidOne = '33333@lid'
			const lidTwo = '44444:99@hosted.lid'

			// @ts-ignore
			mockKeys.get.mockResolvedValue({
				'33333_reverse': '77777',
				'44444_reverse': '88888'
			} as SignalDataTypeMap['lid-mapping'])

			const result = await lidMappingStore.getPNsForLIDs([lidOne, lidTwo])

			expect(result).toEqual(
				expect.arrayContaining([
					{ lid: lidOne, pn: '77777@s.whatsapp.net' },
					{ lid: lidTwo, pn: '88888:99@hosted' }
				])
			)
		})
	})

	describe('bounded mapping writer', () => {
		it('persists one lid-mapping bucket per batch and updates cache only after commit', async () => {
			mockKeys.get.mockResolvedValue({} as never)
			const result = await lidMappingStore.storeLIDPNMappings([
				{ pn: '11111@s.whatsapp.net', lid: 'aaaaa@lid' },
				{ pn: '22222@s.whatsapp.net', lid: 'bbbbb@lid' }
			])

			expect(result).toEqual({ stored: 2, skipped: 0, errors: 0 })
			expect(mockKeys.set).toHaveBeenCalledTimes(1)
			expect(mockKeys.set).toHaveBeenCalledWith({
				'lid-mapping': {
					'11111': 'aaaaa',
					aaaaa_reverse: '11111',
					'22222': 'bbbbb',
					bbbbb_reverse: '22222'
				}
			})
			await expect(lidMappingStore.getKnownLIDForPN('11111@s.whatsapp.net')).resolves.toBe('aaaaa@lid')
		})

		it('does not publish a failed batch into cache', async () => {
			lidMappingStore = new LIDMappingStore(mockKeys, logger, mockPnToLIDFunc, { retryAttempts: 1 })
			mockKeys.get.mockResolvedValue({} as never)
			;(mockKeys.set as any).mockRejectedValueOnce(new Error('disk full'))

			await expect(
				lidMappingStore.storeLIDPNMappings([{ pn: '11111@s.whatsapp.net', lid: 'aaaaa@lid' }])
			).resolves.toEqual({ stored: 0, skipped: 0, errors: 1 })

			mockKeys.get.mockResolvedValue({} as never)
			await expect(lidMappingStore.getKnownLIDForPN('11111@s.whatsapp.net')).resolves.toBeNull()
		})

		it('applies backpressure and resumes a burst when writer capacity returns', async () => {
			let release!: () => void
			const blocked = new Promise<void>(resolve => {
				release = resolve
			})
			lidMappingStore = new LIDMappingStore(mockKeys, logger, mockPnToLIDFunc, {
				batchSize: 100,
				maxPendingMappings: 100,
				retryAttempts: 1
			})
			mockKeys.get.mockResolvedValue({} as never)
			mockKeys.transaction.mockImplementationOnce(async <T>(work: () => Promise<T>): Promise<T> => {
				await blocked
				return work()
			})

			const admittedPairs = Array.from({ length: 100 }, (_, index) => ({
				pn: `${10_000 + index}@s.whatsapp.net`,
				lid: `${20_000 + index}@lid`
			}))
			const admitted = lidMappingStore.storeLIDPNMappings(admittedPairs)
			await Promise.resolve()

			let waitingSettled = false
			const waiting = lidMappingStore.storeLIDPNMappings([{ pn: '99999@s.whatsapp.net', lid: '88888@lid' }])
			void waiting.then(() => {
				waitingSettled = true
			})
			await new Promise(resolve => setImmediate(resolve))

			expect(waitingSettled).toBe(false)
			expect(lidMappingStore.getStatistics().rejectedWrites).toBe(1)

			release()
			await admitted
			await expect(waiting).resolves.toEqual({ stored: 1, skipped: 0, errors: 0 })
		})

		it('chunks an oversized history batch instead of dropping all mappings', async () => {
			lidMappingStore = new LIDMappingStore(mockKeys, logger, mockPnToLIDFunc, {
				batchSize: 100,
				maxPendingMappings: 100
			})
			mockKeys.get.mockResolvedValue({} as never)
			const pairs = Array.from({ length: 250 }, (_, index) => ({
				pn: `${100_000 + index}@s.whatsapp.net`,
				lid: `${200_000 + index}@lid`
			}))

			await expect(lidMappingStore.storeLIDPNMappings(pairs)).resolves.toEqual({
				stored: 250,
				skipped: 0,
				errors: 0
			})
			expect(mockKeys.set).toHaveBeenCalledTimes(3)
		})

		it('normalizes non-finite pending-writer overrides', () => {
			lidMappingStore = new LIDMappingStore(mockKeys, logger, mockPnToLIDFunc, {
				maxPendingMappings: Number.POSITIVE_INFINITY
			})

			expect(lidMappingStore.getConfig().maxPendingMappings).toBe(5_000)
		})

		it('deduplicates conflicting mappings with the last pair winning', async () => {
			mockKeys.get.mockResolvedValue({} as never)
			const result = await lidMappingStore.storeLIDPNMappings([
				{ pn: '11111@s.whatsapp.net', lid: 'aaaaa@lid' },
				{ pn: '11111@s.whatsapp.net', lid: 'bbbbb@lid' },
				{ pn: '22222@s.whatsapp.net', lid: 'bbbbb@lid' }
			])

			expect(result.skipped).toBe(2)
			expect(mockKeys.set).toHaveBeenCalledWith({
				'lid-mapping': {
					'22222': 'bbbbb',
					bbbbb_reverse: '22222'
				}
			})
		})

		it('filters malformed mappings before deduplication', async () => {
			mockKeys.get.mockResolvedValue({} as never)
			const result = await lidMappingStore.storeLIDPNMappings([
				{ pn: '11111@s.whatsapp.net', lid: 'aaaaa@lid' },
				{ pn: '11111@s.whatsapp.net', lid: 'not-a-lid@s.whatsapp.net' }
			])

			expect(result).toEqual({ stored: 1, skipped: 1, errors: 0 })
			expect(mockKeys.set).toHaveBeenCalledWith({
				'lid-mapping': {
					'11111': 'aaaaa',
					aaaaa_reverse: '11111'
				}
			})
		})
	})

	// ========================================================================
	// M3: REQUEST COALESCING TESTS
	// ========================================================================

	describe('Request Coalescing (M3)', () => {
		it('should deduplicate concurrent getLIDForPN calls for same PN', async () => {
			const pn = '12345@s.whatsapp.net'
			const lidUser = 'aaaaa'

			// @ts-ignore - Mock DB lookup to return mapping
			mockKeys.get.mockResolvedValue({ '12345': lidUser } as SignalDataTypeMap['lid-mapping'])

			// Make 10 concurrent calls for the same PN
			const promises = Array(10)
				.fill(null)
				.map(() => lidMappingStore.getLIDForPN(pn))

			// All should resolve to same result
			const results = await Promise.all(promises)
			expect(results.every(r => r === `${lidUser}@lid`)).toBe(true)

			// But DB should only be queried ONCE (not 10 times)
			// The batch method getLIDsForPNs calls keys.get once
			expect(mockKeys.get).toHaveBeenCalledTimes(1)
		})

		it('should deduplicate concurrent getPNForLID calls for same LID', async () => {
			const lid = '54321@lid'
			const pnUser = 'bbbbb'

			// @ts-ignore - Mock DB lookup to return reverse mapping
			mockKeys.get.mockResolvedValue({ '54321_reverse': pnUser } as SignalDataTypeMap['lid-mapping'])

			// Make 10 concurrent calls for the same LID
			const promises = Array(10)
				.fill(null)
				.map(() => lidMappingStore.getPNForLID(lid))

			// All should resolve to same result
			const results = await Promise.all(promises)
			expect(results.every(r => r === `${pnUser}@s.whatsapp.net`)).toBe(true)

			// But DB should only be queried ONCE (not 10 times)
			expect(mockKeys.get).toHaveBeenCalledTimes(1)
		})

		it('should NOT coalesce calls for different PNs', async () => {
			const pn1 = '11111@s.whatsapp.net'
			const pn2 = '22222@s.whatsapp.net'

			// @ts-ignore - Mock to return different mappings
			mockKeys.get.mockResolvedValue({ '11111': 'aaaaa', '22222': 'bbbbb' } as SignalDataTypeMap['lid-mapping'])

			// Concurrent calls for DIFFERENT PNs
			const [result1, result2] = await Promise.all([lidMappingStore.getLIDForPN(pn1), lidMappingStore.getLIDForPN(pn2)])

			expect(result1).toBe('aaaaa@lid')
			expect(result2).toBe('bbbbb@lid')

			// Should make 2 separate DB calls (no coalescing)
			expect(mockKeys.get).toHaveBeenCalledTimes(2)
		})
	})

	// ========================================================================
	// V4: DESTROYED FLAG & OPERATION COUNTER TESTS
	// ========================================================================

	describe('Destroyed Flag Protection (V4, M2)', () => {
		it('should reject operations after destroy()', async () => {
			lidMappingStore.destroy()

			// All operations should throw after destroy
			await expect(lidMappingStore.getLIDForPN('12345@s.whatsapp.net')).rejects.toThrow(
				'LIDMappingStore has been destroyed'
			)

			await expect(lidMappingStore.getPNForLID('54321@lid')).rejects.toThrow('LIDMappingStore has been destroyed')

			await expect(lidMappingStore.storeLIDPNMappings([{ lid: 'a@lid', pn: 'b@s.whatsapp.net' }])).rejects.toThrow(
				'LIDMappingStore has been destroyed'
			)
		})

		it('should allow destroy() to be called multiple times safely', () => {
			// First destroy
			lidMappingStore.destroy()

			// Second destroy should not throw (reentrancy guard)
			expect(() => lidMappingStore.destroy()).not.toThrow()

			// Third destroy should also be safe
			expect(() => lidMappingStore.destroy()).not.toThrow()
		})

		it('should drain active operations before destroy resolves', async () => {
			const pn = '12345@s.whatsapp.net'

			// Mock slow DB operation (simulates long-running operation)
			let operationStarted = false
			let operationCompleted = false

			// @ts-ignore
			mockKeys.get.mockImplementation(async () => {
				operationStarted = true
				await new Promise(resolve => setTimeout(resolve, 100)) // 100ms delay
				operationCompleted = true
				return { '12345': 'aaaaa' } as unknown as SignalDataTypeMap['lid-mapping']
			})

			// Start operation
			const operationPromise = lidMappingStore.getLIDForPN(pn)

			// Wait a bit to ensure operation has started
			await new Promise(resolve => setTimeout(resolve, 10))
			expect(operationStarted).toBe(true)
			expect(operationCompleted).toBe(false)

			// Call destroy while operation is in progress. It must reject new
			// work immediately but not resolve until the active operation ends.
			let destroyResolved = false
			const destroyPromise = lidMappingStore.destroy().then(drained => {
				expect(drained).toBe(true)
				destroyResolved = true
			})
			await new Promise(resolve => setTimeout(resolve, 10))
			expect(destroyResolved).toBe(false)

			// Operation should still complete successfully (graceful degradation)
			const result = await operationPromise
			expect(result).toBe('aaaaa@lid')
			expect(operationCompleted).toBe(true)
			await destroyPromise
			expect(destroyResolved).toBe(true)

			// But new operations should be rejected
			await expect(lidMappingStore.getLIDForPN(pn)).rejects.toThrow('LIDMappingStore has been destroyed')
		})

		it('should bound socket shutdown while keeping cleanup deferred until an active operation drains', async () => {
			jest.useFakeTimers()
			let releaseOperation!: () => void
			const operationBlocked = new Promise<void>(resolve => {
				releaseOperation = resolve
			})

			// @ts-ignore
			mockKeys.get.mockImplementation(async () => {
				await operationBlocked
				return { '12345': 'aaaaa' } as unknown as SignalDataTypeMap['lid-mapping']
			})

			const operationPromise = lidMappingStore.getLIDForPN('12345@s.whatsapp.net')
			await Promise.resolve()

			const destroyPromise = lidMappingStore.destroy()
			await jest.advanceTimersByTimeAsync(5_000)
			await expect(destroyPromise).resolves.toBe(false)

			let fullyDrained = false
			const waitForDestroy = lidMappingStore.waitForDestroy().then(() => {
				fullyDrained = true
			})
			await Promise.resolve()
			expect(fullyDrained).toBe(false)

			releaseOperation()
			await operationPromise
			await expect(waitForDestroy).resolves.toBeUndefined()
			expect(fullyDrained).toBe(true)
			jest.useRealTimers()
		})
	})

	// ========================================================================
	// CACHE & OPTIMIZATION TESTS
	// ========================================================================

	describe('Cache Behavior', () => {
		it('should use cache for subsequent lookups (no DB hit)', async () => {
			const pn = '12345@s.whatsapp.net'
			const lidUser = 'aaaaa'

			// @ts-ignore - First lookup hits DB
			mockKeys.get.mockResolvedValue({ '12345': lidUser } as SignalDataTypeMap['lid-mapping'])

			// First lookup - cache miss, DB hit
			const result1 = await lidMappingStore.getLIDForPN(pn)
			expect(result1).toBe(`${lidUser}@lid`)
			expect(mockKeys.get).toHaveBeenCalledTimes(1)

			// Second lookup - cache hit, no DB call
			const result2 = await lidMappingStore.getLIDForPN(pn)
			expect(result2).toBe(`${lidUser}@lid`)

			// DB should still only have been called once (cache hit)
			expect(mockKeys.get).toHaveBeenCalledTimes(1)
		})

		it('should clear cache on destroy()', async () => {
			const pn = '12345@s.whatsapp.net'

			// @ts-ignore
			mockKeys.get.mockResolvedValue({ '12345': 'aaaaa' } as SignalDataTypeMap['lid-mapping'])

			// Populate cache
			await lidMappingStore.getLIDForPN(pn)

			// Destroy should clear cache
			lidMappingStore.destroy()

			// Create new store
			const newStore = new LIDMappingStore(mockKeys, logger, mockPnToLIDFunc)

			// New lookup should hit DB again (cache was cleared)
			jest.clearAllMocks() // Reset call count
			await newStore.getLIDForPN(pn)
			expect(mockKeys.get).toHaveBeenCalledTimes(1)
		})
	})

	// ========================================================================
	// EDGE CASES & ERROR HANDLING
	// ========================================================================

	describe('Edge Cases', () => {
		it('should handle invalid JIDs gracefully', async () => {
			const result1 = await lidMappingStore.getLIDForPN('invalid')
			expect(result1).toBeNull()

			const result2 = await lidMappingStore.getPNForLID('invalid')
			expect(result2).toBeNull()
		})

		it('should handle empty results from DB', async () => {
			// @ts-ignore
			mockKeys.get.mockResolvedValue({} as SignalDataTypeMap['lid-mapping'])

			const result = await lidMappingStore.getLIDForPN('12345@s.whatsapp.net')
			expect(result).toBeNull()
		})

		it('should handle batch operations with mixed valid/invalid JIDs', async () => {
			// @ts-ignore
			mockKeys.get.mockResolvedValue({ '12345': 'aaaaa' } as SignalDataTypeMap['lid-mapping'])

			const result = await lidMappingStore.getLIDsForPNs([
				'12345@s.whatsapp.net', // Valid
				'invalid', // Invalid
				'67890@s.whatsapp.net' // Valid but not in DB
			])

			// Should only return valid results
			expect(result).toEqual([{ pn: '12345@s.whatsapp.net', lid: 'aaaaa@lid' }])
		})
	})
})
