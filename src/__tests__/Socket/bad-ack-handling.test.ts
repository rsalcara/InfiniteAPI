import { jest } from '@jest/globals'

/**
 * Tests for the error 463 retry logic in handleBadAck.
 *
 * Since handleBadAck is a closure inside makeMessagesRecvSocket, we extract
 * the core retry logic into a standalone function that mirrors the real
 * implementation and test it directly.
 */

interface MockKey {
	remoteJid: string
	fromMe: boolean
	id: string
}

type GetMessageFn = (key: MockKey) => Promise<any>
type RelayMessageFn = (jid: string, msg: any, opts: any) => Promise<void>
type EmitFn = (event: string, data: any) => void

interface MockMessageRetryManager {
	getRecentMessage: (jid: string, msgId: string) => { message: any } | undefined
}

/** Mirrors jidNormalizedUser: strips device suffix from JID user part */
function jidNormalizedUser(jid: string): string {
	const atIdx = jid.indexOf('@')
	if (atIdx < 0) return jid
	const user = jid.slice(0, atIdx)
	const server = jid.slice(atIdx + 1)
	const normalizedUser = user.includes(':') ? user.split(':')[0] : user
	return `${normalizedUser}@${server}`
}

/** Mirrors the handleBadAck error-463 retry logic */
async function handleBadAck463(
	attrs: { id: string; from: string; error: string },
	tcTokenRetriedMsgIds: Set<string>,
	getMessage: GetMessageFn,
	relayMessage: RelayMessageFn,
	emit: EmitFn,
	delayFn: (ms: number) => Promise<void>,
	messageRetryManager?: MockMessageRetryManager
): Promise<{ action: string }> {
	const msgId = attrs.id
	const jid = jidNormalizedUser(attrs.from)
	const key: MockKey = { remoteJid: attrs.from, fromMe: true, id: msgId }

	if (attrs.error === '463') {
		const retryKey = `${jid}:${msgId}`
		if (msgId && jid && !tcTokenRetriedMsgIds.has(retryKey)) {
			tcTokenRetriedMsgIds.add(retryKey)
			// Each entry auto-expires after 60s — naturally bounded under normal use
			setTimeout(() => tcTokenRetriedMsgIds.delete(retryKey), 60_000)

			const msg =
				(await getMessage(key)) ??
				// Fallback: ack can arrive <30ms after send, before store persists
				messageRetryManager?.getRecentMessage(jid, msgId)?.message
			if (msg) {
				try {
					await delayFn(1500)
					await relayMessage(jid, msg, {
						messageId: msgId,
						useUserDevicesCache: true
					})
					return { action: 'retry_succeeded' }
				} catch {
					// fall through to ERROR
				}
			}
		}
	}

	emit('messages.update', [{ key, update: { status: 'ERROR', messageStubParameters: [attrs.error] } }])
	return { action: 'error_emitted' }
}

describe('handleBadAck error 463 retry', () => {
	let tcTokenRetriedMsgIds: Set<string>
	let mockGetMessage: jest.Mock<GetMessageFn>
	let mockRelayMessage: jest.Mock<RelayMessageFn>
	let mockEmit: jest.Mock<EmitFn>
	let mockDelay: jest.Mock<(ms: number) => Promise<void>>

	const baseAttrs = { id: 'msg-001', from: '1234@s.whatsapp.net', error: '463' }

	beforeEach(() => {
		tcTokenRetriedMsgIds = new Set()
		mockGetMessage = jest.fn()
		mockRelayMessage = jest.fn()
		mockEmit = jest.fn()
		mockDelay = jest.fn<(ms: number) => Promise<void>>().mockResolvedValue(undefined)
	})

	it('should retry once on 463 when getMessage returns content', async () => {
		const fakeMsg = { conversation: 'hello' }
		mockGetMessage.mockResolvedValue(fakeMsg)
		mockRelayMessage.mockResolvedValue(undefined)

		const result = await handleBadAck463(
			baseAttrs,
			tcTokenRetriedMsgIds,
			mockGetMessage,
			mockRelayMessage,
			mockEmit,
			mockDelay
		)

		expect(result.action).toBe('retry_succeeded')
		expect(mockGetMessage).toHaveBeenCalledTimes(1)
		expect(mockRelayMessage).toHaveBeenCalledWith(baseAttrs.from, fakeMsg, {
			messageId: baseAttrs.id,
			useUserDevicesCache: true
		})
		expect(mockDelay).toHaveBeenCalledWith(1500)
		expect(mockEmit).not.toHaveBeenCalled()
	})

	it('should NOT retry when getMessage returns undefined', async () => {
		mockGetMessage.mockResolvedValue(undefined)

		const result = await handleBadAck463(
			baseAttrs,
			tcTokenRetriedMsgIds,
			mockGetMessage,
			mockRelayMessage,
			mockEmit,
			mockDelay
		)

		expect(result.action).toBe('error_emitted')
		expect(mockRelayMessage).not.toHaveBeenCalled()
		expect(mockEmit).toHaveBeenCalledTimes(1)
	})

	it('should NOT retry same message ID twice (loop guard)', async () => {
		const fakeMsg = { conversation: 'hello' }
		mockGetMessage.mockResolvedValue(fakeMsg)
		mockRelayMessage.mockResolvedValue(undefined)

		// First attempt succeeds
		await handleBadAck463(baseAttrs, tcTokenRetriedMsgIds, mockGetMessage, mockRelayMessage, mockEmit, mockDelay)
		const retryKey = `${jidNormalizedUser(baseAttrs.from)}:${baseAttrs.id}`
		expect(tcTokenRetriedMsgIds.has(retryKey)).toBe(true)

		// Second attempt with same ID — should not retry
		mockGetMessage.mockClear()
		mockRelayMessage.mockClear()

		const result = await handleBadAck463(
			baseAttrs,
			tcTokenRetriedMsgIds,
			mockGetMessage,
			mockRelayMessage,
			mockEmit,
			mockDelay
		)

		expect(result.action).toBe('error_emitted')
		expect(mockGetMessage).not.toHaveBeenCalled()
		expect(mockRelayMessage).not.toHaveBeenCalled()
		expect(mockEmit).toHaveBeenCalledTimes(1)
	})

	it('should emit ERROR status when retry fails', async () => {
		const fakeMsg = { conversation: 'hello' }
		mockGetMessage.mockResolvedValue(fakeMsg)
		mockRelayMessage.mockRejectedValue(new Error('send failed'))

		const result = await handleBadAck463(
			baseAttrs,
			tcTokenRetriedMsgIds,
			mockGetMessage,
			mockRelayMessage,
			mockEmit,
			mockDelay
		)

		expect(result.action).toBe('error_emitted')
		expect(mockEmit).toHaveBeenCalledTimes(1)
		expect(mockEmit).toHaveBeenCalledWith(
			'messages.update',
			expect.arrayContaining([
				expect.objectContaining({
					update: expect.objectContaining({ status: 'ERROR' })
				})
			])
		)
	})

	it('should not retry for non-463 errors', async () => {
		for (const errorCode of ['479', '421']) {
			mockGetMessage.mockClear()
			mockRelayMessage.mockClear()
			mockEmit.mockClear()

			const attrs = { ...baseAttrs, error: errorCode }
			const result = await handleBadAck463(
				attrs,
				tcTokenRetriedMsgIds,
				mockGetMessage,
				mockRelayMessage,
				mockEmit,
				mockDelay
			)

			expect(result.action).toBe('error_emitted')
			expect(mockGetMessage).not.toHaveBeenCalled()
			expect(mockRelayMessage).not.toHaveBeenCalled()
		}
	})

	it('should allow retry for different message IDs', async () => {
		const fakeMsg = { conversation: 'hello' }
		mockGetMessage.mockResolvedValue(fakeMsg)
		mockRelayMessage.mockResolvedValue(undefined)

		const result1 = await handleBadAck463(
			{ ...baseAttrs, id: 'msg-A' },
			tcTokenRetriedMsgIds,
			mockGetMessage,
			mockRelayMessage,
			mockEmit,
			mockDelay
		)
		const result2 = await handleBadAck463(
			{ ...baseAttrs, id: 'msg-B' },
			tcTokenRetriedMsgIds,
			mockGetMessage,
			mockRelayMessage,
			mockEmit,
			mockDelay
		)

		expect(result1.action).toBe('retry_succeeded')
		expect(result2.action).toBe('retry_succeeded')
		expect(mockRelayMessage).toHaveBeenCalledTimes(2)
	})

	it('should use jid:msgId composite key to isolate retries per destination', async () => {
		const fakeMsg = { conversation: 'hello' }
		mockGetMessage.mockResolvedValue(fakeMsg)
		mockRelayMessage.mockResolvedValue(undefined)

		const jid1 = '1111@s.whatsapp.net'
		const jid2 = '2222@s.whatsapp.net'
		const sharedMsgId = 'shared-msg'

		// Retry from jid1 should not block retry from jid2 for the same msgId
		await handleBadAck463(
			{ id: sharedMsgId, from: jid1, error: '463' },
			tcTokenRetriedMsgIds,
			mockGetMessage,
			mockRelayMessage,
			mockEmit,
			mockDelay
		)
		mockRelayMessage.mockClear()

		const result = await handleBadAck463(
			{ id: sharedMsgId, from: jid2, error: '463' },
			tcTokenRetriedMsgIds,
			mockGetMessage,
			mockRelayMessage,
			mockEmit,
			mockDelay
		)

		expect(result.action).toBe('retry_succeeded')
		expect(mockRelayMessage).toHaveBeenCalledTimes(1)
	})

	it('should fall back to messageRetryManager when getMessage returns undefined', async () => {
		const cachedMsg = { conversation: 'cached' }
		const mockRetryManager: MockMessageRetryManager = {
			getRecentMessage: jest
				.fn<(jid: string, msgId: string) => { message: any } | undefined>()
				.mockReturnValue({ message: cachedMsg })
		}
		mockGetMessage.mockResolvedValue(undefined)
		mockRelayMessage.mockResolvedValue(undefined)

		const result = await handleBadAck463(
			baseAttrs,
			tcTokenRetriedMsgIds,
			mockGetMessage,
			mockRelayMessage,
			mockEmit,
			mockDelay,
			mockRetryManager
		)

		expect(result.action).toBe('retry_succeeded')
		expect(mockRelayMessage).toHaveBeenCalledWith(baseAttrs.from, cachedMsg, {
			messageId: baseAttrs.id,
			useUserDevicesCache: true
		})
	})

	it('should expire retry key after 60s, allowing future retries', async () => {
		jest.useFakeTimers()

		const fakeMsg = { conversation: 'hello' }
		mockGetMessage.mockResolvedValue(fakeMsg)
		mockRelayMessage.mockResolvedValue(undefined)

		// First attempt — adds retryKey and registers 60s TTL
		await handleBadAck463(baseAttrs, tcTokenRetriedMsgIds, mockGetMessage, mockRelayMessage, mockEmit, mockDelay)
		const retryKey = `${jidNormalizedUser(baseAttrs.from)}:${baseAttrs.id}`
		expect(tcTokenRetriedMsgIds.has(retryKey)).toBe(true)

		// Advance time by 60s — TTL should fire and remove the key
		jest.advanceTimersByTime(60_000)
		expect(tcTokenRetriedMsgIds.has(retryKey)).toBe(false)

		// After expiry, the same message can be retried again
		mockGetMessage.mockClear()
		mockRelayMessage.mockClear()
		mockEmit.mockClear()

		const result = await handleBadAck463(
			baseAttrs,
			tcTokenRetriedMsgIds,
			mockGetMessage,
			mockRelayMessage,
			mockEmit,
			mockDelay
		)

		expect(result.action).toBe('retry_succeeded')
		jest.useRealTimers()
	})
})
