/* eslint-disable @typescript-eslint/no-explicit-any */
import { jest } from '@jest/globals'
import { EventEmitter } from 'events'
import { proto } from '../../../WAProto/index.js'
import type { SignalKeyStore, SocketConfig } from '../../Types'
import { unpadRandomMax16 } from '../../Utils/generics'
import { jidDecode } from '../../WABinary'

type CapturedEncryption = { jid: string; data: Uint8Array }

const ownPn = '5511000000001@s.whatsapp.net'
const ownLid = '100000000000001@lid'
const remotePn = '5511000000002@s.whatsapp.net'
const remoteLid = '100000000000002@lid'

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
	corruptRemoteReverse = false
}: { ownMapping?: boolean; corruptRemoteReverse?: boolean } = {}) => {
	const sent: any[] = []
	const encryptions: CapturedEncryption[] = []
	const endHandlers: Array<() => void | Promise<void>> = []
	const drainHandlers: Array<() => void | Promise<void>> = []
	const keys = makeKeys()
	const mapping = {
		getLIDForPN: async (jid: string) =>
			jid.startsWith('5511000000001') && ownMapping ? ownLid : jid.startsWith('5511000000002') ? remoteLid : null,
		getKnownLIDForPN: async (jid: string) =>
			jid.startsWith('5511000000001') && ownMapping ? ownLid : jid.startsWith('5511000000002') ? remoteLid : null,
		getPNForLID: async (jid: string) =>
			jid.startsWith('100000000000001') ? ownPn : jid.startsWith('100000000000002') ? remotePn : null,
		getKnownPNForLID: async (jid: string) =>
			jid.startsWith('100000000000001')
				? ownPn
				: jid.startsWith('100000000000002')
					? corruptRemoteReverse
						? ownPn
						: remotePn
					: null,
		getLIDsForPNs: async (jids: string[]) =>
			jids.flatMap(jid =>
				jid.startsWith('5511000000001') ? (ownMapping ? [{ pn: jid, lid: ownLid }] : []) : [{ pn: jid, lid: remoteLid }]
			),
		storeLIDPNMappings: async () => undefined
	}
	const signalRepository = {
		lidMapping: mapping,
		validateSession: async () => ({ exists: true }),
		encryptMessage: async ({ jid, data }: { jid: string; data: Uint8Array }) => {
			encryptions.push({ jid, data })
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
		executeUSyncQuery: async (query: { users: Array<{ id?: string }> }) => ({
			list: query.users.flatMap(user => (user.id ? [makeDeviceResult(user.id)] : []))
		}),
		sendNode: async (node: any) => {
			sent.push(node)
		},
		generateMessageTag: () => 'tag-1',
		end: async () => {
			for (const handler of [...drainHandlers, ...endHandlers]) await handler()
		}
	}
	return { sock, sent, encryptions }
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
	it('keeps remote envelope, participant fanout and DSM destination in the same LID route', async () => {
		const fake = makeFakeSocket()
		activeFakeSocket = fake.sock
		const socket = makeMessagesSocket(makeConfig(fake.sock.authState) as any)
		try {
			await socket.relayMessage(remotePn, proto.Message.fromObject({ conversation: 'remote' }), {
				messageId: 'REMOTE-1'
			})

			const stanza = fake.sent.at(-1)
			expect(stanza.attrs.to).toBe(remoteLid)
			const participants = stanza.content.find((node: any) => node.tag === 'participants')?.content || []
			expect(participants.length).toBeGreaterThan(0)
			expect(participants.every((node: any) => jidDecode(node.attrs.jid)?.server === 'lid')).toBe(true)
			const ownEncryption = fake.encryptions.find(item => item.jid.startsWith('100000000000001'))
			expect(ownEncryption).toBeDefined()
			const dsm = proto.Message.decode(unpadRandomMax16(ownEncryption!.data))
			expect(dsm.deviceSentMessage?.destinationJid).toBe(remoteLid)
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
			expect(fake.encryptions.some(item => item.jid.startsWith('100000000000001'))).toBe(true)
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
