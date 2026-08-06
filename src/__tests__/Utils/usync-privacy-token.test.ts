import { jest } from '@jest/globals'
import {
	buildMexContactProfileVariables,
	executeWMexQuery,
	MEX_CONTACT_PROFILE_QUERY_ID,
	withMexPrivacyToken
} from '../../Socket/mex'
import type { BinaryNode } from '../../WABinary'
import {
	getUSyncLidIdentity,
	getUSyncPnIdentity,
	mapUSyncResultToLIDMappings,
	mapUSyncResultToOnWhatsApp,
	USyncQuery,
	USyncUser
} from '../../WAUSync'

describe('USync/MEX privacy-token serialization', () => {
	it('keeps an exact copy of the token on an explicitly enriched USync user', () => {
		const source = Buffer.from([1, 2, 3])
		const user = new USyncUser().withId('5511999999999@s.whatsapp.net').withPrivacyToken(source, 123)
		source[0] = 9

		expect(user.privacyToken).toEqual({ token: Buffer.from([1, 2, 3]), timestamp: '123' })
	})

	it('serializes the official XML child without leaking the MEX timestamp attribute', () => {
		const query = new USyncQuery().withStatusProtocol()
		const user = new USyncUser().withId('5511999999999@s.whatsapp.net').withPrivacyToken(Buffer.from([1, 2, 3]), 123)

		expect(query.buildUserNode(user)).toEqual({
			tag: 'user',
			attrs: { jid: '5511999999999@s.whatsapp.net' },
			content: [{ tag: 'tctoken', attrs: {}, content: Buffer.from([1, 2, 3]) }]
		})
	})

	it('leaves the USync user untouched when no valid token was enriched', () => {
		const query = new USyncQuery().withStatusProtocol()

		expect(query.buildUserNode(new USyncUser().withId('5511999999999@s.whatsapp.net'))).toEqual({
			tag: 'user',
			attrs: { jid: '5511999999999@s.whatsapp.net' },
			content: []
		})
	})

	it('preserves PN and LID identities without redefining the primary row id', () => {
		const query = new USyncQuery()
		const result = query.parseUSyncQueryResult({
			tag: 'iq',
			attrs: { type: 'result' },
			content: [
				{
					tag: 'usync',
					attrs: {},
					content: [
						{
							tag: 'list',
							attrs: {},
							content: [
								{
									tag: 'user',
									attrs: { pn_jid: '5511999999999@s.whatsapp.net', new_jid: '123456@lid' }
								}
							]
						}
					]
				}
			]
		})

		const row = result?.list[0]
		expect(row).toEqual({
			id: '5511999999999@s.whatsapp.net',
			pnJid: '5511999999999@s.whatsapp.net',
			newJid: '123456@lid'
		})
		expect(getUSyncPnIdentity(row!)).toBe('5511999999999@s.whatsapp.net')
		expect(getUSyncLidIdentity(row!)).toBe('123456@lid')
	})

	it('keeps a LID-only row while refusing to reinterpret it as a PN', () => {
		const query = new USyncQuery()
		const result = query.parseUSyncQueryResult({
			tag: 'iq',
			attrs: { type: 'result' },
			content: [
				{
					tag: 'usync',
					attrs: {},
					content: [
						{
							tag: 'list',
							attrs: {},
							content: [{ tag: 'user', attrs: { new_jid: '123456@lid', lid: '123456@lid' } }]
						}
					]
				}
			]
		})

		const row = result?.list[0]
		expect(row).toEqual({ id: '123456@lid', newJid: '123456@lid', lid: '123456@lid' })
		expect(getUSyncPnIdentity(row!)).toBeUndefined()
		expect(getUSyncLidIdentity(row!)).toBe('123456@lid')
	})

	it('uses the requested PN only as a single-row fallback for LID-only USync', () => {
		const row = { id: '123456@lid', newJid: '123456@lid', lid: '123456@lid', contact: true }
		expect(mapUSyncResultToLIDMappings([row], ['5511999999999@s.whatsapp.net'])).toEqual([
			{ pn: '5511999999999@s.whatsapp.net', lid: '123456@lid' }
		])
		expect(mapUSyncResultToOnWhatsApp([row], ['5511999999999@s.whatsapp.net'])).toEqual([
			{ jid: '5511999999999@s.whatsapp.net', exists: true }
		])
	})

	it('does not add privacy_token to MEX unless the call site opts in', () => {
		const variables = { user_id: '123@lid' }

		expect(withMexPrivacyToken(variables)).toBe(variables)
		expect(withMexPrivacyToken(variables, { token: Buffer.alloc(0), timestamp: 10 })).toBe(variables)
	})

	it('serializes the official MEX privacy_token shape', () => {
		expect(withMexPrivacyToken({ user_id: '123@lid' }, { token: Buffer.from([1, 2, 3]), timestamp: 456 })).toEqual({
			user_id: '123@lid',
			privacy_token: { tctoken: 'AQID', timestamp: '456' }
		})
	})

	it('builds the captured MEX profile batch and omits missing tokens per user', () => {
		expect(
			buildMexContactProfileVariables([
				{ jid: '123@lid', privacyToken: { token: Buffer.from([1, 2, 3]), timestamp: 456 } },
				{ jid: '456@lid' }
			])
		).toEqual({
			include_picture: true,
			input: {
				query_input: [{ jid: '123@lid', privacy_token: { tctoken: 'AQID', timestamp: '456' } }, { jid: '456@lid' }],
				telemetry: { context: 'BACKGROUND' }
			},
			picture_field_input: { type: 'IMAGE' }
		})
	})

	it('emits queryId and trace only for the explicit captured MEX call site', async () => {
		const query = jest.fn(async (node: BinaryNode) => ({
			tag: 'iq',
			attrs: { id: node.attrs.id || 'test-id' },
			content: [{ tag: 'result', attrs: {}, content: Buffer.from('{"data":{"ok":true}}') }]
		}))
		const variables = buildMexContactProfileVariables([{ jid: '123@lid' }])

		await expect(
			executeWMexQuery<Record<string, unknown>>(variables, MEX_CONTACT_PROFILE_QUERY_ID, '', query, () => 'tag', {
				includeQueryId: true,
				includeTrace: true
			})
		).resolves.toEqual({ ok: true })

		const sent = query.mock.calls[0]![0]
		const content = sent.content as BinaryNode[]
		expect(content[0]).toEqual({
			tag: 'trace',
			attrs: {},
			content: [{ tag: 'flow_id', attrs: {}, content: Buffer.from(MEX_CONTACT_PROFILE_QUERY_ID) }]
		})
		expect(JSON.parse((content[1]!.content as Buffer).toString())).toEqual({
			queryId: MEX_CONTACT_PROFILE_QUERY_ID,
			variables
		})
	})
})
