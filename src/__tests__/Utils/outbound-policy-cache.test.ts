import { jest } from '@jest/globals'
import { NewChatMessageCappingStatusType } from '../../Types'
import type { NewChatMessageCapInfo, ReachoutTimelockState } from '../../Types/State'
import { describeNewChatQuota, makeOutboundPolicyCache } from '../../Utils/outbound-policy-cache'

const capped: NewChatMessageCapInfo = {
	capping_status: NewChatMessageCappingStatusType.CAPPED,
	total_quota: 20,
	used_quota: 20,
	cycle_start_timestamp: '1790000000',
	cycle_end_timestamp: '1790604800'
}

const setup = () => {
	let clock = 1_000_000
	const fetchReachout = jest.fn(async (): Promise<ReachoutTimelockState | undefined> => ({ isActive: false }))
	const fetchCapping = jest.fn(async (): Promise<NewChatMessageCapInfo | undefined> => capped)
	const logger = { warn: jest.fn() }
	const cache = makeOutboundPolicyCache({
		fetchReachout,
		fetchCapping,
		logger,
		now: () => clock,
		refreshMs: 3_600_000,
		retryMs: 60_000
	})
	return { cache, fetchReachout, fetchCapping, logger, advance: (ms: number) => (clock += ms) }
}

describe('outbound policy cache', () => {
	it('asks the server once and serves later sends from memory until the state is an hour old', async () => {
		const { cache, fetchReachout, fetchCapping, advance } = setup()

		await Promise.all([cache.get(), cache.get(), cache.get()])
		await cache.get()
		expect(fetchReachout).toHaveBeenCalledTimes(1)
		expect(fetchCapping).toHaveBeenCalledTimes(1)

		advance(3_599_999)
		await cache.get()
		expect(fetchCapping).toHaveBeenCalledTimes(1)

		advance(1)
		await cache.get()
		expect(fetchCapping).toHaveBeenCalledTimes(2)
	})

	it('takes server pushes as fresh state without a lookup', async () => {
		const { cache, fetchReachout, fetchCapping } = setup()
		const until = new Date(Date.now() + 6 * 3_600_000)
		cache.setReachout({ isActive: true, timeEnforcementEnds: until })
		cache.setCapping(capped)

		await expect(cache.get()).resolves.toEqual({
			reachout: { isActive: true, timeEnforcementEnds: until },
			capping: capped
		})
		expect(fetchReachout).not.toHaveBeenCalled()
		expect(fetchCapping).not.toHaveBeenCalled()
	})

	it('keeps the last state when a lookup fails and retries only after a minute', async () => {
		const { cache, fetchCapping, logger, advance } = setup()
		await cache.get()
		advance(3_600_000)
		fetchCapping.mockRejectedValueOnce(new Error('timeout'))

		await expect(cache.get()).resolves.toMatchObject({ capping: capped })
		expect(logger.warn).toHaveBeenCalled()
		await cache.get()
		expect(fetchCapping).toHaveBeenCalledTimes(2)

		advance(60_000)
		await cache.get()
		expect(fetchCapping).toHaveBeenCalledTimes(3)
	})

	it('refetches on demand', async () => {
		const { cache, fetchCapping } = setup()
		await cache.get()
		await cache.get({ force: true })
		expect(fetchCapping).toHaveBeenCalledTimes(2)
	})
})

describe('describeNewChatQuota', () => {
	it('reports the server quota, what is left and when the cycle ends', () => {
		expect(describeNewChatQuota({ ...capped, used_quota: 7 })).toEqual({
			status: NewChatMessageCappingStatusType.CAPPED,
			total: 20,
			used: 7,
			remaining: 13,
			cycleStart: 1_790_000_000_000,
			cycleEnd: 1_790_604_800_000,
			oneTimeException: undefined,
			metaVerified: undefined
		})
		expect(describeNewChatQuota(undefined)).toBeUndefined()
	})
})
