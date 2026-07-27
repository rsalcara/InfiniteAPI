import { createInboundTaskAdmission } from '../../Socket/inbound-task-admission'

const deferred = () => {
	let resolve!: () => void
	const promise = new Promise<void>(done => {
		resolve = done
	})
	return { promise, resolve }
}

describe('inbound task admission', () => {
	it('rejects new top-level work after close and drains admitted parent and derived work', async () => {
		const errors: Array<{ error: Error; identifier: string }> = []
		const admission = createInboundTaskAdmission((error, identifier) => errors.push({ error, identifier }))
		const releaseParent = deferred()
		const releaseDerived = deferred()
		let externalWorkRan = false
		let derivedWorkRan = false

		expect(
			admission.track('parent', async () => {
				await releaseParent.promise
				expect(
					admission.track('derived', async () => {
						derivedWorkRan = true
						await releaseDerived.promise
					})
				).toBe(true)
			})
		).toBe(true)

		expect(admission.close()).toBe(1)
		expect(admission.isAccepting()).toBe(false)
		expect(
			admission.track('late external work', async () => {
				externalWorkRan = true
			})
		).toBe(false)

		let drained = false
		const drainPromise = admission.drain().then(() => {
			drained = true
		})

		releaseParent.resolve()
		await Promise.resolve()
		await Promise.resolve()

		expect(derivedWorkRan).toBe(true)
		expect(externalWorkRan).toBe(false)
		expect(drained).toBe(false)
		expect(admission.pendingCount()).toBeGreaterThan(0)

		releaseDerived.resolve()
		await drainPromise

		expect(drained).toBe(true)
		expect(admission.pendingCount()).toBe(0)
		expect(errors).toEqual([])
	})

	it('reports admitted task failures without rejecting drain', async () => {
		const errors: Array<{ error: Error; identifier: string }> = []
		const admission = createInboundTaskAdmission((error, identifier) => errors.push({ error, identifier }))

		expect(
			admission.track('failing task', async () => {
				throw new Error('failed inside admitted work')
			})
		).toBe(true)

		admission.close()
		await expect(admission.drain()).resolves.toBeUndefined()
		expect(errors).toHaveLength(1)
		expect(errors[0]?.identifier).toBe('failing task')
		expect(errors[0]?.error.message).toBe('failed inside admitted work')
	})

	it('rejects timer work inherited from a task that already settled', async () => {
		const admission = createInboundTaskAdmission(() => {})
		let lateWorkAccepted: boolean | undefined
		let lateWorkRan = false
		let resolveTimerAttempt!: () => void
		const timerAttempted = new Promise<void>(resolve => {
			resolveTimerAttempt = resolve
		})

		expect(
			admission.track('timer parent', async () => {
				setTimeout(() => {
					lateWorkAccepted = admission.track('late timer work', async () => {
						lateWorkRan = true
					})
					resolveTimerAttempt()
				}, 10)
			})
		).toBe(true)

		admission.close()
		await admission.drain()
		expect(admission.pendingCount()).toBe(0)

		await timerAttempted
		expect(lateWorkAccepted).toBe(false)
		expect(lateWorkRan).toBe(false)
		expect(admission.pendingCount()).toBe(0)
	})
})
