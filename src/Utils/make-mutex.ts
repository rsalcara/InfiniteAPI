import { Mutex as AsyncMutex } from 'async-mutex'

export const makeMutex = () => {
	const mutex = new AsyncMutex()

	return {
		mutex<T>(code: () => Promise<T> | T): Promise<T> {
			return mutex.runExclusive(code)
		}
	}
}

export type Mutex = ReturnType<typeof makeMutex>

export const makeKeyedMutex = () => {
	const map = new Map<string, { mutex: AsyncMutex; refCount: number }>()

	return {
		async mutex<T>(key: string, task: () => Promise<T> | T): Promise<T> {
			let entry = map.get(key)

			if (!entry) {
				entry = { mutex: new AsyncMutex(), refCount: 0 }
				map.set(key, entry)
			}

			entry.refCount++

			try {
				return await entry.mutex.runExclusive(task)
			} finally {
				entry.refCount--
				// only delete it if this is still the current entry
				if (entry.refCount === 0 && map.get(key) === entry) {
					map.delete(key)
				}
			}
		}
	}
}

export type KeyedMutex = ReturnType<typeof makeKeyedMutex>

/**
 * Preserves admission order for tasks that may take different amounts of time
 * before reaching a keyed mutex. `acquire()` resolves callers in the order they
 * first call it; callers must invoke the returned release function in a
 * `finally` block.
 *
 * This is intentionally separate from `makeKeyedMutex`: ordering can require a
 * stable raw JID before async LID→PN normalization, while the processing mutex
 * requires the normalized chat JID.
 */
export const makeKeyedOrderGate = () => {
	const occupancyByKey = new Map<string, Promise<void>>()

	return {
		async acquire(key: string): Promise<() => void> {
			const previousOccupancy = occupancyByKey.get(key) ?? Promise.resolve()
			let release!: () => void
			const currentOccupancy = new Promise<void>(resolve => {
				release = resolve
			})
			occupancyByKey.set(key, currentOccupancy)
			void currentOccupancy.then(() => {
				if (occupancyByKey.get(key) === currentOccupancy) occupancyByKey.delete(key)
			})

			await previousOccupancy
			return release
		}
	}
}

export type KeyedOrderGate = ReturnType<typeof makeKeyedOrderGate>
