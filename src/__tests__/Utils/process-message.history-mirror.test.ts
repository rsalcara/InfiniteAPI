import { jest } from '@jest/globals'
import { proto } from '../../../WAProto/index.js'
import type { SignalRepositoryWithLIDStore, WAMessage } from '../../Types'
import type { MessageStoreBackend } from '../../Utils/multi-db-sqlite'
import { applyProcessedHistorySync, mirrorHistoryMessagesToStore } from '../../Utils/process-message'

describe('history-sync message mirror', () => {
	it('persists LID mappings before applying messages from the same chunk', async () => {
		const order: string[] = []
		const signalRepository = {
			lidMapping: {
				storeLIDPNMappings: jest.fn(async () => {
					order.push('mapping')
					return { stored: 1, skipped: 0, errors: 0 }
				})
			}
		} as unknown as SignalRepositoryWithLIDStore
		const messageStoreBackend = {
			recordMessages: jest.fn(() => {
				order.push('message')
				return [1]
			})
		} as unknown as MessageStoreBackend

		await applyProcessedHistorySync(
			{
				chats: [],
				contacts: [],
				messages: [
					{
						key: { remoteJid: '5511999999999@s.whatsapp.net', fromMe: false, id: 'ORDER-1' },
						messageTimestamp: 1,
						message: { conversation: 'ordered' }
					}
				],
				lidPnMappings: [{ lid: '123456789@lid', pn: '5511999999999@s.whatsapp.net' }],
				pastParticipants: [],
				syncType: proto.HistorySync.HistorySyncType.RECENT,
				progress: 100
			},
			{ signalRepository, messageStoreBackend }
		)

		expect(order).toEqual(['mapping', 'message'])
	})

	it('keeps the legacy custom-auth path best-effort when LID mapping persistence fails', async () => {
		const signalRepository = {
			lidMapping: {
				storeLIDPNMappings: jest.fn(async () => {
					throw new Error('custom mapping store unavailable')
				})
			}
		} as unknown as SignalRepositoryWithLIDStore
		const recordMessages = jest.fn(() => [1])
		const messageStoreBackend = { recordMessages } as unknown as MessageStoreBackend

		await expect(
			applyProcessedHistorySync(
				{
					chats: [],
					contacts: [],
					messages: [
						{
							key: { remoteJid: '5511999999999@s.whatsapp.net', fromMe: false, id: 'LEGACY-1' },
							messageTimestamp: 1,
							message: { conversation: 'legacy fallback' }
						}
					],
					lidPnMappings: [{ lid: '123456789@lid', pn: '5511999999999@s.whatsapp.net' }],
					pastParticipants: [],
					syncType: proto.HistorySync.HistorySyncType.RECENT,
					progress: 100
				},
				{ signalRepository, messageStoreBackend },
				undefined,
				false
			)
		).resolves.toBeUndefined()
		expect(recordMessages).toHaveBeenCalledTimes(1)
	})

	it('stops between mapping and message phases when socket teardown aborts the apply', async () => {
		const controller = new AbortController()
		const signalRepository = {
			lidMapping: {
				storeLIDPNMappings: jest.fn(async () => {
					controller.abort()
					return { stored: 1, skipped: 0, errors: 0 }
				})
			}
		} as unknown as SignalRepositoryWithLIDStore
		const recordMessages = jest.fn(() => [1])
		const messageStoreBackend = { recordMessages } as unknown as MessageStoreBackend

		await expect(
			applyProcessedHistorySync(
				{
					chats: [],
					contacts: [],
					messages: [
						{
							key: { remoteJid: '5511999999999@s.whatsapp.net', fromMe: false, id: 'ABORT-1' },
							messageTimestamp: 1,
							message: { conversation: 'must not persist after teardown' }
						}
					],
					lidPnMappings: [{ lid: '123456789@lid', pn: '5511999999999@s.whatsapp.net' }],
					pastParticipants: [],
					syncType: proto.HistorySync.HistorySyncType.RECENT,
					progress: 100
				},
				{ signalRepository, messageStoreBackend },
				undefined,
				true,
				controller.signal
			)
		).rejects.toThrow('history sync apply interrupted by socket teardown')
		expect(recordMessages).not.toHaveBeenCalled()
	})

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

	it.each([
		['image', 'viewOnceMessage', 'imageMessage', 42],
		['video', 'viewOnceMessageV2', 'videoMessage', 43],
		['audio', 'viewOnceMessageV2Extension', 'audioMessage', 82]
	])('persists historical view-once %s metadata', async (_kind, wrapper, media, messageType) => {
		const recordMessages = jest.fn(() => [1])
		const backend = { recordMessages } as any
		const message: WAMessage = {
			key: { remoteJid: '5511999999999@s.whatsapp.net', fromMe: false, id: `HISTORY-${messageType}` },
			messageTimestamp: 1_700_000_000,
			message: { [wrapper]: { message: { [media]: {} } } } as any
		}

		await mirrorHistoryMessagesToStore([message], backend)

		expect(recordMessages).toHaveBeenCalledWith([
			expect.objectContaining({
				messageType,
				viewMode: 0,
				viewOnceState: 0
			})
		])
	})

	it('persists an unavailable historical view-once placeholder without inventing a media type', async () => {
		const recordMessages = jest.fn(() => [1])
		const backend = { recordMessages } as any
		const encoded = proto.WebMessageInfo.encode({
			key: {
				remoteJid: '5511999999999@s.whatsapp.net',
				fromMe: false,
				id: 'HISTORY-VIEW-ONCE-UNAVAILABLE'
			},
			messageTimestamp: 1_700_000_000,
			messageStubParameters: ['view_once_unavailable']
		}).finish()
		const decoded = proto.WebMessageInfo.decode(encoded)
		const message = { ...decoded, key: decoded.key! } as WAMessage

		await mirrorHistoryMessagesToStore([message], backend)

		expect(recordMessages).toHaveBeenCalledWith([
			expect.objectContaining({
				messageType: null,
				viewMode: 0,
				viewOnceState: 0
			})
		])
		expect(message.key.isViewOnce).toBeUndefined()
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
		const batchSizes = recordMessages.mock.calls.map(([rows]) => rows.length)
		expect(batchSizes.length).toBeGreaterThan(1)
		expect(batchSizes.reduce((total, size) => total + size, 0)).toBe(300)
		expect(batchSizes.every(size => size >= 1 && size <= 500)).toBe(true)
	})
})
