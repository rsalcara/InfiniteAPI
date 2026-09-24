import { jest } from '@jest/globals'
import { proto } from '../../../WAProto/index.js'
import { DEFAULT_CONNECTION_CONFIG, NOISE_WA_HEADER } from '../../Defaults'
import { initAuthCreds, makeCacheableSignalKeyStore } from '../../Utils/auth-utils'
import { makeKeyedOrderGate } from '../../Utils/make-mutex'
import type { BinaryNode } from '../../WABinary'
import { decodeBinaryNode } from '../../WABinary'

type FakeSocketClient = Record<string, any>

const ME_PN = '5511999999999@s.whatsapp.net'
const ME_LID = '1029384756@lid'
const GROUP_A = '120363400000000001@g.us'
const GROUP_B = '120363400000000002@g.us'
const DM_A_LID = '188888000000010@lid'
const DM_A_PN = '5511888880010@s.whatsapp.net'
const DM_B_LID = '188888000000011@lid'
const DM_B_PN = '5511888880011@s.whatsapp.net'
const PARTICIPANT_A_PN = '5511888880001@s.whatsapp.net'
const PARTICIPANT_A_LID = '188888000000001@lid'
const PARTICIPANT_B_PN = '5511888880002@s.whatsapp.net'
const PARTICIPANT_B_LID = '188888000000002@lid'

const orderingTestClients = globalThis as typeof globalThis & {
	__infiniteApiGroupOrderingWiringClients?: FakeSocketClient[]
}
orderingTestClients.__infiniteApiGroupOrderingWiringClients ??= []
const clients = orderingTestClients.__infiniteApiGroupOrderingWiringClients

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
				void decodeWiringFrame(data).then(node => this.sentNodes.push(node))
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

const flushMicrotasks = async () => {
	for (let index = 0; index < 10; index++) await Promise.resolve()
}

const makeSocket = async (getPNForLID?: (lid: string) => Promise<string | null>) => {
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
		logger
	} as never)

	socket.signalRepository.migrateSession = async () => ({ migrated: 0, skipped: 0, total: 0 })
	socket.signalRepository.lidMapping.getLIDForPN = async () => null
	socket.signalRepository.lidMapping.getPNForLID = getPNForLID ?? (async () => null)
	socket.signalRepository.lidMapping.storeLIDPNMappings = async () => ({ stored: 0, skipped: 0, errors: 0 })

	return { socket, logger }
}

const endSocket = async (socket: Awaited<ReturnType<typeof makeSocket>>['socket']) => {
	await socket.end(new Error('test complete'))
	await new Promise(resolve => setTimeout(resolve, 2_100))
}

const instrumentSessionMigration = (
	socket: Awaited<ReturnType<typeof makeSocket>>['socket'],
	onMigrate: (altJid: string, primaryJid: string) => void
) => {
	const originalMigrateSession = socket.signalRepository.migrateSession.bind(socket.signalRepository)
	socket.signalRepository.migrateSession = async (
		...args: Parameters<typeof socket.signalRepository.migrateSession>
	) => {
		onMigrate(args[1], args[0])
		return await originalMigrateSession(...args)
	}
}

describe('keyed order gate', () => {
	it('preserves admission order and requires each caller to release', async () => {
		const gate = makeKeyedOrderGate()
		const order: string[] = []

		const releaseFirst = await gate.acquire('group')
		order.push('first-admitted')

		let secondAdmitted = false
		const secondPromise = gate.acquire('group').then(release => {
			secondAdmitted = true
			order.push('second-admitted')
			return release
		})
		let thirdAdmitted = false
		const thirdPromise = gate.acquire('group').then(release => {
			thirdAdmitted = true
			order.push('third-admitted')
			return release
		})

		await flushMicrotasks()
		expect(order).toEqual(['first-admitted'])
		expect(secondAdmitted).toBe(false)
		expect(thirdAdmitted).toBe(false)

		releaseFirst()
		const releaseSecond = await secondPromise
		expect(secondAdmitted).toBe(true)
		expect(thirdAdmitted).toBe(false)

		releaseSecond()
		const releaseThird = await thirdPromise
		expect(thirdAdmitted).toBe(true)
		expect(order).toEqual(['first-admitted', 'second-admitted', 'third-admitted'])

		releaseThird()
		const nextRelease = await gate.acquire('group')
		nextRelease()
	})

	it('keeps different keys independent and allows admission again after release', async () => {
		const gate = makeKeyedOrderGate()
		const releaseBlocked = await gate.acquire('blocked-group')

		const releaseOther = await gate.acquire('other-group')
		releaseOther()

		releaseBlocked()
		const releaseBlockedAgain = await gate.acquire('blocked-group')
		releaseBlockedAgain()
	})
})

describe('inbound live chat ordering wiring', () => {
	it('preserves same-group arrival order when LID mapping has uneven latency', async () => {
		const mappingCalls: string[] = []
		const { socket } = await makeSocket(async lid => {
			mappingCalls.push(`enter:${lid}`)
			if (lid === PARTICIPANT_A_LID) await new Promise(resolve => setTimeout(resolve, 40))
			mappingCalls.push(`exit:${lid}`)
			return lid === PARTICIPANT_A_LID ? PARTICIPANT_A_PN : PARTICIPANT_B_PN
		})

		const upsertIds: string[] = []
		socket.ev.on('messages.upsert', update => {
			for (const message of update.messages) upsertIds.push(message.key.id!)
		})

		const client = latestClient()
		client.emit(
			'CB:message',
			makeChatStanza({
				chat: GROUP_A,
				id: 'GROUP-A-1',
				participant: PARTICIPANT_A_PN,
				participantAlt: PARTICIPANT_A_LID
			})
		)
		client.emit(
			'CB:message',
			makeChatStanza({
				chat: GROUP_A,
				id: 'GROUP-A-2',
				participant: PARTICIPANT_B_PN,
				participantAlt: PARTICIPANT_B_LID
			})
		)

		await waitFor(() => upsertIds.length === 2)

		expect(mappingCalls[0]).toBe(`enter:${PARTICIPANT_A_LID}`)
		// storeMappingFromEnvelope and the handler's explicit LID setup may each
		// read the mapping. B must not begin either read until every A read has
		// exited; this is the pre-mutex admission guarantee.
		expect(mappingCalls.indexOf(`enter:${PARTICIPANT_B_LID}`)).toBeGreaterThan(
			mappingCalls.lastIndexOf(`exit:${PARTICIPANT_A_LID}`)
		)
		expect(upsertIds).toEqual(['GROUP-A-1', 'GROUP-A-2'])

		await endSocket(socket)
	})

	it('orders a participant message before a later self-routed message in the same recipient group', async () => {
		const { socket } = await makeSocket(async lid => {
			if (lid === PARTICIPANT_A_LID) await new Promise(resolve => setTimeout(resolve, 40))
			return lid === PARTICIPANT_A_LID ? PARTICIPANT_A_PN : PARTICIPANT_B_PN
		})

		const upsertIds: string[] = []
		socket.ev.on('messages.upsert', update => {
			for (const message of update.messages) upsertIds.push(message.key.id!)
		})

		const client = latestClient()
		client.emit(
			'CB:message',
			makeChatStanza({
				chat: GROUP_A,
				id: 'PARTICIPANT-FIRST',
				participant: PARTICIPANT_A_PN,
				participantAlt: PARTICIPANT_A_LID
			})
		)
		client.emit(
			'CB:message',
			makeChatStanza({
				chat: ME_PN,
				id: 'SELF-Routed-SECOND',
				recipient: GROUP_A
			})
		)

		await waitFor(() => upsertIds.length === 2)
		expect(upsertIds).toEqual(['PARTICIPANT-FIRST', 'SELF-Routed-SECOND'])

		await endSocket(socket)
	})

	it('preserves same-dm arrival order when the first raw identity lookup is slow', async () => {
		const { socket } = await makeSocket(async () => null)
		const phaseCalls: string[] = []
		let firstLookup = true
		socket.signalRepository.lidMapping.getLIDForPN = async pn => {
			const isFirstLookup = pn === DM_A_PN && firstLookup

			phaseCalls.push(`lookup-enter:${pn}`)
			if (isFirstLookup) {
				firstLookup = false
				await new Promise(resolve => setTimeout(resolve, 30))
			}

			phaseCalls.push(`lookup-exit:${pn}`)

			return isFirstLookup ? DM_A_LID : null
		}

		const originalMigrateSession = socket.signalRepository.migrateSession.bind(socket.signalRepository)
		socket.signalRepository.migrateSession = async (...args: unknown[]) => {
			const primaryJid = String(args[1])
			phaseCalls.push(`migrate-enter:${primaryJid}`)
			if (primaryJid === DM_A_LID) await new Promise(resolve => setTimeout(resolve, 30))
			phaseCalls.push(`migrate-exit:${primaryJid}`)
			return await originalMigrateSession(...(args as Parameters<typeof socket.signalRepository.migrateSession>))
		}

		const upsertIds: string[] = []
		socket.ev.on('messages.upsert', update => {
			for (const message of update.messages) upsertIds.push(message.key.id!)
		})

		const client = latestClient()
		client.emit('CB:message', makeChatStanza({ chat: DM_A_LID, id: 'DM-A-1', senderAlt: DM_A_PN }))
		client.emit('CB:message', makeChatStanza({ chat: DM_A_LID, id: 'DM-A-2', senderAlt: DM_A_PN }))

		await waitFor(() => upsertIds.length === 2)

		expect(phaseCalls[0]).toBe(`lookup-enter:${DM_A_PN}`)
		// Both DMs share the raw wire identity. B must not begin LID/PN setup
		// until A has released admission at the normalized chat mutex.
		expect(phaseCalls.indexOf(`lookup-enter:${DM_A_PN}`, 1)).toBeGreaterThan(
			phaseCalls.indexOf(`migrate-exit:${DM_A_LID}`)
		)
		expect(upsertIds).toEqual(['DM-A-1', 'DM-A-2'])

		await endSocket(socket)
	})

	it('releases the admission gate when decoding fails before the processing mutex', async () => {
		const { socket, logger } = await makeSocket(async () => PARTICIPANT_A_PN)

		const upsertIds: string[] = []
		socket.ev.on('messages.upsert', update => {
			for (const message of update.messages) upsertIds.push(message.key.id!)
		})

		const client = latestClient()
		client.emit('CB:message', makeChatStanza({ chat: GROUP_A, id: 'DECODE-FAILURE' }))
		client.emit(
			'CB:message',
			makeChatStanza({
				chat: GROUP_A,
				id: 'AFTER-DECODE-FAILURE',
				participant: PARTICIPANT_A_PN,
				participantAlt: PARTICIPANT_A_LID
			})
		)

		await waitFor(() => logger.error.mock.calls.some((call: unknown[]) => call[1] === 'error in handling message'))
		await waitFor(() => upsertIds.length === 1)
		expect(upsertIds).toEqual(['AFTER-DECODE-FAILURE'])

		await endSocket(socket)
	})

	it('keeps different dms parallel when the first dm is delayed', async () => {
		const mappingCalls: string[] = []
		const { socket } = await makeSocket(async () => null)
		socket.signalRepository.lidMapping.getLIDForPN = async pn => {
			mappingCalls.push(`enter:${pn}`)
			if (pn === DM_A_PN) await new Promise(resolve => setTimeout(resolve, 30))
			mappingCalls.push(`exit:${pn}`)
			return pn === DM_A_PN ? DM_A_LID : null
		}

		const upsertIds: string[] = []
		socket.ev.on('messages.upsert', update => {
			for (const message of update.messages) upsertIds.push(message.key.id!)
		})

		const client = latestClient()
		client.emit('CB:message', makeChatStanza({ chat: DM_A_LID, id: 'DM-DELAYED', senderAlt: DM_A_PN }))
		client.emit('CB:message', makeChatStanza({ chat: DM_B_LID, id: 'DM-FAST', senderAlt: DM_B_PN }))

		await waitFor(() => upsertIds.length === 2)

		expect(mappingCalls.indexOf(`enter:${DM_B_PN}`)).toBeLessThan(mappingCalls.lastIndexOf(`exit:${DM_A_PN}`))
		expect(upsertIds).toEqual(['DM-FAST', 'DM-DELAYED'])

		await endSocket(socket)
	})

	it('keeps self-routed chats parallel when both use the sender in from', async () => {
		const mappingCalls: string[] = []
		const { socket } = await makeSocket(async lid => {
			mappingCalls.push(`enter:${lid}`)
			if (lid === DM_A_LID) await new Promise(resolve => setTimeout(resolve, 40))
			mappingCalls.push(`exit:${lid}`)
			return lid === DM_A_LID ? DM_A_PN : DM_B_PN
		})

		const upsertIds: string[] = []
		socket.ev.on('messages.upsert', update => {
			for (const message of update.messages) upsertIds.push(message.key.id!)
		})

		const client = latestClient()
		client.emit(
			'CB:message',
			makeChatStanza({
				chat: ME_PN,
				id: 'SELF-DM-DELAYED',
				recipient: DM_A_LID,
				peerRecipientAlt: DM_A_LID
			})
		)
		client.emit(
			'CB:message',
			makeChatStanza({
				chat: ME_PN,
				id: 'SELF-DM-FAST',
				recipient: DM_B_LID,
				peerRecipientAlt: DM_B_LID
			})
		)

		await waitFor(() => upsertIds.length === 2)

		// A still owns its LID setup when B enters: effective recipient keys keep
		// two self-routed chats independent instead of sharing the sender key.
		expect(mappingCalls.indexOf(`enter:${DM_B_LID}`)).toBeLessThan(mappingCalls.lastIndexOf(`exit:${DM_A_LID}`))
		expect(upsertIds).toEqual(['SELF-DM-FAST', 'SELF-DM-DELAYED'])

		await endSocket(socket)
	})

	it('keeps different chats parallel when the first chat is delayed', async () => {
		const { socket } = await makeSocket(async lid => {
			if (lid === PARTICIPANT_A_LID) await new Promise(resolve => setTimeout(resolve, 40))
			return lid === PARTICIPANT_A_LID ? PARTICIPANT_A_PN : PARTICIPANT_B_PN
		})

		const processingIds: string[] = []
		instrumentSessionMigration(socket, altJid => {
			processingIds.push(altJid === PARTICIPANT_A_LID ? 'DELAYED-GROUP' : 'FAST-GROUP')
		})

		const client = latestClient()
		client.emit(
			'CB:message',
			makeChatStanza({
				chat: GROUP_A,
				id: 'DELAYED-GROUP',
				participant: PARTICIPANT_A_PN,
				participantAlt: PARTICIPANT_A_LID
			})
		)
		client.emit(
			'CB:message',
			makeChatStanza({
				chat: GROUP_B,
				id: 'FAST-GROUP',
				participant: PARTICIPANT_B_PN,
				participantAlt: PARTICIPANT_B_LID
			})
		)

		await waitFor(() => processingIds.length === 2)
		expect(processingIds).toEqual(['FAST-GROUP', 'DELAYED-GROUP'])

		await endSocket(socket)
	})

	it('keeps status participants parallel instead of sharing one broadcast queue', async () => {
		const mappingCalls: string[] = []
		const { socket } = await makeSocket(async lid => {
			mappingCalls.push(`enter:${lid}`)
			if (lid === PARTICIPANT_A_LID) await new Promise(resolve => setTimeout(resolve, 40))
			mappingCalls.push(`exit:${lid}`)
			return lid === PARTICIPANT_A_LID ? PARTICIPANT_A_PN : PARTICIPANT_B_PN
		})

		const upsertIds: string[] = []
		socket.ev.on('messages.upsert', update => {
			for (const message of update.messages) upsertIds.push(message.key.id!)
		})

		const client = latestClient()
		client.emit(
			'CB:message',
			makeChatStanza({
				chat: 'status@broadcast',
				id: 'STATUS-A',
				participant: PARTICIPANT_A_PN,
				participantAlt: PARTICIPANT_A_LID
			})
		)
		client.emit(
			'CB:message',
			makeChatStanza({
				chat: 'status@broadcast',
				id: 'STATUS-B',
				participant: PARTICIPANT_B_PN,
				participantAlt: PARTICIPANT_B_LID
			})
		)

		await waitFor(() => upsertIds.length === 2)

		expect(mappingCalls.indexOf(`enter:${PARTICIPANT_B_LID}`)).toBeLessThan(
			mappingCalls.lastIndexOf(`exit:${PARTICIPANT_A_LID}`)
		)
		expect(upsertIds).toEqual(['STATUS-B', 'STATUS-A'])

		await endSocket(socket)
	})

	it('leaves offline dm drain outside the live admission gate', async () => {
		const { socket, logger } = await makeSocket(async lid => {
			if (lid === DM_A_LID) await new Promise(resolve => setTimeout(resolve, 40))
			return DM_A_PN
		})

		let liveUpserted = false
		let liveStaged = false
		socket.ev.on('messages.upsert', update => {
			if (update.messages.some(message => message.key.id === 'OFFLINE-DM-GATE-LIVE')) liveUpserted = true
		})
		const originalGetLIDForPN = socket.signalRepository.lidMapping.getLIDForPN.bind(socket.signalRepository.lidMapping)
		socket.signalRepository.lidMapping.getLIDForPN = async pn => {
			if (pn === DM_A_PN) await new Promise(resolve => setTimeout(resolve, 40))
			const result = await originalGetLIDForPN(pn)
			if (pn === DM_A_PN) liveStaged = true
			return result
		}

		const client = latestClient()
		client.emit('CB:message', makeChatStanza({ chat: DM_A_LID, id: 'OFFLINE-DM-GATE-LIVE', senderAlt: DM_A_PN }))

		// An unsupported offline DM fails during decode. If it entered the live
		// gate, that error would remain queued behind the delayed live message;
		// bypassing the gate makes the boundary deterministic.
		client.emit('CB:message', {
			tag: 'message',
			attrs: { from: DM_A_LID, offline: 'true', t: '1789500100' },
			content: [{ tag: 'enc', attrs: { type: 'unsupported-offline-test-type' } }]
		})

		await waitFor(() => logger.error.mock.calls.some((call: unknown[]) => call[1] === 'error in handling message'))
		expect(liveStaged).toBe(false)
		expect(liveUpserted).toBe(false)

		await waitFor(() => liveStaged)
		expect(liveStaged).toBe(true)

		await endSocket(socket)
	})

	it('leaves offline drain outside the live admission gate', async () => {
		const { socket, logger } = await makeSocket(async lid => {
			if (lid === PARTICIPANT_A_LID) await new Promise(resolve => setTimeout(resolve, 40))
			return PARTICIPANT_A_PN
		})

		let liveUpserted = false
		let liveStaged = false
		socket.ev.on('messages.upsert', update => {
			if (update.messages.some(message => message.key.id === 'OFFLINE-GATE-LIVE')) liveUpserted = true
		})
		const originalGetPNForLID = socket.signalRepository.lidMapping.getPNForLID.bind(socket.signalRepository.lidMapping)
		socket.signalRepository.lidMapping.getPNForLID = async lid => {
			const result = await originalGetPNForLID(lid)
			if (lid === PARTICIPANT_A_LID) liveStaged = true
			return result
		}

		const client = latestClient()
		client.emit(
			'CB:message',
			makeChatStanza({
				chat: GROUP_A,
				id: 'OFFLINE-GATE-LIVE',
				participant: PARTICIPANT_A_PN,
				participantAlt: PARTICIPANT_A_LID
			})
		)

		// A malformed offline stanza fails before decode. If the offline path
		// entered the live gate, this error would only appear after the delayed
		// live message completed; bypassing the gate makes it deterministic.
		client.emit(
			'CB:message',
			makeChatStanza({
				chat: GROUP_A,
				id: 'OFFLINE-GATE-MISSING-PARTICIPANT',
				offline: true
			})
		)

		await waitFor(() => logger.error.mock.calls.some((call: unknown[]) => call[1] === 'error in handling message'))
		expect(liveStaged).toBe(false)
		expect(liveUpserted).toBe(false)

		await waitFor(() => liveStaged)
		expect(liveStaged).toBe(true)

		await endSocket(socket)
	})
})
