import { jest } from '@jest/globals'
import { DEFAULT_CONNECTION_CONFIG, NOISE_WA_HEADER } from '../../Defaults'
import { initAuthCreds } from '../../Utils/auth-utils'
import type { BinaryNode } from '../../WABinary'
import { decodeBinaryNode } from '../../WABinary'

type FakeSocketClient = {
	readonly sentNodes: BinaryNode[]
	failGroupListQueries: boolean
	failCleanSends: boolean
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

const clients: FakeSocketClient[] = []

const asNodeArray = (content: BinaryNode['content']): BinaryNode[] => (Array.isArray(content) ? content : [])

const mockMakeFakeSocketClient = () =>
	class FakeSocketClient {
		readonly sentNodes: BinaryNode[] = []
		failGroupListQueries = false
		failCleanSends = false
		private readonly listeners = new Map<string, Set<(payload?: unknown) => void>>()

		constructor() {
			clients.push(this)
		}

		on(event: string, listener: (payload?: unknown) => void) {
			const listeners = this.listeners.get(event) ?? new Set()
			listeners.add(listener)
			this.listeners.set(event, listeners)
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
				if (node.tag !== 'iq') {
					callback?.()
					return
				}

				if (this.failCleanSends && asNodeArray(node.content)[0]?.tag === 'clean') {
					setImmediate(() => callback?.(new Error('clean send failed')))
					return
				}

				const isGroupListQuery = asNodeArray(node.content)[0]?.tag === 'participating'
				const response: BinaryNode =
					isGroupListQuery && this.failGroupListQueries
						? {
								tag: 'iq',
								attrs: { id: String(node.attrs.id), type: 'error' },
								content: [{ tag: 'error', attrs: { code: '500', text: 'group list refresh failed' } }]
							}
						: {
								tag: 'iq',
								attrs: { id: String(node.attrs.id), type: 'result' },
								content: isGroupListQuery ? [{ tag: 'groups', attrs: {} }] : undefined
							}

				setImmediate(() => {
					callback?.()
					this.emit(`TAG:${node.attrs.id}`, response)
				})
			})
			return true
		}
	}

const decodeWiringFrame = async (frame: Uint8Array | string): Promise<BinaryNode> => {
	if (typeof frame === 'string') throw new Error('dirty groups wiring expected a binary frame')

	const offset =
		frame.length >= NOISE_WA_HEADER.length && NOISE_WA_HEADER.equals(frame.slice(0, NOISE_WA_HEADER.length))
			? NOISE_WA_HEADER.length
			: 0

	return await decodeBinaryNode(Buffer.from(frame.subarray(offset + 3)))
}

jest.unstable_mockModule('../../Socket/Client/websocket', () => ({
	WebSocketClient: mockMakeFakeSocketClient()
}))
jest.unstable_mockModule('../../Socket/Client/tcp', () => ({
	TcpSocketClient: mockMakeFakeSocketClient()
}))

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

const makeSocket = () => {
	const logger = makeTestLogger()
	const socket = makeWASocket({
		...DEFAULT_CONNECTION_CONFIG,
		auth: { creds: initAuthCreds(), keys: {} },
		fireInitQueries: false,
		logger
	} as never)
	const client = clients.at(-1)
	if (!client) throw new Error('socket client was not created')
	return { client, logger, socket }
}

const dirtyNode = (type: string): BinaryNode => ({
	tag: 'ib',
	attrs: {},
	content: [{ tag: 'dirty', attrs: { type } }]
})

const sentChildTags = (client: FakeSocketClient) =>
	client.sentNodes.flatMap((node: BinaryNode) => asNodeArray(node.content).map(child => child.tag))

const waitFor = async (predicate: () => boolean) => {
	const deadline = Date.now() + 5_000
	while (!predicate()) {
		if (Date.now() >= deadline) throw new Error('test predicate was not satisfied within 5 seconds')
		await new Promise(resolve => setTimeout(resolve, 5))
	}
}

const warningsWith = (logger: TestLogger, message: string) =>
	logger.warn.mock.calls.filter((call: unknown[]) => call[1] === message)

describe.each([
	{ dirtyType: 'groups', subject: 'groups' },
	{ dirtyType: 'communities', subject: 'communities' }
])('dirty $dirtyType notification', ({ dirtyType, subject }) => {
	const refreshFailure = `failed to refresh ${subject} for dirty notification; dirty bit left pending`
	const cleanFailure = `refreshed ${subject} for dirty notification but failed to clear the dirty bit`

	beforeEach(() => {
		clients.length = 0
	})

	it('refreshes and clears the dirty bit after a successful refresh', async () => {
		const { client, logger, socket } = makeSocket()

		client.emit('CB:ib,,dirty', dirtyNode(dirtyType))
		await waitFor(() => sentChildTags(client).includes('clean'))

		expect(sentChildTags(client)).toEqual(['participating', 'clean'])
		expect(warningsWith(logger, refreshFailure)).toHaveLength(0)
		expect(warningsWith(logger, cleanFailure)).toHaveLength(0)

		await socket.end(new Error('test complete'))
	})

	it('keeps the dirty bit pending and does not reject when the refresh fails', async () => {
		const { client, logger, socket } = makeSocket()
		client.failGroupListQueries = true

		client.emit('CB:ib,,dirty', dirtyNode(dirtyType))
		await waitFor(() => warningsWith(logger, refreshFailure).length === 1)
		await new Promise(resolve => setTimeout(resolve, 20))

		expect(sentChildTags(client)).toEqual(['participating'])
		expect(warningsWith(logger, cleanFailure)).toHaveLength(0)

		await socket.end(new Error('test complete'))
	})

	it('reports a clean failure separately and does not reject', async () => {
		const { client, logger, socket } = makeSocket()
		client.failCleanSends = true

		client.emit('CB:ib,,dirty', dirtyNode(dirtyType))
		await waitFor(() => warningsWith(logger, cleanFailure).length === 1)

		expect(sentChildTags(client)).toEqual(['participating', 'clean'])
		expect(warningsWith(logger, refreshFailure)).toHaveLength(0)

		await socket.end(new Error('test complete'))
	})
})

describe('dirty notification for other sync types', () => {
	beforeEach(() => {
		clients.length = 0
	})

	it('does not refresh groups or communities', async () => {
		const { client, socket } = makeSocket()

		client.emit('CB:ib,,dirty', dirtyNode('other'))
		await new Promise(resolve => setTimeout(resolve, 20))

		expect(sentChildTags(client)).not.toContain('participating')

		await socket.end(new Error('test complete'))
	})
})
