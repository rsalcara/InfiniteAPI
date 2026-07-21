import P from 'pino'
import type { proto } from '../../../WAProto/index.js'
import {
	MessageRetryManager,
	parseRetryErrorCode,
	RetryReason,
	retryReasonFromDecryptionError
} from '../../Utils/message-retry-manager'
import {
	hasRetrySendBudget,
	nextRetrySendAttempt,
	persistRetrySendReservation,
	resolveRetryReceiptRoute,
	shouldIncludeRetryKeysForSession
} from '../../Utils/retry-receipt'
import {
	classifyLibsignalFailure,
	installLibsignalDiagnostics,
	LibsignalDecryptError,
	withLibsignalDiagnosticCapture
} from '../../Utils/suppress-libsignal-logs'

const silent = P({ level: 'silent' })

describe('retry receipt routing parity', () => {
	it('restores the original destination for a fromMe LID receipt without recipient', () => {
		expect(
			resolveRetryReceiptRoute({
				stanzaFrom: '100000000000001@lid',
				isNodeFromMe: true,
				isGroup: false,
				isRetry: true,
				recentMessageTo: '5511000000001@s.whatsapp.net'
			})
		).toEqual({
			remoteJid: '5511000000001@s.whatsapp.net',
			source: 'recent-message-cache'
		})
	})

	it('fails closed when an own-device retry has no recipient or cached original route', () => {
		expect(
			resolveRetryReceiptRoute({
				stanzaFrom: '100000000000001@lid',
				isNodeFromMe: true,
				isGroup: false,
				isRetry: true
			})
		).toEqual({
			remoteJid: undefined,
			source: 'unresolved'
		})
	})

	it('keeps stanza context for non-retry receipts', () => {
		expect(
			resolveRetryReceiptRoute({
				stanzaFrom: '100000000000001@lid',
				isNodeFromMe: true,
				isGroup: false,
				isRetry: false
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
				isGroup: false,
				isRetry: true
			})
		).toEqual({
			remoteJid: '5511000000002@s.whatsapp.net',
			source: 'recipient-attribute'
		})

		expect(
			resolveRetryReceiptRoute({
				stanzaFrom: '5511000000002@s.whatsapp.net',
				isNodeFromMe: false,
				isGroup: false,
				isRetry: true
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

	it('checks the cap without consuming an attempt before session preparation', () => {
		expect(hasRetrySendBudget(4, 5)).toBe(true)
		expect(hasRetrySendBudget(5, 5)).toBe(false)
	})

	it('includes keys on the first retry only when explicitly forced or the session is absent', () => {
		expect(shouldIncludeRetryKeysForSession(1, false, true)).toBe(false)
		expect(shouldIncludeRetryKeysForSession(1, false, false)).toBe(true)
		expect(shouldIncludeRetryKeysForSession(1, true, true)).toBe(true)
		expect(shouldIncludeRetryKeysForSession(2, false, true)).toBe(true)
	})

	it('fails closed when a retry counter write is rejected or cannot be verified', async () => {
		const rejected = {
			get: () => undefined,
			set: () => false
		}
		expect(await persistRetrySendReservation(rejected, 'MSG:peer', 5)).toEqual({
			proceed: false,
			count: 0,
			reservationFailure: 'write-rejected'
		})

		const dropped = {
			get: () => undefined,
			set: () => true
		}
		expect(await persistRetrySendReservation(dropped, 'MSG:peer', 5)).toEqual({
			proceed: false,
			count: 0,
			reservationFailure: 'verification-failed'
		})
	})

	it('persists and verifies exactly one reservation', async () => {
		const values = new Map<string, number>()
		const store = {
			get: (key: string) => values.get(key),
			set: (key: string, value: number) => {
				values.set(key, value)
				return true
			}
		}

		expect(await persistRetrySendReservation(store, 'MSG:peer', 5)).toEqual({ proceed: true, count: 1 })
		expect(values.get('MSG:peer')).toBe(1)
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

	it('retains Bad MAC diagnostics independently of output suppression', async () => {
		installLibsignalDiagnostics({ suppressLogs: false })

		await expect(
			withLibsignalDiagnosticCapture(async () => {
				const session_cipher_candidate = () => console.error('Session error: Bad MAC for candidate session')
				session_cipher_candidate()
				throw new Error('No matching sessions found for message')
			})
		).rejects.toMatchObject<Partial<LibsignalDecryptError>>({
			name: 'LibsignalDecryptError',
			message: 'Bad MAC',
			diagnostics: [{ kind: 'bad-mac' }]
		})
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
