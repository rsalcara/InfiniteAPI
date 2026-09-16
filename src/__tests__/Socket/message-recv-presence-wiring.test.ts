import { readFileSync } from 'fs'
import { join } from 'path'

describe('message receive and presence wiring', () => {
	it('routes notification attribution through the raw sender-device JID', () => {
		const source = readFileSync(join(process.cwd(), 'src/Socket/messages-recv.ts'), 'utf8')

		expect(source).toContain('selectNotificationSenderAuthorJid({')
		expect(source).toContain('msg.participant = jidWithoutExplicitZeroDevice(msg.participant || rawKeyParticipant)')
		expect(source).toContain('rawRemoteJid')
		expect(source).not.toContain('authorJid: node.attrs.participant || remoteJid')
	})

	it('routes public presence identifiers through the canonical presence helper', () => {
		const source = readFileSync(join(process.cwd(), 'src/Socket/chats.ts'), 'utf8')

		expect(source).toContain('resolvePresenceUpdateIdentifiers({')
		expect(source).toContain('rawJid,')
		expect(source).toContain('rawParticipant,')
		expect(source).not.toContain('resolveLidToPn(rawJid, lidMapping, logger)')
	})
})
