import { makeSocketOperationGate } from '../../Socket/socket-operation-gate'
import { isExpectedSocketTeardownError } from '../../Utils/socket-teardown'

describe('socket operation gate', () => {
	it('drains admitted work and rejects work from the closing generation', async () => {
		const gate = makeSocketOperationGate()
		let releaseOperation!: () => void
		const operationBlocker = new Promise<void>(resolve => {
			releaseOperation = resolve
		})
		let drainSettled = false

		const admitted = gate.run(async () => {
			await operationBlocker
			return 'completed'
		})
		expect(gate.activeCount()).toBe(1)

		const drain = gate.closeAdmission(new Error('transport closed')).then(() => {
			drainSettled = true
		})
		const lateError = await gate.run(async () => 'late').catch(error => error)
		expect(isExpectedSocketTeardownError(lateError)).toBe(true)
		expect(drainSettled).toBe(false)

		releaseOperation()
		await expect(admitted).resolves.toBe('completed')
		await drain
		expect(drainSettled).toBe(true)
		expect(gate.activeCount()).toBe(0)
	})

	it('closes immediately when no operation is active', async () => {
		const gate = makeSocketOperationGate()

		await expect(gate.closeAdmission()).resolves.toBeUndefined()
		expect(gate.isClosed()).toBe(true)
		const lateError = await gate.run(() => undefined).catch(error => error)
		expect(isExpectedSocketTeardownError(lateError)).toBe(true)
	})

	it('releases the drain when admitted work fails', async () => {
		const gate = makeSocketOperationGate()
		let rejectOperation!: (error: Error) => void
		const operationBlocker = new Promise<void>((_, reject) => {
			rejectOperation = reject
		})
		const admitted = gate.run(() => operationBlocker)
		const drain = gate.closeAdmission()

		rejectOperation(new Error('send failed'))
		await expect(admitted).rejects.toThrow('send failed')
		await expect(drain).resolves.toBeUndefined()
	})
})
