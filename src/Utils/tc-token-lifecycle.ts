import { Boom } from '@hapi/boom'
import type { SignalDataTypeMap, SignalKeyStoreWithTransaction } from '../Types'
import type { BinaryNode } from '../WABinary'
import { jidNormalizedUser } from '../WABinary'
import type { ILogger } from './logger'
import {
	resolveTcTokenAliases,
	shouldSendNewTcToken,
	type TcTokenAliasResolvers,
	type TcTokenBucketPolicy,
	updateTcTokenIssueState
} from './tc-token-utils'

export type TcTokenIssueJob = SignalDataTypeMap['tctoken-job']

export type TcTokenLifecycleOptions = {
	keys: SignalKeyStoreWithTransaction
	resolvers: TcTokenAliasResolvers
	send: (job: TcTokenIssueJob) => Promise<BinaryNode>
	logger?: ILogger
	now?: () => number
	random?: () => number
	leaseMs?: number
	maxJobsPerTurn?: number
	bucketPolicy?: TcTokenBucketPolicy
}

type Waiter = {
	resolve: (result: BinaryNode) => void
	reject: (error: unknown) => void
}

const RETRY_BASE_MS = 1_000
const RETRY_MAX_MS = 60_000
const DEFAULT_LEASE_MS = 35_000
const DEFAULT_TIMEOUT_MS = 32_000

const errorStatus = (error: unknown): number | undefined => {
	try {
		if (!error || typeof error !== 'object') return undefined
		const candidate = error as { output?: { statusCode?: unknown }; statusCode?: unknown }
		const value = candidate.output?.statusCode ?? candidate.statusCode
		return typeof value === 'number' ? value : undefined
	} catch {
		return undefined
	}
}

const errorMessage = (error: unknown): string => {
	try {
		return String(error instanceof Error ? error.message : error).slice(0, 512)
	} catch {
		return 'unknown trusted-contact token issue error'
	}
}

/**
 * Durable single-flight lifecycle for the official generate-tc-token job.
 * Message delivery only waits for enqueue persistence; the worker owns IQ,
 * retry and ACK state independently from the send transaction.
 */
export class TcTokenLifecycleService {
	private readonly now: () => number
	private readonly random: () => number
	private readonly leaseMs: number
	private readonly maxJobsPerTurn: number
	private readonly waiters = new Map<string, Waiter[]>()
	private readonly trackedJobIds = new Set<string>()
	private timer?: NodeJS.Timeout
	private worker?: Promise<void>
	private rerunRequested = false
	private stopped = false
	private currentJob?: TcTokenIssueJob

	constructor(private readonly options: TcTokenLifecycleOptions) {
		this.now = options.now ?? Date.now
		this.random = options.random ?? Math.random
		this.leaseMs = options.leaseMs ?? DEFAULT_LEASE_MS
		this.maxJobsPerTurn = options.maxJobsPerTurn ?? 8
	}

	async startRecovery(): Promise<void> {
		this.schedule(0)
	}

	async issue(
		jids: string[],
		timestamp = Math.floor(this.now() / 1000),
		timeoutMs = DEFAULT_TIMEOUT_MS
	): Promise<BinaryNode> {
		const normalized = [...new Set(jids.map(jidNormalizedUser))]
		if (!normalized.length) throw new Error('trusted-contact token issue requires at least one JID')
		const pending = await Promise.all(normalized.map(jid => this.enqueueAndWait(jid, timestamp, timeoutMs)))
		return pending.at(-1)!
	}

	async enqueue(
		jids: string[],
		timestamp = Math.floor(this.now() / 1000),
		timeoutMs = DEFAULT_TIMEOUT_MS
	): Promise<void> {
		const normalized = [...new Set(jids.map(jidNormalizedUser))]
		await Promise.all(normalized.map(jid => this.enqueueOne(jid, timestamp, timeoutMs)))
		this.schedule(0)
	}

	private async enqueueAndWait(jid: string, timestamp: number, timeoutMs: number): Promise<BinaryNode> {
		const job = await this.enqueueOne(jid, timestamp, timeoutMs)
		if (job.state === 'terminal') {
			throw new Boom(job.lastError || 'trusted-contact token issue is terminal for the current bucket', {
				statusCode: job.lastStatus ?? 400
			})
		}

		const waiter = new Promise<BinaryNode>((resolve, reject) => {
			const key = this.waiterKey(job)
			this.waiters.set(key, [...(this.waiters.get(key) ?? []), { resolve, reject }])
		})
		this.schedule(0)
		return waiter
	}

	private async enqueueOne(jid: string, timestamp: number, timeoutMs: number): Promise<TcTokenIssueJob> {
		if (this.stopped) throw new Error('trusted-contact token lifecycle is stopped')
		const aliases = await resolveTcTokenAliases(jid, this.options.resolvers)
		const canonicalJid = aliases[0]!
		const records = [
			...aliases.map(id => ({ type: 'tctoken' as const, id })),
			{ type: 'tctoken-job' as const, id: canonicalJid }
		]
		let selected!: TcTokenIssueJob
		const work = async () => {
			const current = (await this.options.keys.get('tctoken-job', [canonicalJid]))[canonicalJid]
			if (
				current &&
				(current.state !== 'terminal' ||
					!shouldSendNewTcToken(current.issueTimestamp, this.options.bucketPolicy, Math.floor(this.now() / 1000)))
			) {
				selected = current
				return
			}

			const now = this.now()
			selected = {
				canonicalJid,
				requestedJid: jid,
				aliases,
				issueTimestamp: timestamp,
				state: 'pending',
				attemptCount: 0,
				nextRetryAt: now,
				leaseUntil: 0,
				timeoutMs,
				createdAt: now,
				updatedAt: now
			}
			await updateTcTokenIssueState({
				keys: this.options.keys,
				aliasGroups: [{ requestedJid: jid, aliases }],
				issueTimestamp: timestamp,
				phase: 'scheduled'
			})
			await this.options.keys.set({ 'tctoken-job': { [canonicalJid]: selected } })
		}

		if (this.options.keys.transactWith) await this.options.keys.transactWith({ records }, work)
		else await this.options.keys.transaction(work, `privacy-token-job:${canonicalJid}`)
		if (selected.state === 'terminal') this.trackedJobIds.delete(canonicalJid)
		else this.trackedJobIds.add(canonicalJid)
		return selected
	}

	private waiterKey(job: Pick<TcTokenIssueJob, 'canonicalJid' | 'issueTimestamp'>): string {
		return `${job.canonicalJid}:${job.issueTimestamp}`
	}

	private settle(job: TcTokenIssueJob, result: BinaryNode | undefined, error?: unknown): void {
		const key = this.waiterKey(job)
		const waiters = this.waiters.get(key) ?? []
		this.waiters.delete(key)
		for (const waiter of waiters) {
			if (error !== undefined) waiter.reject(error)
			else waiter.resolve(result!)
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
				if (this.worker) return
				const run = () => this.runDueJobs()
				this.worker = (this.options.keys.runOutsideTransaction ? this.options.keys.runOutsideTransaction(run) : run())
					.catch(error => {
						this.options.logger?.error({ error }, 'durable trusted-contact token worker failed')
					})
					.finally(() => {
						this.worker = undefined
						if (this.stopped) return
						if (this.rerunRequested) {
							this.rerunRequested = false
							this.schedule(0)
						}
					})
			},
			Math.max(0, delayMs)
		)
		this.timer.unref?.()
	}

	async runDueJobs(): Promise<void> {
		if (this.stopped) return
		const jobs: TcTokenIssueJob[] = []
		if (this.options.keys.list) {
			for await (const [id, job] of this.options.keys.list('tctoken-job')) {
				this.trackedJobIds.add(id)
				jobs.push(job)
			}
		} else if (this.trackedJobIds.size) {
			const ids = [...this.trackedJobIds]
			const records = await this.options.keys.get('tctoken-job', ids)
			for (const id of ids) {
				const job = records[id]
				if (job) jobs.push(job)
				else this.trackedJobIds.delete(id)
			}
		}

		const now = this.now()
		const due = jobs
			.filter(
				job =>
					(job.state === 'pending' || job.state === 'retry' || job.state === 'in_flight') &&
					(job.state === 'in_flight' ? job.leaseUntil <= now : job.nextRetryAt <= now)
			)
			.sort((left, right) => left.nextRetryAt - right.nextRetryAt || left.createdAt - right.createdAt)
			.slice(0, this.maxJobsPerTurn)

		for (const job of due) {
			if (this.stopped) return
			await this.process(job)
		}

		if (due.length === this.maxJobsPerTurn) {
			this.schedule(0)
			return
		}

		const next = jobs
			.filter(job => job.state === 'retry' || job.state === 'in_flight')
			.map(job => (job.state === 'in_flight' ? job.leaseUntil : job.nextRetryAt))
			.filter(timestamp => timestamp > now)
			.sort((left, right) => left - right)[0]
		if (next !== undefined) this.schedule(next - now)
	}

	private async process(snapshot: TcTokenIssueJob): Promise<void> {
		const job = await this.markInFlight(snapshot)
		if (!job) return
		this.currentJob = job
		try {
			const result = await this.options.send(job)
			if (this.stopped) return
			await this.complete(job)
			this.settle(job, result)
		} catch (error) {
			if (this.stopped) return
			const status = errorStatus(error)
			if (status !== undefined && status >= 400 && status < 500) {
				await this.markTerminal(job, error, status)
				this.settle(job, undefined, error)
			} else {
				await this.markRetry(job, error, status)
			}
		} finally {
			if (this.currentJob === job) this.currentJob = undefined
		}
	}

	private async markInFlight(snapshot: TcTokenIssueJob): Promise<TcTokenIssueJob | undefined> {
		let claimed: TcTokenIssueJob | undefined
		await this.mutateJob(snapshot, current => {
			if (current.state === 'in_flight' && current.leaseUntil > this.now()) return current
			claimed = {
				...current,
				state: 'in_flight',
				attemptCount: current.attemptCount + 1,
				leaseUntil: this.now() + this.leaseMs,
				updatedAt: this.now()
			}
			return claimed
		})
		return claimed
	}

	private async complete(job: TcTokenIssueJob): Promise<void> {
		const records = [
			...job.aliases.map(id => ({ type: 'tctoken' as const, id })),
			{ type: 'tctoken-job' as const, id: job.canonicalJid }
		]
		let completed = false
		const work = async () => {
			const current = (await this.options.keys.get('tctoken-job', [job.canonicalJid]))[job.canonicalJid]
			if (current?.issueTimestamp !== job.issueTimestamp) return
			await updateTcTokenIssueState({
				keys: this.options.keys,
				aliasGroups: [{ requestedJid: job.requestedJid, aliases: job.aliases }],
				issueTimestamp: job.issueTimestamp,
				phase: 'confirmed',
				onStaleAck: details =>
					this.options.logger?.debug(
						{ ...details, ackTimestamp: job.issueTimestamp },
						'late trusted-contact token ACK did not overwrite a newer issue'
					)
			})
			await this.options.keys.set({ 'tctoken-job': { [job.canonicalJid]: null } })
			completed = true
		}

		if (this.options.keys.transactWith) await this.options.keys.transactWith({ records }, work)
		else await this.options.keys.transaction(work, `privacy-token-complete:${job.canonicalJid}`)
		if (completed) this.trackedJobIds.delete(job.canonicalJid)
	}

	private async markRetry(job: TcTokenIssueJob, error: unknown, status?: number): Promise<void> {
		const retryDelay = Math.round(
			Math.min(RETRY_MAX_MS, RETRY_BASE_MS * 2 ** Math.max(0, job.attemptCount - 1)) * (0.5 + this.random())
		)
		await this.mutateJob(job, current => ({
			...current,
			state: 'retry',
			nextRetryAt: this.now() + retryDelay,
			leaseUntil: 0,
			updatedAt: this.now(),
			...(status !== undefined ? { lastStatus: status } : {}),
			lastError: errorMessage(error)
		}))
		this.options.logger?.warn(
			{ jid: job.requestedJid, attempt: job.attemptCount, status, retryDelay },
			'trusted-contact token issue failed transiently; durable retry scheduled'
		)
		this.schedule(retryDelay)
	}

	private async markTerminal(job: TcTokenIssueJob, error: unknown, status: number): Promise<void> {
		await this.mutateJob(job, current => ({
			...current,
			state: 'terminal',
			nextRetryAt: 0,
			leaseUntil: 0,
			updatedAt: this.now(),
			lastStatus: status,
			lastError: errorMessage(error)
		}))
		this.options.logger?.warn(
			{ jid: job.requestedJid, attempt: job.attemptCount, status },
			'trusted-contact token issue rejected with terminal 4xx; automatic retry suppressed for this bucket'
		)
		this.trackedJobIds.delete(job.canonicalJid)
	}

	private async mutateJob(job: TcTokenIssueJob, mutate: (current: TcTokenIssueJob) => TcTokenIssueJob): Promise<void> {
		const record = { type: 'tctoken-job' as const, id: job.canonicalJid }
		const work = async () => {
			const current = (await this.options.keys.get('tctoken-job', [job.canonicalJid]))[job.canonicalJid]
			if (current?.issueTimestamp !== job.issueTimestamp) return
			await this.options.keys.set({ 'tctoken-job': { [job.canonicalJid]: mutate(current) } })
		}

		if (this.options.keys.transactWith) await this.options.keys.transactWith({ records: [record] }, work)
		else await this.options.keys.transaction(work, `privacy-token-job:${job.canonicalJid}`)
	}

	async stop(): Promise<void> {
		if (this.stopped) return
		this.stopped = true
		if (this.timer) {
			clearTimeout(this.timer)
			this.timer = undefined
		}

		const current = this.currentJob
		if (current) {
			await this.mutateJob(current, job => ({
				...job,
				state: 'retry',
				nextRetryAt: this.now(),
				leaseUntil: 0,
				updatedAt: this.now(),
				lastError: 'interrupted by socket teardown'
			})).catch(error =>
				this.options.logger?.warn(
					{ error, jid: current.requestedJid },
					'trusted-contact token teardown checkpoint failed; lease recovery remains available'
				)
			)
		}

		const error = new Error('trusted-contact token issue interrupted by socket teardown')
		for (const waiters of this.waiters.values()) for (const waiter of waiters) waiter.reject(error)
		this.waiters.clear()
		this.trackedJobIds.clear()
	}
}
