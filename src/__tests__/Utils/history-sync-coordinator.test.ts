import { jest } from '@jest/globals'
import { mkdtemp, rm } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { proto } from '../../../WAProto/index.js'
import type { StoredHistorySyncJob } from '../../Types'
import {
	AdaptiveHistoryBatchController,
	DurableHistorySyncCoordinator,
	markHistorySyncCheckpointComplete,
	type ProcessedHistorySync
} from '../../Utils/history-sync-coordinator'
import { FileHistorySyncStore } from '../../Utils/history-sync-store'

const emptyResult = (): ProcessedHistorySync => ({
	chats: [],
	contacts: [],
	messages: [],
	lidPnMappings: [],
	pastParticipants: [],
	syncType: proto.HistorySync.HistorySyncType.RECENT,
	progress: 100
})

const notification = (overrides: proto.Message.IHistorySyncNotification = {}) =>
	proto.Message.HistorySyncNotification.create({
		syncType: proto.HistorySync.HistorySyncType.RECENT,
		chunkOrder: 1,
		progress: 100,
		mediaKey: Buffer.alloc(32, 7),
		...overrides
	})

const waitFor = async (predicate: () => Promise<boolean>, timeoutMs = 2_000): Promise<void> => {
	const deadline = Date.now() + timeoutMs
	while (!(await predicate())) {
		if (Date.now() >= deadline) throw new Error('condition was not reached before timeout')
		await new Promise(resolve => setTimeout(resolve, 5))
	}
}

describe('DurableHistorySyncCoordinator', () => {
	let dir: string
	let store: FileHistorySyncStore

	beforeEach(async () => {
		dir = await mkdtemp(join(tmpdir(), 'history-sync-coordinator-'))
		store = new FileHistorySyncStore(join(dir, 'queue.json'))
	})

	afterEach(async () => {
		await rm(dir, { recursive: true, force: true })
	})

	it('admits durably without waiting for the download or blocking live work', async () => {
		let releaseDownload!: (value: ProcessedHistorySync) => void
		const download = jest.fn(
			() =>
				new Promise<ProcessedHistorySync>(resolve => {
					releaseDownload = resolve
				})
		)
		const apply = jest.fn(async () => undefined)
		const coordinator = new DurableHistorySyncCoordinator({
			store,
			requestOptions: {},
			download,
			apply,
			requestReupload: async () => undefined
		})

		await coordinator.enqueue(
			{ id: 'LIVE-NONBLOCK', remoteJid: '5511@s.whatsapp.net', fromMe: true },
			1,
			notification()
		)
		expect(apply).not.toHaveBeenCalled()
		expect(['received', 'downloading']).toContain((await store.get('LIVE-NONBLOCK'))?.state)

		await waitFor(async () => download.mock.calls.length === 1)
		releaseDownload(emptyResult())
		await waitFor(async () => (await store.get('LIVE-NONBLOCK'))?.state === 'committed')
		expect(apply).toHaveBeenCalledTimes(1)
		await coordinator.stop()
	})

	it('does not spin while a received phase is waiting for its protocol predecessor', async () => {
		const claimNext = jest.spyOn(store, 'claimNext')
		const coordinator = new DurableHistorySyncCoordinator({
			store,
			requestOptions: {},
			download: async () => emptyResult(),
			apply: async () => undefined,
			requestReupload: async () => undefined,
			initialHistorySyncComplete: false,
			recentHistorySyncComplete: false
		})

		await coordinator.enqueue(
			{ id: 'WAITING-RECENT', remoteJid: '5511@s.whatsapp.net', fromMe: true },
			1,
			notification({ chunkOrder: 1 })
		)
		await waitFor(async () => claimNext.mock.calls.length > 0)
		await new Promise(resolve => setTimeout(resolve, 30))
		expect(claimNext).toHaveBeenCalledTimes(1)
		expect(await store.get('WAITING-RECENT')).toMatchObject({ state: 'received' })
		await coordinator.stop()
	})

	it('does not lose an enqueue that arrives while a worker turn is finishing', async () => {
		let releaseList!: () => void
		let markListEntered!: () => void
		const listEntered = new Promise<void>(resolve => {
			markListEntered = resolve
		})
		const originalList = store.list.bind(store)
		jest.spyOn(store, 'list').mockImplementationOnce(async () => {
			markListEntered()
			await new Promise<void>(resolve => {
				releaseList = resolve
			})
			return originalList()
		})
		const coordinator = new DurableHistorySyncCoordinator({
			store,
			requestOptions: {},
			download: async () => emptyResult(),
			apply: async () => undefined,
			requestReupload: async () => undefined,
			initialHistorySyncComplete: false,
			recentHistorySyncComplete: false
		})

		await coordinator.enqueue(
			{ id: 'RACE-RECENT', remoteJid: '5511@s.whatsapp.net', fromMe: true },
			1,
			notification({ chunkOrder: 1 })
		)
		await listEntered
		await coordinator.enqueue(
			{ id: 'RACE-INITIAL', remoteJid: '5511@s.whatsapp.net', fromMe: true },
			1,
			notification({
				syncType: proto.HistorySync.HistorySyncType.INITIAL_BOOTSTRAP,
				chunkOrder: 0,
				progress: 100
			})
		)
		releaseList()

		await waitFor(async () => (await store.get('RACE-INITIAL'))?.state === 'committed')
		await waitFor(async () => (await store.get('RACE-RECENT'))?.state === 'committed')
		await coordinator.stop()
	})

	it('keeps corrupt downloads for official peer reupload instead of dropping the row', async () => {
		const requested: StoredHistorySyncJob[] = []
		const coordinator = new DurableHistorySyncCoordinator({
			store,
			requestOptions: {},
			download: async () => {
				throw new Error('inflate checksum corrupt')
			},
			apply: async () => undefined,
			requestReupload: async job => {
				requested.push(job)
			}
		})

		await coordinator.enqueue({ id: 'REUPLOAD-1', remoteJid: '5511@s.whatsapp.net', fromMe: true }, 1, notification())
		await waitFor(async () => (await store.get('REUPLOAD-1'))?.state === 'reupload_pending')
		expect(requested).toHaveLength(1)
		expect(await store.get('REUPLOAD-1')).toMatchObject({ attemptCount: 1, state: 'reupload_pending' })
		await coordinator.stop()
	})

	it('resumes an expired applying lease after restart and commits once', async () => {
		await store.enqueue({
			messageId: 'RECOVER-1',
			sourceMessageId: 'RECOVER-1',
			messageKey: { id: 'RECOVER-1', remoteJid: '5511@s.whatsapp.net', fromMe: true },
			messageTimestamp: 1,
			notification: proto.Message.HistorySyncNotification.encode(notification()).finish(),
			syncType: proto.HistorySync.HistorySyncType.RECENT,
			chunkOrder: 1,
			progress: 100
		})
		await store.claimNext(Date.now(), 1)
		await store.markState('RECOVER-1', 'applying')
		await new Promise(resolve => setTimeout(resolve, 3))

		const apply = jest.fn(async () => undefined)
		const recoveryStore = new FileHistorySyncStore(join(dir, 'queue.json'))
		const coordinator = new DurableHistorySyncCoordinator({
			store: recoveryStore,
			requestOptions: {},
			download: async () => emptyResult(),
			apply,
			requestReupload: async () => undefined
		})
		await coordinator.startRecovery()
		await waitFor(async () => (await recoveryStore.get('RECOVER-1'))?.state === 'committed')
		expect(apply).toHaveBeenCalledTimes(1)
		await coordinator.stop()
	})

	it('retries local apply failures without requesting a remote reupload', async () => {
		const requestReupload = jest.fn(async () => undefined)
		const coordinator = new DurableHistorySyncCoordinator({
			store,
			requestOptions: {},
			download: async () => emptyResult(),
			apply: async () => {
				throw new Error('local sqlite busy')
			},
			requestReupload,
			maxLocalAttempts: 1
		})
		await coordinator.enqueue({ id: 'LOCAL-FAIL', remoteJid: '5511@s.whatsapp.net', fromMe: true }, 1, notification())
		await waitFor(async () => (await store.get('LOCAL-FAIL'))?.state === 'failed')
		expect(requestReupload).not.toHaveBeenCalled()
		await coordinator.stop()
	})

	it('does not request a remote reupload when local durable state persistence fails', async () => {
		const requestReupload = jest.fn(async () => undefined)
		jest.spyOn(store, 'markState').mockRejectedValueOnce(new Error('local queue disk full'))
		const coordinator = new DurableHistorySyncCoordinator({
			store,
			requestOptions: {},
			download: async () => emptyResult(),
			apply: async () => undefined,
			requestReupload
		})

		await coordinator.enqueue(
			{ id: 'LOCAL-STATE-FAIL', remoteJid: '5511@s.whatsapp.net', fromMe: true },
			1,
			notification()
		)
		await waitFor(async () => (await store.get('LOCAL-STATE-FAIL'))?.state === 'failed')
		expect(requestReupload).not.toHaveBeenCalled()
		await coordinator.stop()
	})

	it('runs the post-commit callback only after the durable checkpoint is visible', async () => {
		let releaseCommit!: () => void
		const originalCommit = store.commit.bind(store)
		const commit = jest.spyOn(store, 'commit').mockImplementation(async (messageId, checkpoint) => {
			await new Promise<void>(resolve => {
				releaseCommit = resolve
			})
			await originalCommit(messageId, checkpoint)
		})
		const onCommitted = jest.fn(async () => {
			expect(await store.getCheckpoint('RECENT')).toMatchObject({ messageId: 'COMMIT-ORDER' })
		})
		const coordinator = new DurableHistorySyncCoordinator({
			store,
			requestOptions: {},
			download: async () => emptyResult(),
			apply: async () => undefined,
			requestReupload: async () => undefined,
			onCommitted
		})

		await coordinator.enqueue({ id: 'COMMIT-ORDER', remoteJid: '5511@s.whatsapp.net', fromMe: true }, 1, notification())
		await waitFor(async () => commit.mock.calls.length === 1)
		expect(onCommitted).not.toHaveBeenCalled()
		releaseCommit()
		await waitFor(async () => onCommitted.mock.calls.length === 1)
		expect(await store.get('COMMIT-ORDER')).toMatchObject({ state: 'committed' })
		await coordinator.stop()
	})

	it('reconciles committed post-commit callbacks idempotently on recovery', async () => {
		await store.enqueue({
			messageId: 'POST-COMMIT-INITIAL',
			sourceMessageId: 'POST-COMMIT-INITIAL',
			messageKey: { id: 'POST-COMMIT-INITIAL', remoteJid: '5511@s.whatsapp.net', fromMe: true },
			messageTimestamp: 1,
			notification: proto.Message.HistorySyncNotification.encode(
				notification({ syncType: proto.HistorySync.HistorySyncType.INITIAL_BOOTSTRAP, chunkOrder: 0 })
			).finish(),
			syncType: proto.HistorySync.HistorySyncType.INITIAL_BOOTSTRAP,
			chunkOrder: 0,
			progress: 100
		})
		await store.commit('POST-COMMIT-INITIAL', {
			phase: 'INITIAL',
			syncType: proto.HistorySync.HistorySyncType.INITIAL_BOOTSTRAP,
			chunkOrder: 0,
			progress: 100,
			messageId: 'POST-COMMIT-INITIAL',
			updatedAt: Date.now()
		})
		await store.enqueue({
			messageId: 'POST-COMMIT-RECOVERY',
			sourceMessageId: 'POST-COMMIT-RECOVERY',
			messageKey: { id: 'POST-COMMIT-RECOVERY', remoteJid: '5511@s.whatsapp.net', fromMe: true },
			messageTimestamp: 1,
			notification: proto.Message.HistorySyncNotification.encode(notification()).finish(),
			syncType: proto.HistorySync.HistorySyncType.RECENT,
			chunkOrder: 1,
			progress: 100
		})
		await store.commit('POST-COMMIT-RECOVERY', {
			phase: 'RECENT',
			syncType: proto.HistorySync.HistorySyncType.RECENT,
			chunkOrder: 1,
			progress: 100,
			messageId: 'POST-COMMIT-RECOVERY',
			updatedAt: Date.now()
		})
		const recovered: string[] = []
		const onCommitted = jest.fn(async (job: StoredHistorySyncJob) => {
			recovered.push(job.messageId)
		})
		const coordinator = new DurableHistorySyncCoordinator({
			store,
			requestOptions: {},
			download: async () => emptyResult(),
			apply: async () => undefined,
			requestReupload: async () => undefined,
			onCommitted
		})

		await coordinator.startRecovery()
		expect(onCommitted).toHaveBeenCalledTimes(2)
		expect(recovered).toEqual(['POST-COMMIT-INITIAL', 'POST-COMMIT-RECOVERY'])
		await coordinator.startRecovery()
		expect(onCommitted).toHaveBeenCalledTimes(4)
		await coordinator.stop()
	})

	it('bounds teardown while an already admitted apply is slow', async () => {
		let releaseApply!: () => void
		const apply = jest.fn(
			() =>
				new Promise<void>(resolve => {
					releaseApply = resolve
				})
		)
		const coordinator = new DurableHistorySyncCoordinator({
			store,
			requestOptions: {},
			download: async () => emptyResult(),
			apply,
			requestReupload: async () => undefined,
			drainTimeoutMs: 20
		})

		await coordinator.enqueue({ id: 'SLOW-APPLY', remoteJid: '5511@s.whatsapp.net', fromMe: true }, 1, notification())
		await waitFor(async () => apply.mock.calls.length === 1)
		const startedAt = Date.now()
		await coordinator.stop()
		expect(Date.now() - startedAt).toBeLessThan(500)
		expect(await store.get('SLOW-APPLY')).toMatchObject({ state: 'failed', leaseUntil: 0 })
		releaseApply()
		await new Promise(resolve => setImmediate(resolve))
		expect(await store.get('SLOW-APPLY')).toMatchObject({ state: 'failed', leaseUntil: 0 })
	})

	it('propagates teardown cancellation to the local apply worker', async () => {
		const apply = jest.fn(
			async (_job: StoredHistorySyncJob, _data: ProcessedHistorySync, signal: AbortSignal) =>
				new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true }))
		)
		const coordinator = new DurableHistorySyncCoordinator({
			store,
			requestOptions: {},
			download: async () => emptyResult(),
			apply,
			requestReupload: async () => undefined,
			drainTimeoutMs: 100
		})

		await coordinator.enqueue({ id: 'ABORT-APPLY', remoteJid: '5511@s.whatsapp.net', fromMe: true }, 1, notification())
		await waitFor(async () => apply.mock.calls.length === 1)
		await coordinator.stop()
		expect(apply.mock.calls[0]?.[2].aborted).toBe(true)
		expect(await store.get('ABORT-APPLY')).toMatchObject({ state: 'failed', leaseUntil: 0 })
	})

	it('keeps adaptive batches inside 1..500 and reacts to storage latency', () => {
		const controller = new AdaptiveHistoryBatchController(100, 1, 500, 50)
		expect(controller.record(200)).toBe(50)
		for (let index = 0; index < 50; index++) controller.record(1)
		expect(controller.current()).toBe(500)
		for (let index = 0; index < 20; index++) controller.record(1_000)
		expect(controller.current()).toBe(1)
	})

	it('promotes a paused RECENT sync to complete only at the committed 100% boundary', () => {
		const status = {
			initialBootstrapComplete: false,
			recentSyncComplete: false,
			recentSyncPaused: true,
			fullSyncComplete: false
		}

		expect(markHistorySyncCheckpointComplete(status, notification({ progress: 75 }))).toBe(false)
		expect(status).toMatchObject({ recentSyncComplete: false, recentSyncPaused: true })
		expect(markHistorySyncCheckpointComplete(status, notification({ progress: 100 }))).toBe(true)
		expect(status).toMatchObject({ recentSyncComplete: true, recentSyncPaused: false })
		expect(markHistorySyncCheckpointComplete(status, notification({ progress: 100 }))).toBe(false)
	})
})
