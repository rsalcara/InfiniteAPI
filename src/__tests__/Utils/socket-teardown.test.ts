import { Boom } from '@hapi/boom'
import { createExpectedSocketTeardownError, isExpectedSocketTeardownError } from '../../Utils/socket-teardown'

describe('socket teardown errors', () => {
	it('classifies only locally marked connection-closed errors as expected teardown', () => {
		const error = createExpectedSocketTeardownError()

		expect(error.output.statusCode).toBe(428)
		expect(isExpectedSocketTeardownError(error)).toBe(true)
	})

	it('does not hide an unmarked server or network 428', () => {
		const error = new Boom('Connection Closed', { statusCode: 428 })

		expect(isExpectedSocketTeardownError(error)).toBe(false)
	})

	it('does not classify unrelated failures', () => {
		expect(isExpectedSocketTeardownError(new Error('database failed'))).toBe(false)
		expect(isExpectedSocketTeardownError(undefined)).toBe(false)
	})
})
