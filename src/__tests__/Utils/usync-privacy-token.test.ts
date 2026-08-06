import { withMexPrivacyToken } from '../../Socket/mex'
import { USyncQuery, USyncUser } from '../../WAUSync'

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
})
