import P from 'pino'
import type { proto } from '../../../WAProto/index.js'
import {
	MessageRetryManager,
	parseRetryErrorCode,
	RetryReason,
	retryReasonFromDecryptionError
} from '../../Utils/message-retry-manager'
import { nextRetrySendAttempt, resolveRetryReceiptRoute } from '../../Utils/retry-receipt'
import { classifyLibsignalFailure } from '../../Utils/suppress-libsignal-logs'

const silent = P({ level: 'silent' })

describe('retry receipt routing parity', () => {
	it('restores the original destination for a fromMe LID receipt without recipient', () => {
		expect(
			resolveRetryReceiptRoute({
				stanzaFrom: '100000000000001@lid',
				isNodeFromMe: true,
				isGroup: false,
				recentMessageTo: '5511000000001@s.whatsapp.net'
			})
		).toEqual({
			remoteJid: '5511000000001@s.whatsapp.net',
			source: 'recent-message-cache'
		})
	})

	it('falls back to stanza remote context instead of producing an undefined JID', () => {
		expect(
			resolveRetryReceiptRoute({
				stanzaFrom: '100000000000001@lid',
				isNodeFromMe: true,
				isGroup: false
			})
		).toEqual({
			remoteJid: '100000000000001@lid',
			source: 'stanza-remote-context'
		})
	})

	it('preserves explicit recipient and non-self/group routing', () => {
		expect(
			resolveRetryReceiptRoute({
				stanzaFrom: '100000000000001@lid',
				recipient: '5511000000002@s.whatsapp.net',
				isNodeFromMe: true,
				isGroup: false
			})
		).toEqual({
			remoteJid: '5511000000002@s.whatsapp.net',
			source: 'recipient-attribute'
		})

		expect(
			resolveRetryReceiptRoute({
				stanzaFrom: '5511000000002@s.whatsapp.net',
				isNodeFromMe: false,
				isGroup: false
			}).remoteJid
		).toBe('5511000000002@s.whatsapp.net')
	})

	it('keeps an interactive carousel payload unchanged in the recent-message fallback', () => {
		const manager = new MessageRetryManager(silent, 5)
		const carousel = {
			interactiveMessage: {
				carouselMessage: {
					cards: [{ nativeFlowMessage: { buttons: [{ name: 'quick_reply', buttonParamsJson: '{"id":"1"}' }] } }]
				}
			}
		} as proto.IMessage
		manager.addRecentMessage('5511000000002@s.whatsapp.net', 'CAROUSEL-1', carousel)

		const cached = manager.getRecentMessage('100000000000001@lid', 'CAROUSEL-1')
		expect(cached?.message).toBe(carousel)
		expect(cached?.to).toBe('5511000000002@s.whatsapp.net')
	})
})

describe('retry attempt accounting', () => {
	it('advances once and stops exactly at the configured limit', () => {
		expect(nextRetrySendAttempt(0, 5)).toEqual({ proceed: true, count: 1 })
		expect(nextRetrySendAttempt(4, 5)).toEqual({ proceed: true, count: 5 })
		expect(nextRetrySendAttempt(5, 5)).toEqual({ proceed: false, count: 5 })
	})
})

describe('Signal retry reason parity', () => {
	it('maps verified Android failure strings and keeps unknown failures generic', () => {
		expect(retryReasonFromDecryptionError(new Error('Bad MAC'))).toBe(RetryReason.SignalErrorBadMac)
		expect(retryReasonFromDecryptionError(new Error('No matching sessions found for message'))).toBe(
			RetryReason.SignalErrorInvalidSession
		)
		expect(retryReasonFromDecryptionError(new Error('unclassified failure'))).toBe(RetryReason.UnknownError)
		expect(parseRetryErrorCode('7')).toBe(RetryReason.SignalErrorBadMac)
		expect(parseRetryErrorCode('not-a-number')).toBeUndefined()
	})

	it('classifies libsignal console failures without retaining message material', () => {
		expect(classifyLibsignalFailure('Session error: Bad MAC')).toBe('bad-mac')
		expect(classifyLibsignalFailure('MessageCounterError for address')).toBe('message-counter')
		expect(classifyLibsignalFailure('ordinary application error')).toBeUndefined()
	})

	it('does not delete an existing session from an error label alone', () => {
		const manager = new MessageRetryManager(silent, 5)
		expect(manager.shouldRecreateSession('5511000000002@s.whatsapp.net', true, RetryReason.SignalErrorBadMac)).toEqual({
			reason: '',
			recreate: false
		})
		expect(
			manager.shouldRecreateSession('5511000000002@s.whatsapp.net', false, RetryReason.SignalErrorNoSession)
		).toEqual({
			reason: "we don't have a Signal session with them",
			recreate: true
		})
	})
})
