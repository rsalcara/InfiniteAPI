import { resolvePresenceUpdateIdentifiers } from '../../Utils/presence-update'

describe('presence update identifiers', () => {
	it('strips explicit primary-device suffix before public presence emission', async () => {
		const seen: Array<string | undefined> = []
		const result = await resolvePresenceUpdateIdentifiers({
			rawJid: '5511000000000:0@s.whatsapp.net',
			rawParticipant: '5511000000000:0@s.whatsapp.net',
			resolveJid: async jid => {
				seen.push(jid)
				return jid
			}
		})

		expect(result).toEqual({
			id: '5511000000000@s.whatsapp.net',
			participant: '5511000000000@s.whatsapp.net'
		})
		expect(seen).toEqual(['5511000000000@s.whatsapp.net', '5511000000000@s.whatsapp.net'])
	})
})
