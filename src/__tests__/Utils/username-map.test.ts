import { clearUsernameMap, getKnownUsername, rememberUsername } from '../../Utils/username-map'

describe('username-map (peer @username memory)', () => {
	beforeEach(() => clearUsernameMap())

	it('remembers and returns a username keyed by the normalized user jid', () => {
		rememberUsername('100000000000002:12@lid', 'peeruser')

		expect(getKnownUsername('100000000000002@lid')).toBe('peeruser')
		expect(getKnownUsername('100000000000002:3@lid')).toBe('peeruser')
	})

	it('ignores empty jids or usernames and never returns for unknown users', () => {
		rememberUsername(undefined, 'x')
		rememberUsername('100000000000002@lid', undefined)
		rememberUsername('100000000000002@lid', '')

		expect(getKnownUsername('100000000000002@lid')).toBeUndefined()
		expect(getKnownUsername(undefined)).toBeUndefined()
	})

	it('stays bounded by evicting the oldest entry', () => {
		for (let index = 0; index < 5001; index++) {
			rememberUsername(`1000000${String(index).padStart(7, '0')}@lid`, `user${index}`)
		}

		expect(getKnownUsername('10000000000000@lid')).toBeUndefined()
		expect(getKnownUsername('10000000005000@lid')).toBe('user5000')
	})
})
