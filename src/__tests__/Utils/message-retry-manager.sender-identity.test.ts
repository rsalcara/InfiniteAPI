import { jest } from '@jest/globals'
import P from 'pino'
import { proto } from '../../../WAProto/index.js'
import { MessageRetryManager } from '../../Utils/message-retry-manager'
import { pdoRequestCacheKey } from '../../Utils/pdo-recovery'

const silent = P({ level: 'silent' })

describe('MessageRetryManager sender-aware PDO identity', () => {
	afterEach(() => {
		jest.useRealTimers()
	})

	const group = '120363400000000000@g.us'
	const messageId = 'same-client-id'
	const firstSenderKey = {
		remoteJid: group,
		id: messageId,
		fromMe: false,
		participant: '5511900000000@s.whatsapp.net'
	} as proto.IMessageKey
	const secondSenderKey = {
		remoteJid: group,
		id: messageId,
		fromMe: false,
		participant: '5511800000000@s.whatsapp.net'
	} as proto.IMessageKey

	it('keeps counters independent for group senders that reuse a message id', () => {
		const manager = new MessageRetryManager(silent, 5)
		const firstIdentity = pdoRequestCacheKey(firstSenderKey)
		const secondIdentity = pdoRequestCacheKey(secondSenderKey)

		expect(firstIdentity).not.toBe(secondIdentity)
		expect(manager.tryIncrement(firstIdentity)).toEqual({ proceed: true, count: 1 })
		expect(manager.tryIncrement(secondIdentity)).toEqual({ proceed: true, count: 1 })
		expect(manager.tryIncrement(firstIdentity)).toEqual({ proceed: true, count: 2 })
		expect(manager.getRetryCount(secondIdentity)).toBe(1)
	})

	it('does not cancel one sender phone request when the other is scheduled', () => {
		const manager = new MessageRetryManager(silent, 5)
		jest.useFakeTimers()
		const firstCallback = jest.fn()
		const secondCallback = jest.fn()

		manager.schedulePhoneRequest(pdoRequestCacheKey(firstSenderKey), firstCallback, 10)
		manager.schedulePhoneRequest(pdoRequestCacheKey(secondSenderKey), secondCallback, 20)

		jest.advanceTimersByTime(20)
		expect(firstCallback).toHaveBeenCalledTimes(1)
		expect(secondCallback).toHaveBeenCalledTimes(1)
	})

	it('removes only the failed sender payload while preserving the reused message id elsewhere', () => {
		const manager = new MessageRetryManager(silent, 5)
		const firstIdentity = pdoRequestCacheKey(firstSenderKey)
		const firstMessage = { conversation: 'first sender payload' } as proto.IMessage
		const secondMessage = { conversation: 'second sender payload' } as proto.IMessage
		const unrelatedChat = '5511700000000@s.whatsapp.net'
		manager.addRecentMessage(firstSenderKey.remoteJid!, messageId, firstMessage)
		manager.addRecentMessage(unrelatedChat, messageId, secondMessage)

		manager.markRetryFailed(firstIdentity, [firstSenderKey.remoteJid!], messageId)

		expect(manager.getRecentMessage(firstSenderKey.remoteJid!, messageId)).toBeUndefined()
		expect(manager.getRecentMessage(unrelatedChat, messageId)?.message).toBe(secondMessage)
	})

	it('clears the sender-aware retry counter and cancels its phone request when exhausted', () => {
		const manager = new MessageRetryManager(silent, 5)
		const identity = pdoRequestCacheKey(firstSenderKey)
		jest.useFakeTimers()
		const callback = jest.fn()
		manager.schedulePhoneRequest(identity, callback, 10)

		for (let count = 1; count <= 5; count++) {
			expect(manager.tryIncrement(identity)).toEqual({ proceed: true, count })
		}

		expect(manager.tryIncrement(identity)).toEqual({ proceed: false, count: 5 })

		manager.markRetryFailed(identity, [firstSenderKey.remoteJid!], messageId)

		jest.advanceTimersByTime(10)
		expect(callback).not.toHaveBeenCalled()
		expect(manager.tryIncrement(identity)).toEqual({ proceed: true, count: 1 })
	})

	it('accepts the canonical PN spelling after normalization collapses the LID alt', () => {
		const manager = new MessageRetryManager(silent, 5)
		const rawKey = {
			...firstSenderKey,
			participant: '5511900000000@s.whatsapp.net',
			participantAlt: '5511900000000@lid'
		} as proto.IMessageKey
		const normalizedKey = {
			...rawKey,
			participantAlt: '5511900000000@s.whatsapp.net'
		} as proto.IMessageKey

		manager.tryIncrement(pdoRequestCacheKey(rawKey))
		expect(manager.markInboundRetrySuccess(pdoRequestCacheKey(normalizedKey))).toBe(true)
	})
})
