/* eslint-disable @typescript-eslint/no-explicit-any */
import { Boom } from '@hapi/boom'
import { jest } from '@jest/globals'
import { EventEmitter } from 'events'
import { proto } from '../../../WAProto/index.js'
import { makeSocketOperationGate } from '../../Socket/socket-operation-gate'
import type { SignalKeyStore, SocketConfig, WAMessage } from '../../Types'
import { unpadRandomMax16 } from '../../Utils/generics'
import { normalizeMessageJids } from '../../Utils/process-message'
import { jidDecode } from '../../WABinary'

type CapturedEncryption = { jid: string; data: Uint8Array; useLegacyLock?: boolean }

const ownPn = '5511000000001@s.whatsapp.net'
const ownLid = '100000000000001@lid'
const remotePn = '5511000000002@s.whatsapp.net'
const remoteLid = '100000000000002@lid'
const coldRequestedPn = '5543991910391@s.whatsapp.net'
const coldCanonicalPn = '554391910391@s.whatsapp.net'
const coldLid = '127496221651050@lid'

const noopLogger = {
	level: 'silent',
	child: () => noopLogger,
	trace: () => undefined,
	debug: () => undefined,
	info: () => undefined,
	warn: () => undefined,
	error: () => undefined,
	fatal: () => undefined
} as any

const makeKeys = (): SignalKeyStore => {
	const records = new Map<string, Record<string, unknown>>()

	return {
		get: async (type: string, ids: string[]) => {
			const values = records.get(type) || {}
			return Object.fromEntries(ids.map(id => [id, values[id]]))
		},
		set: async (data: Record<string, Record<string, unknown>>) => {
			for (const [type, values] of Object.entries(data)) {
				const current = records.get(type) || {}
				for (const [id, value] of Object.entries(values)) {
					if (value === null) delete current[id]
					else current[id] = value
				}

				records.set(type, current)
			}
		},
		transaction: async (work: () => Promise<unknown>) => work()
	} as unknown as SignalKeyStore
}

const makeDeviceResult = (jid: string) => ({
	id: jid,
	devices: {
		deviceList: [
			{ id: 0, keyIndex: 1 },
			{ id: 2, keyIndex: 2 }
		]
	}
})

const makeFakeSocket = ({
	ownMapping = true,
	corruptRemoteReverse = false,
	returnPnDevicesForLidQueries = false,
	coldRecipient = false,
	socketOperationGate,
	onSendNode,
	assertNativeAndroidIntegrityReady
}: {
	ownMapping?: boolean
	corruptRemoteReverse?: boolean
	returnPnDevicesForLidQueries?: boolean
	coldRecipient?: boolean
	socketOperationGate?: ReturnType<typeof makeSocketOperationGate>
	onSendNode?: (node: any, sendIndex: number) => void | Promise<void>
	assertNativeAndroidIntegrityReady?: (egress?: 'message' | 'call') => void
} = {}) => {
	const sent: any[] = []
	const encryptions: CapturedEncryption[] = []
	const endHandlers: Array<() => void | Promise<void>> = []
	const drainHandlers: Array<() => void | Promise<void>> = []
	const keys = makeKeys()
	let coldMappingKnown = false
	const getKnownPNForLID = jest.fn(async (jid: string) =>
		jid.startsWith('100000000000001')
			? ownPn
			: jid.startsWith('100000000000002')
				? corruptRemoteReverse
					? ownPn
					: remotePn
				: jid.startsWith('127496221651050') && coldRecipient
					? coldCanonicalPn
					: null
	)
	const mapping = {
		getLIDForPN: async (jid: string) =>
			jid.startsWith('5511000000001') && ownMapping
				? ownLid
				: jid.startsWith('5511000000002')
					? remoteLid
					: jid.startsWith('554391910391') && coldRecipient
						? coldLid
						: null,
		getKnownLIDForPN: async (jid: string) =>
			jid.startsWith('5511000000001') && ownMapping
				? ownLid
				: jid.startsWith('5511000000002')
					? remoteLid
					: (jid.startsWith('554391910391') || (coldMappingKnown && jid.startsWith('5543991910391'))) && coldRecipient
						? coldLid
						: null,
		getPNForLID: async (jid: string) =>
			jid.startsWith('100000000000001')
				? ownPn
				: jid.startsWith('100000000000002')
					? remotePn
					: jid.startsWith('127496221651050') && coldRecipient
						? coldCanonicalPn
						: null,
		getKnownPNForLID,
		getLIDsForPNs: async (jids: string[]) =>
			jids.flatMap(jid =>
				jid.startsWith('5511000000001') ? (ownMapping ? [{ pn: jid, lid: ownLid }] : []) : [{ pn: jid, lid: remoteLid }]
			),
		storeLIDPNMappings: async () => {
			coldMappingKnown = true
		}
	}
	const signalRepository = {
		lidMapping: mapping,
		validateSession: async () => ({ exists: true }),
		encryptMessage: async ({
			jid,
			data,
			useLegacyLock
		}: {
			jid: string
			data: Uint8Array
			useLegacyLock?: boolean
		}) => {
			encryptions.push({ jid, data, useLegacyLock })
			return { type: 'pkmsg' as const, ciphertext: Buffer.from(`ciphertext:${jid}`) }
		},
		jidToSignalProtocolAddress: (jid: string) => jid,
		getSessionInfo: async () => null,
		injectE2ESession: async () => undefined,
		deleteSession: async () => undefined,
		migrateSession: async () => ({ migrated: 0, skipped: 0, total: 0 })
	} as any
	const ev = new EventEmitter()
	const authState = { creds: { me: { id: `${ownPn.split('@')[0]}:1@s.whatsapp.net`, lid: `${ownLid}` } }, keys }
	const sock = {
		ev,
		authState,
		signalRepository,
		messageMutex: { mutex: async <T>(work: () => Promise<T>) => work() },
		sessionActivityTracker: { recordActivity: () => undefined },
		upsertMessage: async () => undefined,
		query: async () => ({ tag: 'iq', attrs: {}, content: [] }),
		fetchPrivacySettings: async () => ({ readreceipts: 'all' }),
		fetchAccountReachoutTimelock: async () => undefined,
		fetchNewChatMessageCap: async () => undefined,
		groupMetadata: async () => ({ participants: [] }),
		groupToggleEphemeral: async () => undefined,
		registerSocketDrainHandler: (handler: () => void | Promise<void>) => drainHandlers.push(handler),
		registerSocketEndHandler: (handler: () => void | Promise<void>) => endHandlers.push(handler),
		runWithSocketOperation:
			socketOperationGate?.run || jest.fn(async <T>(operation: () => Promise<T> | T) => operation()),
		assertNativeAndroidIntegrityReady,
		executeUSyncQuery: async (query: any) => ({
			list: query.users.flatMap((user: any) => {
				if (coldRecipient && (user as any).phone) {
					return [
						{
							id: coldCanonicalPn,
							jid: coldCanonicalPn,
							pnJid: coldCanonicalPn,
							newJid: coldLid,
							lid: coldLid,
							contactType: 'in'
						}
					]
				}

				if (!user.id) return []
				if (!returnPnDevicesForLidQueries) return [makeDeviceResult(user.id)]
				if (user.id.startsWith('100000000000001')) return [makeDeviceResult(ownPn)]
				if (user.id.startsWith('100000000000002')) return [makeDeviceResult(remotePn)]

				return [makeDeviceResult(user.id)]
			})
		}),
		sendNode: async (node: any) => {
			sent.push(node)
			await onSendNode?.(node, sent.length)
		},
		generateMessageTag: () => 'tag-1',
		end: async (error?: Error) => {
			await socketOperationGate?.closeAdmission(error)
			for (const handler of [...drainHandlers, ...endHandlers]) await handler()
		}
	}
	return { sock, sent, encryptions, mapping }
}

const makeConfig = (auth: any): SocketConfig => ({
	transportProfile: 'web',
	waWebSocketUrl: 'wss://web.whatsapp.com/ws',
	connectTimeoutMs: 5_000,
	defaultQueryTimeoutMs: 5_000,
	keepAliveIntervalMs: 30_000,
	logger: noopLogger,
	version: [2, 3000, 1044296537],
	versionCheckIntervalMs: 0,
	browser: ['InfiniteAPI', 'Chrome', '1.0.0'],
	emitOwnEvents: false,
	customUploadHosts: [],
	retryRequestDelayMs: 0,
	maxMsgRetryCount: 3,
	auth,
	shouldSyncHistoryMessage: () => false,
	transactionOpts: { maxCommitRetries: 3, delayBetweenTriesMs: 10 },
	markOnlineOnConnect: false,
	countryCode: '55',
	syncFullHistory: false,
	fireInitQueries: false,
	generateHighQualityLinkPreview: false,
	linkPreviewImageThumbnailWidth: 100,
	options: {},
	enableAutoSessionRecreation: false,
	enableRecentMessageCache: false,
	enableCTWARecovery: false,
	enableInteractiveMessages: false,
	clearRoutingInfoOnStart: false,
	shouldIgnoreJid: () => false,
	patchMessageBeforeSending: message => message,
	appStateMacVerification: { patch: false, snapshot: false },
	getMessage: async () => undefined,
	cachedGroupMetadata: async () => undefined,
	makeSignalRepository: () => ({}) as any
})

let activeFakeSocket: any
jest.unstable_mockModule('../../Socket/newsletter.js', () => ({
	makeNewsletterSocket: () => activeFakeSocket
}))

const { makeMessagesSocket } = await import('../../Socket/messages-send.js')

describe('messages-send stanza assembly', () => {
	const legacyReplyMessage = () =>
		proto.Message.fromObject({
			buttonsMessage: {
				contentText: 'Choose an option',
				footerText: 'Support',
				headerType: proto.Message.ButtonsMessage.HeaderType.EMPTY,
				buttons: Array.from({ length: 16 }, (_, index) => ({
					buttonId: `option-${index + 1}`,
					buttonText: { displayText: `Option ${index + 1}` },
					type: proto.Message.ButtonsMessage.Button.Type.RESPONSE
				}))
			}
		})

	it('blocks new user egress before encryption while keeping retry and peer recovery available', async () => {
		const guard = jest.fn<() => void>(() => {
			throw new Boom('integrity pending', { statusCode: 428 })
		})
		const fake = makeFakeSocket({ assertNativeAndroidIntegrityReady: guard })
		activeFakeSocket = fake.sock
		const socket = makeMessagesSocket(makeConfig(fake.sock.authState) as any)
		try {
			await expect(
				socket.relayMessage(remotePn, proto.Message.fromObject({ conversation: 'blocked' }), {
					messageId: 'BLOCKED-1'
				})
			).rejects.toMatchObject({ output: { statusCode: 428 } })
			expect(fake.encryptions).toHaveLength(0)
			expect(fake.sent).toHaveLength(0)

			guard.mockImplementation(() => undefined)
			await socket.relayMessage(remotePn, proto.Message.fromObject({ conversation: 'retry' }), {
				messageId: 'RETRY-1',
				participant: { jid: `${remotePn.split('@')[0]}:2@s.whatsapp.net`, count: 1 }
			})
			await socket.relayMessage(ownPn, proto.Message.fromObject({ conversation: 'peer recovery' }), {
				messageId: 'PEER-1',
				additionalAttributes: { category: 'peer' }
			})
			expect(guard).toHaveBeenCalledTimes(1)
			expect(fake.sent.length).toBeGreaterThanOrEqual(2)
		} finally {
			await socket.end(new Error('test completed'))
		}
	})

	it('keeps remote envelope, participant fanout and DSM destination in the same LID route', async () => {
		const fake = makeFakeSocket()
		activeFakeSocket = fake.sock
		const socket = makeMessagesSocket(makeConfig(fake.sock.authState) as any)
		try {
			await socket.relayMessage(remotePn, proto.Message.fromObject({ conversation: 'remote' }), {
				messageId: 'REMOTE-1'
			})
			expect(fake.sock.runWithSocketOperation).toHaveBeenCalledTimes(1)

			const stanza = fake.sent.at(-1)
			expect(stanza.attrs.to).toBe(remoteLid)
			const participants = stanza.content.find((node: any) => node.tag === 'participants')?.content || []
			expect(participants.length).toBeGreaterThan(0)
			expect(participants.every((node: any) => jidDecode(node.attrs.jid)?.server === 'lid')).toBe(true)
			expect(participants.some((node: any) => jidDecode(node.attrs.jid)?.user === jidDecode(remoteLid)?.user)).toBe(
				true
			)
			const ownEncryption = fake.encryptions.find(item => item.jid.startsWith('100000000000001'))
			expect(ownEncryption).toBeDefined()
			const dsm = proto.Message.decode(unpadRandomMax16(ownEncryption!.data))
			expect(dsm.deviceSentMessage?.destinationJid).toBe(remoteLid)
		} finally {
			await socket.end(new Error('test completed'))
		}
	})

	it('keeps teardown waiting through live-location sender-key distribution', async () => {
		const socketOperationGate = makeSocketOperationGate()
		let releaseDistribution!: () => void
		let markDistributionStarted!: () => void
		const distributionBlocker = new Promise<void>(resolve => {
			releaseDistribution = resolve
		})
		const distributionStarted = new Promise<void>(resolve => {
			markDistributionStarted = resolve
		})
		const fake = makeFakeSocket({
			socketOperationGate,
			onSendNode: async node => {
				if (node.tag === 'notification' && node.attrs.type === 'location') {
					markDistributionStarted()
					await distributionBlocker
				}
			}
		})
		// Live-location initiation is an official-primary-only operation.
		fake.sock.authState.creds.me.id = ownPn
		activeFakeSocket = fake.sock
		const socket = makeMessagesSocket(makeConfig(fake.sock.authState) as any)
		let endSettled = false

		const send = socket.sendLiveLocation(remotePn, {
			degreesLatitude: -23.5505,
			degreesLongitude: -46.6333
		})
		await distributionStarted
		expect(socketOperationGate.activeCount()).toBe(1)

		const end = socket.end(new Error('transport replaced')).then(() => {
			endSettled = true
		})
		await Promise.resolve()
		expect(endSettled).toBe(false)

		releaseDistribution()
		await expect(send).resolves.toMatchObject({ message: { liveLocationMessage: expect.any(Object) } })
		await end
		expect(endSettled).toBe(true)
		expect(socketOperationGate.activeCount()).toBe(0)
	})

	it('keeps a remote legacy reply-button envelope and fanout on PN', async () => {
		const fake = makeFakeSocket()
		activeFakeSocket = fake.sock
		const config = makeConfig(fake.sock.authState)
		config.enableInteractiveMessages = true
		const socket = makeMessagesSocket(config as any)
		try {
			await socket.relayMessage(remotePn, legacyReplyMessage(), { messageId: 'REMOTE-BUTTONS-PN-1' })

			const stanza = fake.sent.at(-1)
			expect(stanza.attrs.to).toBe(remotePn)
			const participants = stanza.content.find((node: any) => node.tag === 'participants')?.content || []
			expect(participants.length).toBeGreaterThan(0)
			expect(participants.every((node: any) => jidDecode(node.attrs.jid)?.server === 's.whatsapp.net')).toBe(true)
			const biz = stanza.content.find((node: any) => node.tag === 'biz')
			expect(biz?.content?.[0]).toMatchObject({
				tag: 'interactive',
				attrs: { type: 'native_flow', v: '1' },
				content: [
					{
						tag: 'native_flow',
						attrs: { name: 'mixed', v: '9' }
					}
				]
			})
			expect(stanza.content.some((node: any) => node.tag === 'bot')).toBe(true)
			expect(fake.encryptions.length).toBeGreaterThan(0)
			expect(fake.encryptions.every(item => item.useLegacyLock === true)).toBe(true)
			const ownEncryption = fake.encryptions.find(item => item.jid.startsWith('5511000000001'))
			expect(ownEncryption).toBeDefined()
			const dsm = proto.Message.decode(unpadRandomMax16(ownEncryption!.data))
			expect(dsm.deviceSentMessage?.destinationJid).toBe(remotePn)
		} finally {
			await socket.end(new Error('test completed'))
		}
	})

	it('uses the canonical PN for cold-recipient legacy reply buttons', async () => {
		const fake = makeFakeSocket({ coldRecipient: true })
		activeFakeSocket = fake.sock
		const socket = makeMessagesSocket(makeConfig(fake.sock.authState) as any)
		try {
			await socket.relayMessage(coldRequestedPn, legacyReplyMessage(), { messageId: 'COLD-BUTTONS-PN-1' })

			const stanza = fake.sent.at(-1)
			expect(stanza.attrs.to).toBe(coldCanonicalPn)
			expect(stanza.attrs.to).not.toBe(coldRequestedPn)
			const participants = stanza.content.find((node: any) => node.tag === 'participants')?.content || []
			expect(participants.length).toBeGreaterThan(0)
			expect(participants.every((node: any) => jidDecode(node.attrs.jid)?.server === 's.whatsapp.net')).toBe(true)
		} finally {
			await socket.end(new Error('test completed'))
		}
	})

	it('keeps legacy reply-button self-send on the canonical own LID', async () => {
		const fake = makeFakeSocket()
		activeFakeSocket = fake.sock
		const socket = makeMessagesSocket(makeConfig(fake.sock.authState) as any)
		try {
			await socket.relayMessage(ownPn, legacyReplyMessage(), { messageId: 'SELF-BUTTONS-LID-1' })

			const stanza = fake.sent.at(-1)
			expect(stanza.attrs.to).toBe(ownLid)
			const participants = stanza.content.find((node: any) => node.tag === 'participants')?.content || []
			expect(participants.length).toBeGreaterThan(0)
			expect(participants.every((node: any) => jidDecode(node.attrs.jid)?.server === 'lid')).toBe(true)
		} finally {
			await socket.end(new Error('test completed'))
		}
	})

	it('keeps a remote LID envelope aligned when the own PN mapping cache is cold', async () => {
		const fake = makeFakeSocket({ ownMapping: false })
		activeFakeSocket = fake.sock
		const socket = makeMessagesSocket(makeConfig(fake.sock.authState) as any)
		try {
			await socket.relayMessage(remotePn, proto.Message.fromObject({ conversation: 'cold own mapping' }), {
				messageId: 'REMOTE-COLD-OWN-1'
			})

			const stanza = fake.sent.at(-1)
			expect(stanza.attrs.to).toBe(remoteLid)
			const participants = stanza.content.find((node: any) => node.tag === 'participants')?.content || []
			expect(participants.length).toBeGreaterThan(0)
			expect(participants.every((node: any) => jidDecode(node.attrs.jid)?.server === 'lid')).toBe(true)
			expect(participants.some((node: any) => jidDecode(node.attrs.jid)?.user === jidDecode(remoteLid)?.user)).toBe(
				true
			)
			expect(fake.encryptions.some(item => item.jid.startsWith('100000000000001'))).toBe(true)
			expect(fake.encryptions.some(item => jidDecode(item.jid)?.server === 's.whatsapp.net')).toBe(false)
		} finally {
			await socket.end(new Error('test completed'))
		}
	})

	it('publishes one canonical chat identity for a cold recipient whose PN changes', async () => {
		const fake = makeFakeSocket({ coldRecipient: true })
		activeFakeSocket = fake.sock
		const chatUpdates: any[] = []
		const deliveryStates: any[] = []
		fake.sock.ev.on('chats.update', (updates: any[]) => chatUpdates.push(...updates))
		fake.sock.ev.on('message.delivery-state', (update: any) => deliveryStates.push(update))
		const socket = makeMessagesSocket(makeConfig(fake.sock.authState) as any)
		try {
			const sent = await socket.sendMessage(coldRequestedPn, { text: 'cold identity' })
			const sentAgain = await socket.sendMessage(coldRequestedPn, { text: 'cold identity again' })
			const inboundReply = {
				key: { remoteJid: coldLid, fromMe: false, id: 'COLD-REPLY-1' },
				message: { conversation: 'reply' }
			} as WAMessage
			await normalizeMessageJids(inboundReply, {
				lidMapping: { getPNForLID: async () => coldCanonicalPn }
			} as any)

			expect(sent!.key.remoteJid).toBe(coldCanonicalPn)
			expect(sentAgain!.key.remoteJid).toBe(coldCanonicalPn)
			expect(inboundReply.key.remoteJid).toBe(sent!.key.remoteJid)
			expect(sent!.key.remoteJidAlt).toBe(coldLid)
			expect(fake.sent.at(-1).attrs.to).toBe(coldLid)
			expect(deliveryStates.at(-1)).toMatchObject({
				requestedJid: coldRequestedPn,
				canonicalJid: coldCanonicalPn,
				wireJid: coldLid,
				key: { remoteJid: coldCanonicalPn, remoteJidAlt: coldLid }
			})
			expect(chatUpdates).toEqual(
				expect.arrayContaining([
					expect.objectContaining({ id: coldCanonicalPn, previousId: coldLid, merged: true }),
					expect.objectContaining({ id: coldCanonicalPn, previousId: coldRequestedPn, merged: true })
				])
			)
		} finally {
			await socket.end(new Error('test completed'))
		}
	})

	it('continues a cold-recipient relay when the identity callback throws', async () => {
		const fake = makeFakeSocket({ coldRecipient: true })
		activeFakeSocket = fake.sock
		const socket = makeMessagesSocket(makeConfig(fake.sock.authState) as any)
		try {
			await expect(
				socket.relayMessage(
					coldRequestedPn,
					{ conversation: 'callback isolation' },
					{
						messageId: 'COLD-CALLBACK-1',
						onResolvedRecipient: () => {
							throw new Error('consumer callback failed')
						}
					}
				)
			).resolves.toBe('COLD-CALLBACK-1')
			expect(fake.sent.at(-1).attrs).toMatchObject({ id: 'COLD-CALLBACK-1', to: coldLid })
		} finally {
			await socket.end(new Error('test completed'))
		}
	})

	it('canonicalizes stale PN device rows before building a remote LID fanout', async () => {
		const fake = makeFakeSocket({ returnPnDevicesForLidQueries: true })
		activeFakeSocket = fake.sock
		const socket = makeMessagesSocket(makeConfig(fake.sock.authState) as any)
		try {
			await socket.relayMessage(remotePn, proto.Message.fromObject({ conversation: 'stale PN device rows' }), {
				messageId: 'REMOTE-STALE-PN-1'
			})

			const stanza = fake.sent.at(-1)
			expect(stanza.attrs.to).toBe(remoteLid)
			const participants = stanza.content.find((node: any) => node.tag === 'participants')?.content || []
			expect(participants.length).toBeGreaterThan(0)
			expect(participants.every((node: any) => jidDecode(node.attrs.jid)?.server === 'lid')).toBe(true)
			expect(participants.some((node: any) => jidDecode(node.attrs.jid)?.user === jidDecode(remoteLid)?.user)).toBe(
				true
			)
			expect(fake.encryptions.some(item => jidDecode(item.jid)?.server === 's.whatsapp.net')).toBe(false)
		} finally {
			await socket.end(new Error('test completed'))
		}
	})

	it('does not classify a remote LID as self-send from a corrupt reverse mapping', async () => {
		const fake = makeFakeSocket({ ownMapping: false, corruptRemoteReverse: true })
		activeFakeSocket = fake.sock
		const socket = makeMessagesSocket(makeConfig(fake.sock.authState) as any)
		try {
			await socket.relayMessage(remoteLid, proto.Message.fromObject({ conversation: 'remote LID' }), {
				messageId: 'REMOTE-LID-1'
			})

			const stanza = fake.sent.at(-1)
			expect(stanza.attrs.to).toBe(remoteLid)
			const remoteEncryptions = fake.encryptions.filter(item => item.jid.startsWith('100000000000002'))
			expect(remoteEncryptions.length).toBeGreaterThan(0)
			expect(fake.mapping.getKnownPNForLID).not.toHaveBeenCalled()
		} finally {
			await socket.end(new Error('test completed'))
		}
	})

	it('canonicalizes self-send envelope and all participant devices to own LID', async () => {
		const fake = makeFakeSocket()
		activeFakeSocket = fake.sock
		const socket = makeMessagesSocket(makeConfig(fake.sock.authState) as any)
		try {
			await socket.relayMessage(ownPn, proto.Message.fromObject({ conversation: 'self' }), {
				messageId: 'SELF-1'
			})

			const stanza = fake.sent.at(-1)
			expect(stanza.attrs.to).toBe(ownLid)
			const participants = stanza.content.find((node: any) => node.tag === 'participants')?.content || []
			expect(participants.length).toBeGreaterThan(0)
			expect(participants.every((node: any) => jidDecode(node.attrs.jid)?.server === 'lid')).toBe(true)
			const ownDsm = fake.encryptions
				.filter(item => item.jid.startsWith('100000000000001'))
				.map(item => proto.Message.decode(unpadRandomMax16(item.data)))
				.find(message => message.deviceSentMessage?.destinationJid)
			expect(ownDsm?.deviceSentMessage?.destinationJid).toBe(ownLid)
		} finally {
			await socket.end(new Error('test completed'))
		}
	})

	it('keeps the original conversation in recipient for a self-device retry', async () => {
		const fake = makeFakeSocket()
		activeFakeSocket = fake.sock
		const socket = makeMessagesSocket(makeConfig(fake.sock.authState) as any)
		try {
			await socket.relayMessage(ownLid, proto.Message.fromObject({ conversation: 'retry' }), {
				messageId: 'SELF-RETRY-1',
				participant: { jid: '100000000000001:2@lid', count: 1 }
			})

			const stanza = fake.sent.at(-1)
			expect(stanza.attrs.to).toBe('100000000000001:2@lid')
			expect(stanza.attrs.recipient).toBe(ownLid)
			expect(stanza.content.filter((node: any) => node.tag === 'enc')).toHaveLength(1)
			expect(stanza.content.some((node: any) => node.tag === 'participants')).toBe(false)
		} finally {
			await socket.end(new Error('test completed'))
		}
	})
})
