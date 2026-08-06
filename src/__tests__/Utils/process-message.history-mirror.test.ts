import { jest } from '@jest/globals'
import { proto } from '../../../WAProto/index.js'
import type {
	SignalDataTypeMap,
	SignalKeyStoreWithTransaction,
	SignalRepositoryWithLIDStore,
	WAMessage
} from '../../Types'
import type { MessageStoreBackend } from '../../Utils/multi-db-sqlite'
import { applyProcessedHistorySync, mirrorHistoryMessagesToStore } from '../../Utils/process-message'

const emptyKeyStore = {
	get: jest.fn(async () => ({})),
	set: jest.fn(async () => undefined),
	transaction: jest.fn(async (work: () => Promise<unknown>) => work()),
	isInTransaction: jest.fn(() => false)
} as unknown as SignalKeyStoreWithTransaction

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
			{ signalRepository, keyStore: emptyKeyStore, messageStoreBackend }
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
				{ signalRepository, keyStore: emptyKeyStore, messageStoreBackend },
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
				{ signalRepository, keyStore: emptyKeyStore, messageStoreBackend },
				undefined,
				true,
				controller.signal
			)
		).rejects.toThrow('history sync apply interrupted by socket teardown')
		expect(recordMessages).not.toHaveBeenCalled()
	})

	it('canonicalizes PN history tokens to LID after mappings and before messages', async () => {
		const pn = '5511999999999@s.whatsapp.net'
		const lid = '123456789@lid'
		const order: string[] = []
		let mappingStored = false
		const state: Record<string, SignalDataTypeMap['tctoken'] | undefined> = {
			[pn]: { token: Buffer.from([7]), timestamp: '90', senderTimestamp: 80 }
		}
		const signalRepository = {
			lidMapping: {
				storeLIDPNMappings: jest.fn(async () => {
					order.push('mapping')
					mappingStored = true
					return { stored: 1, skipped: 0, errors: 0 }
				}),
				getLIDForPN: jest.fn(async () => (mappingStored ? lid : null)),
				getPNForLID: jest.fn(async () => pn)
			}
		} as unknown as SignalRepositoryWithLIDStore
		const keyStore = {
			get: jest.fn(async (_type: 'tctoken', ids: string[]) =>
				Object.fromEntries(ids.flatMap(id => (state[id] ? [[id, state[id]]] : [])))
			),
			set: jest.fn(async ({ tctoken }: { tctoken?: Record<string, SignalDataTypeMap['tctoken'] | null> }) => {
				order.push('tctoken')
				for (const [jid, value] of Object.entries(tctoken ?? {})) {
					if (value) state[jid] = value
					else delete state[jid]
				}
			}),
			transaction: jest.fn(async (work: () => Promise<unknown>) => work()),
			transactWith: jest.fn(async (_scope: unknown, work: () => Promise<unknown>) => work()),
			isInTransaction: jest.fn(() => false)
		} as unknown as SignalKeyStoreWithTransaction
		const messageStoreBackend = {
			recordMessages: jest.fn(() => {
				order.push('message')
				return [1]
			})
		} as unknown as MessageStoreBackend
		const data = {
			chats: [],
			contacts: [],
			messages: [
				{
					key: { remoteJid: pn, fromMe: false, id: 'TOKEN-ORDER' },
					messageTimestamp: 100,
					message: { conversation: 'ordered token restore' }
				}
			],
			lidPnMappings: [{ lid, pn }],
			tcTokens: [{ jid: pn, token: Buffer.from([9]), timestamp: 100, senderTimestamp: 110 }],
			pastParticipants: [],
			syncType: proto.HistorySync.HistorySyncType.RECENT,
			progress: 100
		}

		await applyProcessedHistorySync(data, { signalRepository, keyStore, messageStoreBackend })
		const writesAfterFirstApply = (keyStore.set as jest.Mock).mock.calls.length
		expect(order).toEqual(['mapping', 'tctoken', 'message'])
		expect(state[lid]).toEqual({
			token: Buffer.from([9]),
			timestamp: '100',
			senderTimestamp: 110,
			realIssueTimestamp: null
		})
		expect(state[pn]).toBeUndefined()

		await applyProcessedHistorySync(data, { signalRepository, keyStore, messageStoreBackend })
		expect((keyStore.set as jest.Mock).mock.calls).toHaveLength(writesAfterFirstApply)
		expect(state[lid]).toEqual({
			token: Buffer.from([9]),
			timestamp: '100',
			senderTimestamp: 110,
			realIssueTimestamp: null
		})
	})

	it('fails the durable apply before message persistence when token restore fails', async () => {
		const signalRepository = {
			lidMapping: {
				storeLIDPNMappings: jest.fn(async () => ({ stored: 0, skipped: 0, errors: 0 })),
				getLIDForPN: jest.fn(async () => null),
				getPNForLID: jest.fn(async () => null)
			}
		} as unknown as SignalRepositoryWithLIDStore
		const keyStore = {
			get: jest.fn(async () => ({})),
			set: jest.fn(async () => {
				throw new Error('token store unavailable')
			}),
			transaction: jest.fn(async (work: () => Promise<unknown>) => work()),
			isInTransaction: jest.fn(() => false)
		} as unknown as SignalKeyStoreWithTransaction
		const recordMessages = jest.fn(() => [1])

		await expect(
			applyProcessedHistorySync(
				{
					chats: [],
					contacts: [],
					messages: [
						{
							key: { remoteJid: '5511999999999@s.whatsapp.net', fromMe: false, id: 'NO-COMMIT' },
							messageTimestamp: 1,
							message: { conversation: 'must wait for token state' }
						}
					],
					lidPnMappings: [],
					tcTokens: [{ jid: '5511999999999@s.whatsapp.net', token: Buffer.from([1]), timestamp: 100 }],
					pastParticipants: [],
					syncType: proto.HistorySync.HistorySyncType.RECENT,
					progress: 100
				},
				{
					signalRepository,
					keyStore,
					messageStoreBackend: { recordMessages } as unknown as MessageStoreBackend
				}
			)
		).rejects.toThrow('token store unavailable')
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
