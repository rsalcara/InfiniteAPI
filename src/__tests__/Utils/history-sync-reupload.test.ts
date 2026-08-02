import { encryptHistorySyncRetryRequest } from '../../Utils/messages-media'

describe('history sync reupload receipt', () => {
	it('matches the official peer server-error envelope and omits rmr', () => {
		const node = encryptHistorySyncRetryRequest(
			'HISTORY-MESSAGE-ID',
			Buffer.from('01234567890123456789012345678901'),
			'5511999999999:24@s.whatsapp.net'
		)

		expect(node).toMatchObject({
			tag: 'receipt',
			attrs: {
				id: 'HISTORY-MESSAGE-ID',
				to: '5511999999999@s.whatsapp.net',
				type: 'server-error',
				category: 'peer'
			}
		})
		const content = node.content as Array<{ tag: string; content?: Array<{ tag: string }> }>
		expect(content.map(child => child.tag)).toEqual(['encrypt'])
		expect(content[0]?.content?.map(child => child.tag)).toEqual(['enc_p', 'enc_iv'])
		expect(JSON.stringify(node)).not.toContain('rmr')
	})
})
