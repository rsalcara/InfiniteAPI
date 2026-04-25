import { jest } from '@jest/globals'
import { proto, type WAMessage } from '../..'
import { DEFAULT_CONNECTION_CONFIG } from '../../Defaults'
import makeWASocket from '../../Socket'
import { makeSession, mockWebSocket } from '../TestUtils/session'

mockWebSocket()

// chats.ts treats a connection as a reconnection when EITHER signal is true:
//   1. authState.creds.accountSyncCounter > 0
//      (at least one full history sync completed in a previous session)
//   2. socketSkippedOfflineBuffer (forwarded from socket.ts as `skipOfflineBuffer`)
//      (socket.ts already decided to skip the offline buffer, e.g. because
//       routingInfo was stale and was discarded on startup)
// On reconnection, AwaitingInitialSync is skipped and the buffer is flushed
// immediately so live messages are not held in the initial-sync window.
describe('Reconnection Sync Skip', () => {
	it('should skip the history sync wait on reconnection (accountSyncCounter > 0)', async () => {
		const { state, clear } = await makeSession()

		state.creds.me = { id: '1234567890:1@s.whatsapp.net', name: 'Test User' }
		// Simulate a session that has already synced before
		state.creds.accountSyncCounter = 1

		const sock = makeWASocket({
			...DEFAULT_CONNECTION_CONFIG,
			auth: state
		})

		const messageListener = jest.fn()
		sock.ev.on('messages.upsert', messageListener)

		// Simulate receiving pending notifications (triggers AwaitingInitialSync)
		sock.ev.emit('connection.update', { receivedPendingNotifications: true })

		// Emit a message immediately after — if the wait is skipped,
		// the buffer should already be flushed and this message should be delivered.
		const msg = proto.WebMessageInfo.fromObject({
			key: { remoteJid: '1234567890@s.whatsapp.net', fromMe: false, id: 'MSG_AFTER_RECONNECT' },
			messageTimestamp: Date.now() / 1000,
			message: { conversation: 'Hello after reconnect' }
		}) as WAMessage
		sock.ev.emit('messages.upsert', { messages: [msg], type: 'notify' })

		await new Promise(resolve => setTimeout(resolve, 50))

		// Message should be delivered immediately, NOT buffered
		expect(messageListener).toHaveBeenCalledTimes(1)
		expect(messageListener).toHaveBeenCalledWith(
			expect.objectContaining({
				messages: expect.arrayContaining([expect.objectContaining({ key: msg.key })]),
				type: 'notify'
			})
		)

		await sock.end(new Error('Test completed'))
		await clear()
	})

	it('should skip the history sync wait when socketSkippedOfflineBuffer is true (stale routingInfo, accountSyncCounter === 0)', async () => {
		const { state, clear } = await makeSession()

		state.creds.me = { id: '1234567890:1@s.whatsapp.net', name: 'Test User' }
		// Fresh-looking session from the counter perspective
		state.creds.accountSyncCounter = 0
		// But routingInfo is present and we ask the socket to discard it on start.
		// socket.ts will set hadStaleRoutingInfo=true → skipOfflineBuffer=true,
		// which chats.ts forwards as socketSkippedOfflineBuffer. Without this
		// branch, the buffers would be misaligned (offline buffer skipped while
		// AwaitingInitialSync still waits) and live messages would stall.
		state.creds.routingInfo = Buffer.from([1, 2, 3, 4])

		const sock = makeWASocket({
			...DEFAULT_CONNECTION_CONFIG,
			auth: state,
			clearRoutingInfoOnStart: true
		})

		const messageListener = jest.fn()
		sock.ev.on('messages.upsert', messageListener)

		sock.ev.emit('connection.update', { receivedPendingNotifications: true })

		const msg = proto.WebMessageInfo.fromObject({
			key: { remoteJid: '1234567890@s.whatsapp.net', fromMe: false, id: 'MSG_AFTER_STALE_ROUTING' },
			messageTimestamp: Date.now() / 1000,
			message: { conversation: 'Hello after stale routing reconnect' }
		}) as WAMessage
		sock.ev.emit('messages.upsert', { messages: [msg], type: 'notify' })

		await new Promise(resolve => setTimeout(resolve, 50))

		expect(messageListener).toHaveBeenCalledTimes(1)
		expect(messageListener).toHaveBeenCalledWith(
			expect.objectContaining({
				messages: expect.arrayContaining([expect.objectContaining({ key: msg.key })]),
				type: 'notify'
			})
		)

		await sock.end(new Error('Test completed'))
		await clear()
	})

	it('should still wait for history sync on fresh pairing (both signals false)', async () => {
		const { state, clear } = await makeSession()

		state.creds.me = { id: '1234567890:1@s.whatsapp.net', name: 'Test User' }
		// Fresh pairing — both reconnect signals are false:
		// accountSyncCounter is 0 (default) and no stale routingInfo to clear.
		state.creds.accountSyncCounter = 0

		const sock = makeWASocket({
			...DEFAULT_CONNECTION_CONFIG,
			auth: state
		})

		const messageListener = jest.fn()
		sock.ev.on('messages.upsert', messageListener)

		sock.ev.emit('connection.update', { receivedPendingNotifications: true })

		const msg = proto.WebMessageInfo.fromObject({
			key: { remoteJid: '1234567890@s.whatsapp.net', fromMe: false, id: 'MSG_DURING_INITIAL_SYNC' },
			messageTimestamp: Date.now() / 1000,
			message: { conversation: 'Hello during initial sync' }
		}) as WAMessage
		sock.ev.emit('messages.upsert', { messages: [msg], type: 'notify' })

		await new Promise(resolve => setTimeout(resolve, 50))

		// Message should be BUFFERED (not delivered) because we're waiting for history sync
		expect(messageListener).toHaveBeenCalledTimes(0)

		// Drain the 2s AwaitingInitialSync timeout (chats.ts:1522) so its callback
		// doesn't fire after Jest considers the test done — otherwise we get a
		// "Cannot log after tests are done" warning from the post-teardown flush
		// and the suite is flagged with --detectOpenHandles. After the timer
		// fires, syncState becomes Online and the buffer flushes; that delivery
		// is post-assertion and irrelevant to the test goal.
		await new Promise(resolve => setTimeout(resolve, 2_100))

		await sock.end(new Error('Test completed'))
		await clear()
	}, 10_000)
})
