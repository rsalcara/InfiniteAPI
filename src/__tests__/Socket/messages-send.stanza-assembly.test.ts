/* eslint-disable @typescript-eslint/no-explicit-any */
import { Boom } from '@hapi/boom'
import { jest } from '@jest/globals'
import { createHmac } from 'crypto'
import { EventEmitter } from 'events'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { dirname, join } from 'path'
import { fileURLToPath } from 'url'
import { proto } from '../../../WAProto/index.js'
import {
	getNativeAndroidIntegrityGatedEgress,
	isNativeAndroidIntegrityCleared
} from '../../Socket/native-android-integrity-state'
import { makeSocketOperationGate } from '../../Socket/socket-operation-gate'
import { ReachoutTimelockEnforcementType, type SignalKeyStore, type SocketConfig, type WAMessage } from '../../Types'
import { addTransactionCapability } from '../../Utils/auth-utils'
import { hkdf } from '../../Utils/crypto'
import { unpadRandomMax16 } from '../../Utils/generics'
import { buildMsmsgCacheKey } from '../../Utils/meta-ai-msmsg'
import { META_AI_PUBLIC_ALIAS } from '../../Utils/meta-ai-outbound'
import { normalizeMessageJids } from '../../Utils/process-message'
import { getMessageReportingToken } from '../../Utils/reporting-utils'
import { encodeBinaryNode, isJidMetaAI, jidDecode } from '../../WABinary'

type CapturedEncryption = { jid: string; data: Uint8Array; useLegacyLock?: boolean }

const ownPn = '5511000000001@s.whatsapp.net'
const ownLid = '100000000000001@lid'
const remotePn = '5511000000002@s.whatsapp.net'
const remoteLid = '100000000000002@lid'
const coldRequestedPn = '5543991910391@s.whatsapp.net'
const coldCanonicalPn = '554391910391@s.whatsapp.net'
const coldLid = '127496221651050@lid'
const groupJid = '120363012345678900@g.us'
const metaAiJid = '718584497008509@bot'

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
		// Expose only the non-primary Meta AI device so the send path must
		// explicitly add the primary device; this keeps the routing assertion real.
		deviceList: isJidMetaAI(jid)
			? [{ id: 2, keyIndex: 2 }]
			: [
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
	const baseSignalRepository = {
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
	const signalRepository = {
		...baseSignalRepository,
		encryptGroupMessage: async ({ group, data }: { group: string; data: Uint8Array }) => {
			encryptions.push({ jid: group, data })
			return {
				ciphertext: new Uint8Array(),
				senderKeyDistributionMessage: new Uint8Array()
			}
		}
	}
	const ev = new EventEmitter()
	const authState = { creds: { me: { id: `${ownPn.split('@')[0]}:1@s.whatsapp.net`, lid: `${ownLid}` } }, keys }
	const sock = {
		ev,
		authState,
		signalRepository,
		messageMutex: { mutex: async <T>(work: () => Promise<T>) => work() },
		sessionActivityTracker: { recordActivity: () => undefined },
		upsertMessage: async () => undefined,
		fetchStartChatTrustSignals: undefined as unknown as (
			jid: string,
			context?: { lookupJid: string; pnJid?: string }
		) => Promise<any>,
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
				if (coldRecipient && user.phone) {
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
			const gatedEgress = getNativeAndroidIntegrityGatedEgress(node)
			if (gatedEgress && !isNativeAndroidIntegrityCleared(node)) assertNativeAndroidIntegrityReady?.(gatedEgress)
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
			// The retry and peer stanzas must arrive at sendNode with the same
			// object identity the relay guard marked as cleared. If a refactor
			// clones the stanza between mark and send, this fails and prevents
			// silent reintroduction of the retry-blocking bug.
			expect(isNativeAndroidIntegrityCleared(fake.sent[0])).toBe(true)
			expect(isNativeAndroidIntegrityCleared(fake.sent[1])).toBe(true)
		} finally {
			await socket.end(new Error('test completed'))
		}
	})

	it('keeps peer recovery to our own number open while the account is timelocked', async () => {
		// The app's new-chat gate skips the account itself (`CappingGatingManager.A02`
		// → `UserScopeMeManager.BN3`): a PDO to our own phone must not get the
		// cold-recipient 403 that a timelocked account gets for a new chat.
		const fake = makeFakeSocket()
		activeFakeSocket = fake.sock
		const socket = makeMessagesSocket(makeConfig(fake.sock.authState) as any)
		try {
			fake.sock.ev.emit('connection.update', {
				reachoutTimeLock: {
					isActive: true,
					timeEnforcementEnds: new Date(Date.now() + 3_600_000),
					enforcementType: ReachoutTimelockEnforcementType.RESTRICT_ALL_COMPANIONS
				}
			})

			await socket.relayMessage(ownPn, proto.Message.fromObject({ conversation: 'peer recovery' }), {
				messageId: 'PEER-TIMELOCK-1',
				additionalAttributes: { category: 'peer' }
			})
			expect(fake.sent.map(node => node.attrs.id)).toContain('PEER-TIMELOCK-1')

			await expect(
				socket.relayMessage(remotePn, proto.Message.fromObject({ conversation: 'cold' }), {
					messageId: 'COLD-TIMELOCK-1'
				})
			).rejects.toMatchObject({ output: { statusCode: 403 }, data: { category: 'reachout' } })
			expect(fake.sent.map(node => node.attrs.id)).not.toContain('COLD-TIMELOCK-1')

			// A contact whose PN digits equal our LID is still someone else: self
			// is matched per namespace (PN to PN, LID to LID), not by digits.
			const lookalikePn = `${ownLid.split('@')[0]}@s.whatsapp.net`
			await expect(
				socket.relayMessage(lookalikePn, proto.Message.fromObject({ conversation: 'lookalike' }), {
					messageId: 'LOOKALIKE-TIMELOCK-1'
				})
			).rejects.toMatchObject({ output: { statusCode: 403 }, data: { category: 'reachout' } })
		} finally {
			await socket.end(new Error('test completed'))
		}
	})

	it('rejects an encrypted CAG reaction without a target key at sendMessage', async () => {
		const fake = makeFakeSocket()
		activeFakeSocket = fake.sock
		const socket = makeMessagesSocket(makeConfig(fake.sock.authState) as any)
		try {
			const content = {
				react: {
					text: '🔥',
					parentMessageSecret: Buffer.alloc(32, 0x42),
					senderJid: ownPn
				}
			} as any

			await expect(socket.sendMessage(remotePn, content)).rejects.toMatchObject({
				message: 'react.key.id is required for an encrypted CAG reaction',
				output: { statusCode: 400 }
			})
			expect(fake.sent).toHaveLength(0)
			expect(fake.encryptions).toHaveLength(0)
		} finally {
			await socket.end(new Error('encrypted CAG reaction guard test completed'))
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
			// The fixture's DSM payload includes an unknown message field that
			// protobufjs cannot skip here; valid Message bytes follow the header.
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

	it('routes the official OTP native-flow button without the bot marker', async () => {
		const fake = makeFakeSocket()
		activeFakeSocket = fake.sock
		const config = makeConfig(fake.sock.authState)
		config.enableInteractiveMessages = true
		const socket = makeMessagesSocket(config as any)
		try {
			const message = proto.Message.fromObject({
				interactiveMessage: {
					body: { text: '123456 is your verification code' },
					nativeFlowMessage: {
						buttons: [
							{
								name: 'otp',
								buttonParamsJson: JSON.stringify({
									otp_type: 'ONE_TAP',
									cta_display_name: 'Example App',
									code_expiration_minutes: 10,
									supported_apps: [{ package_name: 'com.example.app', signature_hash: 'AB:CD:EF' }]
								})
							}
						],
						messageParamsJson: '{}',
						messageVersion: 1
					}
				}
			})
			await socket.relayMessage(remotePn, message, { messageId: 'OFFICIAL-OTP-1' })

			const stanza = fake.sent.at(-1)
			const biz = stanza.content.find((node: any) => node.tag === 'biz')
			expect(biz?.content?.[0]).toMatchObject({
				tag: 'interactive',
				attrs: { type: 'native_flow', v: '1' },
				content: [{ tag: 'native_flow', attrs: { name: 'otp', v: '9' } }]
			})
			expect(stanza.content.some((node: any) => node.tag === 'bot')).toBe(false)
		} finally {
			await socket.end(new Error('test completed'))
		}
	})

	it('caches group Meta AI prompt secrets under the participant-qualified reply key', async () => {
		const fake = makeFakeSocket()
		activeFakeSocket = fake.sock
		const socket = makeMessagesSocket(makeConfig(fake.sock.authState) as any)
		try {
			const messageSecret = Buffer.alloc(32, 9)
			await fake.sock.authState.keys.set({
				tctoken: {
					[groupJid]: { token: Buffer.from('group-token'), timestamp: String(Math.floor(Date.now() / 1000)) }
				}
			})
			await socket.relayMessage(
				groupJid,
				proto.Message.fromObject({
					conversation: 'group Meta AI prompt',
					messageContextInfo: { messageSecret }
				}),
				{
					messageId: 'GROUP-META-AI-1',
					metaAi: { botJid: '718584497008509@bot' }
				}
			)

			const cache = activeFakeSocket.__msmsgSecretCache
			for (const participant of [ownPn, ownLid]) {
				expect(
					cache.get(
						buildMsmsgCacheKey({
							fromMe: true,
							remoteJid: groupJid,
							id: 'GROUP-META-AI-1',
							participant
						})
					)
				).toEqual(messageSecret)
			}

			const stanza = fake.sent.at(-1)
			expect(stanza.attrs.to).toBe(groupJid)
			expect(stanza.content.some((node: any) => node.tag === 'bot')).toBe(true)

			const groupEncryption = fake.encryptions.find(item => item.jid === groupJid)
			expect(groupEncryption).toBeDefined()
			const groupMessage = proto.Message.decode(unpadRandomMax16(groupEncryption!.data))
			const groupContext = groupMessage.messageContextInfo
			expect(groupContext?.messageSecret).toBeFalsy()
			expect(groupContext?.botMessageSecret).toEqual(Buffer.from(hkdf(messageSecret, 32, { info: 'Bot Message' })))
			expect(groupContext?.botMetadata?.botMetricsMetadata?.destinationEntryPoint).toBe(
				proto.BotMetricsEntryPoint.INVOKE_META_AI_GROUP
			)
			expect(stanza.content.some((node: any) => node.tag === 'tctoken')).toBe(false)
		} finally {
			await socket.end(new Error('group Meta AI cache test completed'))
		}
	})

	it('sends a direct Meta AI prompt to the bot route without leaking the root secret', async () => {
		const fake = makeFakeSocket()
		activeFakeSocket = fake.sock
		const socket = makeMessagesSocket(makeConfig(fake.sock.authState) as any)
		try {
			const messageSecret = Buffer.alloc(32, 11)
			await fake.sock.authState.keys.set({
				tctoken: {
					[metaAiJid]: { token: Buffer.from('bot-token'), timestamp: String(Math.floor(Date.now() / 1000)) }
				}
			})
			await socket.relayMessage(
				metaAiJid,
				proto.Message.fromObject({
					conversation: 'direct Meta AI prompt',
					messageContextInfo: { messageSecret }
				}),
				{
					messageId: 'DIRECT-META-AI-1',
					metaAi: { type: 'prompt' }
				}
			)

			const stanza = fake.sent.at(-1)
			expect(stanza.attrs.to).toBe(metaAiJid)
			const botNode = stanza.content.find((node: any) => node.tag === 'bot')
			expect(botNode?.attrs).toMatchObject({ type: 'prompt', client_thread_id: expect.any(String) })

			const botEncryption = fake.encryptions.find(item => item.jid === metaAiJid)
			expect(botEncryption).toBeDefined()
			const botMessage = proto.Message.decode(unpadRandomMax16(botEncryption!.data))
			const context = botMessage.messageContextInfo
			expect(context?.messageSecret).toBeFalsy()
			expect(context?.botMessageSecret).toEqual(Buffer.from(hkdf(messageSecret, 32, { info: 'Bot Message' })))
			expect(context?.botMetadata?.botMetricsMetadata).toMatchObject({
				destinationId: metaAiJid,
				destinationEntryPoint: proto.BotMetricsEntryPoint.INVOKE_META_AI_1ON1
			})

			const participants = stanza.content.find((node: any) => node.tag === 'participants')?.content || []
			const botParticipants = participants.filter((node: any) => jidDecode(node.attrs.jid)?.server === 'bot')
			expect(botParticipants.map((node: any) => node.attrs.jid).sort()).toEqual([
				`${jidDecode(metaAiJid)?.user}:2@bot`,
				`${jidDecode(metaAiJid)?.user}@bot`
			])
			expect(stanza.content.some((node: any) => node.tag === 'tctoken')).toBe(false)
		} finally {
			await socket.end(new Error('direct Meta AI test completed'))
		}
	})

	it('exposes the normalized public Meta AI send contract', async () => {
		const fake = makeFakeSocket()
		activeFakeSocket = fake.sock
		const socket = makeMessagesSocket(makeConfig(fake.sock.authState) as any)
		try {
			const result = await socket.sendMetaAi({
				to: META_AI_PUBLIC_ALIAS,
				text: 'public contract prompt',
				type: 'request_welcome'
			})

			const stanza = fake.sent.at(-1)
			const botNode = stanza.content.find((node: any) => node.tag === 'bot')

			expect(result).toMatchObject({
				chatJid: META_AI_PUBLIC_ALIAS,
				botJid: META_AI_PUBLIC_ALIAS,
				type: 'request_welcome',
				threadType: 'default',
				createdNewThread: true
			})
			expect(result.messageId).toBeTruthy()
			expect(result.threadId).toBe(botNode?.attrs.client_thread_id)
			expect(stanza.attrs.to).toBe(metaAiJid)
			expect(stanza.content.some((node: any) => node.tag === 'tctoken')).toBe(false)
		} finally {
			await socket.end(new Error('public Meta AI contract test completed'))
		}
	})

	it('keeps sendMetaAi callable after the socket is destructured', async () => {
		const fake = makeFakeSocket()
		activeFakeSocket = fake.sock
		const socket = makeMessagesSocket(makeConfig(fake.sock.authState) as any)
		try {
			// Gateways and SDKs routinely destructure the socket. If sendMetaAi
			// ever goes back to depending on `this`, this call throws and the
			// public contract silently breaks for the main integration idiom.
			const { sendMetaAi } = socket as any
			const result = await sendMetaAi({
				to: META_AI_PUBLIC_ALIAS,
				text: 'detached call',
				type: 'request_welcome'
			})

			expect(result).toMatchObject({
				chatJid: META_AI_PUBLIC_ALIAS,
				botJid: META_AI_PUBLIC_ALIAS,
				type: 'request_welcome'
			})
			expect(fake.sent.at(-1).attrs.to).toBe(metaAiJid)
		} finally {
			await socket.end(new Error('destructured sendMetaAi test completed'))
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

	it('observes trust signals even after a cold PN→LID mapping is cached', async () => {
		const fake = makeFakeSocket({ coldRecipient: true })
		activeFakeSocket = fake.sock
		const trustUpdates: any[] = []
		const fetchStartChatTrustSignals = jest.fn(async (jid: string) => {
			const update = {
				jid,
				useCase: 'CHAT_FMX',
				status: 'unknown',
				observedAt: Date.now(),
				error: 'provider-timeout'
			}
			trustUpdates.push(update)
			fake.sock.ev.emit('start-chat.trust-signals', update)
			return update
		})
		fake.sock.fetchStartChatTrustSignals = fetchStartChatTrustSignals
		const socket = makeMessagesSocket(makeConfig(fake.sock.authState) as any)
		try {
			await socket.sendMessage(coldRequestedPn, { text: 'first cold identity' })
			const trustUpdatesAfterFirstSend = trustUpdates.length
			expect(trustUpdatesAfterFirstSend).toBeGreaterThan(0)

			await socket.sendMessage(coldRequestedPn, { text: 'cached cold identity' })

			expect(trustUpdates.length).toBe(trustUpdatesAfterFirstSend + 1)
			expect(fetchStartChatTrustSignals).toHaveBeenCalledTimes(2)
			expect(trustUpdates.at(-1)).toMatchObject({
				jid: coldRequestedPn,
				useCase: 'CHAT_FMX',
				status: 'unknown'
			})
			expect(fake.sent.at(-1).attrs.to).toBe(coldLid)
		} finally {
			await socket.end(new Error('cached trust wiring test completed'))
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

describe('messages-send cstoken (NCT) on 1:1 sends', () => {
	// NctTokenMessageSendStanzaContributor (X/C30120DHe.java) and WA Web: no
	// usable privacy token for the recipient, account salt present.
	const salt = Buffer.alloc(32, 7)
	const expectedCsToken = (lid: string) => createHmac('sha256', salt).update(Buffer.from(lid, 'utf8')).digest()
	const tags = (stanza: any) => (stanza.content as any[]).map(node => node.tag)
	const propOn = { tracked: ['24941'], values: { '24941': 'true' } }
	const propOff = { tracked: ['24941'], values: { '24941': 'false' } }

	const send = async ({
		to,
		message = proto.Message.fromObject({ conversation: 'first contact' }),
		creds,
		tctokenFor,
		knownLid,
		config: overrides = {}
	}: {
		to: string
		message?: proto.IMessage
		creds: { nctSalt?: Uint8Array; abProps?: { tracked: string[]; values: Record<string, string> } }
		tctokenFor?: string
		knownLid?: Record<string, string>
		config?: Partial<SocketConfig>
	}) => {
		const fake = makeFakeSocket()
		if (knownLid) {
			const mapping = fake.mapping as any
			const { getKnownLIDForPN, getLIDForPN } = fake.mapping
			mapping.getKnownLIDForPN = async (jid: string) => knownLid[jid] ?? getKnownLIDForPN(jid)
			mapping.getLIDForPN = async (jid: string) => knownLid[jid] ?? getLIDForPN(jid)
		}

		Object.assign(fake.sock.authState.creds, creds)
		if (tctokenFor) {
			await fake.sock.authState.keys.set({
				tctoken: {
					[tctokenFor]: { token: Buffer.from('peer-token'), timestamp: String(Math.floor(Date.now() / 1000)) }
				}
			})
		}

		activeFakeSocket = fake.sock
		const socket = makeMessagesSocket({ ...makeConfig(fake.sock.authState), ...overrides } as any)
		try {
			await socket.relayMessage(to, message, { messageId: 'NCT-1' })
			return fake.sent.at(-1)
		} finally {
			await socket.end(new Error('test completed'))
		}
	}

	it('signs the recipient LID with the account salt when there is no privacy token (web default)', async () => {
		const stanza = await send({ to: remotePn, creds: { nctSalt: salt } })

		expect(stanza.attrs.to).toBe(remoteLid)
		const csToken = stanza.content.find((node: any) => node.tag === 'cstoken')
		expect(csToken).toBeDefined()
		expect(Buffer.from(csToken.content).equals(expectedCsToken(remoteLid))).toBe(true)
		expect(tags(stanza)).not.toContain('tctoken')
		// Same slot as the privacy token: after the participants and device identity.
		expect(tags(stanza).indexOf('cstoken')).toBeGreaterThan(tags(stanza).indexOf('participants'))
	})

	it('signs the known LID when the envelope stays on PN, ahead of the biz nodes', async () => {
		const stanza = await send({
			to: remotePn,
			message: proto.Message.fromObject({
				buttonsMessage: {
					contentText: 'Choose',
					headerType: proto.Message.ButtonsMessage.HeaderType.EMPTY,
					buttons: [
						{
							buttonId: 'a',
							buttonText: { displayText: 'A' },
							type: proto.Message.ButtonsMessage.Button.Type.RESPONSE
						}
					]
				}
			}),
			creds: { nctSalt: salt },
			config: { enableInteractiveMessages: true }
		})

		expect(stanza.attrs.to).toBe(remotePn)
		const csToken = stanza.content.find((node: any) => node.tag === 'cstoken')
		expect(Buffer.from(csToken.content).equals(expectedCsToken(remoteLid))).toBe(true)
		expect(tags(stanza).indexOf('cstoken')).toBeLessThan(tags(stanza).indexOf('biz'))
	})

	it('sends the privacy token instead when the recipient has a usable one', async () => {
		const stanza = await send({ to: remotePn, creds: { nctSalt: salt }, tctokenFor: remoteLid })

		expect(tags(stanza)).toContain('tctoken')
		expect(tags(stanza)).not.toContain('cstoken')
	})

	it('follows AB prop 24941 in ab-prop mode, as the app does', async () => {
		const config = { csTokenMode: 'ab-prop' as const }
		expect(tags(await send({ to: remotePn, creds: { nctSalt: salt, abProps: propOn }, config }))).toContain('cstoken')
		expect(tags(await send({ to: remotePn, creds: { nctSalt: salt, abProps: propOff }, config }))).not.toContain(
			'cstoken'
		)
		expect(tags(await send({ to: remotePn, creds: { nctSalt: salt }, config }))).not.toContain('cstoken')
	})

	it('adds nothing without a synced salt or with the mode off', async () => {
		expect(tags(await send({ to: remotePn, creds: {} }))).not.toContain('cstoken')
		expect(tags(await send({ to: remotePn, creds: { nctSalt: salt }, config: { csTokenMode: 'off' } }))).not.toContain(
			'cstoken'
		)
	})

	it('never signs PSA or bot recipients, even with a known LID', async () => {
		for (const to of ['0@s.whatsapp.net', '13135550002@s.whatsapp.net']) {
			const stanza = await send({ to, creds: { nctSalt: salt }, knownLid: { [to]: '100000000000077@lid' } })
			expect(tags(stanza)).not.toContain('cstoken')
		}
	})

	it('never signs a group send', async () => {
		const stanza = await send({ to: groupJid, creds: { nctSalt: salt } })

		expect(stanza.attrs.to).toBe(groupJid)
		expect(tags(stanza)).not.toContain('cstoken')
	})
})

/**
 * Golden wire shapes for the 32 message types below (interactive first)
 * across 5 routes. Families outside this list (edit/revoke, status, newsletter,
 * event, album, lottie, view once, sendMessage-side generation) are PR-00b,
 * see docs/auditoria-1a1/README.md. These assertions freeze the exact stanza
 * the engine emits today so the 1:1 remediation PRs (lanes, outbox, retry
 * rules, persistence) cannot change a single attribute or child of a send
 * without the diff being visible here.
 *
 * Only non-deterministic values are masked: message secrets and the carousel
 * `quality_control.decision_id`. Everything else — tags, attributes, child
 * order, fanout targets, `biz`/`bot` nodes, DSM wrapping and the decrypted
 * payload of every encryption — is compared exactly.
 *
 * Regenerate intentionally with `UPDATE_GOLDEN=1`; a PR that does so must
 * justify every changed entry.
 */
describe('messages-send golden wire shapes', () => {
	const GOLDEN_PATH = join(dirname(fileURLToPath(import.meta.url)), '__fixtures__', 'send-stanzas.golden.json')
	const UPDATE_GOLDEN = process.env.UPDATE_GOLDEN === '1'
	const golden: Record<string, unknown> = existsSync(GOLDEN_PATH) ? JSON.parse(readFileSync(GOLDEN_PATH, 'utf8')) : {}
	const actual: Record<string, unknown> = {}
	const MASKED_KEY = /secret|decision_id/i

	const bytes = (value: Uint8Array) => {
		const buffer = Buffer.from(value)
		const text = buffer.toString('utf8')
		return /^[\x20-\x7e]*$/.test(text) ? `utf8:${text}` : `b64:${buffer.toString('base64')}`
	}

	const maskValue = (key: string, value: unknown): unknown => (MASKED_KEY.test(key) ? '<masked>' : value)

	// Attributes stay as ordered [key, value] pairs: the binary encoder writes
	// them in insertion order, so the order is part of the wire shape.
	const normalizeNode = (node: any): unknown => {
		if (node instanceof Uint8Array) return bytes(node)
		if (typeof node === 'string' || node === undefined || node === null) return node ?? null
		const attrs = Object.entries(node.attrs || {}).map(([key, value]) => [key, maskValue(key, value)])
		const content = Array.isArray(node.content)
			? node.content.map(normalizeNode)
			: node.content instanceof Uint8Array
				? bytes(node.content)
				: (node.content ?? null)
		return { tag: node.tag, attrs, content }
	}

	// The same node with random values replaced by a fixed placeholder, so the
	// encoder output is deterministic and can be frozen as bytes.
	const maskNode = (node: any): any => {
		if (!node || typeof node !== 'object' || node instanceof Uint8Array) return node
		return {
			tag: node.tag,
			attrs: Object.fromEntries(
				Object.entries(node.attrs || {}).map(([key, value]) => [key, maskValue(key, value) as string])
			),
			content: Array.isArray(node.content) ? node.content.map(maskNode) : node.content
		}
	}

	const wireBytes = (node: any) => Buffer.from(encodeBinaryNode(maskNode(node))).toString('base64')

	// PII guard: a golden may only contain the synthetic identities and fixed
	// timestamps of this suite. Every run of 10+ digits (JID user, phone with
	// or without "+", inside JSON strings such as buttonParamsJson) and every
	// JID user of 5+ digits must be one of them; base64 payloads and the
	// encoder bytes are skipped. Applied
	// when comparing and to every entry written with UPDATE_GOLDEN=1.
	const SYNTHETIC_NUMBERS = new Set([
		...[ownPn, ownLid, remotePn, remoteLid, groupJid].map(jid => jid.split('@')[0]),
		'5511000000000',
		'1789500100',
		'1789500100000'
	])
	const assertSyntheticIdentities = (name: string, value: unknown) => {
		const foreign = new Set<string>()
		const visit = (node: unknown, key = ''): void => {
			if (key === 'wire') return
			if (Array.isArray(node)) {
				for (const item of node) visit(item, key)
			} else if (node && typeof node === 'object') {
				for (const [childKey, child] of Object.entries(node)) visit(child, childKey)
			} else if (typeof node === 'string' || typeof node === 'number' || typeof node === 'bigint') {
				const text = String(node)
				if (text.startsWith('b64:')) return
				for (const [digits] of text.matchAll(/\d{10,}/g)) {
					if (!SYNTHETIC_NUMBERS.has(digits)) foreign.add(digits)
				}

				// JID users can be shorter than 10 digits (short national numbers).
				for (const [, user] of text.matchAll(/(\d{5,})(?::\d+)?@/g)) {
					if (!SYNTHETIC_NUMBERS.has(user)) foreign.add(user!)
				}
			}
		}

		visit(value)
		if (foreign.size) {
			throw new Error(`golden "${name}" contains non-synthetic identities: ${[...foreign].join(', ')}`)
		}
	}

	const maskJson = (value: unknown, key = ''): unknown => {
		if (MASKED_KEY.test(key)) return '<masked>'
		if (Array.isArray(value)) return value.map(item => maskJson(item))
		if (value && typeof value === 'object') {
			return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, maskJson(v, k)]))
		}

		return value
	}

	const decodeEncryption = (item: CapturedEncryption) => {
		let message: unknown
		try {
			message = maskJson(proto.Message.decode(unpadRandomMax16(item.data)).toJSON())
		} catch {
			message = bytes(item.data)
		}

		return { jid: item.jid, legacyLock: item.useLegacyLock ?? null, message }
	}

	const capture = (fake: ReturnType<typeof makeFakeSocket>) => ({
		stanzas: fake.sent.map(normalizeNode),
		wire: fake.sent.map(wireBytes),
		encryptions: fake.encryptions.map(decodeEncryption)
	})

	const expectGolden = (name: string, value: unknown) => {
		assertSyntheticIdentities(name, value)
		actual[name] = value
		if (UPDATE_GOLDEN) return
		if (!(name in golden)) throw new Error(`missing golden entry "${name}" — run with UPDATE_GOLDEN=1`)
		expect(value).toEqual(golden[name])
	}

	it('rejects a golden snapshot that carries a non-synthetic identity', () => {
		expect(() => assertSyntheticIdentities('probe', { to: '5511987654321@s.whatsapp.net' })).toThrow(
			/non-synthetic identities: 5511987654321/
		)
		expect(() => assertSyntheticIdentities('probe', { phone_number: '+5511987654321' })).toThrow(/5511987654321/)
		expect(() => assertSyntheticIdentities('probe', { participant: '12345678:3@s.whatsapp.net' })).toThrow(
			/non-synthetic identities: 12345678/
		)
		expect(() => assertSyntheticIdentities('probe', { buttonParamsJson: '{"phone_number":"5511987654321"}' })).toThrow(
			/5511987654321/
		)
		expect(() =>
			assertSyntheticIdentities('probe', {
				to: remoteLid,
				participant: `${ownPn}`,
				t: 1789500100,
				content: 'b64:MTIzNDU2Nzg5MDEyMzQ1',
				wire: ['5511987654321']
			})
		).not.toThrow()
	})

	// Regeneration keeps exactly one entry per case and route: entries for
	// removed cases are dropped, entries not regenerated in this run (a run
	// filtered with -t) are kept, and every written entry passes the PII guard.
	afterAll(() => {
		if (!UPDATE_GOLDEN) return
		mkdirSync(dirname(GOLDEN_PATH), { recursive: true })
		const merged: Record<string, unknown> = {}
		for (const key of expectedGoldenKeys()) {
			const value = key in actual ? actual[key] : golden[key]
			if (value === undefined) continue
			assertSyntheticIdentities(key, value)
			merged[key] = value
		}

		writeFileSync(GOLDEN_PATH, JSON.stringify(merged, null, '\t') + '\n')
	})

	const nativeFlow = (buttons: Array<{ name: string; params: Record<string, unknown> }>, text = 'Escolha uma opção') =>
		proto.Message.fromObject({
			interactiveMessage: {
				body: { text },
				footer: { text: 'InfiniteAPI' },
				nativeFlowMessage: {
					buttons: buttons.map(button => ({ name: button.name, buttonParamsJson: JSON.stringify(button.params) })),
					messageParamsJson: '{}',
					messageVersion: 1
				}
			}
		})

	const quickReply = { name: 'quick_reply', params: { display_text: 'Sim', id: 'yes' } }
	const ctaUrl = {
		name: 'cta_url',
		params: { display_text: 'Abrir', url: 'https://example.com', merchant_url: 'https://example.com' }
	}

	const carouselInteractive = () => ({
		body: { text: 'Catálogo' },
		carouselMessage: {
			cards: [1, 2].map(index => ({
				header: { title: `Card ${index}`, hasMediaAttachment: false },
				body: { text: `Descrição ${index}` },
				nativeFlowMessage: {
					buttons: [
						{
							name: 'quick_reply',
							buttonParamsJson: JSON.stringify({ display_text: `Card ${index}`, id: `card-${index}` })
						}
					],
					messageParamsJson: '{}',
					messageVersion: 1
				}
			})),
			messageVersion: 1
		}
	})

	const INTERACTIVE_CASES: Array<{ name: string; message: () => proto.IMessage }> = [
		{
			name: 'buttons-legacy',
			message: () =>
				proto.Message.fromObject({
					buttonsMessage: {
						contentText: 'Escolha',
						footerText: 'Suporte',
						headerType: proto.Message.ButtonsMessage.HeaderType.EMPTY,
						buttons: [1, 2, 3].map(index => ({
							buttonId: `opt-${index}`,
							buttonText: { displayText: `Opção ${index}` },
							type: proto.Message.ButtonsMessage.Button.Type.RESPONSE
						}))
					}
				})
		},
		{
			name: 'list-single-select',
			message: () =>
				proto.Message.fromObject({
					listMessage: {
						title: 'Menu',
						description: 'Escolha um item',
						buttonText: 'Ver opções',
						listType: proto.Message.ListMessage.ListType.SINGLE_SELECT,
						sections: [{ title: 'Seção', rows: [{ title: 'Item 1', rowId: 'row-1', description: 'Primeiro' }] }]
					}
				})
		},
		{
			name: 'template-hydrated',
			message: () =>
				proto.Message.fromObject({
					templateMessage: {
						hydratedTemplate: {
							hydratedContentText: 'Modelo',
							hydratedButtons: [{ index: 0, quickReplyButton: { displayText: 'OK', id: 'ok' } }]
						}
					}
				})
		},
		{ name: 'native-flow-quick-reply', message: () => nativeFlow([quickReply]) },
		{ name: 'native-flow-cta-url', message: () => nativeFlow([ctaUrl]) },
		{
			name: 'native-flow-cta-copy',
			message: () => nativeFlow([{ name: 'cta_copy', params: { display_text: 'Copiar', copy_code: 'ABC123' } }])
		},
		{
			name: 'native-flow-cta-call',
			message: () =>
				nativeFlow([{ name: 'cta_call', params: { display_text: 'Ligar', phone_number: '+5511000000000' } }])
		},
		{ name: 'native-flow-mixed', message: () => nativeFlow([quickReply, ctaUrl]) },
		{
			name: 'native-flow-otp',
			message: () =>
				nativeFlow([
					{
						name: 'otp',
						params: {
							otp_type: 'COPY_CODE',
							code: '123456',
							cta_display_name: 'Copiar código',
							code_expiration_minutes: 10
						}
					}
				])
		},
		{
			name: 'native-flow-review-and-pay',
			message: () => nativeFlow([{ name: 'review_and_pay', params: { currency: 'BRL' } }])
		},
		{
			name: 'native-flow-review-order',
			message: () => nativeFlow([{ name: 'review_order', params: { currency: 'BRL' } }])
		},
		{
			name: 'native-flow-catalog',
			message: () => nativeFlow([{ name: 'catalog_message', params: { display_text: 'Ver catálogo' } }])
		},
		{
			name: 'native-flow-single-select',
			message: () =>
				nativeFlow([
					{
						name: 'single_select',
						params: {
							title: 'Ver opções',
							sections: [{ title: 'Seção', rows: [{ id: 'row-1', title: 'Item 1', description: 'Primeiro' }] }]
						}
					}
				])
		},
		{
			name: 'native-flow-payment-info',
			message: () => nativeFlow([{ name: 'payment_info', params: { currency: 'BRL' } }])
		},
		{
			name: 'native-flow-mpm',
			message: () => nativeFlow([{ name: 'mpm', params: { product_retailer_id: 'SKU-1' } }])
		},
		{
			name: 'native-flow-single-product',
			message: () => nativeFlow([{ name: 'single_product', params: { product_retailer_id: 'SKU-1' } }])
		},
		{
			name: 'native-flow-product-list',
			message: () => nativeFlow([{ name: 'product_list', params: { thumbnail_product_retailer_id: 'SKU-1' } }])
		},
		{
			name: 'list-product-list',
			message: () =>
				proto.Message.fromObject({
					listMessage: {
						title: 'Produtos',
						description: 'Nossa seleção',
						buttonText: 'Ver produtos',
						listType: proto.Message.ListMessage.ListType.PRODUCT_LIST,
						productListInfo: {
							productSections: [{ title: 'Seção', products: [{ productId: 'SKU-1' }] }],
							headerImage: { productId: 'SKU-1' },
							businessOwnerJid: remotePn
						}
					}
				})
		},
		{
			name: 'interactive-plain',
			message: () => proto.Message.fromObject({ interactiveMessage: { body: { text: 'Somente texto' } } })
		},
		{ name: 'carousel', message: () => proto.Message.fromObject({ interactiveMessage: carouselInteractive() }) },
		{
			name: 'carousel-view-once-v2',
			message: () =>
				proto.Message.fromObject({ viewOnceMessageV2: { message: { interactiveMessage: carouselInteractive() } } })
		}
	]

	const MEDIA_FIELDS = {
		url: 'https://mmg.whatsapp.net/v/t62.7118-24/synthetic.enc',
		directPath: '/v/t62.7118-24/synthetic.enc',
		mediaKey: Buffer.alloc(32, 1),
		fileSha256: Buffer.alloc(32, 2),
		fileEncSha256: Buffer.alloc(32, 3),
		fileLength: 1024,
		mediaKeyTimestamp: 1789500100
	}

	const BASE_CASES: Array<{ name: string; message: () => proto.IMessage }> = [
		{ name: 'text', message: () => proto.Message.fromObject({ conversation: 'Olá' }) },
		{
			name: 'extended-text-reply',
			message: () =>
				proto.Message.fromObject({
					extendedTextMessage: { text: 'Resposta', contextInfo: { stanzaId: 'QUOTED-1', participant: remotePn } }
				})
		},
		{
			name: 'image',
			message: () =>
				proto.Message.fromObject({
					imageMessage: { ...MEDIA_FIELDS, mimetype: 'image/jpeg', caption: 'Foto', width: 64, height: 64 }
				})
		},
		{
			name: 'video',
			message: () => proto.Message.fromObject({ videoMessage: { ...MEDIA_FIELDS, mimetype: 'video/mp4', seconds: 3 } })
		},
		{
			name: 'audio-ptt',
			message: () =>
				proto.Message.fromObject({
					audioMessage: { ...MEDIA_FIELDS, mimetype: 'audio/ogg; codecs=opus', seconds: 2, ptt: true }
				})
		},
		{
			name: 'document',
			message: () =>
				proto.Message.fromObject({
					documentMessage: { ...MEDIA_FIELDS, mimetype: 'application/pdf', fileName: 'arquivo.pdf' }
				})
		},
		{
			name: 'sticker',
			message: () => proto.Message.fromObject({ stickerMessage: { ...MEDIA_FIELDS, mimetype: 'image/webp' } })
		},
		{
			name: 'location',
			message: () =>
				proto.Message.fromObject({ locationMessage: { degreesLatitude: -23.5, degreesLongitude: -46.6, name: 'SP' } })
		},
		{
			name: 'contact',
			message: () =>
				proto.Message.fromObject({
					contactMessage: {
						displayName: 'Contato',
						vcard: 'BEGIN:VCARD\nVERSION:3.0\nFN:Contato\nTEL;type=CELL:+5511000000000\nEND:VCARD'
					}
				})
		},
		{
			name: 'poll-v3',
			// Without messageSecret on purpose: with a secret the reporting token
			// depends on the random padding (audit F2-10, pinned below).
			message: () =>
				proto.Message.fromObject({
					pollCreationMessageV3: {
						name: 'Enquete',
						options: [{ optionName: 'A' }, { optionName: 'B' }],
						selectableOptionsCount: 1
					}
				})
		},
		{
			name: 'reaction',
			message: () =>
				proto.Message.fromObject({
					reactionMessage: {
						key: { remoteJid: remotePn, fromMe: false, id: 'REACTED-1' },
						text: '👍',
						senderTimestampMs: 1789500100000
					}
				})
		}
	]

	const runSend = async (
		to: string,
		message: proto.IMessage,
		opts: Record<string, unknown>,
		prepare?: (fake: ReturnType<typeof makeFakeSocket>) => void
	) => {
		const fake = makeFakeSocket()
		prepare?.(fake)
		activeFakeSocket = fake.sock
		const config = makeConfig(fake.sock.authState)
		config.enableInteractiveMessages = true
		const socket = makeMessagesSocket(config as any)
		try {
			await socket.relayMessage(to, message, opts as any)
		} finally {
			await socket.end(new Error('test completed'))
		}

		return capture(fake)
	}

	const withGroup = (fake: ReturnType<typeof makeFakeSocket>) => {
		;(fake.sock as any).groupMetadata = async () => ({
			id: groupJid,
			addressingMode: 'pn',
			participants: [
				{ id: ownPn, admin: 'admin' },
				{ id: remotePn, admin: null }
			]
		})
	}

	const GOLDEN_ROUTES = ['pn', 'lid', 'group', 'retry-remote', 'retry-self']
	function expectedGoldenKeys() {
		return [...INTERACTIVE_CASES, ...BASE_CASES]
			.flatMap(testCase => GOLDEN_ROUTES.map(route => `${route}/${testCase.name}`))
			.sort((a, b) => a.localeCompare(b))
	}

	it('keeps exactly one golden entry per case and route (no orphans, none missing)', () => {
		if (UPDATE_GOLDEN) return
		expect(Object.keys(golden).sort((a, b) => a.localeCompare(b))).toEqual(expectedGoldenKeys())
	})

	for (const testCase of [...INTERACTIVE_CASES, ...BASE_CASES]) {
		it(`freezes the 1:1 PN stanza for ${testCase.name}`, async () => {
			expectGolden(
				`pn/${testCase.name}`,
				await runSend(remotePn, testCase.message(), { messageId: `G-PN-${testCase.name}` })
			)
		})

		it(`freezes the 1:1 LID stanza for ${testCase.name}`, async () => {
			expectGolden(
				`lid/${testCase.name}`,
				await runSend(remoteLid, testCase.message(), { messageId: `G-LID-${testCase.name}` })
			)
		})

		it(`freezes the group stanza for ${testCase.name}`, async () => {
			expectGolden(
				`group/${testCase.name}`,
				await runSend(groupJid, testCase.message(), { messageId: `G-GRP-${testCase.name}` }, withGroup)
			)
		})

		it(`freezes the remote retry resend for ${testCase.name}`, async () => {
			expectGolden(
				`retry-remote/${testCase.name}`,
				await runSend(remotePn, testCase.message(), {
					messageId: `G-RETRY-${testCase.name}`,
					participant: { jid: `${remotePn.split('@')[0]}:2@s.whatsapp.net`, count: 1 }
				})
			)
		})

		it(`freezes the own-device retry resend (DSM) for ${testCase.name}`, async () => {
			expectGolden(
				`retry-self/${testCase.name}`,
				await runSend(remotePn, testCase.message(), {
					messageId: `G-SELF-${testCase.name}`,
					participant: { jid: `${ownPn.split('@')[0]}:2@s.whatsapp.net`, count: 1 }
				})
			)
		})
	}

	const sendConcurrently = async (message: () => proto.IMessage, ids: string[]) => {
		const fake = makeFakeSocket()
		// Use the real transaction capability so the send path's locking is the
		// production one (the base fake runs `transaction` without any lock).
		;(fake.sock.authState as any).keys = addTransactionCapability(makeKeys(), noopLogger, {
			maxCommitRetries: 3,
			delayBetweenTriesMs: 10
		})
		activeFakeSocket = fake.sock
		const config = makeConfig(fake.sock.authState)
		config.enableInteractiveMessages = true
		const socket = makeMessagesSocket(config as any)
		try {
			await Promise.all(ids.map(id => socket.relayMessage(remotePn, message(), { messageId: id })))
		} finally {
			await socket.end(new Error('test completed'))
		}

		return fake.sent.filter((node: any) => node.tag === 'message')
	}

	const CONCURRENT_IDS = ['CONC-1', 'CONC-2', 'CONC-3', 'CONC-4', 'CONC-5']

	it('keeps concurrent text sends to one destination in call order (FIFO)', async () => {
		const stanzas = await sendConcurrently(() => proto.Message.fromObject({ conversation: 'fifo' }), CONCURRENT_IDS)
		expect(stanzas.map((node: any) => node.attrs.id)).toEqual(CONCURRENT_IDS)
	})

	it('keeps every concurrent interactive stanza identical apart from its id', async () => {
		const stanzas = await sendConcurrently(() => nativeFlow([quickReply]), CONCURRENT_IDS)
		expect(stanzas).toHaveLength(CONCURRENT_IDS.length)
		const withoutId = (node: any) => {
			const normalized = normalizeNode(node) as any
			return {
				...normalized,
				attrs: normalized.attrs.map(([key, value]: [string, unknown]) => [key, key === 'id' ? '<id>' : value])
			}
		}

		for (const node of stanzas.slice(1)) expect(withoutId(node)).toEqual(withoutId(stanzas[0]))
	})

	// Known defect (audit F2-09): the 1:1 interactive bypass skips the send
	// lock, so a burst of interactive messages to the same chat can leave out
	// of call order. The app serializes per destination (JobQueue groupId =
	// recipient JID). PR-20 (lane per destination) flips this to `it`.
	it.failing('keeps concurrent interactive sends to one destination in call order (FIFO)', async () => {
		const stanzas = await sendConcurrently(() => nativeFlow([quickReply]), CONCURRENT_IDS)
		expect(stanzas.map((node: any) => node.attrs.id)).toEqual(CONCURRENT_IDS)
	})

	// Known defect (audit F2-10): the reporting token is computed over
	// encodeWAMessage(), which already carries the random 1-16 byte padding.
	// The extractor parses the padding as protobuf fields, so whether a token
	// is attached, and its value, change from send to send (4 of 16 padding
	// lengths yield a token, with 3 distinct values). The app derives it from
	// the message and its secret (ReportingToken, X/C29252Crs.java:25-95); it
	// is a function of the message. 64 sends make an accidental pass
	// negligible (< 1e-7). The PR that fixes F2-10 flips this to `it`.
	it.failing('attaches the same reporting token to every send of the same message', async () => {
		const message = () =>
			proto.Message.fromObject({
				messageContextInfo: { messageSecret: Buffer.alloc(32, 4) },
				pollCreationMessageV3: { name: 'Enquete', options: [{ optionName: 'A' }], selectableOptionsCount: 1 }
			})
		const reference = await getMessageReportingToken(Buffer.from(proto.Message.encode(message()).finish()), message(), {
			id: 'F210',
			fromMe: true,
			remoteJid: remoteLid
		})
		const tokenOf = (node: any) => {
			const reporting = (node.content as any[]).find(child => child.tag === 'reporting')
			return reporting ? Buffer.from(reporting.content[0].content).toString('hex') : 'none'
		}

		const observed = new Set<string>()
		for (let attempt = 0; attempt < 64; attempt++) {
			const fake = makeFakeSocket()
			activeFakeSocket = fake.sock
			const socket = makeMessagesSocket(makeConfig(fake.sock.authState) as any)
			try {
				await socket.relayMessage(remotePn, message(), { messageId: 'F210' })
			} finally {
				await socket.end(new Error('test completed'))
			}

			observed.add(tokenOf(fake.sent.find((node: any) => node.tag === 'message')))
		}

		expect([...observed]).toEqual([Buffer.from((reference!.content as any[])[0].content).toString('hex')])
	})

	// Known defect (audit F2-01 / E-01): every send runs under one global lock
	// (keys.transaction keyed by the own JID), so a slow send to one chat holds
	// every other chat. The app runs one lane per destination (JobQueue
	// groupId = recipient JID): destinations proceed in parallel. The send to
	// A (1:1) is held on the wire until B's stanza (a group) goes out, or 1 s.
	// PR-20 (lane per destination) flips this to `it`.
	it.failing('does not hold a send to another destination behind a slow one', async () => {
		let releaseA!: () => void
		const aHeld = new Promise<void>(resolve => {
			releaseA = resolve
		})
		let aOnWire = false
		let bSentWhileAHeld = false
		const fake = makeFakeSocket({
			onSendNode: async (node: any) => {
				if (node.tag !== 'message') return
				if (node.attrs.id === 'PAR-A') {
					aOnWire = true
					await Promise.race([aHeld, new Promise(resolve => setTimeout(resolve, 1_000))])
					aOnWire = false
				} else if (node.attrs.id === 'PAR-B') {
					bSentWhileAHeld = aOnWire
					releaseA()
				}
			}
		})
		withGroup(fake)
		;(fake.sock.authState as any).keys = addTransactionCapability(makeKeys(), noopLogger, {
			maxCommitRetries: 3,
			delayBetweenTriesMs: 10
		})
		activeFakeSocket = fake.sock
		const socket = makeMessagesSocket(makeConfig(fake.sock.authState) as any)
		try {
			const sendA = socket.relayMessage(remotePn, proto.Message.fromObject({ conversation: 'A' }), {
				messageId: 'PAR-A'
			})
			const deadline = Date.now() + 2_000
			while (!aOnWire && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 5))
			const sendB = socket.relayMessage(groupJid, proto.Message.fromObject({ conversation: 'B' }), {
				messageId: 'PAR-B'
			})
			await Promise.all([sendA, sendB])
		} finally {
			await socket.end(new Error('test completed'))
		}

		expect(fake.sent.map((node: any) => node.attrs.id)).toEqual(['PAR-A', 'PAR-B'])
		expect(bSentWhileAHeld).toBe(true)
	})
})
