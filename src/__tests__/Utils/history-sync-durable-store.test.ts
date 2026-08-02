import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { proto } from '../../../WAProto/index.js'
import type { HistorySyncJobInput, HistorySyncStore } from '../../Types'
import { FileHistorySyncStore } from '../../Utils/history-sync-store'
import { useMultiDbSqliteAuthState } from '../../Utils/multi-db-sqlite'
import { useMultiFileAuthState } from '../../Utils/use-multi-file-auth-state'
import { useSqliteAuthState } from '../../Utils/use-sqlite-auth-state'

const LEGACY_PREREQUISITES = { initialComplete: true, recentComplete: true, allowMissingCheckpoint: true }

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

	const recovered = await store.claimNext(Number.MAX_SAFE_INTEGER, 1_000, LEGACY_PREREQUISITES)
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
			expect((await first.state.historySync!.claimNext(Date.now(), 60_000, LEGACY_PREREQUISITES))?.messageId).toBe(
				'MF-1'
			)
			await first.state.historySync!.markState('MF-1', 'applying')

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
			expect((await first.state.historySync!.claimNext(Date.now(), 60_000, LEGACY_PREREQUISITES))?.messageId).toBe(
				'SQL-1'
			)
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
			expect((await first.state.historySync!.claimNext(Date.now(), 60_000, LEGACY_PREREQUISITES))?.messageId).toBe(
				'MDB-1'
			)
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
			expect((await store.claimNext(Date.now(), 1_000, LEGACY_PREREQUISITES))?.messageId).toBe('CHUNK-1')

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
			await store.claimNext(Date.now(), 1_000, LEGACY_PREREQUISITES)
			await store.markFailed('BARRIER-1', { error: 'cdn gone', nextRetryAt: 0, reuploadPending: true })
			expect(await store.claimNext(Date.now(), 1_000, LEGACY_PREREQUISITES)).toBeNull()
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
			expect((await store.claimNext(now, 1_000, LEGACY_PREREQUISITES))?.messageId).toBe('RETRY-2')
			await store.markFailed('RETRY-2', { error: 'retry second', nextRetryAt: 0, reuploadPending: false })

			await store.enqueue(makeJob('RETRY-1', 1))
			expect((await store.claimNext(now, 1_000, LEGACY_PREREQUISITES))?.messageId).toBe('RETRY-1')
			await store.markFailed('RETRY-1', {
				error: 'retry first later',
				nextRetryAt: now + 60_000,
				reuploadPending: false
			})

			expect(await store.claimNext(now, 1_000, LEGACY_PREREQUISITES)).toBeNull()
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

	it('consumes the missing-checkpoint migration baseline once in every built-in backend', async () => {
		const root = await mkdtemp(join(tmpdir(), 'history-sync-compatibility-'))
		const assertConsumedOnce = async (store: HistorySyncStore, prefix: string) => {
			await store.enqueue(makeJob(`${prefix}-RECENT-3`, 3, proto.HistorySync.HistorySyncType.RECENT))
			expect((await store.claimNext(Date.now(), 1_000, LEGACY_PREREQUISITES))?.messageId).toBe(`${prefix}-RECENT-3`)
			await store.commit(`${prefix}-RECENT-3`)
			await store.enqueue(makeJob(`${prefix}-FULL-3`, 3, proto.HistorySync.HistorySyncType.FULL))
			expect(await store.claimNext(Date.now(), 1_000, LEGACY_PREREQUISITES)).toBeNull()
			expect((await store.exportState()).compatibilityBaselineConsumed).toBe(true)
		}

		try {
			const multifilePath = join(root, 'multifile', 'history-sync-state.json')
			await assertConsumedOnce(new FileHistorySyncStore(multifilePath), 'MF')
			expect(
				await new FileHistorySyncStore(multifilePath).claimNext(Date.now(), 1_000, LEGACY_PREREQUISITES)
			).toBeNull()

			await mkdir(join(root, 'sqlite'))
			const sqlitePath = join(root, 'sqlite', 'auth.db')
			const sqlite = await useSqliteAuthState({ dbPath: sqlitePath })
			await assertConsumedOnce(sqlite.state.historySync!, 'SQL')
			sqlite.close()
			const reopenedSqlite = await useSqliteAuthState({ dbPath: sqlitePath })
			expect(await reopenedSqlite.state.historySync!.claimNext(Date.now(), 1_000, LEGACY_PREREQUISITES)).toBeNull()
			reopenedSqlite.close()

			const multiDbPath = join(root, 'multidb')
			const multidb = await useMultiDbSqliteAuthState({ sessionDir: multiDbPath })
			await assertConsumedOnce(multidb.state.historySync!, 'MDB')
			multidb.close()
			const reopenedMultidb = await useMultiDbSqliteAuthState({ sessionDir: multiDbPath })
			expect(await reopenedMultidb.state.historySync!.claimNext(Date.now(), 1_000, LEGACY_PREREQUISITES)).toBeNull()
			reopenedMultidb.close()
		} finally {
			await rm(root, { recursive: true, force: true })
		}
	})

	it('persists post-commit completion markers in every built-in backend', async () => {
		const root = await mkdtemp(join(tmpdir(), 'history-sync-post-commit-'))
		const assertMarker = async (store: HistorySyncStore, id: string) => {
			await store.enqueue(makeJob(id, 1))
			await store.commit(id)
			await store.markPostCommitCompleted(id, 123_456)
			expect(await store.get(id)).toMatchObject({ state: 'committed', postCommitCompletedAt: 123_456 })
		}

		try {
			await assertMarker(new FileHistorySyncStore(join(root, 'multifile', 'history-sync-state.json')), 'MF-MARKER')
			await mkdir(join(root, 'sqlite'))
			const sqlite = await useSqliteAuthState({ dbPath: join(root, 'sqlite', 'auth.db') })
			await assertMarker(sqlite.state.historySync!, 'SQL-MARKER')
			sqlite.close()
			const multidb = await useMultiDbSqliteAuthState({ sessionDir: join(root, 'multidb') })
			await assertMarker(multidb.state.historySync!, 'MDB-MARKER')
			multidb.close()
		} finally {
			await rm(root, { recursive: true, force: true })
		}
	})

	it('prunes only committed jobs whose post-commit work completed', async () => {
		const root = await mkdtemp(join(tmpdir(), 'history-sync-prune-'))
		const assertPruneBoundary = async (store: HistorySyncStore, prefix: string) => {
			const pendingId = `${prefix}-PENDING-POST-COMMIT`
			const completedId = `${prefix}-COMPLETED-POST-COMMIT`
			await store.enqueue(makeJob(pendingId, 1))
			await store.commit(pendingId)
			await store.enqueue(makeJob(completedId, 2))
			await store.commit(completedId)
			await store.markPostCommitCompleted(completedId)

			expect(await store.pruneCommitted(Date.now() + 60_000)).toBe(1)
			expect(await store.get(pendingId)).toMatchObject({ state: 'committed' })
			expect(await store.get(completedId)).toBeNull()
		}

		try {
			await assertPruneBoundary(new FileHistorySyncStore(join(root, 'multifile', 'history-sync-state.json')), 'MF')
			await mkdir(join(root, 'sqlite'))
			const sqlite = await useSqliteAuthState({ dbPath: join(root, 'sqlite', 'auth.db') })
			await assertPruneBoundary(sqlite.state.historySync!, 'SQL')
			sqlite.close()
			const multidb = await useMultiDbSqliteAuthState({ sessionDir: join(root, 'multidb') })
			await assertPruneBoundary(multidb.state.historySync!, 'MDB')
			multidb.close()
		} finally {
			await rm(root, { recursive: true, force: true })
		}
	})

	it('clears durable history jobs, checkpoints, metadata, and recovery files with auth keys', async () => {
		const root = await mkdtemp(join(tmpdir(), 'history-sync-clear-'))
		const seedAndClear = async (store: HistorySyncStore, clear: () => Promise<void>, id: string, filePath?: string) => {
			await store.enqueue(makeJob(id, 3))
			await store.claimNext(Date.now(), 1_000, LEGACY_PREREQUISITES)
			await store.commit(id, {
				phase: 'RECENT',
				syncType: proto.HistorySync.HistorySyncType.RECENT,
				chunkOrder: 3,
				progress: 100,
				messageId: id,
				updatedAt: Date.now()
			})
			await clear()
			expect(await store.exportState()).toEqual({
				jobs: [],
				checkpoints: [],
				compatibilityBaselineConsumed: false
			})
			if (filePath) {
				await expect(readFile(filePath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
				await expect(readFile(`${filePath}.tmp`, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
				await expect(readFile(`${filePath}.bak`, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
			}
		}

		try {
			const multifileDir = join(root, 'multifile')
			const multifile = await useMultiFileAuthState(multifileDir)
			await seedAndClear(
				multifile.state.historySync!,
				async () => {
					await multifile.state.keys.clear?.()
				},
				'MF-CLEAR',
				join(multifileDir, 'history-sync-state.json')
			)

			await mkdir(join(root, 'sqlite'))
			const sqlite = await useSqliteAuthState({ dbPath: join(root, 'sqlite', 'auth.db') })
			await seedAndClear(
				sqlite.state.historySync!,
				async () => {
					await sqlite.state.keys.clear?.()
				},
				'SQL-CLEAR'
			)
			sqlite.close()

			const multidb = await useMultiDbSqliteAuthState({ sessionDir: join(root, 'multidb') })
			await seedAndClear(
				multidb.state.historySync!,
				async () => {
					await multidb.state.keys.clear?.()
				},
				'MDB-CLEAR'
			)
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
			const inMemory = store as unknown as {
				state: { jobs: Record<string, { state: string }> }
			}
			expect(inMemory.state.jobs['ROLLBACK-1']?.state).toBe('received')
			await rm(join(dir, 'history-sync-state.json.tmp'), { recursive: true, force: true })
			await store.markState('ROLLBACK-1', 'applying')
			expect(await store.get('ROLLBACK-1')).toMatchObject({ state: 'applying' })
		} finally {
			await rm(dir, { recursive: true, force: true })
		}
	})

	it('serializes concurrent multifile stores that share the same queue path', async () => {
		const dir = await mkdtemp(join(tmpdir(), 'history-sync-shared-path-'))
		try {
			const path = join(dir, 'queue.json')
			const first = new FileHistorySyncStore(path)
			const second = new FileHistorySyncStore(path)
			const inputs = Array.from({ length: 20 }, (_, index) => makeJob(`SHARED-${index}`))

			await Promise.all(inputs.map((input, index) => (index % 2 === 0 ? first : second).enqueue(input)))

			expect((await first.list()).map(job => job.messageId).sort()).toEqual(inputs.map(job => job.messageId).sort())
		} finally {
			await rm(dir, { recursive: true, force: true })
		}
	})

	it('preserves the only backup when installing a recovered snapshot fails', async () => {
		const dir = await mkdtemp(join(tmpdir(), 'history-sync-backup-'))
		try {
			const path = join(dir, 'queue.json')
			const first = new FileHistorySyncStore(path)
			await first.enqueue(makeJob('BACKUP-ONLY'))
			await rename(path, `${path}.bak`)
			await mkdir(path)

			const recovered = new FileHistorySyncStore(path)
			await expect(recovered.markState('BACKUP-ONLY', 'decoded')).rejects.toThrow()
			expect((await readFile(`${path}.bak`, 'utf8')).length).toBeGreaterThan(0)

			await rm(path, { recursive: true, force: true })
			expect(await recovered.get('BACKUP-ONLY')).toMatchObject({ state: 'received' })
		} finally {
			await rm(dir, { recursive: true, force: true })
		}
	})

	it('does not rotate a corrupt primary over a valid recovered backup', async () => {
		const dir = await mkdtemp(join(tmpdir(), 'history-sync-corrupt-primary-'))
		try {
			const path = join(dir, 'queue.json')
			const first = new FileHistorySyncStore(path)
			await first.enqueue(makeJob('KNOWN-GOOD'))
			await rename(path, `${path}.bak`)
			await writeFile(path, '{corrupt')

			const recovered = new FileHistorySyncStore(path)
			await recovered.markState('KNOWN-GOOD', 'decoded')
			expect(await recovered.get('KNOWN-GOOD')).toMatchObject({ state: 'decoded' })
			expect(JSON.parse(await readFile(`${path}.bak`, 'utf8'))).toBeDefined()
		} finally {
			await rm(dir, { recursive: true, force: true })
		}
	})

	it('defaults a fresh store to conservative phase prerequisites', async () => {
		const dir = await mkdtemp(join(tmpdir(), 'history-sync-safe-defaults-'))
		try {
			const auth = await useMultiFileAuthState(dir)
			const store = auth.state.historySync!
			await store.enqueue(makeJob('RECENT-WITHOUT-INITIAL', 1))

			expect(await store.claimNext(Date.now(), 1_000)).toBeNull()
			expect(await store.get('RECENT-WITHOUT-INITIAL')).toMatchObject({ state: 'received' })
		} finally {
			await rm(dir, { recursive: true, force: true })
		}
	})
})
