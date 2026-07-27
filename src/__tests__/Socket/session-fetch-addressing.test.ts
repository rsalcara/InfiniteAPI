import { resolveSessionFetchJids } from '../../Utils/session-fetch-addressing'

describe('session fetch addressing', () => {
	it('uses mapped LIDs and preserves unmapped PNs for session fetch', () => {
		expect(
			resolveSessionFetchJids(
				[
					'5511000000001@s.whatsapp.net',
					'5511000000002@s.whatsapp.net',
					'100000000000001@lid',
					'5511000000002@s.whatsapp.net'
				],
				[{ pn: '5511000000001@s.whatsapp.net', lid: '100000000000002@lid' }]
			)
		).toEqual(['100000000000001@lid', '100000000000002@lid', '5511000000002@s.whatsapp.net'])
	})
})
