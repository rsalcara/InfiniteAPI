import { mkdir, readFile, rename, stat, unlink, writeFile } from 'fs/promises'
import { dirname, resolve } from 'path'
import { proto } from '../../WAProto/index.js'
import type {
	HistorySyncCheckpoint,
	HistorySyncCheckpointPhase,
	HistorySyncFailure,
	HistorySyncJobInput,
	HistorySyncJobState,
	HistorySyncPrerequisites,
	HistorySyncStore,
	StoredHistorySyncJob
} from '../Types'
import type { SqliteDbLike, SqliteStatementLike } from './multi-db-sqlite/types'
import { BufferJSON } from './generics'
import { makeKeyedMutex } from './make-mutex'

const RUNNABLE_STATES: ReadonlyArray<HistorySyncJobState> = ['received', 'downloading', 'decoded', 'applying', 'failed']

const cloneJob = (job: StoredHistorySyncJob): StoredHistorySyncJob => ({
	...job,
	messageKey: { ...job.messageKey },
	notification: Buffer.from(job.notification)
})

const sortJobs = (left: StoredHistorySyncJob, right: StoredHistorySyncJob): number =>
	right.syncType - left.syncType || left.chunkOrder - right.chunkOrder || left.createdAt - right.createdAt

type FileState = {
	jobs: Record<string, StoredHistorySyncJob>
	checkpoints: Partial<Record<HistorySyncCheckpointPhase, HistorySyncCheckpoint>>
}

const emptyFileState = (): FileState => ({ jobs: {}, checkpoints: {} })

const cloneFileState = (state: FileState): FileState => ({
	jobs: Object.fromEntries(Object.entries(state.jobs).map(([id, job]) => [id, cloneJob(job)])),
	checkpoints: Object.fromEntries(
		Object.entries(state.checkpoints).map(([phase, checkpoint]) => [phase, { ...checkpoint }])
	) as FileState['checkpoints']
})

const DEFAULT_PREREQUISITES: HistorySyncPrerequisites = {
	initialComplete: false,
	recentComplete: false,
	allowMissingCheckpoint: false
}

const fileHistorySyncLocks = makeKeyedMutex()

const isProtocolEligible = (
	jobs: StoredHistorySyncJob[],
	checkpoints: Partial<Record<HistorySyncCheckpointPhase, HistorySyncCheckpoint>>,
	candidate: StoredHistorySyncJob,
	prerequisites: HistorySyncPrerequisites
): boolean => {
	if (
		jobs.some(
			other =>
				other.syncType === candidate.syncType && other.chunkOrder < candidate.chunkOrder && other.state !== 'committed'
		)
	) {
		return false
	}

	let predecessorType: proto.HistorySync.HistorySyncType | undefined
	if (candidate.syncType === proto.HistorySync.HistorySyncType.RECENT) {
		predecessorType = proto.HistorySync.HistorySyncType.INITIAL_BOOTSTRAP
	} else if (candidate.syncType === proto.HistorySync.HistorySyncType.FULL) {
		predecessorType = proto.HistorySync.HistorySyncType.RECENT
	}

	if (
		predecessorType !== undefined &&
		jobs.some(other => other.syncType === predecessorType && other.state !== 'committed')
	) {
		return false
	}

	// A leased job was already admitted before a crash or local retry. Resume it
	// when an older installation did not yet have durable phase checkpoints, but
	// never bypass active same-type or cross-phase predecessors checked above.
	if (candidate.state !== 'received') return true

	const phase =
		candidate.syncType === proto.HistorySync.HistorySyncType.RECENT
			? 'RECENT'
			: candidate.syncType === proto.HistorySync.HistorySyncType.FULL
				? 'FULL'
				: undefined
	if (!phase) return true

	if (phase === 'RECENT' && candidate.chunkOrder === 1 && !prerequisites.initialComplete && !checkpoints.INITIAL) {
		return false
	}

	if (
		phase === 'FULL' &&
		candidate.chunkOrder === 1 &&
		!prerequisites.recentComplete &&
		checkpoints.RECENT?.progress !== 100
	) {
		return false
	}

	if (candidate.chunkOrder > 1) {
		const checkpoint = checkpoints[phase]
		if (!checkpoint && !prerequisites.allowMissingCheckpoint) return false
		if (checkpoint && checkpoint.chunkOrder < candidate.chunkOrder - 1) return false
	}

	return true
}

const errorCode = (error: unknown): string | undefined => {
	if (!error || typeof error !== 'object' || !('code' in error)) return undefined
	const code = (error as { code?: unknown }).code
	return typeof code === 'string' ? code : undefined
}

/** Atomic JSON implementation used by the supported multifile auth backend. */
export class FileHistorySyncStore implements HistorySyncStore {
	private readonly lockKey: string
	private state = emptyFileState()

	constructor(private readonly path: string) {
		const resolved = resolve(path)
		this.lockKey = process.platform === 'win32' ? resolved.toLowerCase() : resolved
	}

	private async load(): Promise<void> {
		let firstError: unknown
		for (const candidate of [this.path, `${this.path}.bak`, `${this.path}.tmp`]) {
			try {
				const raw = await readFile(candidate, 'utf8')
				this.state = JSON.parse(raw, BufferJSON.reviver) as FileState
				return
			} catch (error) {
				if (errorCode(error) !== 'ENOENT' && firstError === undefined) firstError = error
			}
		}

		if (firstError !== undefined) throw firstError
		this.state = emptyFileState()
	}

	private async persist(): Promise<void> {
		await mkdir(dirname(this.path), { recursive: true })
		const tmp = `${this.path}.tmp`
		const backup = `${this.path}.bak`
		await writeFile(tmp, JSON.stringify(this.state, BufferJSON.replacer))
		let hasPrimaryFile = false
		try {
			hasPrimaryFile = (await stat(this.path)).isFile()
		} catch (error) {
			if (errorCode(error) !== 'ENOENT') throw error
		}

		if (hasPrimaryFile) {
			try {
				await unlink(backup)
			} catch (error) {
				if (errorCode(error) !== 'ENOENT') throw error
			}

			await rename(this.path, backup)
		}

		await rename(tmp, this.path)
	}

	private async mutate<T>(work: () => T): Promise<T> {
		return fileHistorySyncLocks.mutex(this.lockKey, async () => {
			await this.load()
			const previous = this.state
			this.state = cloneFileState(previous)
			try {
				const result = work()
				await this.persist()
				return result
			} catch (error) {
				this.state = previous
				throw error
			}
		})
	}

	async enqueue(input: HistorySyncJobInput): Promise<StoredHistorySyncJob> {
		return this.mutate(() => {
			const existing = this.state.jobs[input.messageId]
			if (existing?.state === 'committed') return cloneJob(existing)
			if (existing && existing.state !== 'reupload_pending') return cloneJob(existing)

			const now = Date.now()
			const job: StoredHistorySyncJob = {
				...input,
				messageKey: { ...input.messageKey },
				notification: Buffer.from(input.notification),
				state: 'received',
				attemptCount: existing?.attemptCount ?? 0,
				nextRetryAt: 0,
				leaseUntil: 0,
				createdAt: existing?.createdAt ?? now,
				updatedAt: now
			}
			this.state.jobs[input.messageId] = job
			return cloneJob(job)
		})
	}

	async claimNext(
		now: number,
		leaseMs: number,
		prerequisites = DEFAULT_PREREQUISITES
	): Promise<StoredHistorySyncJob | null> {
		return this.mutate(() => {
			const jobs = Object.values(this.state.jobs)
			const job = jobs
				.filter(candidate => {
					if (!RUNNABLE_STATES.includes(candidate.state)) return false
					if (candidate.state === 'failed' && candidate.nextRetryAt > now) return false
					if (candidate.leaseUntil > now) return false
					return isProtocolEligible(jobs, this.state.checkpoints, candidate, prerequisites)
				})
				.sort(sortJobs)[0]
			if (!job) return null
			job.state = 'downloading'
			job.attemptCount += 1
			job.leaseUntil = now + leaseMs
			job.updatedAt = now
			return cloneJob(job)
		})
	}

	async markState(messageId: string, state: 'decoded' | 'applying'): Promise<void> {
		await this.mutate(() => {
			const job = this.state.jobs[messageId]
			if (!job || job.state === 'committed') return
			job.state = state
			job.updatedAt = Date.now()
		})
	}

	async markFailed(messageId: string, failure: HistorySyncFailure): Promise<void> {
		await this.mutate(() => {
			const job = this.state.jobs[messageId]
			if (!job || job.state === 'committed') return
			job.state = failure.reuploadPending ? 'reupload_pending' : 'failed'
			job.lastError = failure.error
			job.nextRetryAt = failure.nextRetryAt
			job.leaseUntil = 0
			job.updatedAt = Date.now()
			if (failure.reuploadPending) job.reuploadRequestedAt = job.updatedAt
		})
	}

	async commit(messageId: string, checkpoint?: HistorySyncCheckpoint): Promise<void> {
		await this.mutate(() => {
			const job = this.state.jobs[messageId]
			if (!job) throw new Error(`history sync job not found: ${messageId}`)
			const now = Date.now()
			job.state = 'committed'
			job.leaseUntil = 0
			job.updatedAt = now
			job.committedAt = now
			if (checkpoint) {
				const current = this.state.checkpoints[checkpoint.phase]
				if (
					!current ||
					checkpoint.chunkOrder > current.chunkOrder ||
					(checkpoint.chunkOrder === current.chunkOrder && checkpoint.progress >= current.progress)
				) {
					this.state.checkpoints[checkpoint.phase] = { ...checkpoint }
				}
			}
		})
	}

	async get(messageId: string): Promise<StoredHistorySyncJob | null> {
		return fileHistorySyncLocks.mutex(this.lockKey, async () => {
			await this.load()
			const job = this.state.jobs[messageId]
			return job ? cloneJob(job) : null
		})
	}

	async list(): Promise<StoredHistorySyncJob[]> {
		return fileHistorySyncLocks.mutex(this.lockKey, async () => {
			await this.load()
			return Object.values(this.state.jobs).sort(sortJobs).map(cloneJob)
		})
	}

	async getCheckpoint(phase: HistorySyncCheckpointPhase): Promise<HistorySyncCheckpoint | null> {
		return fileHistorySyncLocks.mutex(this.lockKey, async () => {
			await this.load()
			return this.state.checkpoints[phase] ? { ...this.state.checkpoints[phase] } : null
		})
	}

	async pruneCommitted(before: number): Promise<number> {
		return this.mutate(() => {
			let removed = 0
			for (const [id, job] of Object.entries(this.state.jobs)) {
				if (job.state === 'committed' && (job.committedAt ?? job.updatedAt) < before) {
					delete this.state.jobs[id]
					removed++
				}
			}

			return removed
		})
	}
}

const HISTORY_SYNC_SCHEMA = `
CREATE TABLE IF NOT EXISTS history_sync_jobs (
  message_id TEXT PRIMARY KEY,
  source_message_id TEXT NOT NULL,
  message_key_json TEXT NOT NULL,
  message_timestamp INTEGER,
  notification BLOB NOT NULL,
  sync_type INTEGER NOT NULL,
  chunk_order INTEGER NOT NULL,
  progress INTEGER NOT NULL,
  state TEXT NOT NULL,
  attempt_count INTEGER NOT NULL DEFAULT 0,
  next_retry_at INTEGER NOT NULL DEFAULT 0,
  lease_until INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  committed_at INTEGER,
  reupload_requested_at INTEGER
);
CREATE INDEX IF NOT EXISTS history_sync_jobs_runnable_idx
  ON history_sync_jobs (state, next_retry_at, lease_until, sync_type, chunk_order);
CREATE TABLE IF NOT EXISTS history_sync_checkpoints (
  phase TEXT PRIMARY KEY,
  sync_type INTEGER NOT NULL,
  chunk_order INTEGER NOT NULL,
  progress INTEGER NOT NULL,
  message_id TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
`

type JobRow = {
	message_id: string
	source_message_id: string
	message_key_json: string
	message_timestamp: number | null
	notification: Buffer
	sync_type: number
	chunk_order: number
	progress: number
	state: HistorySyncJobState
	attempt_count: number
	next_retry_at: number
	lease_until: number
	last_error: string | null
	created_at: number
	updated_at: number
	committed_at: number | null
	reupload_requested_at: number | null
}

type CheckpointRow = {
	phase: HistorySyncCheckpointPhase
	sync_type: number
	chunk_order: number
	progress: number
	message_id: string
	updated_at: number
}

type HistorySyncStatementName =
	| 'get'
	| 'list'
	| 'listActive'
	| 'insert'
	| 'replaceReupload'
	| 'selectRunnable'
	| 'claim'
	| 'markState'
	| 'markFailed'
	| 'markCommitted'
	| 'upsertCheckpoint'
	| 'getCheckpoint'
	| 'listCheckpoints'
	| 'prune'

const rowToJob = (row: JobRow): StoredHistorySyncJob => ({
	messageId: row.message_id,
	sourceMessageId: row.source_message_id,
	messageKey: JSON.parse(row.message_key_json, BufferJSON.reviver),
	messageTimestamp: row.message_timestamp ?? undefined,
	notification: Buffer.from(row.notification),
	syncType: row.sync_type,
	chunkOrder: row.chunk_order,
	progress: row.progress,
	state: row.state,
	attemptCount: row.attempt_count,
	nextRetryAt: row.next_retry_at,
	leaseUntil: row.lease_until,
	lastError: row.last_error ?? undefined,
	createdAt: row.created_at,
	updatedAt: row.updated_at,
	committedAt: row.committed_at ?? undefined,
	reuploadRequestedAt: row.reupload_requested_at ?? undefined
})

const rowToCheckpoint = (row: CheckpointRow): HistorySyncCheckpoint => ({
	phase: row.phase,
	syncType: row.sync_type,
	chunkOrder: row.chunk_order,
	progress: row.progress,
	messageId: row.message_id,
	updatedAt: row.updated_at
})

/** SQLite implementation shared by monolithic and multi-database auth. */
export class SqliteHistorySyncStore implements HistorySyncStore {
	private readonly stmts: Record<HistorySyncStatementName, SqliteStatementLike>

	constructor(private readonly db: SqliteDbLike) {
		db.exec(HISTORY_SYNC_SCHEMA)
		this.stmts = {
			get: db.prepare('SELECT * FROM history_sync_jobs WHERE message_id = ?'),
			list: db.prepare('SELECT * FROM history_sync_jobs ORDER BY sync_type DESC, chunk_order ASC, created_at ASC'),
			listActive: db.prepare("SELECT * FROM history_sync_jobs WHERE state <> 'committed'"),
			insert: db.prepare(
				'INSERT INTO history_sync_jobs (message_id, source_message_id, message_key_json, message_timestamp, notification, ' +
					'sync_type, chunk_order, progress, state, attempt_count, next_retry_at, lease_until, created_at, updated_at) ' +
					'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, ?, ?) ON CONFLICT(message_id) DO NOTHING'
			),
			replaceReupload: db.prepare(
				'UPDATE history_sync_jobs SET source_message_id = ?, message_key_json = ?, message_timestamp = ?, notification = ?, ' +
					'sync_type = ?, chunk_order = ?, progress = ?, state = ?, next_retry_at = 0, lease_until = 0, ' +
					'last_error = NULL, updated_at = ? WHERE message_id = ? AND state = ?'
			),
			selectRunnable: db.prepare(
				"SELECT candidate.* FROM history_sync_jobs candidate WHERE candidate.state IN ('received','downloading','decoded','applying','failed') " +
					"AND (candidate.state <> 'failed' OR candidate.next_retry_at <= ?) AND candidate.lease_until <= ? " +
					'ORDER BY candidate.sync_type DESC, candidate.chunk_order ASC, candidate.created_at ASC'
			),
			claim: db.prepare(
				"UPDATE history_sync_jobs SET state = 'downloading', attempt_count = attempt_count + 1, lease_until = ?, updated_at = ? " +
					'WHERE message_id = ? AND lease_until <= ?'
			),
			markState: db.prepare(
				"UPDATE history_sync_jobs SET state = ?, updated_at = ? WHERE message_id = ? AND state <> 'committed'"
			),
			markFailed: db.prepare(
				'UPDATE history_sync_jobs SET state = ?, last_error = ?, next_retry_at = ?, lease_until = 0, updated_at = ?, ' +
					"reupload_requested_at = CASE WHEN ? = 'reupload_pending' THEN ? ELSE reupload_requested_at END " +
					"WHERE message_id = ? AND state <> 'committed'"
			),
			markCommitted: db.prepare(
				"UPDATE history_sync_jobs SET state = 'committed', lease_until = 0, updated_at = ?, committed_at = ? WHERE message_id = ?"
			),
			upsertCheckpoint: db.prepare(
				'INSERT INTO history_sync_checkpoints (phase, sync_type, chunk_order, progress, message_id, updated_at) ' +
					'VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(phase) DO UPDATE SET sync_type = excluded.sync_type, ' +
					'chunk_order = excluded.chunk_order, progress = excluded.progress, message_id = excluded.message_id, ' +
					'updated_at = excluded.updated_at WHERE excluded.chunk_order > history_sync_checkpoints.chunk_order ' +
					'OR (excluded.chunk_order = history_sync_checkpoints.chunk_order ' +
					'AND excluded.progress >= history_sync_checkpoints.progress)'
			),
			getCheckpoint: db.prepare('SELECT * FROM history_sync_checkpoints WHERE phase = ?'),
			listCheckpoints: db.prepare('SELECT * FROM history_sync_checkpoints'),
			prune: db.prepare("DELETE FROM history_sync_jobs WHERE state = 'committed' AND committed_at < ?")
		}
	}

	async enqueue(input: HistorySyncJobInput): Promise<StoredHistorySyncJob> {
		const existing = await this.get(input.messageId)
		if (existing?.state === 'committed' || (existing && existing.state !== 'reupload_pending')) return existing

		const now = Date.now()
		if (existing) {
			this.stmts.replaceReupload.run(
				input.sourceMessageId,
				JSON.stringify(input.messageKey, BufferJSON.replacer),
				input.messageTimestamp ?? null,
				Buffer.from(input.notification),
				input.syncType,
				input.chunkOrder,
				input.progress,
				'received',
				now,
				input.messageId,
				'reupload_pending'
			)
		} else {
			this.stmts.insert.run(
				input.messageId,
				input.sourceMessageId,
				JSON.stringify(input.messageKey, BufferJSON.replacer),
				input.messageTimestamp ?? null,
				Buffer.from(input.notification),
				input.syncType,
				input.chunkOrder,
				input.progress,
				'received',
				0,
				now,
				now
			)
		}

		return (await this.get(input.messageId))!
	}

	async claimNext(
		now: number,
		leaseMs: number,
		prerequisites = DEFAULT_PREREQUISITES
	): Promise<StoredHistorySyncJob | null> {
		const claim = this.db.transaction((): StoredHistorySyncJob | null => {
			const rows = this.stmts.selectRunnable.all(now, now) as JobRow[]
			const jobs = (this.stmts.listActive.all() as JobRow[]).map(rowToJob)
			const checkpoints = Object.fromEntries(
				(this.stmts.listCheckpoints.all() as CheckpointRow[]).map(row => [row.phase, rowToCheckpoint(row)])
			) as Partial<Record<HistorySyncCheckpointPhase, HistorySyncCheckpoint>>
			const row = rows.find(candidate => isProtocolEligible(jobs, checkpoints, rowToJob(candidate), prerequisites))
			if (!row) return null
			if (this.stmts.claim.run(now + leaseMs, now, row.message_id, now).changes === 0) return null
			return rowToJob(this.stmts.get.get(row.message_id) as JobRow)
		})
		return claim.immediate()
	}

	async markState(messageId: string, state: 'decoded' | 'applying'): Promise<void> {
		this.stmts.markState.run(state, Date.now(), messageId)
	}

	async markFailed(messageId: string, failure: HistorySyncFailure): Promise<void> {
		const state: HistorySyncJobState = failure.reuploadPending ? 'reupload_pending' : 'failed'
		const now = Date.now()
		this.stmts.markFailed.run(state, failure.error, failure.nextRetryAt, now, state, now, messageId)
	}

	async commit(messageId: string, checkpoint?: HistorySyncCheckpoint): Promise<void> {
		const commit = this.db.transaction(() => {
			const now = Date.now()
			if (this.stmts.markCommitted.run(now, now, messageId).changes === 0) {
				throw new Error(`history sync job not found: ${messageId}`)
			}

			if (checkpoint) {
				this.stmts.upsertCheckpoint.run(
					checkpoint.phase,
					checkpoint.syncType,
					checkpoint.chunkOrder,
					checkpoint.progress,
					checkpoint.messageId,
					checkpoint.updatedAt
				)
			}
		})
		commit.immediate()
	}

	async get(messageId: string): Promise<StoredHistorySyncJob | null> {
		const row = this.stmts.get.get(messageId) as JobRow | undefined
		return row ? rowToJob(row) : null
	}

	async list(): Promise<StoredHistorySyncJob[]> {
		return (this.stmts.list.all() as JobRow[]).map(rowToJob)
	}

	async getCheckpoint(phase: HistorySyncCheckpointPhase): Promise<HistorySyncCheckpoint | null> {
		const row = this.stmts.getCheckpoint.get(phase) as CheckpointRow | undefined
		return row ? rowToCheckpoint(row) : null
	}

	async pruneCommitted(before: number): Promise<number> {
		return this.stmts.prune.run(before).changes
	}
}
