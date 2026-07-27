import { Boom } from '@hapi/boom'

const CONNECTION_CLOSED_STATUS_CODE = 428
const SOCKET_TEARDOWN_REASON = 'socket-teardown'

type BoomLike = {
	data?: unknown
	output?: {
		statusCode?: number
	}
}

/**
 * Creates the local connection-closed error used after this socket has entered
 * teardown. The marker distinguishes expected cancellation of in-flight work
 * from a server/network 428 that still needs operator visibility.
 */
export const createExpectedSocketTeardownError = () =>
	new Boom('Connection Closed', {
		statusCode: CONNECTION_CLOSED_STATUS_CODE,
		data: { reason: SOCKET_TEARDOWN_REASON }
	})

/** Returns true only for a 428 explicitly created by the local teardown path. */
export const isExpectedSocketTeardownError = (error: unknown): boolean => {
	if (!error || typeof error !== 'object') return false

	const candidate = error as BoomLike
	const data = candidate.data

	return (
		candidate.output?.statusCode === CONNECTION_CLOSED_STATUS_CODE &&
		typeof data === 'object' &&
		data !== null &&
		'reason' in data &&
		(data as { reason?: unknown }).reason === SOCKET_TEARDOWN_REASON
	)
}
