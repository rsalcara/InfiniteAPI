import { jest } from '@jest/globals'
import type { WAMessage } from '../../Types'
import { mirrorHistoryMessagesToStore } from '../../Utils/process-message'

describe('history-sync message mirror', () => {
	it('persists historical messages without incrementing unread state', async () => {
		const recordMessages = jest.fn(() => [1])
		const backend = { recordMessages } as any
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

		await expect(mirrorHistoryMessagesToStore(messages, backend)).resolves.toEqual({ stored: 1, failed: 0 })
		expect(recordMessages).toHaveBeenCalledWith(
			expect.arrayContaining([
				expect.objectContaining({
					chatJid: '5511999999999@s.whatsapp.net',
					keyId: 'HISTORY-1',
					textData: 'historical text',
					status: 0,
					incrementUnread: false,
					timestamp: 1_700_000_000,
					receivedTimestamp: 1_700_000_000_000
				})
			])
		)
	})

	it('does not fabricate a server ACK for an outgoing Web ERROR row', async () => {
		const recordMessages = jest.fn(() => [1])
		const backend = { recordMessages } as any
		const message: WAMessage = {
			key: {
				remoteJid: '5511999999999@s.whatsapp.net',
				fromMe: true,
				id: 'HISTORY-ERROR'
			},
			status: 0,
			messageTimestamp: 1_700_000_000,
			message: { conversation: 'failed outgoing text' }
		}

		await mirrorHistoryMessagesToStore([message], backend)
		expect(recordMessages).toHaveBeenCalledWith([
			expect.objectContaining({
				keyId: 'HISTORY-ERROR',
				status: null
			})
		])
	})

	it('stores an incoming broadcast history row under its participant chat', async () => {
		const recordMessages = jest.fn(() => [1])
		const backend = { recordMessages } as any
		const message: WAMessage = {
			key: {
				remoteJid: '12345@broadcast',
				participant: '5511999999999@s.whatsapp.net',
				fromMe: false,
				id: 'HISTORY-BROADCAST'
			},
			messageTimestamp: 1_700_000_000,
			message: { conversation: 'broadcast text' }
		}

		await mirrorHistoryMessagesToStore([message], backend)
		expect(recordMessages).toHaveBeenCalledWith([
			expect.objectContaining({
				chatJid: '5511999999999@s.whatsapp.net',
				keyId: 'HISTORY-BROADCAST'
			})
		])
	})

	it('carries Android album-root counters into the relational history mirror', async () => {
		const recordMessages = jest.fn(() => [99])
		const backend = { recordMessages } as any
		const messages: WAMessage[] = [
			{
				key: {
					remoteJid: '5511999999999@s.whatsapp.net',
					fromMe: false,
					id: 'HISTORY-ALBUM'
				},
				messageTimestamp: 1_700_000_000,
				message: { albumMessage: { expectedImageCount: 4, expectedVideoCount: 3 } }
			}
		]

		await expect(mirrorHistoryMessagesToStore(messages, backend)).resolves.toEqual({ stored: 1, failed: 0 })
		expect(recordMessages).toHaveBeenCalledWith([
			expect.objectContaining({
				keyId: 'HISTORY-ALBUM',
				messageType: 99,
				album: { expectedImageCount: 4, expectedVideoCount: 3 }
			})
		])
	})

	it('carries the complete Android sticker-pack manifest into the relational history mirror', async () => {
		const recordMessages = jest.fn(() => [105])
		const backend = { recordMessages } as any
		const messages: WAMessage[] = [
			{
				key: {
					remoteJid: '5511999999999@s.whatsapp.net',
					fromMe: false,
					id: 'HISTORY-STICKER-PACK'
				},
				messageTimestamp: 1_700_000_000,
				message: {
					stickerPackMessage: {
						stickerPackId: 'PACK-HISTORY',
						name: 'Histórico',
						publisher: 'InfiniteAPI',
						packDescription: 'Pacote histórico',
						trayIconFileName: 'tray.png',
						imageDataHash: 'hash',
						stickerPackSize: 1234,
						stickerPackOrigin: 2,
						fileLength: 1300,
						mediaKey: Buffer.alloc(32, 1),
						mediaKeyTimestamp: 1_700_000_000,
						directPath: '/m1/history-pack.enc',
						fileSha256: Buffer.alloc(32, 2),
						fileEncSha256: Buffer.alloc(32, 3),
						stickers: [
							{
								fileName: 'one.webp',
								isAnimated: false,
								emojis: ['😀', '🚀'],
								accessibilityLabel: 'primeira',
								isLottie: false,
								mimetype: 'image/webp'
							}
						]
					}
				}
			}
		]

		await expect(mirrorHistoryMessagesToStore(messages, backend)).resolves.toEqual({ stored: 1, failed: 0 })
		expect(recordMessages).toHaveBeenCalledWith([
			expect.objectContaining({
				keyId: 'HISTORY-STICKER-PACK',
				messageType: 105,
				stickerPack: expect.objectContaining({
					stickerPackId: 'PACK-HISTORY',
					packName: 'Histórico',
					stickerPackOrigin: 2,
					mediaKeyTimestamp: 1_700_000_000_000,
					stickers: [
						{
							fileName: 'one.webp',
							isAnimated: false,
							emojis: '😀, 🚀',
							accessibilityLabel: 'primeira',
							isLottie: false,
							mimetype: 'image/webp'
						}
					]
				})
			})
		])
	})

	it('isolates a malformed row and continues mirroring the remaining history', async () => {
		const recordMessages = jest.fn((rows: Array<{ keyId: string }>) => {
			if (rows.some(row => row.keyId === 'A')) throw new Error('row failed')
			return rows.map(() => 2)
		})
		const backend = { recordMessages } as any
		const makeMessage = (id: string): WAMessage => ({
			key: { remoteJid: '120363000000000000@g.us', fromMe: true, id },
			messageTimestamp: 1,
			message: { conversation: id }
		})

		await expect(mirrorHistoryMessagesToStore([makeMessage('A'), makeMessage('B')], backend)).resolves.toEqual({
			stored: 1,
			failed: 1
		})
		// Initial atomic batch fails, then binary isolation retries A and B.
		expect(recordMessages).toHaveBeenCalledTimes(3)
	})

	it('persists large histories in bounded pages and yields between them', async () => {
		const recordMessages = jest.fn((rows: unknown[]) => rows.map((_, index) => index + 1))
		const backend = { recordMessages } as any
		const messages = Array.from(
			{ length: 300 },
			(_, index): WAMessage => ({
				key: {
					remoteJid: '5511999999999@s.whatsapp.net',
					fromMe: false,
					id: `HISTORY-${index}`
				},
				messageTimestamp: index + 1,
				message: { conversation: `message ${index}` }
			})
		)

		await expect(mirrorHistoryMessagesToStore(messages, backend)).resolves.toEqual({ stored: 300, failed: 0 })
		expect(recordMessages).toHaveBeenCalledTimes(3)
		expect(recordMessages.mock.calls.map(([rows]) => rows.length)).toEqual([128, 128, 44])
	})
})
