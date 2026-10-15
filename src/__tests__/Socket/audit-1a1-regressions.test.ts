import { jest } from '@jest/globals'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { proto } from '../../../WAProto/index.js'
import { DEFAULT_CONNECTION_CONFIG, NOISE_WA_HEADER } from '../../Defaults'
import type { SignalKeyStore } from '../../Types'
import { initAuthCreds, makeCacheableSignalKeyStore } from '../../Utils/auth-utils'
import { JidMapBackend } from '../../Utils/multi-db-sqlite/lid-mapping-backend'
import { MessageStoreBackend } from '../../Utils/multi-db-sqlite/message-store-backend'
import { ReceiptBackend } from '../../Utils/multi-db-sqlite/receipt-backend'
import { MultiDbSqliteStore } from '../../Utils/multi-db-sqlite/store'
import type { BinaryNode } from '../../WABinary'
import { decodeBinaryNode } from '../../WABinary'

type FakeSocketClient = {
	sentNodes: BinaryNode[]
	emit(event: string, payload?: unknown): boolean
}

type TestLogger = {
	level: string
	child: () => TestLogger
	trace: jest.Mock
	debug: jest.Mock
	info: jest.Mock
	warn: jest.Mock
	error: jest.Mock
	fatal: jest.Mock
}

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
	const logger: TestLogger = {
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
	const rawSignalStore = {
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
	const keys = makeCacheableSignalKeyStore(rawSignalStore as unknown as SignalKeyStore, logger as never)
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
			expect({ committedAt, receiptAt: sentAt.get(receipt()!) }).toEqual({
				committedAt: expect.any(Number),
				receiptAt: expect.any(Number)
			})
			expect(committedAt!).toBeLessThan(sentAt.get(receipt()!)!)
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
	it('learns LID↔PN from sender_pn and persists it without a USync query', async () => {
		// An unanswered usync would hold delivery for the whole query timeout
		// (60 s here, above the 30 s production default), far past waitFor's
		// 5 s deadline: delivering at all proves the message never waited on a query.
		const { socket, signalStore } = await makeSocket(undefined, { defaultQueryTimeoutMs: 60_000 }, false)
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

	// R-09 · msgstore.db keeps the app's status integer per receipt type
	// (ReceiptStanzaHelper.A00, X/C29301Csr.java:337-378), while the consumer
	// event keeps WebMessageInfo.Status. inactive/played-self have no Web
	// status: the app records them, consumers get no event (unchanged).
	it('mirrors each receipt type into msgstore.db with the app status and keeps the consumer events', async () => {
		const sessionDir = mkdtempSync(join(tmpdir(), 'audit-1a1-r09-'))
		const store = new MultiDbSqliteStore({ sessionDir })
		await store.open()
		const db = store.handle('msgstore.db')
		const messages = new MessageStoreBackend(db, new JidMapBackend(db))
		const MY_OTHER_DEVICE = ME_PN.replace('@', ':2@')
		// Receipts on our own messages (fromMe) and, for the -self states, on
		// incoming messages we read/played on another device.
		const receipts: Array<{ id: string; fromMe: boolean; attrs: Record<string, string> }> = [
			{ id: 'R09-delivery', fromMe: true, attrs: { from: DM_A_PN } },
			{ id: 'R09-read', fromMe: true, attrs: { from: DM_A_PN, type: 'read' } },
			{ id: 'R09-played', fromMe: true, attrs: { from: DM_A_PN, type: 'played' } },
			{ id: 'R09-inactive', fromMe: true, attrs: { from: DM_A_PN, type: 'inactive' } },
			{ id: 'R09-sender', fromMe: true, attrs: { from: MY_OTHER_DEVICE, recipient: DM_A_PN, type: 'sender' } },
			{ id: 'R09-read-self', fromMe: false, attrs: { from: MY_OTHER_DEVICE, recipient: DM_A_PN, type: 'read-self' } },
			{
				id: 'R09-played-self',
				fromMe: false,
				attrs: { from: MY_OTHER_DEVICE, recipient: DM_A_PN, type: 'played-self' }
			}
		]
		for (const { id, fromMe } of receipts) {
			messages.recordMessage({ chatJid: DM_A_PN, fromMe, keyId: id, timestamp: 1_789_500_000 })
		}

		const updateSpy = jest.spyOn(MessageStoreBackend.prototype, 'updateMessageStatus')
		const userReceiptKinds = new Map<string, string>()
		const kindSpy = jest.spyOn(ReceiptBackend.prototype, 'recordUserReceipt').mockImplementation(input => {
			userReceiptKinds.set(input.keyId, input.kind)
		})
		try {
			const { socket } = await makeSocket(undefined, { multiDbStore: store })
			const client = latestClient()
			const events = new Map<string, number | null | undefined>()
			socket.ev.on('messages.update', updates => {
				for (const { key, update } of updates) if ('status' in update) events.set(key.id!, update.status)
			})
			for (const { id, attrs } of receipts) {
				client.emit('CB:receipt', { tag: 'receipt', attrs: { ...attrs, id, t: '1789500200' }, content: undefined })
			}

			// inactive no longer calls updateMessageStatus at all (R6), so 6 of
			// the 7 receipts reach the status mirror.
			await waitFor(() => updateSpy.mock.calls.length === receipts.length - 1)
			await endSocket(socket)
			const persisted = Object.fromEntries(
				receipts.map(({ id, fromMe }) => [id, messages.getMessageByKeyId(DM_A_PN, fromMe, id)?.status])
			)
			// R6 errata (2.26.38.10 decompile, X/C28106CSb.java:281-323 +
			// X/C17C.java:400): played-self 18 is APPLIED as PLAYED 8 (the live
			// helper builds the status receipt with 8) and inactive 15 never
			// reaches message.status — dropped as "statusunchanged" — so the
			// row keeps the NULL recordMessage left.
			expect(persisted).toEqual({
				'R09-delivery': 5,
				'R09-read': 13,
				'R09-played': 8,
				'R09-inactive': null,
				'R09-sender': 5,
				'R09-read-self': 17,
				'R09-played-self': 8
			})
			// receipt_user progression follows the same table: sender is a delivery.
			expect(Object.fromEntries(userReceiptKinds)).toEqual({
				'R09-delivery': 'delivery',
				'R09-read': 'read',
				'R09-played': 'played',
				'R09-sender': 'delivery',
				'R09-read-self': 'read'
			})
			const { Status } = proto.WebMessageInfo
			expect(Object.fromEntries(events)).toEqual({
				'R09-delivery': Status.DELIVERY_ACK,
				'R09-read': Status.READ,
				'R09-played': Status.PLAYED,
				'R09-sender': Status.SERVER_ACK,
				'R09-read-self': Status.READ
			})
		} finally {
			updateSpy.mockRestore()
			kindSpy.mockRestore()
			store.close()
			rmSync(sessionDir, { recursive: true, force: true })
		}
	})

	it('holds status-only receipts for a message not mirrored yet with their exact app status', async () => {
		const sessionDir = mkdtempSync(join(tmpdir(), 'audit-1a1-r09-late-'))
		const store = new MultiDbSqliteStore({ sessionDir })
		await store.open()
		const orphans = new Map<string, number>()
		const updateSpy = jest.spyOn(MessageStoreBackend.prototype, 'updateMessageStatus').mockReturnValue(false)
		const orphanSpy = jest.spyOn(ReceiptBackend.prototype, 'recordStatusOrphan').mockImplementation(input => {
			orphans.set(input.keyId, input.androidStatus)
		})
		const userSpy = jest.spyOn(ReceiptBackend.prototype, 'recordUserReceipt').mockImplementation(() => {})
		try {
			const { socket } = await makeSocket(undefined, { multiDbStore: store })
			const client = latestClient()
			const MY_OTHER_DEVICE = ME_PN.replace('@', ':2@')
			const receipts: Array<{ id: string; attrs: Record<string, string> }> = [
				{ id: 'LATE-read', attrs: { from: DM_A_PN, type: 'read' } },
				{ id: 'LATE-inactive', attrs: { from: DM_A_PN, type: 'inactive' } },
				{ id: 'LATE-read-self', attrs: { from: MY_OTHER_DEVICE, recipient: DM_A_PN, type: 'read-self' } },
				{ id: 'LATE-played-self', attrs: { from: MY_OTHER_DEVICE, recipient: DM_A_PN, type: 'played-self' } }
			]
			for (const { id, attrs } of receipts) {
				client.emit('CB:receipt', { tag: 'receipt', attrs: { ...attrs, id, t: '1789500300' }, content: undefined })
			}

			// inactive never calls updateMessageStatus under R6 (the app drops
			// it as "statusunchanged"), so 3 of the 4 receipts reach the mirror.
			await waitFor(() => updateSpy.mock.calls.length === receipts.length - 1)
			await endSocket(socket)
			// read orphans through receipt_user (replays as 13); the status-only
			// states are held with their exact wire value — the R6 raw integer.
			expect(Object.fromEntries(orphans)).toEqual({
				'LATE-inactive': 15,
				'LATE-read-self': 17,
				'LATE-played-self': 18
			})
		} finally {
			updateSpy.mockRestore()
			orphanSpy.mockRestore()
			userSpy.mockRestore()
			store.close()
			rmSync(sessionDir, { recursive: true, force: true })
		}
	})

	// R6 · played-self in a group: the live helper normalizes it to played(8)
	// and stores a receipt_user row for the SENDER'S OWN user
	// (C5W.A00(device, null, ...) → device.userJid, X/C28106CSb.java:281-323 in
	// 2.26.38.10), which feeds the group aggregate exactly like a
	// participant's played receipt. No consumer event changes: the group
	// contract stays `message-receipt.update` for participant receipts.
	it('records a played-self group receipt as the own-user played row and promotes the aggregate', async () => {
		const sessionDir = mkdtempSync(join(tmpdir(), 'audit-1a1-r06-played-self-'))
		const store = new MultiDbSqliteStore({ sessionDir })
		await store.open()
		const db = store.handle('msgstore.db')
		const messages = new MessageStoreBackend(db, new JidMapBackend(db))
		const GROUP = '120363000000000010@g.us'
		const keyId = 'R06-played-self-group'
		messages.recordMessage({
			chatJid: GROUP,
			fromMe: true,
			keyId,
			status: 4, // SERVER_ACK
			timestamp: 1_789_500_000,
			recipientCount: 1
		})
		try {
			const { socket } = await makeSocket(undefined, { multiDbStore: store })
			const client = latestClient()
			const receiptUpdates: string[] = []
			socket.ev.on('message-receipt.update', updates => {
				for (const { key } of updates) receiptUpdates.push(key.id!)
			})
			client.emit('CB:receipt', {
				tag: 'receipt',
				attrs: {
					// A group receipt carries the GROUP as `from`; the member is
					// identified by `participant` — here, ourselves.
					from: GROUP,
					participant: ME_PN,
					type: 'played-self',
					id: keyId,
					t: '1789500400'
				},
				content: undefined
			})

			// played 1/1 reaches recipient_count → PLAYED 8 via the aggregate.
			await waitFor(() => messages.getMessageByKeyId(GROUP, true, keyId)?.status === 8)
			await endSocket(socket)
			const messageRow = messages.getMessageByKeyId(GROUP, true, keyId)
			const userRows = db
				.prepare('SELECT played_timestamp FROM receipt_user WHERE message_row_id = ?')
				.all(messageRow!._id) as Array<{ played_timestamp: number }>
			expect(userRows).toEqual([{ played_timestamp: 1_789_500_400 }])
			expect(receiptUpdates).toEqual([]) // no participant receipt → no per-user event
		} finally {
			store.close()
			rmSync(sessionDir, { recursive: true, force: true })
		}
	})

	// C-03 · app answers server pings with a BARE id-less result. The inbound
	// `<iq type="get" xmlns="urn:xmpp:ping" t=..>` is answered by
	// `<iq type="result" to="s.whatsapp.net"/>` — the request id is deliberately
	// NOT echoed (W4B 2.26.36.72: inbound handler X/AbstractC37331lB.java:384
	// reads only `t`; pong X/C17Q.java:175 "onSendServerPong"). Closed by PR-08
	// (#30); the earlier expectation here (echo the id) was the generic-XMPP
	// assumption, which the app does not follow.
	it('answers a server ping iq with a bare id-less result (no echoed id)', async () => {
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
			(node: BinaryNode) =>
				node.tag === 'iq' && node.attrs.type === 'result' && /(?:^|@)s\.whatsapp\.net$/.test(node.attrs.to ?? '')
		)
		// Exactly one pong, and it carries the app's bare shape: no echoed id,
		// no xmlns/from, no child.
		expect(replies).toHaveLength(1)
		const pong = replies[0]!
		expect(pong.attrs.id).toBeUndefined()
		expect(pong.attrs.xmlns).toBeUndefined()
		expect(pong.attrs.from).toBeUndefined()
		expect(pong.content === undefined || (Array.isArray(pong.content) && pong.content.length === 0)).toBe(true)
	})

	// C-01 · `connection.update: open` is emitted synchronously inside the
	// CB:success handler; a listener that ends the socket right there must not
	// leave the deferred cleanup timer or the activity-tracker interval armed
	// on the closed socket. Fixed by PR-01.
	it('arms no post-login timer when an open listener closes the socket synchronously', async () => {
		const { socket } = await makeSocket()
		let closedByListener = false
		const armedAfterClose: string[] = []
		const original = { setTimeout: global.setTimeout, setInterval: global.setInterval }
		const timers: { setTimeout: unknown; setInterval: unknown } = global
		timers.setTimeout = (fn: (...args: any[]) => void, ms?: number, ...rest: any[]) => {
			if (closedByListener && ms === 5_000) armedAfterClose.push(`timeout:${ms}`)
			return original.setTimeout(fn, ms, ...rest)
		}

		timers.setInterval = (fn: (...args: any[]) => void, ms?: number, ...rest: any[]) => {
			if (closedByListener) armedAfterClose.push(`interval:${ms}`)
			return original.setInterval(fn, ms, ...rest)
		}

		socket.ev.on('connection.update', update => {
			if (update.connection === 'open' && !closedByListener) {
				void socket.end(new Error('closed by open listener'))
				closedByListener = true
			}
		})
		try {
			latestClient().emit('CB:success', { tag: 'success', attrs: { lid: ME_LID, t: '1789500100' }, content: [] })
			expect(closedByListener).toBe(true)
			expect(armedAfterClose).toEqual([])
		} finally {
			Object.assign(global, original)
			await new Promise(resolve => setTimeout(resolve, 2_100))
		}
	})

	// C-01 · a socket that closes within 5 s of CB:success must not leave a
	// session-cleanup scheduler behind (it pins the closed socket forever).
	// Fixed by PR-01: end() cancels the deferred start and the scheduler
	// checks its generation. Live timers created by the test are tracked and
	// cleared afterwards so a regression cannot keep the Jest process alive.
	it('leaves no timer behind after quick close cycles following login', async () => {
		const live = new Set<unknown>()
		const original = {
			setTimeout: global.setTimeout,
			setInterval: global.setInterval,
			clearTimeout: global.clearTimeout,
			clearInterval: global.clearInterval
		}
		const track =
			(create: (...args: any[]) => unknown) =>
			(...args: any[]) => {
				const handle = create(...args)
				live.add(handle)
				return handle
			}

		const untrack =
			<H>(clear: (handle: H) => void) =>
			(handle: H) => {
				live.delete(handle)
				clear(handle)
			}

		const timerGlobals: { setTimeout: unknown; setInterval: unknown; clearTimeout: unknown; clearInterval: unknown } =
			global
		timerGlobals.setTimeout = track(original.setTimeout)
		timerGlobals.setInterval = track(original.setInterval)
		timerGlobals.clearTimeout = untrack(original.clearTimeout)
		timerGlobals.clearInterval = untrack(original.clearInterval)
		const successNode: BinaryNode = { tag: 'success', attrs: { lid: ME_LID, t: '1789500100' }, content: [] }
		const liveCount = () => process.getActiveResourcesInfo().filter((kind: string) => kind === 'Timeout').length
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
				original.clearTimeout(handle as NodeJS.Timeout)
				original.clearInterval(handle as NodeJS.Timeout)
			}

			Object.assign(global, original)
		}
	}, 30_000)
})
