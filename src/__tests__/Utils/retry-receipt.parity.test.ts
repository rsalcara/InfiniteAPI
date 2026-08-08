import P from 'pino'
import type { proto } from '../../../WAProto/index.js'
import {
	MessageRetryManager,
	parseRetryErrorCode,
	RetryReason,
	retryReasonFromDecryptionError,
	transmitWithRetryPayload
} from '../../Utils/message-retry-manager'
import {
	hasRetrySendBudget,
	nextRetrySendAttempt,
	persistRetrySendReservation,
	resolveRetryReceiptRoute,
	resolveRetryRelayDestination,
	shouldIncludeRetryKeysForSession
} from '../../Utils/retry-receipt'
import {
	classifyLibsignalFailure,
	installLibsignalDiagnostics,
	isLibsignalCallerStack,
	LibsignalDecryptError,
	recordLibsignalFailureDiagnostic,
	safeConsoleArgumentMessage,
	withLibsignalDiagnosticCapture
} from '../../Utils/suppress-libsignal-logs'

const silent = P({ level: 'silent' })

describe('retry receipt routing parity', () => {
	it('upgrades an old PN retry route when a canonical LID is now known', () => {
		expect(resolveRetryRelayDestination('5511000000001@s.whatsapp.net', '100000000000001@lid')).toBe(
			'100000000000001@lid'
		)
	})

	it('preserves the original LID route across a later mapping rotation', () => {
		expect(resolveRetryRelayDestination('100000000000001@lid', '100000000000002@lid')).toBe('100000000000001@lid')
	})

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

	it('keeps one outbound payload available for retries from multiple linked devices', () => {
		const manager = new MessageRetryManager(silent, 5)
		const interactive = {
			viewOnceMessage: {
				message: {
					interactiveMessage: {
						nativeFlowMessage: {
							buttons: [{ name: 'cta_url', buttonParamsJson: '{"url":"https://example.com"}' }]
						}
					}
				}
			}
		} as proto.IMessage
		manager.addRecentMessage('5511000000002@s.whatsapp.net', 'INTERACTIVE-1', interactive)

		expect(manager.getRecentMessage('100000000000001:24@lid', 'INTERACTIVE-1')?.message).toBe(interactive)
		manager.markOutboundRetrySuccess()
		expect(manager.getRecentMessage('100000000000001:50@lid', 'INTERACTIVE-1')?.message).toBe(interactive)
	})

	it('stages before transmission and discards a new payload when transmission fails', async () => {
		const manager = new MessageRetryManager(silent, 5)
		const message = { conversation: 'not transmitted' } as proto.IMessage

		await expect(
			transmitWithRetryPayload({
				manager,
				to: '5511000000002@s.whatsapp.net',
				id: 'FAILED-1',
				message,
				isDirectRetry: false,
				transmit: async () => {
					expect(manager.getRecentMessage('5511000000002@s.whatsapp.net', 'FAILED-1')?.message).toBe(message)
					throw new Error('send failed')
				}
			})
		).rejects.toThrow('send failed')

		expect(manager.getRecentMessage('5511000000002@s.whatsapp.net', 'FAILED-1')).toBeUndefined()
	})

	it('preserves a shared payload when a send-to-all retry transmission fails', async () => {
		const manager = new MessageRetryManager(silent, 5)
		const original = { conversation: 'original outbound payload' } as proto.IMessage
		const retry = { conversation: 'retry wrapper must not replace it' } as proto.IMessage

		manager.addRecentMessage('5511000000002@s.whatsapp.net', 'SHARED-1', original)
		await expect(
			transmitWithRetryPayload({
				manager,
				to: '5511000000002@s.whatsapp.net',
				id: 'SHARED-1',
				message: retry,
				isDirectRetry: false,
				transmit: async () => {
					throw new Error('retry broadcast failed')
				}
			})
		).rejects.toThrow('retry broadcast failed')
		expect(manager.getRecentMessage('100000000000001:50@lid', 'SHARED-1')?.message).toBe(original)
	})

	it('isolates reused custom message ids by destination and fails closed on an ambiguous fallback', () => {
		const manager = new MessageRetryManager(silent, 5)
		const first = { conversation: 'first chat' } as proto.IMessage
		const second = { conversation: 'second chat' } as proto.IMessage

		manager.addRecentMessage('5511000000001@s.whatsapp.net', 'REUSED-ID', first)
		manager.addRecentMessage('5511000000002@s.whatsapp.net', 'REUSED-ID', second)

		expect(manager.getRecentMessage('5511000000001@s.whatsapp.net', 'REUSED-ID')?.message).toBe(first)
		expect(manager.getRecentMessage('5511000000002@s.whatsapp.net', 'REUSED-ID')?.message).toBe(second)
		expect(manager.getRecentMessage('100000000000001:24@lid', 'REUSED-ID')).toBeUndefined()
	})

	it('resolves an exact LID/PN alias before the unique-id fallback', () => {
		const manager = new MessageRetryManager(silent, 5)
		const first = { conversation: 'first chat' } as proto.IMessage
		const second = { conversation: 'second chat' } as proto.IMessage

		manager.addRecentMessage('100000000000001@lid', 'ALIAS-ID', first)
		manager.addRecentMessage('100000000000002@lid', 'ALIAS-ID', second)

		expect(
			manager.getRecentMessageForJids(['5511000000001@s.whatsapp.net', '100000000000001@lid'], 'ALIAS-ID')?.message
		).toBe(first)
		expect(
			manager.getRecentMessageForJids(['5511000000002@s.whatsapp.net', '100000000000002@lid'], 'ALIAS-ID')?.message
		).toBe(second)
	})

	it('does not route a retry through a cache entry without a plaintext payload', () => {
		const manager = new MessageRetryManager(silent, 5)
		manager.addRecentMessage('100000000000001@lid', 'EMPTY-ID', undefined as unknown as proto.IMessage)

		expect(
			manager.getRecentMessageForJids(['5511000000001@s.whatsapp.net', '100000000000001@lid'], 'EMPTY-ID')
		).toBeUndefined()
	})

	it('removes every destination entry when a reused id is exhausted', () => {
		const manager = new MessageRetryManager(silent, 5)
		manager.addRecentMessage('5511000000001@s.whatsapp.net', 'DUPLICATE-ID', { conversation: 'one' } as proto.IMessage)
		manager.addRecentMessage('5511000000002@s.whatsapp.net', 'DUPLICATE-ID', { conversation: 'two' } as proto.IMessage)

		manager.markRetryFailed('DUPLICATE-ID')

		expect(manager.getRecentMessage('5511000000001@s.whatsapp.net', 'DUPLICATE-ID')).toBeUndefined()
		expect(manager.getRecentMessage('5511000000002@s.whatsapp.net', 'DUPLICATE-ID')).toBeUndefined()
	})

	it('rolls back only the failed destination when a custom message id is reused', async () => {
		const manager = new MessageRetryManager(silent, 5)
		const first = { conversation: 'first chat' } as proto.IMessage
		const second = { conversation: 'second chat failed' } as proto.IMessage

		manager.addRecentMessage('5511000000001@s.whatsapp.net', 'REUSED-ID', first)
		await expect(
			transmitWithRetryPayload({
				manager,
				to: '5511000000002@s.whatsapp.net',
				id: 'REUSED-ID',
				message: second,
				isDirectRetry: false,
				transmit: async () => {
					expect(manager.getRecentMessage('5511000000002@s.whatsapp.net', 'REUSED-ID')?.message).toBe(second)
					throw new Error('second send failed')
				}
			})
		).rejects.toThrow('second send failed')

		expect(manager.getRecentMessage('5511000000002@s.whatsapp.net', 'REUSED-ID')).toBeUndefined()
		expect(manager.getRecentMessage('5511000000001@s.whatsapp.net', 'REUSED-ID')?.message).toBe(first)
		expect(manager.getRecentMessage('100000000000001:24@lid', 'REUSED-ID')).toBeUndefined()
	})

	it('keeps live-location transport duration with the recent message', () => {
		const manager = new MessageRetryManager(silent, 5)
		const liveLocation = {
			liveLocationMessage: {
				degreesLatitude: -23.5,
				degreesLongitude: -47.4
			}
		} as proto.IMessage
		manager.addRecentMessage('5511000000002@s.whatsapp.net', 'LIVE-1', liveLocation, {
			liveLocationDuration: 1800
		})

		const cached = manager.getRecentMessage('100000000000001@lid', 'LIVE-1')
		expect(cached?.message).toBe(liveLocation)
		expect(cached?.liveLocationDuration).toBe(1800)
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

	it('does not coerce arbitrary console arguments while collecting libsignal diagnostics', () => {
		installLibsignalDiagnostics({ suppressLogs: true })
		const nullPrototype = Object.create(null)
		const hostile = {
			[Symbol.toPrimitive]: () => {
				throw new Error('must not be coerced')
			}
		}

		expect(() => console.error('Session error: Bad MAC', nullPrototype, hostile)).not.toThrow()
	})

	it('does not let a hostile Error.message getter break diagnostic extraction', () => {
		const hostileError = new Error('placeholder')
		Object.defineProperty(hostileError, 'message', {
			get: () => {
				throw new Error('must not read hostile message')
			}
		})

		expect(safeConsoleArgumentMessage(hostileError)).toBe('')
	})

	it('recognizes only real libsignal caller frames, not the diagnostic wrapper filename', () => {
		expect(
			isLibsignalCallerStack(
				'Error\n    at console.error (C:\\repo\\src\\Utils\\suppress-libsignal-logs.ts:180:49)\n' +
					'    at applicationFailure (C:\\repo\\src\\Socket\\socket.ts:10:2)'
			)
		).toBe(false)
		expect(
			isLibsignalCallerStack(
				'Error\n    at console.error (C:\\repo\\src\\Utils\\suppress-libsignal-logs.ts:180:49)\n' +
					'    at SessionCipher.decrypt (C:\\repo\\node_modules\\libsignal\\session_cipher.js:42:7)'
			)
		).toBe(true)
	})

	it('retains Bad MAC diagnostics independently of output suppression', async () => {
		installLibsignalDiagnostics({ suppressLogs: false })

		await expect(
			withLibsignalDiagnosticCapture(async () => {
				recordLibsignalFailureDiagnostic('Session error: Bad MAC for candidate session')
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
