import type { WAMessageKey } from './Message'

export type HistorySyncJobState =
	| 'received'
	| 'downloading'
	| 'decoded'
	| 'applying'
	| 'committed'
	| 'failed'
	| 'reupload_pending'

export type HistorySyncCheckpointPhase = 'INITIAL' | 'RECENT' | 'FULL'

export type HistorySyncJobInput = {
	messageId: string
	sourceMessageId: string
	messageKey: WAMessageKey
	messageTimestamp?: number
	notification: Uint8Array
	syncType: number
	chunkOrder: number
	progress: number
}

export type StoredHistorySyncJob = HistorySyncJobInput & {
	state: HistorySyncJobState
	attemptCount: number
	nextRetryAt: number
	leaseUntil: number
	lastError?: string
	createdAt: number
	updatedAt: number
	committedAt?: number
	postCommitCompletedAt?: number
	reuploadRequestedAt?: number
}

export type HistorySyncCheckpoint = {
	phase: HistorySyncCheckpointPhase
	syncType: number
	chunkOrder: number
	progress: number
	messageId: string
	updatedAt: number
}

export type HistorySyncFailure = {
	error: string
	nextRetryAt: number
	reuploadPending: boolean
}

export type HistorySyncPrerequisites = {
	initialComplete: boolean
	recentComplete: boolean
	allowMissingCheckpoint: boolean
}

export type HistorySyncStoreSnapshot = {
	jobs: StoredHistorySyncJob[]
	checkpoints: HistorySyncCheckpoint[]
	compatibilityBaselineConsumed: boolean
}

export type HistorySyncImportResult = {
	jobs: number
	checkpoints: number
	compatibilityBaselineUpdated: boolean
}

/** Durable queue capability supplied by the built-in auth-state adapters. */
export interface HistorySyncStore {
	enqueue(input: HistorySyncJobInput): Promise<StoredHistorySyncJob>
	claimNext(
		now: number,
		leaseMs: number,
		prerequisites?: HistorySyncPrerequisites
	): Promise<StoredHistorySyncJob | null>
	markState(messageId: string, state: 'decoded' | 'applying'): Promise<void>
	markFailed(messageId: string, failure: HistorySyncFailure): Promise<void>
	commit(messageId: string, checkpoint?: HistorySyncCheckpoint): Promise<void>
	markPostCommitCompleted(messageId: string, completedAt?: number): Promise<void>
	get(messageId: string): Promise<StoredHistorySyncJob | null>
	list(): Promise<StoredHistorySyncJob[]>
	getCheckpoint(phase: HistorySyncCheckpointPhase): Promise<HistorySyncCheckpoint | null>
	pruneCommitted(before: number): Promise<number>
	exportState(): Promise<HistorySyncStoreSnapshot>
	importState(snapshot: HistorySyncStoreSnapshot): Promise<HistorySyncImportResult>
	clear(): Promise<void>
}
