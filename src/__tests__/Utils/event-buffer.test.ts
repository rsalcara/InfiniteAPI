import { jest } from '@jest/globals'
import type { BaileysEventMap } from '../../Types'
import { makeEventBuffer } from '../../Utils/event-buffer'
import type { ILogger } from '../../Utils/logger'

const makeTestLogger = (): ILogger =>
	({
		level: 'silent',
		child: () => makeTestLogger(),
		trace: () => {},
		debug: () => {},
		info: () => {},
		warn: () => {},
		error: () => {},
		fatal: () => {}
	}) as unknown as ILogger

describe('event-buffer', () => {
	describe('long buffered operations', () => {
		afterEach(() => {
			jest.useRealTimers()
		})

		it('keeps batching after a safety timeout while createBufferedFunction is still active', async () => {
			jest.useFakeTimers()
			const ev = makeEventBuffer(makeTestLogger(), {
				bufferTimeoutMs: 10,
				minBufferTimeoutMs: 10,
				maxBufferTimeoutMs: 10,
				flushDebounceMs: 1,
				enableAdaptiveTimeout: false
			})
			const received: BaileysEventMap['lid-mapping.update'][] = []
			let release!: () => void
			const gate = new Promise<void>(resolve => {
				release = resolve
			})

			ev.on('lid-mapping.update', mappings => received.push(mappings))
			const run = ev.createBufferedFunction(async () => {
				ev.emit('lid-mapping.update', [{ lid: '111@lid', pn: '55111@s.whatsapp.net' }])
				await gate
				ev.emit('lid-mapping.update', [{ lid: '222@lid', pn: '55222@s.whatsapp.net' }])
			})

			const running = run()
			await jest.advanceTimersByTimeAsync(10)
			expect(received).toEqual([[{ lid: '111@lid', pn: '55111@s.whatsapp.net' }]])

			release()
			await running

			// The second event must remain buffered until the post-operation
			// debounce. Before this fix it was delivered synchronously as a
			// singleton because the safety flush disabled buffering.
			expect(received).toHaveLength(1)
			await jest.advanceTimersByTimeAsync(1)
			expect(received).toEqual([
				[{ lid: '111@lid', pn: '55111@s.whatsapp.net' }],
				[{ lid: '222@lid', pn: '55222@s.whatsapp.net' }]
			])

			ev.destroy()
		})
	})

	describe('messaging-history.set pastParticipants buffering', () => {
		it('should include pastParticipants in flushed event', async () => {
			const logger = makeTestLogger()
			const ev = makeEventBuffer(logger)

			const pastParticipants = [
				{
					groupJid: '123456789012345678@g.us',
					pastParticipants: [{ userJid: '1234567890123@s.whatsapp.net', leaveReason: 1, leaveTs: 1700000000 }]
				}
			]

			const receivedEvents: BaileysEventMap['messaging-history.set'][] = []
			ev.on('messaging-history.set', (data: BaileysEventMap['messaging-history.set']) => {
				receivedEvents.push(data)
			})

			ev.buffer()
			ev.emit('messaging-history.set', {
				chats: [],
				contacts: [],
				messages: [],
				pastParticipants,
				syncType: 0,
				progress: 50,
				isLatest: false,
				peerDataRequestSessionId: null
			})
			ev.flush()

			// wait for event emission
			await new Promise(resolve => setTimeout(resolve, 100))

			expect(receivedEvents).toHaveLength(1)
			expect(receivedEvents[0]!.pastParticipants).toEqual(pastParticipants)
		})

		it('should accumulate pastParticipants across multiple buffered events', async () => {
			const logger = makeTestLogger()
			const ev = makeEventBuffer(logger)

			const batch1 = [
				{
					groupJid: '111111111111111111@g.us',
					pastParticipants: [{ userJid: '1111111111111@s.whatsapp.net', leaveReason: 1, leaveTs: 1700000000 }]
				}
			]

			const batch2 = [
				{
					groupJid: '222222222222222222@g.us',
					pastParticipants: [{ userJid: '2222222222222@s.whatsapp.net', leaveReason: 2, leaveTs: 1700000001 }]
				}
			]

			const receivedEvents: BaileysEventMap['messaging-history.set'][] = []
			ev.on('messaging-history.set', (data: BaileysEventMap['messaging-history.set']) => {
				receivedEvents.push(data)
			})

			ev.buffer()
			ev.emit('messaging-history.set', {
				chats: [],
				contacts: [],
				messages: [],
				pastParticipants: batch1,
				syncType: 0,
				progress: 25,
				isLatest: false,
				peerDataRequestSessionId: null
			})
			ev.emit('messaging-history.set', {
				chats: [],
				contacts: [],
				messages: [],
				pastParticipants: batch2,
				syncType: 0,
				progress: 50,
				isLatest: false,
				peerDataRequestSessionId: null
			})
			ev.flush()

			await new Promise(resolve => setTimeout(resolve, 100))

			expect(receivedEvents).toHaveLength(1)
			expect(receivedEvents[0]!.pastParticipants).toHaveLength(2)
			expect(receivedEvents[0]!.pastParticipants).toContainEqual(batch1[0])
			expect(receivedEvents[0]!.pastParticipants).toContainEqual(batch2[0])
		})

		it('should not lose pastParticipants when later event has none', async () => {
			const logger = makeTestLogger()
			const ev = makeEventBuffer(logger)

			const batch1 = [
				{
					groupJid: '111111111111111111@g.us',
					pastParticipants: [{ userJid: '1111111111111@s.whatsapp.net', leaveReason: 1, leaveTs: 1700000000 }]
				}
			]

			const receivedEvents: BaileysEventMap['messaging-history.set'][] = []
			ev.on('messaging-history.set', (data: BaileysEventMap['messaging-history.set']) => {
				receivedEvents.push(data)
			})

			ev.buffer()
			ev.emit('messaging-history.set', {
				chats: [],
				contacts: [],
				messages: [],
				pastParticipants: batch1,
				syncType: 0,
				progress: 25,
				isLatest: false,
				peerDataRequestSessionId: null
			})
			// Second event has no pastParticipants
			ev.emit('messaging-history.set', {
				chats: [],
				contacts: [],
				messages: [],
				syncType: 0,
				progress: 50,
				isLatest: false,
				peerDataRequestSessionId: null
			})
			ev.flush()

			await new Promise(resolve => setTimeout(resolve, 100))

			expect(receivedEvents).toHaveLength(1)
			expect(receivedEvents[0]!.pastParticipants).toEqual(batch1)
		})
	})
})
