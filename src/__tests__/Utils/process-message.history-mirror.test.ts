import { jest } from '@jest/globals'
import type { WAMessage } from '../../Types'
import { mirrorHistoryMessagesToStore } from '../../Utils/process-message'

describe('history-sync message mirror', () => {
	it('persists historical messages without incrementing unread state', () => {
		const recordMessage = jest.fn(() => 1)
		const backend = { recordMessage } as any
		const messages: WAMessage[] = [
			{
				key: {
					remoteJid: '5511999999999@s.whatsapp.net',
					fromMe: false,
					id: 'HISTORY-1',
					participant: '5511999999999:2@s.whatsapp.net'
				},
				messageTimestamp: 1_700_000_000,
				message: { conversation: 'historical text' }
			}
		]

		expect(mirrorHistoryMessagesToStore(messages, backend)).toEqual({ stored: 1, failed: 0 })
		expect(recordMessage).toHaveBeenCalledWith(
			expect.objectContaining({
				chatJid: '5511999999999@s.whatsapp.net',
				keyId: 'HISTORY-1',
				textData: 'historical text',
				incrementUnread: false,
				timestamp: 1_700_000_000,
				receivedTimestamp: 1_700_000_000_000
			})
		)
	})

	it('isolates a malformed row and continues mirroring the remaining history', () => {
		const recordMessage = jest
			.fn()
			.mockImplementationOnce(() => {
				throw new Error('row failed')
			})
			.mockReturnValueOnce(2)
		const backend = { recordMessage } as any
		const makeMessage = (id: string): WAMessage => ({
			key: { remoteJid: '120363000000000000@g.us', fromMe: true, id },
			messageTimestamp: 1,
			message: { conversation: id }
		})

		expect(mirrorHistoryMessagesToStore([makeMessage('A'), makeMessage('B')], backend)).toEqual({
			stored: 1,
			failed: 1
		})
		expect(recordMessage).toHaveBeenCalledTimes(2)
	})
})
