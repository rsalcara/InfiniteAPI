import { AsyncLocalStorage } from 'async_hooks'

type InboundTaskErrorHandler = (error: Error, identifier: string) => void

type AdmissionToken = {
	active: boolean
}

type InboundTaskAdmissionOptions = {
	drainTimeoutMs?: number
}

export type InboundTaskDrainResult = {
	timedOut: boolean
	pendingTasks: number
	waitedMs: number
}

export const DEFAULT_INBOUND_TASK_DRAIN_TIMEOUT_MS = 15_000

const normalizeInboundTaskError = (error: unknown): Error => {
	if (error instanceof Error) return error

	try {
		return new Error(String(error))
	} catch {
		return new Error('Inbound task rejected with a non-coercible value')
	}
}

/**
 * Tracks receive-path work admitted by one socket.
 *
 * `close()` is synchronous so teardown can stop new top-level work before its
 * first await. Work derived from an already-admitted task remains admissible
 * and is included in `drain()`, preventing a parent task from outliving one of
 * its own deferred children.
 */
export const createInboundTaskAdmission = (
	onError: InboundTaskErrorHandler,
	{ drainTimeoutMs = DEFAULT_INBOUND_TASK_DRAIN_TIMEOUT_MS }: InboundTaskAdmissionOptions = {}
) => {
	let accepting = true
	const tasks = new Set<Promise<void>>()
	const tokens = new Set<AdmissionToken>()
	const context = new AsyncLocalStorage<AdmissionToken>()

	const track = (identifier: string, factory: () => void | Promise<void>): boolean => {
		const derivedFromAdmittedTask = context.getStore()?.active === true
		if (!accepting && !derivedFromAdmittedTask) return false

		const token: AdmissionToken = { active: true }
		tokens.add(token)
		// Starting the factory in a promise reaction converts synchronous throws
		// into rejections handled by the same admission error path.
		const task = Promise.resolve()
			.then(() => context.run(token, factory))
			.catch(error => onError(normalizeInboundTaskError(error), identifier))
		tasks.add(task)
		const finalize = () => {
			// AsyncLocalStorage propagates into timers created by this task.
			// Expiring the shared token prevents those callbacks from admitting
			// work after their originating task has settled and drain returned.
			token.active = false
			tokens.delete(token)
			tasks.delete(task)
		}

		void task.then(finalize, finalize)
		return true
	}

	const close = (): number => {
		accepting = false
		return tasks.size
	}

	const drain = async (): Promise<InboundTaskDrainResult> => {
		const startedAt = Date.now()
		const deadline = startedAt + drainTimeoutMs

		// Admitted parents may create derived tasks while settling. Re-snapshot
		// until the set stays empty, but use one global deadline so repeated
		// snapshots cannot extend teardown indefinitely.
		while (tasks.size > 0) {
			const remainingMs = deadline - Date.now()
			if (remainingMs <= 0) break

			let timeout: ReturnType<typeof setTimeout> | undefined
			const snapshotSettled = Promise.allSettled([...tasks]).then(() => true)
			const settledBeforeDeadline = await Promise.race([
				snapshotSettled,
				new Promise<false>(resolve => {
					timeout = setTimeout(() => resolve(false), remainingMs)
				})
			])
			if (timeout) clearTimeout(timeout)
			if (!settledBeforeDeadline) break
		}

		const timedOut = tasks.size > 0
		if (timedOut) {
			// Closing admission rejects new roots. Expiring every active token
			// also rejects work derived later by callbacks inherited from tasks
			// that outlived the deadline.
			for (const token of tokens) token.active = false
		}

		return {
			timedOut,
			pendingTasks: tasks.size,
			waitedMs: Date.now() - startedAt
		}
	}

	return {
		track,
		close,
		drain,
		isAccepting: () => accepting,
		pendingCount: () => tasks.size
	}
}
