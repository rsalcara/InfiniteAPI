import { jest } from '@jest/globals'
import { proto } from '../../../WAProto/index.js'
import { DEFAULT_CONNECTION_CONFIG, NOISE_WA_HEADER } from '../../Defaults'
import { initAuthCreds, makeCacheableSignalKeyStore } from '../../Utils/auth-utils'
import { decodeMessageNode } from '../../Utils/decode-wa-message'
import { pdoRequestCacheKey } from '../../Utils/pdo-recovery'
import type { BinaryNode } from '../../WABinary'
import { decodeBinaryNode } from '../../WABinary'

type FakeSocketClient = Record<string, any>

const ME_PN = '5511999999999@s.whatsapp.net'
const ME_LID = '1029384756@lid'
const PEER_PN = '5515991426667@s.whatsapp.net'
const PEER_LID = '207421150646274@lid'
const RECEIPT_ERROR = 'wiring: receipt transport failed'
const ACK_ERROR = 'wiring: ack transport failed'

const integrityTestClients = globalThis as typeof globalThis & {
	__infiniteApiSelfSyncWiringClients?: FakeSocketClient[]
}
integrityTestClients.__infiniteApiSelfSyncWiringClients ??= []
const clients = integrityTestClients.__infiniteApiSelfSyncWiringClients

const mockMakeFakeSocketClient = () =>
	class FakeSocketClient {
		constructor(public config: unknown) {
			this.listeners = new Map()
			this.sentNodes = []
			this.failTags = []
			clients.push(this)
		}

		listeners: Map<string, Set<(payload?: unknown) => void>>
		sentNodes: BinaryNode[]
		failTags: string[]

		on(event: string, listener: (payload?: unknown) => void) {
			if (!this.listeners.has(event)) this.listeners.set(event, new Set())
			this.listeners.get(event)!.add(listener)
		}

		off(event: string, listener: (payload?: unknown) => void) {
			this.listeners.get(event)?.delete(listener)
		}

		removeAllListeners(event?: string) {
			if (event) this.listeners.delete(event)
			else this.listeners.clear()
		}

		emit(event: string, payload?: unknown) {
			for (const listener of [...(this.listeners.get(event) ?? [])]) listener(payload)
			return true
		}

		get isOpen() {
			return true
		}

		get isClosed() {
			return false
		}

		get isClosing() {
			return false
		}

		get isConnecting() {
			return false
		}

		connect() {}

		close() {
			this.emit('close', false)
		}

		send(data: Uint8Array | string, callback?: (error?: Error) => void) {
			void decodeWiringFrame(data).then(node => {
				this.sentNodes.push(node)

				if (this.failTags.includes(node.tag)) {
					callback?.(new Error(node.tag === 'receipt' ? RECEIPT_ERROR : ACK_ERROR))
					return
				}

				callback?.()
			})
			return true
		}
	}

const decodeWiringFrame = async (frame: Uint8Array | string): Promise<BinaryNode> => {
	if (typeof frame === 'string') throw new Error('wiring test expected a binary frame')

	// Before the noise handshake, encodeFrame writes the plain binary node.
	// The very first frame can still include the fixed WA intro header.
	const offset =
		frame.length >= NOISE_WA_HEADER.length && NOISE_WA_HEADER.equals(frame.slice(0, NOISE_WA_HEADER.length))
			? NOISE_WA_HEADER.length
			: 0

	return await decodeBinaryNode(Buffer.from(frame.subarray(offset + 3)))
}

jest.unstable_mockModule('../../Socket/Client/websocket', () => ({
	WebSocketClient: mockMakeFakeSocketClient()
}))
jest.unstable_mockModule('../../Socket/Client/tcp', () => ({ TcpSocketClient: mockMakeFakeSocketClient() }))

const makeWASocket = (await import('../../Socket')).default

const makeTestLogger = () => {
	const logger: Record<string, any> = {
		level: 'warn',
		child: () => logger,
		trace: jest.fn(),
		debug: jest.fn(),
		info: jest.fn(),
		warn: jest.fn(),
		error: jest.fn(),
		fatal: jest.fn()
	}
	return logger
}

const makeSelfSyncStanza = (): BinaryNode => ({
	tag: 'message',
	attrs: {
		id: 'SELF-SYNC-WIRING-1',
		from: ME_LID,
		recipient: PEER_LID,
		type: 'chat',
		t: '1789500000',
		peer_recipient_pn: PEER_PN
	},
	content: [{ tag: 'enc', attrs: { type: 'msg' }, content: makeEncryptedPayload() }]
})

const makeInboundDmLidStanza = (): BinaryNode => ({
	tag: 'message',
	attrs: {
		id: 'PDO-IDENTITY-WIRING-1',
		from: PEER_LID,
		type: 'chat',
		t: '1789500001',
		addressing_mode: 'lid',
		sender_pn: PEER_PN
	},
	content: [{ tag: 'enc', attrs: { type: 'msg' }, content: makeEncryptedPayload() }]
})

function makeEncryptedPayload(): Uint8Array {
	const body = proto.Message.encode(proto.Message.create({ conversation: 'self-sync ack wiring' })).finish()
	// decryptMessageNode calls unpadRandomMax16; a one-byte zero pad gives it
	// the original protobuf back without involving real Signal state.
	const payload = new Uint8Array(body.length + 1)
	payload.set(body)
	payload[body.length] = 1
	return payload
}

const latestClient = () => {
	const client = clients.at(-1)
	if (!client) throw new Error('socket client was not created')
	return client
}

const waitFor = async (predicate: () => boolean) => {
	for (let index = 0; index < 200 && !predicate(); index++) {
		await new Promise(resolve => setImmediate(resolve))
	}
}

const makeSocket = async () => {
	const creds = {
		...initAuthCreds(),
		me: {
			id: ME_PN,
			name: 'self-sync wiring',
			lid: ME_LID
		}
	}

	const logger = makeTestLogger()
	const signalStore = new Map<string, unknown>()
	const rawSignalStore: any = {
		get: async (type: string, ids: string[]) =>
			ids.reduce<Record<string, unknown>>((result: Record<string, unknown>, id: string) => {
				const value = signalStore.get(`${type}.${id}`)
				if (value !== undefined) result[id] = value
				return result
			}, {}),
		set: async (data: Record<string, Record<string, unknown>>) => {
			for (const [type, records] of Object.entries(data)) {
				for (const [id, value] of Object.entries(records)) {
					signalStore.set(`${type}.${id}`, value)
				}
			}
		},
		clear: async () => signalStore.clear()
	}
	const keys = makeCacheableSignalKeyStore(rawSignalStore, logger as never)
	const socket = makeWASocket({
		...DEFAULT_CONNECTION_CONFIG,
		auth: { creds, keys },
		fireInitQueries: false,
		logger
	} as never)

	// The wiring under test is receipt/ACK ownership, not Signal crypto. Patch
	// the repository boundary so decrypt succeeds deterministically while the
	// real decode, receipt, fallback ACK, upsert and NACK wiring still run.
	socket.signalRepository.decryptMessage = async () => makeEncryptedPayload()
	// The inbound LID/PN envelope triggers session migration before the retry
	// branch under test. That repository side effect is outside this wiring and
	// can wait on real Signal records, so keep it deterministic as well.
	socket.signalRepository.migrateSession = async () => ({ migrated: 0, skipped: 0, total: 0 })
	socket.signalRepository.lidMapping.getLIDForPN = async () => null
	socket.signalRepository.lidMapping.getPNForLID = async () => null
	socket.signalRepository.lidMapping.storeLIDPNMappings = async () => ({ stored: 0, skipped: 0, errors: 0 })

	return { socket, logger }
}

describe('self-sync receipt fallback ACK wiring', () => {
	it('processes the message and dispatches a clean ACK when the sender receipt fails', async () => {
		const { socket } = await makeSocket()
		const client = latestClient()
		client.failTags = ['receipt']

		const upserts: unknown[] = []
		socket.ev.on('messages.upsert', update => upserts.push(update))

		client.emit('CB:message', makeSelfSyncStanza())
		await waitFor(
			() => upserts.length > 0 && client.sentNodes.filter((node: BinaryNode) => node.tag === 'ack').length > 0
		)

		const sentTags: string[] = client.sentNodes.map((node: BinaryNode) => node.tag)
		expect(sentTags.slice(0, 2)).toEqual(['receipt', 'ack'])
		expect(sentTags.filter(tag => tag === 'ack')).toHaveLength(1)
		expect(client.sentNodes[0]).toMatchObject({
			tag: 'receipt',
			attrs: {
				id: 'SELF-SYNC-WIRING-1',
				recipient: PEER_PN,
				to: ME_LID,
				type: 'sender'
			}
		})
		expect(client.sentNodes[1]).toMatchObject({
			tag: 'ack',
			attrs: {
				id: 'SELF-SYNC-WIRING-1',
				class: 'message',
				from: ME_PN,
				to: ME_LID,
				recipient: PEER_LID,
				type: 'chat'
			}
		})
		expect(upserts).toEqual([
			expect.objectContaining({
				type: 'notify',
				messages: [
					expect.objectContaining({
						key: expect.objectContaining({
							remoteJid: PEER_PN,
							remoteJidAlt: PEER_LID,
							fromMe: true,
							id: 'SELF-SYNC-WIRING-1'
						})
					})
				]
			})
		])

		await socket.end(new Error('test complete'))
		// Let the event-buffer backup timer settle inside the test so teardown
		// does not leak an open handle after the assertion succeeds.
		await new Promise(resolve => setTimeout(resolve, 2_100))
	})

	it('propagates the original receipt error and leaves the stanza NACK-eligible when the fallback ACK fails', async () => {
		const { socket, logger } = await makeSocket()
		const client = latestClient()
		client.failTags = ['receipt', 'ack']

		const upserts: unknown[] = []
		socket.ev.on('messages.upsert', update => upserts.push(update))

		client.emit('CB:message', makeSelfSyncStanza())
		await waitFor(
			() =>
				client.sentNodes.filter((node: BinaryNode) => node.tag === 'ack').length > 1 &&
				logger.error.mock.calls.some((call: unknown[]) => call[1] === 'error in handling message')
		)

		const sentTags: string[] = client.sentNodes.map((node: BinaryNode) => node.tag)
		expect(sentTags.slice(0, 3)).toEqual(['receipt', 'ack', 'ack'])
		expect(client.sentNodes[1]).toMatchObject({ tag: 'ack', attrs: { class: 'message' } })
		expect(client.sentNodes[2]).toMatchObject({
			tag: 'ack',
			attrs: { class: 'message', error: '500' }
		})
		expect(upserts).toEqual([])

		const handlingError = logger.error.mock.calls
			.map((call: unknown[]) => call[0])
			.find((context: any) => context?.error?.message === RECEIPT_ERROR)
		expect(handlingError).toBeDefined()

		await socket.end(new Error('test complete'))
		await new Promise(resolve => setTimeout(resolve, 2_100))
	})

	it('completes retry state staged before JID normalization through the real message handler', async () => {
		const { socket } = await makeSocket()
		const client = latestClient()
		const stanza = makeInboundDmLidStanza()

		// This is the same boundary used by handleMessage: the raw decoded key is
		// captured before normalizeMessageJids can rewrite the DM LID to its PN.
		const { fullMessage } = decodeMessageNode(stanza, ME_PN, ME_LID)
		const rawRetryIdentity = pdoRequestCacheKey(fullMessage.key)
		const manager = socket.messageRetryManager
		if (!manager) throw new Error('messageRetryManager was not exposed by the socket')
		const phoneRequestCallback = jest.fn()
		const upserts: unknown[] = []

		manager.tryIncrement(rawRetryIdentity)
		manager.schedulePhoneRequest(rawRetryIdentity, phoneRequestCallback, 50)
		socket.ev.on('messages.upsert', update => upserts.push(update))

		try {
			client.emit('CB:message', stanza)
			await waitFor(() => upserts.length > 0)

			expect(upserts).toEqual([
				expect.objectContaining({
					type: 'notify',
					messages: [
						expect.objectContaining({
							key: expect.objectContaining({
								remoteJid: PEER_PN,
								fromMe: false,
								id: 'PDO-IDENTITY-WIRING-1'
							})
						})
					]
				})
			])

			expect((manager as unknown as { pendingPhoneRequests: Record<string, unknown> }).pendingPhoneRequests).toEqual({})
			expect(phoneRequestCallback).not.toHaveBeenCalled()
			expect(manager.tryIncrement(rawRetryIdentity)).toEqual({ proceed: true, count: 1 })
		} finally {
			// A successful completion must have canceled the pending PDO timer.
			manager.cancelPendingPhoneRequest(rawRetryIdentity)
		}

		await socket.end(new Error('test complete'))
		// Drain the socket teardown timer on real timers before ending the test.
		await new Promise(resolve => setTimeout(resolve, 2_100))
	})
})
