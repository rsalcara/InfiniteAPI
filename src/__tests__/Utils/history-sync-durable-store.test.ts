import { mkdir, mkdtemp, rm } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { proto } from '../../../WAProto/index.js'
import type { HistorySyncJobInput, HistorySyncStore } from '../../Types'
import { useMultiDbSqliteAuthState } from '../../Utils/multi-db-sqlite'
import { useMultiFileAuthState } from '../../Utils/use-multi-file-auth-state'
import { useSqliteAuthState } from '../../Utils/use-sqlite-auth-state'

const makeJob = (
	messageId: string,
	chunkOrder = 0,
	syncType = proto.HistorySync.HistorySyncType.RECENT
): HistorySyncJobInput => ({
	messageId,
	sourceMessageId: messageId,
	messageKey: { id: messageId, remoteJid: '5511999999999@s.whatsapp.net', fromMe: true },
	messageTimestamp: 123,
	notification: proto.Message.HistorySyncNotification.encode({
		syncType,
		chunkOrder,
		progress: 100
	}).finish(),
	syncType,
	chunkOrder,
	progress: 100
})

const assertRecoveryAndCheckpoint = async (store: HistorySyncStore, messageId: string): Promise<void> => {
	const jobs = await store.list()
	expect(jobs).toHaveLength(1)
	expect(jobs[0]).toMatchObject({ messageId, state: 'applying' })

	const recovered = await store.claimNext(Number.MAX_SAFE_INTEGER, 1_000)
	expect(recovered?.messageId).toBe(messageId)
	await store.markState(messageId, 'decoded')
	await store.markState(messageId, 'applying')
	await store.commit(messageId, {
		phase: 'RECENT',
		syncType: proto.HistorySync.HistorySyncType.RECENT,
		chunkOrder: 7,
		progress: 100,
		messageId,
		updatedAt: Date.now()
	})

	expect(await store.get(messageId)).toMatchObject({ state: 'committed' })
	expect(await store.getCheckpoint('RECENT')).toMatchObject({ chunkOrder: 7, progress: 100, messageId })
}

const assertPhaseBarrier = async (store: HistorySyncStore, prefix: string): Promise<void> => {
	const prerequisites = { initialComplete: false, recentComplete: false, allowMissingCheckpoint: false }
	const initialId = `${prefix}-INITIAL`
	const recentId = `${prefix}-RECENT`
	const recentSecondId = `${prefix}-RECENT-2`
	const fullId = `${prefix}-FULL`
	await store.enqueue(makeJob(recentSecondId, 2, proto.HistorySync.HistorySyncType.RECENT))
	await store.enqueue(makeJob(fullId, 1, proto.HistorySync.HistorySyncType.FULL))
	expect(await store.claimNext(Date.now(), 1_000, prerequisites)).toBeNull()
	await store.enqueue(makeJob(initialId, 0, proto.HistorySync.HistorySyncType.INITIAL_BOOTSTRAP))
	await store.enqueue(makeJob(recentId, 1, proto.HistorySync.HistorySyncType.RECENT))

	expect((await store.claimNext(Date.now(), 1_000, prerequisites))?.messageId).toBe(initialId)
	await store.markFailed(initialId, {
		error: 'retry initial',
		nextRetryAt: Date.now() + 60_000,
		reuploadPending: false
	})
	expect(await store.claimNext(Date.now(), 1_000, prerequisites)).toBeNull()

	await store.commit(initialId, {
		phase: 'INITIAL',
		syncType: proto.HistorySync.HistorySyncType.INITIAL_BOOTSTRAP,
		chunkOrder: 0,
		progress: 100,
		messageId: initialId,
		updatedAt: Date.now()
	})
	expect((await store.claimNext(Date.now(), 1_000, prerequisites))?.messageId).toBe(recentId)
	await store.commit(recentId, {
		phase: 'RECENT',
		syncType: proto.HistorySync.HistorySyncType.RECENT,
		chunkOrder: 1,
		progress: 100,
		messageId: recentId,
		updatedAt: Date.now()
	})
	expect((await store.claimNext(Date.now(), 1_000, prerequisites))?.messageId).toBe(recentSecondId)
	await store.commit(recentSecondId, {
		phase: 'RECENT',
		syncType: proto.HistorySync.HistorySyncType.RECENT,
		chunkOrder: 2,
		progress: 100,
		messageId: recentSecondId,
		updatedAt: Date.now()
	})
	expect((await store.claimNext(Date.now(), 1_000, prerequisites))?.messageId).toBe(fullId)
}

describe('durable history sync store across auth backends', () => {
	it('recovers an applying job with the multifile backend', async () => {
		const dir = await mkdtemp(join(tmpdir(), 'history-sync-multifile-'))
		try {
			const first = await useMultiFileAuthState(dir)
			await first.state.historySync!.enqueue(makeJob('MF-1', 7))
			await first.state.historySync!.claimNext(Date.now(), 60_000)
			await first.state.historySync!.markState('MF-1', 'applying')
			await first.state.keys.clear?.()
			expect(await first.state.historySync!.get('MF-1')).toMatchObject({ state: 'applying' })

			const reopened = await useMultiFileAuthState(dir)
			await assertRecoveryAndCheckpoint(reopened.state.historySync!, 'MF-1')
		} finally {
			await rm(dir, { recursive: true, force: true })
		}
	})

	it('recovers an applying job with monolithic SQLite', async () => {
		const dir = await mkdtemp(join(tmpdir(), 'history-sync-sqlite-'))
		const dbPath = join(dir, 'auth.db')
		try {
			const first = await useSqliteAuthState({ dbPath })
			await first.state.historySync!.enqueue(makeJob('SQL-1', 7))
			await first.state.historySync!.claimNext(Date.now(), 60_000)
			await first.state.historySync!.markState('SQL-1', 'applying')
			first.close()

			const reopened = await useSqliteAuthState({ dbPath })
			await assertRecoveryAndCheckpoint(reopened.state.historySync!, 'SQL-1')
			reopened.close()
		} finally {
			await rm(dir, { recursive: true, force: true })
		}
	})

	it('recovers an applying job with multi-database SQLite', async () => {
		const dir = await mkdtemp(join(tmpdir(), 'history-sync-multidb-'))
		try {
			const first = await useMultiDbSqliteAuthState({ sessionDir: dir })
			await first.state.historySync!.enqueue(makeJob('MDB-1', 7))
			await first.state.historySync!.claimNext(Date.now(), 60_000)
			await first.state.historySync!.markState('MDB-1', 'applying')
			first.close()

			const reopened = await useMultiDbSqliteAuthState({ sessionDir: dir })
			await assertRecoveryAndCheckpoint(reopened.state.historySync!, 'MDB-1')
			reopened.close()
		} finally {
			await rm(dir, { recursive: true, force: true })
		}
	})

	it('claims out-of-order arrivals by protocol order and keeps checkpoints monotonic', async () => {
		const dir = await mkdtemp(join(tmpdir(), 'history-sync-order-'))
		try {
			const auth = await useMultiFileAuthState(dir)
			const store = auth.state.historySync!
			await store.enqueue(makeJob('CHUNK-2', 2))
			await store.enqueue(makeJob('CHUNK-1', 1))
			expect((await store.claimNext(Date.now(), 1_000))?.messageId).toBe('CHUNK-1')

			await store.commit('CHUNK-1', {
				phase: 'RECENT',
				syncType: proto.HistorySync.HistorySyncType.RECENT,
				chunkOrder: 2,
				progress: 100,
				messageId: 'CHUNK-1',
				updatedAt: 2
			})
			await store.commit('CHUNK-2', {
				phase: 'RECENT',
				syncType: proto.HistorySync.HistorySyncType.RECENT,
				chunkOrder: 1,
				progress: 50,
				messageId: 'CHUNK-2',
				updatedAt: 3
			})
			expect(await store.getCheckpoint('RECENT')).toMatchObject({ chunkOrder: 2, progress: 100 })
		} finally {
			await rm(dir, { recursive: true, force: true })
		}
	})

	it('does not advance past a predecessor waiting for reupload', async () => {
		const dir = await mkdtemp(join(tmpdir(), 'history-sync-barrier-'))
		try {
			const auth = await useMultiFileAuthState(dir)
			const store = auth.state.historySync!
			await store.enqueue(makeJob('BARRIER-1', 1))
			await store.enqueue(makeJob('BARRIER-2', 2))
			await store.claimNext(Date.now(), 1_000)
			await store.markFailed('BARRIER-1', { error: 'cdn gone', nextRetryAt: 0, reuploadPending: true })
			expect(await store.claimNext(Date.now(), 1_000)).toBeNull()
			expect(await store.get('BARRIER-2')).toMatchObject({ state: 'received' })
		} finally {
			await rm(dir, { recursive: true, force: true })
		}
	})

	it('does not let a due retry overtake a lower chunk still in backoff', async () => {
		const dir = await mkdtemp(join(tmpdir(), 'history-sync-retry-order-'))
		try {
			const auth = await useMultiFileAuthState(dir)
			const store = auth.state.historySync!
			const now = Date.now()
			await store.enqueue(makeJob('RETRY-2', 2))
			expect((await store.claimNext(now, 1_000))?.messageId).toBe('RETRY-2')
			await store.markFailed('RETRY-2', { error: 'retry second', nextRetryAt: 0, reuploadPending: false })

			await store.enqueue(makeJob('RETRY-1', 1))
			expect((await store.claimNext(now, 1_000))?.messageId).toBe('RETRY-1')
			await store.markFailed('RETRY-1', {
				error: 'retry first later',
				nextRetryAt: now + 60_000,
				reuploadPending: false
			})

			expect(await store.claimNext(now, 1_000)).toBeNull()
			expect(await store.get('RETRY-2')).toMatchObject({ state: 'failed' })
		} finally {
			await rm(dir, { recursive: true, force: true })
		}
	})

	it('preserves INITIAL -> RECENT -> FULL phase barriers in every built-in backend', async () => {
		const root = await mkdtemp(join(tmpdir(), 'history-sync-phases-'))
		try {
			const multifile = await useMultiFileAuthState(join(root, 'multifile'))
			await assertPhaseBarrier(multifile.state.historySync!, 'MF')

			await mkdir(join(root, 'sqlite'))
			const sqlite = await useSqliteAuthState({ dbPath: join(root, 'sqlite', 'auth.db') })
			await assertPhaseBarrier(sqlite.state.historySync!, 'SQL')
			sqlite.close()

			const multidb = await useMultiDbSqliteAuthState({ sessionDir: join(root, 'multidb') })
			await assertPhaseBarrier(multidb.state.historySync!, 'MDB')
			multidb.close()
		} finally {
			await rm(root, { recursive: true, force: true })
		}
	})

	it('rolls back multifile in-memory state when its atomic write fails', async () => {
		const dir = await mkdtemp(join(tmpdir(), 'history-sync-rollback-'))
		try {
			const auth = await useMultiFileAuthState(dir)
			const store = auth.state.historySync!
			await store.enqueue(makeJob('ROLLBACK-1', 1))
			await mkdir(join(dir, 'history-sync-state.json.tmp'))

			await expect(store.markState('ROLLBACK-1', 'decoded')).rejects.toThrow()
			expect(await store.get('ROLLBACK-1')).toMatchObject({ state: 'received' })
		} finally {
			await rm(dir, { recursive: true, force: true })
		}
	})
})
