import { jest } from '@jest/globals'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { proto } from '../../../WAProto/index.js'
import { DEFAULT_CONNECTION_CONFIG, NOISE_WA_HEADER } from '../../Defaults'
import { initAuthCreds, makeCacheableSignalKeyStore } from '../../Utils/auth-utils'
import { MessageStoreBackend } from '../../Utils/multi-db-sqlite/message-store-backend'
import { MultiDbSqliteStore } from '../../Utils/multi-db-sqlite/store'
import type { BinaryNode } from '../../WABinary'
import { decodeBinaryNode } from '../../WABinary'

type FakeSocketClient = Record<string, any>

const ME_PN = '5511999999999@s.whatsapp.net'
const ME_LID = '1029384756@lid'
const DM_A_LID = '188888000000010@lid'
const DM_A_PN = '5511888880010@s.whatsapp.net'

const orderingTestClients = globalThis as typeof globalThis & {
	__infiniteApiAudit1a1Clients?: FakeSocketClient[]
}
orderingTestClients.__infiniteApiAudit1a1Clients ??= []
const clients = orderingTestClients.__infiniteApiAudit1a1Clients

// One monotonic clock shared by the wire (frame handed to the socket) and by
// storage probes, so tests can order "sent" against "committed" exactly.
let auditClock = 0
const tick = () => ++auditClock
const sentAt = new WeakMap<BinaryNode, number>()

const mockMakeFakeSocketClient = () =>
	class FakeSocketClient {
		constructor(public config: unknown) {
			this.listeners = new Map()
			this.sentNodes = []
			clients.push(this)
		}

		listeners: Map<string, Set<(payload?: unknown) => void>>
		sentNodes: BinaryNode[]

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
			if (typeof data !== 'string') {
				const at = tick()
				void decodeWiringFrame(data).then(node => {
					sentAt.set(node, at)
					this.sentNodes.push(node)
				})
			}

			callback?.()
			return true
		}
	}

const decodeWiringFrame = async (frame: Uint8Array): Promise<BinaryNode> => {
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

const makeChatStanza = ({
	chat,
	id,
	participant,
	participantAlt,
	senderAlt,
	recipient,
	peerRecipientAlt,
	offline
}: {
	chat: string
	id: string
	participant?: string
	participantAlt?: string
	senderAlt?: string
	recipient?: string
	peerRecipientAlt?: string
	offline?: boolean
}): BinaryNode => ({
	tag: 'message',
	attrs: {
		id,
		from: chat,
		...(participant && { participant }),
		...(participantAlt && { participant_lid: participantAlt }),
		...(senderAlt && { sender_pn: senderAlt }),
		...(recipient && { recipient }),
		...(peerRecipientAlt && { peer_recipient_lid: peerRecipientAlt }),
		...(offline && { offline: 'true' }),
		t: '1789500100'
	},
	content: [
		{
			tag: 'plaintext',
			attrs: {},
			content: proto.Message.encode(proto.Message.create({ conversation: id })).finish()
		}
	]
})

const latestClient = () => {
	const client = clients.at(-1)
	if (!client) throw new Error('socket client was not created')
	return client
}

const waitFor = async (predicate: () => boolean) => {
	const deadline = Date.now() + 5_000
	while (!predicate()) {
		if (Date.now() >= deadline) throw new Error('test predicate was not satisfied within 5 seconds')
		await new Promise(resolve => setTimeout(resolve, 5))
	}
}

const makeSocket = async (
	getPNForLID?: (lid: string) => Promise<string | null>,
	overrides: Record<string, unknown> = {},
	stubLidMapping = true
) => {
	const creds = {
		...initAuthCreds(),
		me: {
			id: ME_PN,
			name: 'group ordering wiring',
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
		logger,
		...overrides
	} as never)

	if (stubLidMapping) {
		socket.signalRepository.migrateSession = async () => ({ migrated: 0, skipped: 0, total: 0 })
		socket.signalRepository.lidMapping.getLIDForPN = async () => null
		socket.signalRepository.lidMapping.getPNForLID = getPNForLID ?? (async () => null)
		socket.signalRepository.lidMapping.storeLIDPNMappings = async () => ({ stored: 0, skipped: 0, errors: 0 })
	}

	return { socket, logger, signalStore }
}

const endSocket = async (socket: Awaited<ReturnType<typeof makeSocket>>['socket']) => {
	await socket.end(new Error('test complete'))
	await new Promise(resolve => setTimeout(resolve, 2_100))
}

/**
 * Regression suite for the 1:1 audit (docs/auditoria-1a1). Each test encodes
 * the app's behavior; tests marked `it.failing` document a defect that still
 * exists and are flipped to `it` by the PR that fixes it (see
 * docs/auditoria-1a1/PLANO_DE_ACAO_PRS.md). A `failing` test that starts
 * passing makes CI red on purpose, so a fix can never land silently.
 */
describe('audit 1:1 regressions', () => {
	afterEach(() => {
		clients.length = 0
	})

	// R-01 · app: CoreMessageStore/writeMessageToDatabase → DeliveryReceipt
	// (X/C247818k.java:5921-5960): the receipt leaves only after the message
	// row is committed. The engine's durable commit is msgstore.db
	// (MessageStoreBackend.recordMessage runs its own SQLite transaction), so
	// the probe orders that commit against the receipt frame on one clock.
	// Fixed by PR-14.
	it.failing('commits an inbound message to msgstore.db before its delivery receipt leaves', async () => {
		const sessionDir = mkdtempSync(join(tmpdir(), 'audit-1a1-r01-'))
		const store = new MultiDbSqliteStore({ sessionDir })
		await store.open()
		const recordMessage = MessageStoreBackend.prototype.recordMessage
		let committedAt: number | undefined
		const spy = jest.spyOn(MessageStoreBackend.prototype, 'recordMessage').mockImplementation(function (
			this: MessageStoreBackend,
			input
		) {
			const rowId = recordMessage.call(this, input)
			if (input.keyId === 'R01-1') committedAt ??= tick()
			return rowId
		})
		try {
			const { socket } = await makeSocket(undefined, { multiDbStore: store })
			const client = latestClient()
			const receipt = () =>
				client.sentNodes.find((node: BinaryNode) => node.tag === 'receipt' && node.attrs.id === 'R01-1')
			client.emit('CB:message', makeChatStanza({ chat: DM_A_LID, id: 'R01-1', senderAlt: DM_A_PN }))
			await waitFor(() => committedAt !== undefined && receipt() !== undefined)
			await endSocket(socket)
			expect({ committedAt, receiptAt: sentAt.get(receipt()) }).toEqual({
				committedAt: expect.any(Number),
				receiptAt: expect.any(Number)
			})
			expect(committedAt!).toBeLessThan(sentAt.get(receipt())!)
		} finally {
			spy.mockRestore()
			store.close()
			rmSync(sessionDir, { recursive: true, force: true })
		}
	})

	// R-03 · app: StanzaQueue → ChatQueue keeps per-chat FIFO across live and
	// offline stanzas (X/C34751fd.java:137-176; AB 16214 = 1). Fixed by PR-15.
	it.failing('never lets a live message overtake the offline backlog of the same chat', async () => {
		const { socket } = await makeSocket()
		const client = latestClient()
		const order: string[] = []
		socket.ev.on('messages.upsert', update => {
			for (const message of update.messages) order.push(message.key.id!)
		})
		for (let index = 0; index < 50; index++) {
			client.emit(
				'CB:message',
				makeChatStanza({ chat: DM_A_LID, id: `R03-OFF-${index}`, senderAlt: DM_A_PN, offline: true })
			)
		}

		client.emit('CB:message', makeChatStanza({ chat: DM_A_LID, id: 'R03-LIVE', senderAlt: DM_A_PN }))
		await waitFor(() => order.length === 51)
		await endSocket(socket)
		expect(order.indexOf('R03-LIVE')).toBe(50)
	})

	// R-02 · app learns LID↔PN from the stanza attributes themselves and
	// persists the pair; it never issues a USync on the inbound hot path.
	// The probe checks both halves: the pair from sender_pn is persisted in
	// the key store (already true today), and no usync IQ left the socket
	// (the defect). Fixed by PR-05.
	it.failing('learns LID↔PN from sender_pn and persists it without a USync query', async () => {
		const { socket, signalStore } = await makeSocket(undefined, { defaultQueryTimeoutMs: 300 }, false)
		const client = latestClient()
		const seen: string[] = []
		socket.ev.on('messages.upsert', update => {
			for (const message of update.messages) seen.push(message.key.id!)
		})
		client.emit('CB:message', makeChatStanza({ chat: DM_A_LID, id: 'R02-1', senderAlt: DM_A_PN }))
		await waitFor(() => seen.length === 1)
		await endSocket(socket)
		const persisted = Object.fromEntries([...signalStore.entries()].filter(([key]) => key.startsWith('lid-mapping.')))
		const usyncQueries = client.sentNodes.filter((node: BinaryNode) => node.attrs.xmlns === 'usync')
		expect({
			pnToLid: persisted[`lid-mapping.${DM_A_PN.split('@')[0]}`],
			lidToPn: persisted[`lid-mapping.${DM_A_LID.split('@')[0]}_reverse`],
			usyncQueries: usyncQueries.length
		}).toEqual({
			pnToLid: DM_A_LID.split('@')[0],
			lidToPn: DM_A_PN.split('@')[0],
			usyncQueries: 0
		})
	})

	// C-03 · app answers server pings (X/AbstractC37331lB.java:384 →
	// ConnectionThreadRequestsImpl/onServerPingReceived). Fixed by PR-08.
	it.failing('answers a server ping iq with a result carrying the same id', async () => {
		const { socket } = await makeSocket()
		const client = latestClient()
		const ping: BinaryNode = {
			tag: 'iq',
			attrs: { from: 's.whatsapp.net', type: 'get', xmlns: 'urn:xmpp:ping', id: 'SRV-PING-1' },
			content: []
		}
		for (const key of [
			'CB:iq,type:get,xmlns:urn:xmpp:ping',
			'CB:iq,type:get',
			'CB:iq,xmlns:urn:xmpp:ping',
			'CB:iq,id:SRV-PING-1',
			'CB:iq'
		]) {
			client.emit(key, ping)
		}

		await new Promise(resolve => setTimeout(resolve, 200))
		await endSocket(socket)
		const replies = client.sentNodes.filter(
			(node: BinaryNode) => node.tag === 'iq' && node.attrs.id === 'SRV-PING-1' && node.attrs.type === 'result'
		)
		expect(replies).toHaveLength(1)
	})

	// C-01 · a socket that closes within 5 s of CB:success must not leave a
	// session-cleanup scheduler behind (it pins the closed socket forever).
	// Fixed by PR-01. Live timers created by the test are tracked and cleared
	// afterwards so the zombie cannot keep the Jest process alive.
	it.failing(
		'leaves no timer behind after quick close cycles following login',
		async () => {
			const live = new Set<unknown>()
			const original = {
				setTimeout: global.setTimeout,
				setInterval: global.setInterval,
				clearTimeout: global.clearTimeout,
				clearInterval: global.clearInterval
			}
			const track =
				(create: (...args: any[]) => any) =>
				(...args: any[]) => {
					const handle = create(...args)
					live.add(handle)
					return handle
				}

			const untrack = (clear: (handle: any) => void) => (handle: any) => {
				live.delete(handle)
				clear(handle)
			}

			;(global as any).setTimeout = track(original.setTimeout)
			;(global as any).setInterval = track(original.setInterval)
			;(global as any).clearTimeout = untrack(original.clearTimeout)
			;(global as any).clearInterval = untrack(original.clearInterval)
			const successNode: BinaryNode = { tag: 'success', attrs: { lid: ME_LID, t: '1789500100' }, content: [] }
			const liveCount = () =>
				(process as any).getActiveResourcesInfo().filter((kind: string) => kind === 'Timeout').length
			try {
				const baseline = liveCount()
				for (let cycle = 0; cycle < 8; cycle++) {
					const { socket } = await makeSocket()
					latestClient().emit('CB:success', successNode)
					await new Promise(resolve => original.setTimeout(resolve, 30))
					await socket.end(new Error('audit cycle'))
					clients.length = 0
				}

				// The deferred cleanup start fires 5 s after CB:success.
				await new Promise(resolve => original.setTimeout(resolve, 5_500))
				expect(liveCount() - baseline).toBeLessThan(4)
			} finally {
				for (const handle of live) {
					original.clearTimeout(handle as any)
					original.clearInterval(handle as any)
				}

				Object.assign(global, original)
			}
		},
		30_000
	)
})
