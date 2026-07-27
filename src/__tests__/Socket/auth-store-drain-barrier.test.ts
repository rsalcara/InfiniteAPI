import { getAuthStoreDrainBarrier, registerAuthStoreDrainBarrier } from '../../Socket/auth-store-drain-barrier'

describe('auth-store drain barrier', () => {
	it('keeps a replacement socket blocked until the old drain settles', async () => {
		const authKeyStore = {}
		let releaseDrain!: () => void
		const drain = new Promise<void>(resolve => {
			releaseDrain = resolve
		})

		const barrier = registerAuthStoreDrainBarrier(authKeyStore, drain)
		let reconnectReleased = false
		void getAuthStoreDrainBarrier(authKeyStore)!.then(() => {
			reconnectReleased = true
		})

		await Promise.resolve()
		expect(reconnectReleased).toBe(false)

		releaseDrain()
		await barrier
		expect(reconnectReleased).toBe(true)
		expect(getAuthStoreDrainBarrier(authKeyStore)).toBeUndefined()
	})

	it('waits for every deferred socket drain registered for the same store', async () => {
		const authKeyStore = {}
		let releaseFirst!: () => void
		let releaseSecond!: () => void
		const first = new Promise<void>(resolve => {
			releaseFirst = resolve
		})
		const second = new Promise<void>(resolve => {
			releaseSecond = resolve
		})

		registerAuthStoreDrainBarrier(authKeyStore, first)
		const combined = registerAuthStoreDrainBarrier(authKeyStore, second)
		let completed = false
		void combined.then(() => {
			completed = true
		})

		releaseSecond()
		await Promise.resolve()
		expect(completed).toBe(false)

		releaseFirst()
		await combined
		expect(completed).toBe(true)
	})
})
