/**
 * Coordinates socket generations that share the same underlying auth key
 * store. A reconnect may build a new transaction wrapper, so wrapper-local
 * locks alone cannot serialize it with deferred work from the old socket.
 */
const authStoreDrainBarriers = new WeakMap<object, Promise<void>>()

export const getAuthStoreDrainBarrier = (authKeyStore: object): Promise<void> | undefined =>
	authStoreDrainBarriers.get(authKeyStore)

export const registerAuthStoreDrainBarrier = (authKeyStore: object, drain: Promise<unknown>): Promise<void> => {
	const existingDrain = authStoreDrainBarriers.get(authKeyStore)
	const barrier = Promise.allSettled(existingDrain ? [existingDrain, drain] : [drain]).then(() => undefined)

	authStoreDrainBarriers.set(authKeyStore, barrier)
	void barrier.then(() => {
		if (authStoreDrainBarriers.get(authKeyStore) === barrier) {
			authStoreDrainBarriers.delete(authKeyStore)
		}
	})

	return barrier
}
