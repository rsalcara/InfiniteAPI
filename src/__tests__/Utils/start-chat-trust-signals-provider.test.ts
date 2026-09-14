import { jest } from '@jest/globals'
import { createStartChatTrustSignalsBridgeProvider } from '../../Utils/start-chat-trust-signals-provider'

describe('start-chat trust-signals bridge provider', () => {
	it('rejects timer values outside the Node timer range', () => {
		expect(() =>
			createStartChatTrustSignalsBridgeProvider({ url: 'http://android-bridge.test', timeoutMs: 2_147_483_648 })
		).toThrow('timeoutMs must be an integer')
		expect(() =>
			createStartChatTrustSignalsBridgeProvider({ url: 'http://android-bridge.test', timeoutMs: 1.5 })
		).toThrow('timeoutMs must be an integer')
	})

	it('sends only the CHAT_FMX request and returns parsed non-sensitive fields', async () => {
		const fetchImpl = jest.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
			expect(init?.method).toBe('POST')
			expect(init?.body).toBe(JSON.stringify({ jid: '5511999999999@s.whatsapp.net', use_case: 'CHAT_FMX' }))
			return new Response(
				JSON.stringify({
					is_sender_suspicious: false,
					is_sender_new_account: true,
					created_ts: 1_786_000_000_000,
					integrity_signals: 'must-not-be-forwarded'
				}),
				{ status: 200 }
			)
		})
		const provider = createStartChatTrustSignalsBridgeProvider({
			url: 'http://android-bridge.test',
			fetch: fetchImpl
		})

		await expect(provider({ jid: '5511999999999@s.whatsapp.net', useCase: 'CHAT_FMX' })).resolves.toEqual({
			isSenderSuspicious: false,
			isSenderNewAccount: true,
			createdTs: 1_786_000_000_000
		})
		expect(fetchImpl).toHaveBeenCalledTimes(1)
	})

	it('rejects a bridge response without validated fields', async () => {
		const provider = createStartChatTrustSignalsBridgeProvider({
			url: 'http://android-bridge.test',
			fetch: async () => new Response(JSON.stringify({ integrity_signals: 'opaque' }), { status: 200 })
		})

		await expect(provider({ jid: '5511999999999@s.whatsapp.net', useCase: 'CHAT_FMX' })).rejects.toThrow(
			'no valid fields'
		)
	})
})
