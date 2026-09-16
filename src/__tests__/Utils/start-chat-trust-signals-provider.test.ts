import { jest } from '@jest/globals'
import { createStartChatTrustSignalsBridgeProvider } from '../../Utils/start-chat-trust-signals-provider'

describe('start-chat trust-signals bridge provider', () => {
	const signal = () => new AbortController().signal

	it('rejects invalid bridge URLs', () => {
		expect(() => createStartChatTrustSignalsBridgeProvider({ url: 'ftp://android-bridge.test' })).toThrow(
			'requires a valid http(s) url'
		)
		expect(() => createStartChatTrustSignalsBridgeProvider({ url: 'http://android-bridge.test' })).toThrow(
			'requires HTTPS for non-loopback urls'
		)
	})

	it('rejects timer values outside the Node timer range', () => {
		expect(() =>
			createStartChatTrustSignalsBridgeProvider({ url: 'http://127.0.0.1', timeoutMs: 2_147_483_648 })
		).toThrow('timeoutMs must be an integer')
		expect(() => createStartChatTrustSignalsBridgeProvider({ url: 'http://127.0.0.1', timeoutMs: 1.5 })).toThrow(
			'timeoutMs must be an integer'
		)
	})

	it('sends only the CHAT_FMX request and returns parsed non-sensitive fields', async () => {
		const fetchImpl = jest.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
			expect(init?.method).toBe('POST')
			expect(init?.redirect).toBe('error')
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
			url: 'http://127.0.0.1',
			fetch: fetchImpl
		})

		await expect(
			provider({ jid: '5511999999999@s.whatsapp.net', useCase: 'CHAT_FMX', signal: signal() })
		).resolves.toEqual({
			isSenderSuspicious: false,
			isSenderNewAccount: true,
			createdTs: 1_786_000_000_000
		})
		expect(fetchImpl).toHaveBeenCalledTimes(1)
	})

	it('rejects a bridge response without validated fields', async () => {
		const provider = createStartChatTrustSignalsBridgeProvider({
			url: 'http://127.0.0.1',
			fetch: async () => new Response(JSON.stringify({ integrity_signals: 'opaque' }), { status: 200 })
		})

		await expect(
			provider({ jid: '5511999999999@s.whatsapp.net', useCase: 'CHAT_FMX', signal: signal() })
		).rejects.toThrow('no valid fields')
	})

	it('does not allow fetch to follow redirects with CHAT_FMX payloads', async () => {
		let redirectMode: RequestRedirect | undefined
		const provider = createStartChatTrustSignalsBridgeProvider({
			url: 'http://127.0.0.1',
			fetch: (async (_url: RequestInfo | URL, init?: RequestInit) => {
				redirectMode = init?.redirect
				return new Response('', {
					status: 308,
					headers: { location: 'http://attacker.invalid/start-chat/trust-signals' }
				})
			}) as unknown as typeof fetch
		})

		await expect(
			provider({ jid: '5511999999999@s.whatsapp.net', useCase: 'CHAT_FMX', signal: signal() })
		).rejects.toThrow('HTTP 308')
		expect(redirectMode).toBe('error')
	})

	it('respects the socket abort signal before dispatch', async () => {
		const controller = new AbortController()
		controller.abort()
		const provider = createStartChatTrustSignalsBridgeProvider({
			url: 'http://127.0.0.1',
			fetch: async () => {
				throw new Error('should not be called')
			}
		})

		await expect(
			provider({ jid: '5511999999999@s.whatsapp.net', useCase: 'CHAT_FMX', signal: controller.signal })
		).rejects.toThrow('aborted before dispatch')
	})
})
