import { Boom } from '@hapi/boom'

const CONNECTION_CLOSED_STATUS_CODE = 428
const SOCKET_TEARDOWN_REASON = 'socket-teardown'
const SOCKET_TEARDOWN_TOKEN = Symbol('socket-teardown')

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
export const createExpectedSocketTeardownError = (cause?: unknown) =>
	new Boom('Connection Closed', {
		statusCode: CONNECTION_CLOSED_STATUS_CODE,
		data: { reason: SOCKET_TEARDOWN_REASON, cause, [SOCKET_TEARDOWN_TOKEN]: true }
	})

/** Returns true only for a 428 explicitly created by the local teardown path. */
export const isExpectedSocketTeardownError = (error: unknown): boolean => {
	if (!error || typeof error !== 'object') return false

	try {
		const candidate = error as BoomLike
		const data = candidate.data

		return (
			candidate.output?.statusCode === CONNECTION_CLOSED_STATUS_CODE &&
			typeof data === 'object' &&
			data !== null &&
			'reason' in data &&
			(data as { reason?: unknown }).reason === SOCKET_TEARDOWN_REASON &&
			(data as { [SOCKET_TEARDOWN_TOKEN]?: unknown })[SOCKET_TEARDOWN_TOKEN] === true
		)
	} catch {
		// Error handling must never replace the original failure with an
		// exception raised by a hostile Proxy/getter. Unknown shapes remain
		// visible to the normal error path.
		return false
	}
}
