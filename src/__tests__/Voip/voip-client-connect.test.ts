import { jest } from '@jest/globals'
import { EventEmitter } from 'events'

type FakeSock = { ev: EventEmitter }

const sockets: FakeSock[] = []
const makeWASocket = jest.fn(() => {
	const sock: FakeSock = { ev: new EventEmitter() }
	sockets.push(sock)
	return sock
})

jest.unstable_mockModule('../../Socket/index', () => ({ default: makeWASocket, makeWASocket }))
jest.unstable_mockModule('../../Utils/use-multi-file-auth-state', () => ({
	useMultiFileAuthState: async () => ({ state: {}, saveCreds: async () => undefined })
}))

const { VoipClient } = await import('../../Voip/index')

const flush = () => new Promise(resolve => setImmediate(resolve))

/**
 * Standalone VoipClient.connect() must not install a process-wide
 * uncaughtException listener (audit G-04): any such listener stops Node from
 * crashing on the host application's own exceptions. The 515 restart is
 * handled through connection.update instead.
 */
describe('VoipClient.connect (standalone)', () => {
	beforeEach(() => {
		sockets.length = 0
		makeWASocket.mockClear()
	})

	it('does not add an uncaughtException listener while connecting', async () => {
		const baseline = process.listenerCount('uncaughtException')
		const client = new VoipClient({ authDir: '/tmp/voip-client-connect-test' } as never)
		const connecting = client.connect()
		await flush()

		expect(makeWASocket).toHaveBeenCalledTimes(1)
		expect(process.listenerCount('uncaughtException')).toBe(baseline)

		const failure = new Error('logged out')
		sockets[0]!.ev.emit('connection.update', { connection: 'close', lastDisconnect: { error: failure } })
		await expect(connecting).rejects.toBe(failure)
		expect(process.listenerCount('uncaughtException')).toBe(baseline)
	})

	it('retries the post-pairing 515 restart through connection.update', async () => {
		const client = new VoipClient({ authDir: '/tmp/voip-client-connect-test' } as never)
		const connecting = client.connect()
		await flush()

		const restart = Object.assign(new Error('restart required'), { output: { statusCode: 515 } })
		sockets[0]!.ev.emit('connection.update', { connection: 'close', lastDisconnect: { error: restart } })
		await new Promise(resolve => setTimeout(resolve, 1_100))
		expect(makeWASocket).toHaveBeenCalledTimes(2)

		const failure = new Error('stop')
		sockets[1]!.ev.emit('connection.update', { connection: 'close', lastDisconnect: { error: failure } })
		await expect(connecting).rejects.toBe(failure)
	})
})
