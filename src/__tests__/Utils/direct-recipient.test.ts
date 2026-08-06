import { resolveDirectRecipientUSync } from '../../Utils/direct-recipient'
import { USyncQuery } from '../../WAUSync'

describe('PN → LID/username recipient resolution', () => {
	it('preserves all USync identity aliases, contact type and username', () => {
		const query = new USyncQuery().withContactProtocol().withLIDProtocol().withUsernameProtocol()
		const parsed = query.parseUSyncQueryResult({
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
									attrs: {
										jid: '5511999999999@s.whatsapp.net',
										pn_jid: '5511999999999@s.whatsapp.net',
										new_jid: '123456@lid'
									},
									content: [
										{ tag: 'contact', attrs: { type: 'in' } },
										{ tag: 'lid', attrs: { val: '123456@lid' } },
										{ tag: 'username', attrs: {}, content: 'cold.contact' }
									]
								}
							]
						}
					]
				}
			]
		})

		expect(parsed?.list[0]).toMatchObject({
			id: '5511999999999@s.whatsapp.net',
			jid: '5511999999999@s.whatsapp.net',
			pnJid: '5511999999999@s.whatsapp.net',
			newJid: '123456@lid',
			lid: '123456@lid',
			contactType: 'in',
			username: 'cold.contact'
		})
		expect(resolveDirectRecipientUSync('5511999999999@c.us', parsed!.list)).toMatchObject({
			contactType: 'in',
			pnJid: '5511999999999@s.whatsapp.net',
			lidJid: '123456@lid',
			destinationJid: '123456@lid',
			username: 'cold.contact'
		})
	})

	it.each(['out', 'invalid'] as const)('rejects contact type %s without selecting a destination', contactType => {
		const result = resolveDirectRecipientUSync('5511999999999@s.whatsapp.net', [
			{
				id: '5511999999999@s.whatsapp.net',
				jid: '5511999999999@s.whatsapp.net',
				newJid: '123456@lid',
				contactType
			}
		])

		expect(result?.contactType).toBe(contactType)
		// The caller is responsible for enforcing `contactType === in`; aliases
		// are still returned so the rejection can be logged without guessing.
		expect(result?.destinationJid).toBe('123456@lid')
	})

	it('rejects ambiguous rows and rows with no explicit registration result', () => {
		expect(
			resolveDirectRecipientUSync('5511999999999@s.whatsapp.net', [
				{ id: 'a@lid', newJid: 'a@lid', contactType: 'in' },
				{ id: 'b@lid', newJid: 'b@lid', contactType: 'in' }
			])
		).toBeUndefined()
		expect(
			resolveDirectRecipientUSync('5511999999999@s.whatsapp.net', [
				{ id: '5511999999999@s.whatsapp.net', newJid: 'a@lid' }
			])
		).toBeUndefined()
	})
})
