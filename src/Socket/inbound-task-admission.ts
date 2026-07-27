import { AsyncLocalStorage } from 'async_hooks'

type InboundTaskErrorHandler = (error: Error, identifier: string) => void

type AdmissionToken = {
	active: boolean
}

/**
 * Tracks receive-path work admitted by one socket.
 *
 * `close()` is synchronous so teardown can stop new top-level work before its
 * first await. Work derived from an already-admitted task remains admissible
 * and is included in `drain()`, preventing a parent task from outliving one of
 * its own deferred children.
 */
export const createInboundTaskAdmission = (onError: InboundTaskErrorHandler) => {
	let accepting = true
	const tasks = new Set<Promise<void>>()
	const context = new AsyncLocalStorage<AdmissionToken>()

	const track = (identifier: string, factory: () => Promise<void>): boolean => {
		const derivedFromAdmittedTask = context.getStore()?.active === true
		if (!accepting && !derivedFromAdmittedTask) return false

		const token: AdmissionToken = { active: true }
		const task = context
			.run(token, factory)
			.catch(error => onError(error instanceof Error ? error : new Error(String(error)), identifier))
		tasks.add(task)
		const finalize = () => {
			// AsyncLocalStorage propagates into timers created by this task.
			// Expiring the shared token prevents those callbacks from admitting
			// work after their originating task has settled and drain returned.
			token.active = false
			tasks.delete(task)
		}

		void task.then(finalize, finalize)
		return true
	}

	const close = (): number => {
		accepting = false
		return tasks.size
	}

	const drain = async (): Promise<void> => {
		// Admitted parents may create derived tasks while settling. Re-snapshot
		// until the set stays empty so teardown cannot destroy stores early.
		while (tasks.size > 0) {
			await Promise.allSettled([...tasks])
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
