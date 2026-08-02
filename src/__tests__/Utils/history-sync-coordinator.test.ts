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

const storedInput = (messageId: string, value = notification()) => ({
	messageId,
	sourceMessageId: messageId,
	messageKey: { id: messageId, remoteJid: '5511@s.whatsapp.net', fromMe: true },
	messageTimestamp: 1,
	notification: proto.Message.HistorySyncNotification.encode(value).finish(),
	syncType: value.syncType ?? 0,
	chunkOrder: value.chunkOrder ?? 0,
	progress: value.progress ?? 0
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

	it('keeps transient downloads locally retryable after the former attempt limit', async () => {
		const requestReupload = jest.fn(async () => undefined)
		await store.enqueue(storedInput('TRANSIENT-RETRY'))
		for (let attempt = 0; attempt < 5; attempt++) {
			await store.claimNext(1_000, 1, {
				initialComplete: true,
				recentComplete: true,
				allowMissingCheckpoint: true
			})
			await store.markFailed('TRANSIENT-RETRY', {
				error: 'ETIMEDOUT',
				nextRetryAt: 0,
				reuploadPending: false
			})
		}

		const coordinator = new DurableHistorySyncCoordinator({
			store,
			requestOptions: {},
			download: async () => {
				throw Object.assign(new Error('socket ETIMEDOUT'), { code: 'ETIMEDOUT' })
			},
			apply: async () => undefined,
			requestReupload,
			now: () => 1_000,
			random: () => 0,
			maxLocalAttempts: 1
		})

		await coordinator.startRecovery()
		await waitFor(async () => (await store.get('TRANSIENT-RETRY'))?.attemptCount === 6)
		expect(await store.get('TRANSIENT-RETRY')).toMatchObject({ state: 'failed', lastError: 'socket ETIMEDOUT' })
		expect(requestReupload).not.toHaveBeenCalled()
		await coordinator.stop()
	})

	it('bounds hostile Error.message getters and still records the failure', async () => {
		const hostile = new Error('hidden')
		Object.defineProperty(hostile, 'message', {
			get: () => {
				throw new Error('hostile getter')
			}
		})
		const coordinator = new DurableHistorySyncCoordinator({
			store,
			requestOptions: {},
			download: async () => {
				throw hostile
			},
			apply: async () => undefined,
			requestReupload: async () => undefined,
			now: () => 1_000,
			random: () => 0
		})

		await coordinator.enqueue(
			{ id: 'HOSTILE-ERROR', remoteJid: '5511@s.whatsapp.net', fromMe: true },
			1,
			notification()
		)
		await waitFor(async () => (await store.get('HOSTILE-ERROR'))?.state === 'failed')
		expect(await store.get('HOSTILE-ERROR')).toMatchObject({ lastError: 'unknown history sync error' })
		await coordinator.stop()
	})

	it('keeps a corrupt keyless inline bootstrap locally retryable', async () => {
		const requestReupload = jest.fn(async () => undefined)
		const coordinator = new DurableHistorySyncCoordinator({
			store,
			requestOptions: {},
			download: async () => {
				throw new Error('inline inflate corrupt')
			},
			apply: async () => undefined,
			requestReupload,
			now: () => 1_000,
			random: () => 0
		})

		await coordinator.enqueue(
			{ id: 'INLINE-KEYLESS', remoteJid: '5511@s.whatsapp.net', fromMe: true },
			1,
			notification({ mediaKey: undefined, initialHistBootstrapInlinePayload: Buffer.from([1, 2, 3]) })
		)
		await waitFor(async () => (await store.get('INLINE-KEYLESS'))?.state === 'failed')
		expect(requestReupload).not.toHaveBeenCalled()
		expect(await store.get('INLINE-KEYLESS')).toMatchObject({ state: 'failed', nextRetryAt: 1_500 })
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
		expect(
			(
				await store.claimNext(Date.now(), 1, {
					initialComplete: true,
					recentComplete: true,
					allowMissingCheckpoint: true
				})
			)?.messageId
		).toBe('RECOVER-1')
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
		const onCommitted = jest.fn(async (_job: StoredHistorySyncJob, context: { recovered: boolean }) => {
			expect(await store.getCheckpoint('RECENT')).toMatchObject({ messageId: 'COMMIT-ORDER' })
			expect(context).toEqual({ recovered: false })
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
		await waitFor(async () => Boolean((await store.get('COMMIT-ORDER'))?.postCommitCompletedAt))
		expect(onCommitted).toHaveBeenCalledTimes(1)
		expect(await store.get('COMMIT-ORDER')).toMatchObject({
			state: 'committed',
			postCommitCompletedAt: expect.any(Number)
		})
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
		const recovered: Array<{ id: string; recovered: boolean }> = []
		const onCommitted = jest.fn(async (job: StoredHistorySyncJob, context: { recovered: boolean }) => {
			recovered.push({ id: job.messageId, recovered: context.recovered })
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
		expect(recovered).toEqual([
			{ id: 'POST-COMMIT-INITIAL', recovered: true },
			{ id: 'POST-COMMIT-RECOVERY', recovered: true }
		])
		expect(await store.get('POST-COMMIT-INITIAL')).toMatchObject({ postCommitCompletedAt: expect.any(Number) })
		expect(await store.get('POST-COMMIT-RECOVERY')).toMatchObject({ postCommitCompletedAt: expect.any(Number) })
		await coordinator.startRecovery()
		expect(onCommitted).toHaveBeenCalledTimes(2)
		await coordinator.stop()

		const reopened = new FileHistorySyncStore(join(dir, 'queue.json'))
		const afterRestart = jest.fn(async () => undefined)
		const restarted = new DurableHistorySyncCoordinator({
			store: reopened,
			requestOptions: {},
			download: async () => emptyResult(),
			apply: async () => undefined,
			requestReupload: async () => undefined,
			onCommitted: afterRestart
		})
		await restarted.startRecovery()
		expect(afterRestart).not.toHaveBeenCalled()
		await restarted.stop()
	})

	it('advances recovery prerequisites from a legacy commit without replaying current-stream completion', async () => {
		await store.enqueue(
			storedInput(
				'LEGACY-INITIAL',
				notification({ syncType: proto.HistorySync.HistorySyncType.INITIAL_BOOTSTRAP, chunkOrder: 0 })
			)
		)
		await store.commit('LEGACY-INITIAL')
		await store.enqueue(storedInput('AFTER-LEGACY-INITIAL', notification({ chunkOrder: 1 })))
		const onCommitted = jest.fn<(job: StoredHistorySyncJob, context: { recovered: boolean }) => void>()
		const coordinator = new DurableHistorySyncCoordinator({
			store,
			requestOptions: {},
			download: async () => emptyResult(),
			apply: async () => undefined,
			requestReupload: async () => undefined,
			onCommitted,
			initialHistorySyncComplete: false,
			recentHistorySyncComplete: false
		})

		await coordinator.startRecovery()
		await waitFor(async () => (await store.get('AFTER-LEGACY-INITIAL'))?.state === 'committed')
		expect(onCommitted.mock.calls[0]?.[1]).toEqual({ recovered: true })
		expect(onCommitted.mock.calls[1]?.[1]).toEqual({ recovered: false })
		await coordinator.stop()
	})

	it('does not spin on an overdue retry blocked by a predecessor in backoff', async () => {
		const now = Date.now()
		await store.enqueue(storedInput('BLOCKED-RECENT'))
		await store.claimNext(now, 1, {
			initialComplete: true,
			recentComplete: true,
			allowMissingCheckpoint: true
		})
		await store.markFailed('BLOCKED-RECENT', { error: 'due', nextRetryAt: 0, reuploadPending: false })
		await store.enqueue(
			storedInput(
				'INITIAL-BACKOFF',
				notification({ syncType: proto.HistorySync.HistorySyncType.INITIAL_BOOTSTRAP, chunkOrder: 0 })
			)
		)
		await store.claimNext(now, 1, {
			initialComplete: false,
			recentComplete: false,
			allowMissingCheckpoint: false
		})
		await store.markFailed('INITIAL-BACKOFF', {
			error: 'later',
			nextRetryAt: now + 60_000,
			reuploadPending: false
		})
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

		await coordinator.startRecovery()
		await waitFor(async () => claimNext.mock.calls.length > 0)
		await new Promise(resolve => setTimeout(resolve, 30))
		expect(claimNext).toHaveBeenCalledTimes(1)
		await coordinator.stop()
	})

	it('finishes committed recovery callbacks before starting pending work', async () => {
		await store.enqueue({
			messageId: 'RECOVERY-COMMITTED',
			sourceMessageId: 'RECOVERY-COMMITTED',
			messageKey: { id: 'RECOVERY-COMMITTED', remoteJid: '5511@s.whatsapp.net', fromMe: true },
			messageTimestamp: 1,
			notification: proto.Message.HistorySyncNotification.encode(notification()).finish(),
			syncType: proto.HistorySync.HistorySyncType.RECENT,
			chunkOrder: 1,
			progress: 100
		})
		await store.commit('RECOVERY-COMMITTED')
		await store.enqueue({
			messageId: 'RECOVERY-PENDING',
			sourceMessageId: 'RECOVERY-PENDING',
			messageKey: { id: 'RECOVERY-PENDING', remoteJid: '5511@s.whatsapp.net', fromMe: true },
			messageTimestamp: 1,
			notification: proto.Message.HistorySyncNotification.encode(notification({ chunkOrder: 2 })).finish(),
			syncType: proto.HistorySync.HistorySyncType.RECENT,
			chunkOrder: 2,
			progress: 100
		})
		let releaseCallback!: () => void
		const callbackStarted = new Promise<void>(resolve => {
			releaseCallback = resolve
		})
		let unblockCallback!: () => void
		const callbackBlocked = new Promise<void>(resolve => {
			unblockCallback = resolve
		})
		const download = jest.fn(async () => emptyResult())
		const coordinator = new DurableHistorySyncCoordinator({
			store,
			requestOptions: {},
			download,
			apply: async () => undefined,
			requestReupload: async () => undefined,
			onCommitted: async () => {
				releaseCallback()
				await callbackBlocked
			}
		})

		const recovery = coordinator.startRecovery()
		await callbackStarted
		expect(download).not.toHaveBeenCalled()
		unblockCallback()
		await recovery
		await waitFor(async () => download.mock.calls.length === 1)
		await coordinator.stop()
	})

	it('retries the worker after a transient durable-store failure', async () => {
		const originalClaimNext = store.claimNext.bind(store)
		const claimNext = jest.spyOn(store, 'claimNext').mockRejectedValueOnce(new Error('temporary sqlite busy'))
		claimNext.mockImplementation(originalClaimNext)
		const apply = jest.fn(async () => undefined)
		const coordinator = new DurableHistorySyncCoordinator({
			store,
			requestOptions: {},
			download: async () => emptyResult(),
			apply,
			requestReupload: async () => undefined,
			random: () => 0
		})

		await coordinator.enqueue({ id: 'STORE-RETRY', remoteJid: '5511@s.whatsapp.net', fromMe: true }, 1, notification())
		await waitFor(async () => (await store.get('STORE-RETRY'))?.state === 'committed')
		expect(claimNext.mock.calls.length).toBeGreaterThanOrEqual(2)
		expect(apply).toHaveBeenCalledTimes(1)
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
