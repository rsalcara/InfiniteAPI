import { Boom } from '@hapi/boom'
import { jest } from '@jest/globals'
import {
	DisconnectReason,
	type SignalDataSet,
	type SignalDataTypeMap,
	type SignalKeyStoreWithTransaction
} from '../../Types'
import { TcTokenLifecycleService } from '../../Utils/tc-token-lifecycle'

type AnyRecord = SignalDataTypeMap[keyof SignalDataTypeMap]

const makeStore = (includeList = true) => {
	const values = new Map<string, AnyRecord>()
	const key = (type: keyof SignalDataTypeMap, id: string) => `${type}:${id}`
	const store = {
		get: jest.fn(async (type: keyof SignalDataTypeMap, ids: string[]) =>
			Object.fromEntries(ids.flatMap(id => (values.has(key(type, id)) ? [[id, values.get(key(type, id))]] : [])))
		),
		set: jest.fn(async (data: SignalDataSet) => {
			for (const [rawType, bucket] of Object.entries(data)) {
				const type = rawType as keyof SignalDataTypeMap
				for (const [id, value] of Object.entries(bucket ?? {})) {
					if (value === null || value === undefined) values.delete(key(type, id))
					else values.set(key(type, id), value as AnyRecord)
				}
			}
		}),
		list: includeList
			? async function* (type: keyof SignalDataTypeMap) {
					const prefix = `${type}:`
					for (const [recordKey, value] of values) {
						if (recordKey.startsWith(prefix)) yield [recordKey.slice(prefix.length), value] as const
					}
				}
			: undefined,
		transaction: jest.fn(async (work: () => Promise<unknown>) => work()),
		transactWith: jest.fn(async (_scope: unknown, work: () => Promise<unknown>) => work()),
		isInTransaction: jest.fn(() => false)
	} as unknown as SignalKeyStoreWithTransaction
	return { store, values, key }
}

const jid = '5511999999999@s.whatsapp.net'
const resultNode = { tag: 'iq', attrs: { type: 'result' } }
const resolvers = { getLIDForPN: async () => null, getPNForLID: async () => null }
const tick = () => new Promise(resolve => setImmediate(resolve))

describe('TcTokenLifecycleService', () => {
	it('runs newly queued jobs when the custom key store cannot enumerate records', async () => {
		const { store, values, key } = makeStore(false)
		const send = jest.fn(async () => resultNode)
		const service = new TcTokenLifecycleService({ keys: store, resolvers, send, now: () => 900_000 })

		await expect(service.issue([jid], 900)).resolves.toEqual(resultNode)
		expect(send).toHaveBeenCalledTimes(1)
		expect(values.has(key('tctoken-job', jid))).toBe(false)
		await service.stop()
	})

	it('persists a job before sending and confirms it after the ACK', async () => {
		const { store, values, key } = makeStore()
		const send = jest.fn(async () => resultNode)
		const service = new TcTokenLifecycleService({ keys: store, resolvers, send, now: () => 1_000_000 })

		await service.enqueue([jid], 1_000)
		expect(values.get(key('tctoken-job', jid))).toEqual(expect.objectContaining({ state: 'pending' }))
		expect(values.get(key('tctoken', jid))).toEqual(
			expect.objectContaining({ senderTimestamp: 1_000, realIssueTimestamp: 0 })
		)

		await service.runDueJobs()
		expect(send).toHaveBeenCalledTimes(1)
		expect(values.has(key('tctoken-job', jid))).toBe(false)
		expect(values.get(key('tctoken', jid))).toEqual(
			expect.objectContaining({ senderTimestamp: 1_000, realIssueTimestamp: null })
		)
		await service.stop()
	})

	it('does not retry a terminal 4xx within the same bucket', async () => {
		const { store, values, key } = makeStore()
		let now = 2_000_000
		const send = jest.fn(async () => {
			throw new Boom('bad request', { statusCode: 400 })
		})
		const service = new TcTokenLifecycleService({ keys: store, resolvers, send, now: () => now })

		await service.enqueue([jid], 2_000)
		await service.runDueJobs()
		expect(values.get(key('tctoken-job', jid))).toEqual(expect.objectContaining({ state: 'terminal', lastStatus: 400 }))
		await expect(service.issue([jid], 2_000, 10)).rejects.toMatchObject({
			isBoom: true,
			output: expect.objectContaining({ statusCode: 400 })
		})
		now += 24 * 60 * 60_000
		await service.runDueJobs()
		expect(send).toHaveBeenCalledTimes(1)
		await service.stop()
	})

	it.each([DisconnectReason.timedOut, DisconnectReason.connectionClosed])(
		'treats disconnect status %s as transient instead of suppressing the bucket',
		async status => {
			const { store, values, key } = makeStore()
			const service = new TcTokenLifecycleService({
				keys: store,
				resolvers,
				send: async () => {
					throw new Boom('transient disconnect', { statusCode: status })
				},
				now: () => 2_500_000,
				random: () => 0.5
			})

			await service.enqueue([jid], 2_500)
			await service.runDueJobs()
			expect(values.get(key('tctoken-job', jid))).toEqual(
				expect.objectContaining({ state: 'retry', lastStatus: status, attemptCount: 1 })
			)
			await service.stop()
		}
	)

	it('retries a 5xx job after backoff and recovers it after restart', async () => {
		const { store, values, key } = makeStore()
		let now = 3_000_000
		const failing = new TcTokenLifecycleService({
			keys: store,
			resolvers,
			send: async () => {
				throw new Boom('server unavailable', { statusCode: 503 })
			},
			now: () => now,
			random: () => 0.5
		})

		await failing.enqueue([jid], 3_000)
		await failing.runDueJobs()
		const retryJob = values.get(key('tctoken-job', jid)) as SignalDataTypeMap['tctoken-job']
		expect(retryJob).toEqual(expect.objectContaining({ state: 'retry', lastStatus: 503, attemptCount: 1 }))
		await failing.stop()

		now = retryJob.nextRetryAt
		const send = jest.fn(async () => resultNode)
		const recovered = new TcTokenLifecycleService({ keys: store, resolvers, send, now: () => now })
		await recovered.runDueJobs()
		expect(send).toHaveBeenCalledTimes(1)
		expect(values.has(key('tctoken-job', jid))).toBe(false)
		await recovered.stop()
	})

	it('keeps retrying 5xx beyond an arbitrary attempt cap', async () => {
		jest.useFakeTimers()
		const { store, values, key } = makeStore()
		let now = 3_250_000
		const send = jest.fn(async () => {
			throw new Boom('server unavailable', { statusCode: 503 })
		})
		const service = new TcTokenLifecycleService({
			keys: store,
			resolvers,
			send,
			now: () => now,
			random: () => 0.5
		})

		try {
			await service.enqueue([jid], 3_250)
			for (let attempt = 1; attempt <= 7; attempt++) {
				await service.runDueJobs()
				const job = values.get(key('tctoken-job', jid)) as SignalDataTypeMap['tctoken-job']
				expect(job).toEqual(expect.objectContaining({ state: 'retry', attemptCount: attempt, lastStatus: 503 }))
				now = job.nextRetryAt
			}

			expect(send).toHaveBeenCalledTimes(7)
		} finally {
			await service.stop()
			jest.useRealTimers()
		}
	})

	it('never overlaps attempts for the same durable job while its IQ is unresolved', async () => {
		jest.useFakeTimers()
		const { store } = makeStore()
		let now = 3_400_000
		let resolveSend!: (value: typeof resultNode) => void
		const send = jest.fn(
			() =>
				new Promise<typeof resultNode>(resolve => {
					resolveSend = resolve
				})
		)
		const service = new TcTokenLifecycleService({
			keys: store,
			resolvers,
			send,
			now: () => now,
			leaseMs: 35_000
		})

		try {
			await service.enqueue([jid], 3_400)
			const firstRun = service.runDueJobs()
			for (let attempt = 0; attempt < 10 && send.mock.calls.length === 0; attempt++) await Promise.resolve()
			expect(send).toHaveBeenCalledTimes(1)

			now += 35_001
			await service.runDueJobs()
			expect(send).toHaveBeenCalledTimes(1)

			resolveSend(resultNode)
			await firstRun
		} finally {
			await service.stop()
			jest.useRealTimers()
		}
	})

	it('bounds issue callers without discarding the durable job', async () => {
		const { store, values, key } = makeStore()
		let resolveSend!: (value: typeof resultNode) => void
		const send = jest.fn(
			() =>
				new Promise<typeof resultNode>(resolve => {
					resolveSend = resolve
				})
		)
		const service = new TcTokenLifecycleService({ keys: store, resolvers, send, now: () => 3_500_000 })

		await service.enqueue([jid], 3_500)
		const running = service.runDueJobs()
		while (send.mock.calls.length === 0) await tick()
		await expect(service.issue([jid], 3_500, 10)).rejects.toMatchObject({
			isBoom: true,
			output: expect.objectContaining({ statusCode: 408 }),
			data: expect.objectContaining({
				reason: 'caller-timeout-job-retained',
				action: 'caller-timeout-job-retained'
			})
		})
		expect(values.get(key('tctoken-job', jid))).toEqual(expect.objectContaining({ state: 'in_flight' }))
		await service.stop()
		resolveSend(resultNode)
		await running
	})

	it('does not let a late ACK remove or confirm a newer job', async () => {
		const { store, values, key } = makeStore()
		let resolveSend!: (value: typeof resultNode) => void
		const send = jest.fn(
			() =>
				new Promise<typeof resultNode>(resolve => {
					resolveSend = resolve
				})
		)
		const service = new TcTokenLifecycleService({ keys: store, resolvers, send, now: () => 4_000_000 })
		await service.enqueue([jid], 4_000)
		const running = service.runDueJobs()
		while (send.mock.calls.length === 0) await tick()

		const newerJob = {
			...(values.get(key('tctoken-job', jid)) as SignalDataTypeMap['tctoken-job']),
			issueTimestamp: 4_001,
			state: 'pending' as const
		}
		await store.set({
			tctoken: { [jid]: { token: Buffer.alloc(0), senderTimestamp: 4_001, realIssueTimestamp: 0 } },
			'tctoken-job': { [jid]: newerJob }
		})
		resolveSend(resultNode)
		await running

		expect(values.get(key('tctoken-job', jid))).toEqual(expect.objectContaining({ issueTimestamp: 4_001 }))
		expect(values.get(key('tctoken', jid))).toEqual(
			expect.objectContaining({ senderTimestamp: 4_001, realIssueTimestamp: 0 })
		)
		await service.stop()
	})

	it('checkpoints an in-flight IQ on teardown and ignores its later result', async () => {
		const { store, values, key } = makeStore()
		let resolveSend!: (value: typeof resultNode) => void
		const send = jest.fn(
			() =>
				new Promise<typeof resultNode>(resolve => {
					resolveSend = resolve
				})
		)
		const service = new TcTokenLifecycleService({ keys: store, resolvers, send, now: () => 5_000_000 })
		await service.enqueue([jid], 5_000)
		const running = service.runDueJobs()
		while (send.mock.calls.length === 0) await tick()

		await service.stop()
		expect(values.get(key('tctoken-job', jid))).toEqual(
			expect.objectContaining({ state: 'retry', nextRetryAt: 5_000_000, leaseUntil: 0 })
		)
		resolveSend(resultNode)
		await running
		expect(values.get(key('tctoken', jid))).toEqual(
			expect.objectContaining({ senderTimestamp: 5_000, realIssueTimestamp: 0 })
		)
	})
})
