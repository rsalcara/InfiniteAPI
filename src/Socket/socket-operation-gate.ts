import { createExpectedSocketTeardownError } from '../Utils/socket-teardown'

/**
 * Prevents a socket generation from admitting new Signal/LID work after its
 * teardown starts, while allowing work admitted before teardown to settle.
 */
export const makeSocketOperationGate = () => {
	let closed = false
	let closeCause: unknown
	let activeOperations = 0
	let resolveDrain: (() => void) | undefined
	let drainPromise: Promise<void> | undefined

	const waitForDrain = (): Promise<void> => {
		if (activeOperations === 0) return Promise.resolve()

		drainPromise ??= new Promise<void>(resolve => {
			resolveDrain = resolve
		})
		return drainPromise
	}

	const closeAdmission = (cause?: unknown): Promise<void> => {
		if (!closed) {
			closed = true
			closeCause = cause
		}

		return waitForDrain()
	}

	const run = async <T>(operation: () => Promise<T> | T): Promise<T> => {
		// Check and increment without an await between them. Once closeAdmission()
		// runs, no later operation can become visible as admitted.
		if (closed) throw createExpectedSocketTeardownError(closeCause)
		activeOperations += 1

		try {
			return await operation()
		} finally {
			activeOperations -= 1
			if (closed && activeOperations === 0) {
				resolveDrain?.()
				resolveDrain = undefined
			}
		}
	}

	return {
		run,
		closeAdmission,
		isClosed: () => closed,
		activeCount: () => activeOperations
	}
}

export type SocketOperationGate = ReturnType<typeof makeSocketOperationGate>
