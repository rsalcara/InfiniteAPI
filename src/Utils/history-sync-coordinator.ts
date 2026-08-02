import Long from 'long'
import { proto } from '../../WAProto/index.js'
import type {
	HistorySyncCheckpoint,
	HistorySyncCheckpointPhase,
	HistorySyncJobInput,
	HistorySyncPrerequisites,
	HistorySyncStore,
	StoredHistorySyncJob,
	WAMessageKey
} from '../Types'
import { toNumber } from './generics'
import { downloadAndProcessHistorySyncNotification } from './history'
import type { ILogger } from './logger'

export type ProcessedHistorySync = Awaited<ReturnType<typeof downloadAndProcessHistorySyncNotification>>

export type HistorySyncRuntimeStatus = {
	initialBootstrapComplete: boolean
	recentSyncComplete: boolean
	recentSyncPaused: boolean
	fullSyncComplete: boolean
}

export type DurableHistorySyncCoordinatorOptions = {
	store: HistorySyncStore
	requestOptions: RequestInit
	logger?: ILogger
	apply: (job: StoredHistorySyncJob, data: ProcessedHistorySync, signal: AbortSignal) => Promise<void>
	requestReupload: (job: StoredHistorySyncJob, mediaKey: Uint8Array) => Promise<void>
	download?: typeof downloadAndProcessHistorySyncNotification
	onCommitted?: (job: StoredHistorySyncJob) => Promise<void> | void
	now?: () => number
	random?: () => number
	leaseMs?: number
	maxLocalAttempts?: number
	retentionMs?: number
	drainTimeoutMs?: number
	initialHistorySyncComplete?: boolean
	recentHistorySyncComplete?: boolean
	allowMissingHistoryCheckpoint?: boolean
}

const DEFAULT_LEASE_MS = 5 * 60_000
const DEFAULT_RETENTION_MS = 7 * 24 * 60 * 60_000
const MAX_JOBS_PER_TURN = 8
const RETRY_BASE_MS = 1_000
const RETRY_MAX_MS = 60_000

const postCommitRecoveryRank = (job: StoredHistorySyncJob): number => {
	switch (historySyncCheckpointPhase(job.syncType)) {
		case 'INITIAL':
			return 0
		case 'RECENT':
			return 1
		case 'FULL':
			return 2
		default:
			return 3
	}
}

const delayToEventLoop = (): Promise<void> => new Promise(resolve => setImmediate(resolve))

const errorStatus = (error: unknown): number | undefined => {
	if (!error || typeof error !== 'object') return undefined
	const candidate = error as { output?: { statusCode?: unknown }; statusCode?: unknown }
	const value = candidate.output?.statusCode ?? candidate.statusCode
	return typeof value === 'number' ? value : undefined
}

const errorMessage = (error: unknown): string => {
	if (error instanceof Error) return error.message.slice(0, 512)
	try {
		return String(error).slice(0, 512)
	} catch {
		return 'unknown history sync error'
	}
}

export const historySyncCheckpointPhase = (syncType: number): HistorySyncCheckpointPhase | undefined => {
	switch (syncType) {
		case proto.HistorySync.HistorySyncType.INITIAL_BOOTSTRAP:
			return 'INITIAL'
		case proto.HistorySync.HistorySyncType.RECENT:
			return 'RECENT'
		case proto.HistorySync.HistorySyncType.FULL:
			return 'FULL'
		default:
			return undefined
	}
}

/** Marks only protocol completion boundaries; a paused live-event timeout is not completion. */
export const markHistorySyncCheckpointComplete = (
	status: HistorySyncRuntimeStatus,
	notification: proto.Message.IHistorySyncNotification
): boolean => {
	const syncType = notification.syncType as proto.HistorySync.HistorySyncType
	if (syncType === proto.HistorySync.HistorySyncType.INITIAL_BOOTSTRAP) {
		if (status.initialBootstrapComplete) return false
		status.initialBootstrapComplete = true
		return true
	}

	if (syncType === proto.HistorySync.HistorySyncType.RECENT && notification.progress === 100) {
		if (status.recentSyncComplete) return false
		status.recentSyncComplete = true
		status.recentSyncPaused = false
		return true
	}

	if (syncType === proto.HistorySync.HistorySyncType.FULL && notification.progress === 100) {
		if (status.fullSyncComplete) return false
		status.fullSyncComplete = true
		return true
	}

	return false
}

export const makeHistorySyncJobInput = (
	messageKey: WAMessageKey,
	messageTimestamp: number | Long | null | undefined,
	notification: proto.Message.IHistorySyncNotification
): HistorySyncJobInput => {
	const sourceMessageId = messageKey.id
	if (!sourceMessageId) throw new Error('history sync notification is missing its message id')
	const messageId = notification.originalMessageId || sourceMessageId

	return {
		messageId,
		sourceMessageId,
		messageKey: { ...messageKey },
		messageTimestamp:
			messageTimestamp === null || messageTimestamp === undefined ? undefined : toNumber(messageTimestamp),
		notification: proto.Message.HistorySyncNotification.encode(notification).finish(),
		syncType: notification.syncType ?? 0,
		chunkOrder: notification.chunkOrder ?? 0,
		progress: notification.progress ?? 0
	}
}

/** Adapts durable write batches to observed latency while staying within the official 1..500 range. */
export class AdaptiveHistoryBatchController {
	private size: number

	constructor(
		initialSize = 50,
		private readonly minSize = 1,
		private readonly maxSize = 500,
		private readonly targetMs = 150
	) {
		this.size = Math.max(minSize, Math.min(maxSize, initialSize))
	}

	current(): number {
		return this.size
	}

	record(durationMs: number): number {
		if (durationMs > this.targetMs * 2) {
			this.size = Math.max(this.minSize, Math.floor(this.size / 2))
		} else if (durationMs < this.targetMs / 2) {
			this.size = Math.min(this.maxSize, Math.max(this.size + 1, Math.ceil(this.size * 1.25)))
		}

		return this.size
	}
}

export class DurableHistorySyncCoordinator {
	private readonly now: () => number
	private readonly random: () => number
	private readonly leaseMs: number
	private readonly maxLocalAttempts: number
	private readonly retentionMs: number
	private readonly drainTimeoutMs: number
	private readonly prerequisites: HistorySyncPrerequisites
	private worker?: Promise<void>
	private timer?: NodeJS.Timeout
	private rerunRequested = false
	private stopped = false
	private currentAbort?: AbortController
	private currentJobId?: string
	private currentStoreMutation?: Promise<unknown>

	constructor(private readonly options: DurableHistorySyncCoordinatorOptions) {
		this.now = options.now ?? Date.now
		this.random = options.random ?? Math.random
		this.leaseMs = options.leaseMs ?? DEFAULT_LEASE_MS
		this.maxLocalAttempts = options.maxLocalAttempts ?? 5
		this.retentionMs = options.retentionMs ?? DEFAULT_RETENTION_MS
		this.drainTimeoutMs = options.drainTimeoutMs ?? 2_000
		this.prerequisites = {
			initialComplete: options.initialHistorySyncComplete ?? true,
			recentComplete: options.recentHistorySyncComplete ?? true,
			allowMissingCheckpoint: options.allowMissingHistoryCheckpoint ?? true
		}
	}

	async enqueue(
		messageKey: WAMessageKey,
		messageTimestamp: number | Long | null | undefined,
		notification: proto.Message.IHistorySyncNotification
	): Promise<StoredHistorySyncJob> {
		const job = await this.options.store.enqueue(makeHistorySyncJobInput(messageKey, messageTimestamp, notification))
		this.schedule(0)
		return job
	}

	async startRecovery(): Promise<void> {
		await this.options.store.pruneCommitted(this.now() - this.retentionMs)
		const jobs = await this.options.store.list()
		this.schedule(0)
		const committed = jobs
			.filter(job => job.state === 'committed')
			.sort(
				(left, right) =>
					postCommitRecoveryRank(left) - postCommitRecoveryRank(right) || left.chunkOrder - right.chunkOrder
			)
		for (const job of committed) await this.runPostCommit(job)

		for (const job of jobs) {
			if (job.state !== 'reupload_pending') continue
			await this.requestReupload(job).catch(error =>
				this.options.logger?.warn(
					{ error, messageId: job.messageId },
					'history sync reupload request could not be resumed; it remains durable'
				)
			)
		}
	}

	private schedule(delayMs: number): void {
		if (this.stopped) return
		if (this.worker && delayMs <= 0) {
			this.rerunRequested = true
			return
		}

		if (this.timer) clearTimeout(this.timer)
		this.timer = setTimeout(
			() => {
				this.timer = undefined
				if (!this.worker) {
					this.worker = this.run()
						.catch(error => this.options.logger?.error({ error }, 'durable history sync worker stopped unexpectedly'))
						.finally(() => {
							this.worker = undefined
							if (this.rerunRequested) {
								this.rerunRequested = false
								this.schedule(0)
							}
						})
				}
			},
			Math.max(0, delayMs)
		)
		this.timer.unref?.()
	}

	private nextRetryDelay(jobs: StoredHistorySyncJob[]): number | undefined {
		const due = jobs
			.flatMap(job => {
				if (job.state === 'failed') return [job.nextRetryAt]
				if (
					(job.state === 'downloading' || job.state === 'decoded' || job.state === 'applying') &&
					job.leaseUntil > this.now()
				) {
					return [job.leaseUntil]
				}

				return []
			})
			.sort((left, right) => left - right)[0]
		return due === undefined ? undefined : Math.max(0, due - this.now())
	}

	private async run(): Promise<void> {
		let processed = 0
		while (!this.stopped && processed < MAX_JOBS_PER_TURN) {
			const job = await this.options.store.claimNext(this.now(), this.leaseMs, this.prerequisites)
			if (!job) break
			await this.process(job)
			processed++
			await delayToEventLoop()
		}

		if (this.stopped) return
		if (processed === MAX_JOBS_PER_TURN) {
			this.schedule(0)
			return
		}

		const jobs = await this.options.store.list()
		const retryDelay = this.nextRetryDelay(jobs)
		if (retryDelay !== undefined) this.schedule(retryDelay)
	}

	private makeCheckpoint(job: StoredHistorySyncJob): HistorySyncCheckpoint | undefined {
		const phase = historySyncCheckpointPhase(job.syncType)
		if (!phase) return undefined
		return {
			phase,
			syncType: job.syncType,
			chunkOrder: job.chunkOrder,
			progress: job.progress,
			messageId: job.messageId,
			updatedAt: this.now()
		}
	}

	private markPrerequisiteComplete(job: StoredHistorySyncJob): void {
		const phase = historySyncCheckpointPhase(job.syncType)
		if (phase === 'INITIAL') this.prerequisites.initialComplete = true
		if (phase === 'RECENT' && job.progress === 100) this.prerequisites.recentComplete = true
	}

	private async runPostCommit(job: StoredHistorySyncJob): Promise<void> {
		try {
			await this.options.onCommitted?.(job)
		} catch (error) {
			this.options.logger?.warn(
				{ error, messageId: job.messageId },
				'history sync committed but its post-commit callback failed and will be reconciled on reconnect'
			)
		}
	}

	private async mutateStore<T>(operation: () => Promise<T>): Promise<T> {
		const mutation = operation()
		this.currentStoreMutation = mutation
		try {
			return await mutation
		} finally {
			if (this.currentStoreMutation === mutation) this.currentStoreMutation = undefined
		}
	}

	private async process(job: StoredHistorySyncJob): Promise<void> {
		let downloaded = false
		let committed = false
		let canRequestReupload = false
		let forwardParentAbort: (() => void) | undefined
		this.currentJobId = job.messageId
		try {
			const notification = proto.Message.HistorySyncNotification.decode(job.notification)
			canRequestReupload = Boolean(notification.mediaKey?.length)
			this.currentAbort = new AbortController()
			const parentSignal = this.options.requestOptions.signal
			if (parentSignal?.aborted) {
				this.currentAbort.abort()
			} else if (parentSignal) {
				forwardParentAbort = () => this.currentAbort?.abort()
				parentSignal.addEventListener('abort', forwardParentAbort, { once: true })
			}

			const download = this.options.download ?? downloadAndProcessHistorySyncNotification
			const data = await download(
				notification,
				{ ...this.options.requestOptions, signal: this.currentAbort.signal },
				this.options.logger
			)
			downloaded = true
			if (this.stopped) return
			await this.mutateStore(() => this.options.store.markState(job.messageId, 'decoded'))
			if (this.stopped) return
			await this.mutateStore(() => this.options.store.markState(job.messageId, 'applying'))
			if (this.stopped) return
			await this.options.apply(job, data, this.currentAbort.signal)
			if (this.stopped) return
			await this.mutateStore(() => this.options.store.commit(job.messageId, this.makeCheckpoint(job)))
			committed = true
			this.markPrerequisiteComplete(job)
			await this.runPostCommit(job)

			this.options.logger?.info(
				{ messageId: job.messageId, syncType: job.syncType, chunkOrder: job.chunkOrder, progress: job.progress },
				'history sync chunk committed durably'
			)
		} catch (error) {
			// stop() owns the durable interruption checkpoint. A stale worker must
			// never write after teardown has returned and the auth stores may close.
			if (this.stopped) return
			if (committed) {
				this.options.logger?.warn(
					{ error, messageId: job.messageId },
					'history sync post-commit work failed; durable checkpoint remains authoritative'
				)
				return
			}

			const reuploadPending =
				!this.stopped && !downloaded && canRequestReupload && this.requiresReupload(error, job.attemptCount)
			const nextRetryAt = reuploadPending ? 0 : this.now() + this.retryDelay(job.attemptCount)
			try {
				await this.mutateStore(() =>
					this.options.store.markFailed(job.messageId, {
						error: errorMessage(error),
						nextRetryAt,
						reuploadPending
					})
				)
			} catch (storeError) {
				this.options.logger?.error(
					{ storeError, messageId: job.messageId },
					'history sync failure state could not be persisted; the active lease remains recoverable'
				)
			}

			if (reuploadPending) {
				await this.requestReupload(job).catch(requestError =>
					this.options.logger?.warn(
						{ requestError, messageId: job.messageId },
						'history sync reupload request failed; durable job retained for reconnect'
					)
				)
			} else {
				this.options.logger?.warn(
					{ error, messageId: job.messageId, attempt: job.attemptCount, nextRetryAt },
					'history sync chunk failed; retry scheduled without blocking live messages'
				)
			}
		} finally {
			if (forwardParentAbort) this.options.requestOptions.signal?.removeEventListener('abort', forwardParentAbort)
			this.currentAbort = undefined
			this.currentJobId = undefined
		}
	}

	private requiresReupload(error: unknown, attemptCount: number): boolean {
		const status = errorStatus(error)
		if (status === 404 || status === 410) return true
		const message = errorMessage(error).toLowerCase()
		if (/hash|hmac|mac mismatch|decrypt|inflate|incorrect data|checksum|corrupt/.test(message)) return true
		return attemptCount >= this.maxLocalAttempts
	}

	private retryDelay(attemptCount: number): number {
		const exponential = Math.min(RETRY_MAX_MS, RETRY_BASE_MS * 2 ** Math.max(0, attemptCount - 1))
		return Math.round(exponential * (0.5 + this.random()))
	}

	private async requestReupload(job: StoredHistorySyncJob): Promise<void> {
		const notification = proto.Message.HistorySyncNotification.decode(job.notification)
		if (!notification.mediaKey?.length) throw new Error('history sync reupload requires a media key')
		await this.options.requestReupload(job, notification.mediaKey)
	}

	async stop(): Promise<void> {
		this.stopped = true
		if (this.timer) {
			clearTimeout(this.timer)
			this.timer = undefined
		}

		this.currentAbort?.abort()
		const activeJobId = this.currentJobId
		const deadline = Date.now() + this.drainTimeoutMs
		const waitWithinDeadline = async (promise: Promise<unknown>): Promise<boolean> => {
			const remaining = deadline - Date.now()
			if (remaining <= 0) return false
			let completed = false
			await Promise.race([
				promise.then(
					() => {
						completed = true
					},
					() => {
						completed = true
					}
				),
				new Promise<void>(resolve => setTimeout(resolve, remaining))
			])
			return completed
		}

		const activeMutation = this.currentStoreMutation
		if (activeMutation && !(await waitWithinDeadline(activeMutation))) {
			this.options.logger?.warn(
				{ messageId: activeJobId },
				'history sync store mutation exceeded teardown deadline; lease-based recovery remains available'
			)
			return
		}

		if (activeJobId) {
			const checkpoint = this.options.store.markFailed(activeJobId, {
				error: 'history sync interrupted by socket teardown',
				nextRetryAt: this.now(),
				reuploadPending: false
			})
			const checkpointed = await waitWithinDeadline(
				checkpoint.catch(error =>
					this.options.logger?.warn(
						{ error, messageId: activeJobId },
						'history sync teardown checkpoint failed; lease-based recovery remains available'
					)
				)
			)
			if (!checkpointed) {
				this.options.logger?.warn(
					{ messageId: activeJobId },
					'history sync teardown checkpoint timed out; lease-based recovery remains available'
				)
				return
			}
		}

		if (this.worker && !(await waitWithinDeadline(this.worker))) {
			this.options.logger?.warn('history sync worker drain timed out; durable job will resume on reconnect')
		}
	}
}
