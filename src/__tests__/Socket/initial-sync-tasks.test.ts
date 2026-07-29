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
		const order: string[] = []
		const prepareFailureRelease = jest.fn(() => order.push('state-online'))
		const settled = settleInitialSyncTasks(
			[Promise.reject(failure), secondTask],
			() => false,
			failed => {
				order.push(`release-${failed}`)
				releaseBuffer(failed)
			},
			prepareFailureRelease
		)

		await Promise.resolve()
		expect(releaseBuffer).not.toHaveBeenCalled()

		finishSecond()
		await expect(settled).rejects.toBe(failure)
		expect(prepareFailureRelease).toHaveBeenCalledTimes(1)
		expect(releaseBuffer).toHaveBeenCalledTimes(1)
		expect(releaseBuffer).toHaveBeenCalledWith(true)
		expect(order).toEqual(['state-online', 'release-true'])
	})

	it('releases after successful app-state sync but not for an ordinary message window', async () => {
		const releaseAfterSync = jest.fn()
		const prepareFailureRelease = jest.fn()
		await settleInitialSyncTasks(
			[Promise.resolve(), Promise.resolve()],
			() => true,
			releaseAfterSync,
			prepareFailureRelease
		)
		expect(releaseAfterSync).toHaveBeenCalledWith(false)
		expect(prepareFailureRelease).not.toHaveBeenCalled()

		const keepBuffered = jest.fn()
		await settleInitialSyncTasks([Promise.resolve(), Promise.resolve()], () => false, keepBuffered)
		expect(keepBuffered).not.toHaveBeenCalled()
	})

	it('still releases and preserves the task failure when failure preparation throws', async () => {
		const failure = new Error('sync failed')
		const releaseBuffer = jest.fn()

		await expect(
			settleInitialSyncTasks(
				[Promise.reject(failure)],
				() => false,
				releaseBuffer,
				() => {
					throw new Error('state preparation failed')
				}
			)
		).rejects.toBe(failure)
		expect(releaseBuffer).toHaveBeenCalledWith(true)
	})
})
