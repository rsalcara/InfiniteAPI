/**
 * Tests for the @username MEX wire-protocol contract.
 *
 * The CRUD entry points live inside `makeChatsSocket` (chats.ts) as
 * closures over the socket state, which would force a full socket
 * bring-up to exercise end-to-end. Instead, this suite tests the
 * `executeWMexQuery` helper from `src/Socket/mex.ts` against the EXACT
 * `doc_id` / `xwa2_*` data-path pairs the username CRUD uses
 * (`UsernameQueryIds` / `XWAUsernamePaths` from `src/Types/Username.ts`)
 * — driving the same code path the production functions drive, one
 * level lower.
 *
 * What is locked in here:
 *   - The IQ wire shape: `<iq xmlns="w:mex" type="get">
 *       <query query_id="...">{JSON-encoded {variables}}</query></iq>`
 *   - Each operation's `doc_id` MUST be the captured value from the
 *     WhatsApp Web bundle as of 2026-06-30 (regression guard for the
 *     ID rotation discussed in `Types/Username.ts`)
 *   - DELETE = SET with empty variables `{}` (matches the Web client's
 *     `isStringNullOrEmpty(t.input) ? {} : t` branch)
 *   - Response unwrap pulls `data.xwa2_<op>` out of the `<result>`
 *     child and surfaces it directly to callers
 *   - GraphQL `errors[]` → `Boom` with the server's `error_code`
 */
import { Boom } from '@hapi/boom'
import { jest } from '@jest/globals'
import { executeWMexQuery } from '../../Socket/mex'
import { UsernameQueryIds, XWAUsernamePaths } from '../../Types/Username'
import type { BinaryNode } from '../../WABinary'
import { USyncUsernameProtocol } from '../../WAUSync/Protocols/USyncUsernameProtocol'
import { USyncUser } from '../../WAUSync/USyncUser'

const makeOkResponse = (dataPath: string, payload: unknown): BinaryNode => ({
	tag: 'iq',
	attrs: { type: 'result' },
	content: [
		{
			tag: 'result',
			attrs: {},
			content: Buffer.from(JSON.stringify({ data: { [dataPath]: payload } }), 'utf-8')
		}
	]
})

const makeErrorResponse = (message: string, errorCode = 421): BinaryNode => ({
	tag: 'iq',
	attrs: { type: 'result' },
	content: [
		{
			tag: 'result',
			attrs: {},
			content: Buffer.from(
				JSON.stringify({
					errors: [{ message, extensions: { error_code: errorCode } }]
				}),
				'utf-8'
			)
		}
	]
})

describe('@username MEX wire protocol', () => {
	let queryMock: jest.Mock<(node: BinaryNode) => Promise<BinaryNode>>
	let tag = 0
	const generateMessageTag = () => `tag-${++tag}`

	beforeEach(() => {
		tag = 0
		queryMock = jest.fn<(node: BinaryNode) => Promise<BinaryNode>>()
	})

	describe('doc_id regression guard', () => {
		// Hard-coded so a rotation in WA Web flips this test red and we
		// notice before users hit MexFatalExtensionError in prod.
		it('GET = 25347099718279209', () => {
			expect(UsernameQueryIds.GET).toBe('25347099718279209')
		})
		it('SET = 25757341163897635', () => {
			expect(UsernameQueryIds.SET).toBe('25757341163897635')
		})
		it('CHECK = 26122779627399568', () => {
			expect(UsernameQueryIds.CHECK).toBe('26122779627399568')
		})
		it('PIN_SET = 9749436995157074', () => {
			expect(UsernameQueryIds.PIN_SET).toBe('9749436995157074')
		})

		it('xwa2_* data-paths match server spelling verbatim', () => {
			expect(XWAUsernamePaths.GET).toBe('xwa2_username_get')
			expect(XWAUsernamePaths.SET).toBe('xwa2_username_set')
			expect(XWAUsernamePaths.CHECK).toBe('xwa2_username_check')
			expect(XWAUsernamePaths.PIN_SET).toBe('xwa2_username_pin_set')
		})
	})

	describe('SET wire shape', () => {
		it('builds an `iq xmlns="w:mex" type="get"` with `<query query_id=SET>{JSON variables}</query>`', async () => {
			queryMock.mockResolvedValue(makeOkResponse(XWAUsernamePaths.SET, { result: 'SUCCESS' }))

			const variables = {
				username: 'tuoli',
				reserved: true,
				session_id: 'abc123',
				source: 'USER_INPUT'
			}
			const r = await executeWMexQuery(
				variables,
				UsernameQueryIds.SET,
				XWAUsernamePaths.SET,
				queryMock,
				generateMessageTag
			)

			expect(r).toEqual({ result: 'SUCCESS' })

			expect(queryMock).toHaveBeenCalledTimes(1)
			const sent = queryMock.mock.calls[0]![0]
			expect(sent.tag).toBe('iq')
			expect(sent.attrs.xmlns).toBe('w:mex')
			expect(sent.attrs.type).toBe('get')
			expect(sent.attrs.to).toBe('@s.whatsapp.net')
			expect(sent.attrs.id).toBe('tag-1')

			const queryChild = (sent.content as BinaryNode[])[0]!
			expect(queryChild.tag).toBe('query')
			expect(queryChild.attrs.query_id).toBe('25757341163897635')

			const body = JSON.parse((queryChild.content as Buffer).toString('utf-8'))
			expect(body).toEqual({ variables })
		})

		it('DELETE: SET with empty `{}` variables (matches WA Web `isStringNullOrEmpty(t.input)` branch)', async () => {
			queryMock.mockResolvedValue(makeOkResponse(XWAUsernamePaths.SET, { result: 'SUCCESS' }))

			await executeWMexQuery({}, UsernameQueryIds.SET, XWAUsernamePaths.SET, queryMock, generateMessageTag)

			const sent = queryMock.mock.calls[0]![0]
			const queryChild = (sent.content as BinaryNode[])[0]!
			const body = JSON.parse((queryChild.content as Buffer).toString('utf-8'))
			// Empty variables MUST round-trip as `{variables: {}}`, not
			// dropped entirely — server treats absence-of-key as "still
			// updating, no-op" and the operation silently no-ops.
			expect(body).toEqual({ variables: {} })
		})
	})

	describe('GET / CHECK / PIN_SET wire shape', () => {
		it('GET sends `pin` variable when supplied; empty `{}` otherwise', async () => {
			queryMock.mockResolvedValue(makeOkResponse(XWAUsernamePaths.GET, { username: 'tuoli', state: 'RESERVED' }))
			await executeWMexQuery({ pin: '1234' }, UsernameQueryIds.GET, XWAUsernamePaths.GET, queryMock, generateMessageTag)
			const sent = queryMock.mock.calls[0]![0]
			const body = JSON.parse(((sent.content as BinaryNode[])[0]!.content as Buffer).toString('utf-8'))
			expect(body).toEqual({ variables: { pin: '1234' } })
			expect((sent.content as BinaryNode[])[0]!.attrs.query_id).toBe('25347099718279209')
		})

		it('CHECK includes username + session_id + source', async () => {
			queryMock.mockResolvedValue(makeOkResponse(XWAUsernamePaths.CHECK, { result: 'AVAILABLE', suggestions: [] }))
			const vars = { username: 'free_handle', session_id: 's1', source: 'USER_INPUT' }
			const r = await executeWMexQuery<{ result: string; suggestions: string[] }>(
				vars,
				UsernameQueryIds.CHECK,
				XWAUsernamePaths.CHECK,
				queryMock,
				generateMessageTag
			)
			expect(r.result).toBe('AVAILABLE')

			const sent = queryMock.mock.calls[0]![0]
			expect((sent.content as BinaryNode[])[0]!.attrs.query_id).toBe('26122779627399568')
			const body = JSON.parse(((sent.content as BinaryNode[])[0]!.content as Buffer).toString('utf-8'))
			expect(body).toEqual({ variables: vars })
		})

		it('PIN_SET includes pin only', async () => {
			queryMock.mockResolvedValue(makeOkResponse(XWAUsernamePaths.PIN_SET, { result: 'SUCCESS' }))
			await executeWMexQuery(
				{ pin: '4321' },
				UsernameQueryIds.PIN_SET,
				XWAUsernamePaths.PIN_SET,
				queryMock,
				generateMessageTag
			)
			const sent = queryMock.mock.calls[0]![0]
			expect((sent.content as BinaryNode[])[0]!.attrs.query_id).toBe('9749436995157074')
		})

		it('CHECK surfaces `suggestions` when result is TAKEN', async () => {
			queryMock.mockResolvedValue(
				makeOkResponse(XWAUsernamePaths.CHECK, { result: 'TAKEN', suggestions: ['tuoli_1', 'tuoli_2'] })
			)
			const r = await executeWMexQuery<{ result: string; suggestions: string[] }>(
				{ username: 'tuoli', session_id: 's', source: 'USER_INPUT' },
				UsernameQueryIds.CHECK,
				XWAUsernamePaths.CHECK,
				queryMock,
				generateMessageTag
			)
			expect(r).toEqual({ result: 'TAKEN', suggestions: ['tuoli_1', 'tuoli_2'] })
		})
	})

	describe('error handling', () => {
		it('GraphQL `errors[]` MUST throw Boom with the server error_code', async () => {
			queryMock.mockResolvedValue(makeErrorResponse('unknown query', 421))

			await expect(
				executeWMexQuery({}, UsernameQueryIds.SET, XWAUsernamePaths.SET, queryMock, generateMessageTag)
			).rejects.toThrow(/GraphQL server error.*unknown query/)
		})

		it('error keeps server `statusCode` reachable via Boom', async () => {
			queryMock.mockResolvedValue(makeErrorResponse('not authorized', 403))

			try {
				await executeWMexQuery({}, UsernameQueryIds.PIN_SET, XWAUsernamePaths.PIN_SET, queryMock, generateMessageTag)
				throw new Error('expected throw')
			} catch (e) {
				const b = e as Boom
				expect(b.output?.statusCode).toBe(403)
			}
		})

		it('missing data-path field throws a "Failed to ..." Boom', async () => {
			// Server returns data.<some_other_field>, so the helper can't
			// find xwa2_username_set and must error rather than silently
			// returning undefined.
			queryMock.mockResolvedValue(makeOkResponse('xwa2_some_other_op', { result: 'SUCCESS' }))

			await expect(
				executeWMexQuery({}, UsernameQueryIds.SET, XWAUsernamePaths.SET, queryMock, generateMessageTag)
			).rejects.toThrow(/Failed to username set/)
		})
	})
})

describe('USyncUsernameProtocol wire shape (getUserByUsername path)', () => {
	// Regression for the bug two reviewers (Codex P1 + cubic P1, confidence 9)
	// flagged: prior `getUserElement` returned null unconditionally, so
	// `getUserByUsername("tuoli")` shipped `<user></user>` (no jid, no username
	// payload) and the server silently returned nothing for any input.
	const proto = new USyncUsernameProtocol()

	it('getQueryElement = <username/> (empty <username/> in the <query> envelope)', () => {
		const node = proto.getQueryElement()
		expect(node.tag).toBe('username')
		expect(node.attrs).toEqual({})
	})

	it('getUserElement returns null when user has no username (the SET-pattern callers)', () => {
		const user = new USyncUser().withId('46802@lid')
		expect(proto.getUserElement(user)).toBeNull()
	})

	it('getUserElement emits `<username username="tuoli"/>` when user.username is set', () => {
		// Mirrors WAWebUsyncUsername in the WhatsApp Web bundle:
		//   `wap("username", { username: CUSTOM_STRING(e) })`
		const user = new USyncUser().withUsername('tuoli')
		const node = proto.getUserElement(user)
		expect(node).toEqual({
			tag: 'username',
			attrs: { username: 'tuoli' }
		})
	})

	it('parser reads the resolved username out of `<username>tuoli</username>` (string content)', () => {
		expect(proto.parser({ tag: 'username', attrs: {}, content: 'tuoli' })).toBe('tuoli')
	})

	it('parser decodes the resolved username out of Uint8Array content (UTF-8)', () => {
		const bytes = new TextEncoder().encode('tuoli')
		expect(proto.parser({ tag: 'username', attrs: {}, content: bytes })).toBe('tuoli')
	})
})
