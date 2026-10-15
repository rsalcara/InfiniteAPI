import { Boom } from '@hapi/boom'
import { executeWMexQuery, MEX_PERSISTED_QUERY_ROTATED_ERROR_CODE } from '../../Socket/mex'
import type { BinaryNode } from '../../WABinary'

const resultNode = (payload: unknown): BinaryNode => ({
	tag: 'iq',
	attrs: {},
	content: [{ tag: 'result', attrs: {}, content: Buffer.from(JSON.stringify(payload), 'utf-8') }]
})

const run = (payload: unknown, queryId = '8823471724422422') =>
	executeWMexQuery(
		{},
		queryId,
		'xwa2_some_op',
		async () => resultNode(payload),
		() => 'tag-1'
	)

describe('executeWMexQuery error handling (w:mex doc_id rotation)', () => {
	it('exposes 421 as a diagnosable persisted-query rotation', async () => {
		const payload = { errors: [{ message: 'unknown query', extensions: { error_code: 421 } }] }
		expect.assertions(4)
		try {
			await run(payload, '8823471724422422')
		} catch (error) {
			const boom = error as Boom
			expect(boom.output.statusCode).toBe(MEX_PERSISTED_QUERY_ROTATED_ERROR_CODE)
			expect(boom.message).toContain('doc_id likely rotated')
			expect((boom.data as { mexPersistedQueryRotated?: boolean }).mexPersistedQueryRotated).toBe(true)
			expect((boom.data as { mexQueryId?: string }).mexQueryId).toBe('8823471724422422')
		}
	})

	it('keeps a generic message and flag=false for other GraphQL errors', async () => {
		const payload = { errors: [{ message: 'boom', extensions: { error_code: 500 } }] }
		expect.assertions(3)
		try {
			await run(payload)
		} catch (error) {
			const boom = error as Boom
			expect(boom.output.statusCode).toBe(500)
			expect(boom.message).toContain('GraphQL server error')
			expect((boom.data as { mexPersistedQueryRotated?: boolean }).mexPersistedQueryRotated).toBe(false)
		}
	})

	it('returns the data payload unchanged on success', async () => {
		const payload = { data: { xwa2_some_op: { ok: true } } }
		await expect(run(payload)).resolves.toEqual({ ok: true })
	})
})
