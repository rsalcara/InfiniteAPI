import { jest } from '@jest/globals'
import { settleInitialSyncTasks } from '../../Socket/initial-sync-tasks'

describe('initial sync task settlement', () => {
	it('waits for every task, releases the buffer, and rethrows the first failure', async () => {
		const failure = new Error('history decode failed')
		let finishSecond!: () => void
		const secondTask = new Promise<void>(resolve => {
			finishSecond = resolve
		})
		const releaseBuffer = jest.fn()
		const settled = settleInitialSyncTasks([Promise.reject(failure), secondTask], () => false, releaseBuffer)

		await Promise.resolve()
		expect(releaseBuffer).not.toHaveBeenCalled()

		finishSecond()
		await expect(settled).rejects.toBe(failure)
		expect(releaseBuffer).toHaveBeenCalledTimes(1)
		expect(releaseBuffer).toHaveBeenCalledWith(true)
	})

	it('releases after successful app-state sync but not for an ordinary message window', async () => {
		const releaseAfterSync = jest.fn()
		await settleInitialSyncTasks([Promise.resolve(), Promise.resolve()], () => true, releaseAfterSync)
		expect(releaseAfterSync).toHaveBeenCalledWith(false)

		const keepBuffered = jest.fn()
		await settleInitialSyncTasks([Promise.resolve(), Promise.resolve()], () => false, keepBuffered)
		expect(keepBuffered).not.toHaveBeenCalled()
	})
})
