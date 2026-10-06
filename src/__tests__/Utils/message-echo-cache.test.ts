import { jest } from '@jest/globals'
import {
	clearMessageEchoCache,
	getMessageEcho,
	rememberMessageEcho,
	takeMessageEcho
} from '../../Utils/message-echo-cache'

const ACCOUNT = '5511999999999:1@s.whatsapp.net'
const OTHER_ACCOUNT = '5511888888888:2@s.whatsapp.net'
const DAY_MS = 24 * 60 * 60 * 1000

beforeEach(() => clearMessageEchoCache())

describe('message-echo-cache lifecycle', () => {
	it('peeks without consuming, so the delivery receipt cannot spend the read echo', () => {
		rememberMessageEcho(ACCOUNT, 'MSG-1', {
			sts: '4242',
			senderDeviceJid: '5511999999999:3@s.whatsapp.net'
		})
		expect(getMessageEcho(ACCOUNT, 'MSG-1')?.sts).toBe('4242')
		expect(getMessageEcho(ACCOUNT, 'MSG-1')?.sts).toBe('4242')
	})

	it('consumes the entry on take — the read receipt spends the echo', () => {
		rememberMessageEcho(ACCOUNT, 'MSG-1', { sts: '4242' })
		expect(takeMessageEcho(ACCOUNT, 'MSG-1')?.sts).toBe('4242')
		expect(takeMessageEcho(ACCOUNT, 'MSG-1')).toBeUndefined()
		expect(getMessageEcho(ACCOUNT, 'MSG-1')).toBeUndefined()
	})

	it('expires entries after the TTL and drops them, not just hides them', () => {
		const now = jest.spyOn(Date, 'now')
		try {
			now.mockReturnValue(1_000_000)
			rememberMessageEcho(ACCOUNT, 'MSG-1', { sts: '4242' })
			now.mockReturnValue(1_000_000 + DAY_MS)
			expect(getMessageEcho(ACCOUNT, 'MSG-1')?.sts).toBe('4242')
			now.mockReturnValue(1_000_000 + DAY_MS + 1)
			expect(getMessageEcho(ACCOUNT, 'MSG-1')).toBeUndefined()
			now.mockReturnValue(1_000_000)
			expect(getMessageEcho(ACCOUNT, 'MSG-1')).toBeUndefined()
		} finally {
			now.mockRestore()
		}
	})

	it('evicts the oldest entries past the per-account cap', () => {
		for (let i = 0; i <= 10_000; i++) {
			rememberMessageEcho(ACCOUNT, `MSG-${i}`, { sts: String(i) })
		}

		expect(getMessageEcho(ACCOUNT, 'MSG-0')).toBeUndefined()
		expect(getMessageEcho(ACCOUNT, 'MSG-1')?.sts).toBe('1')
		expect(getMessageEcho(ACCOUNT, 'MSG-10000')?.sts).toBe('10000')
	})

	it('scopes entries per account and normalizes the account jid', () => {
		rememberMessageEcho(ACCOUNT, 'MSG-1', { sts: 'mine' })
		rememberMessageEcho(OTHER_ACCOUNT, 'MSG-1', { sts: 'theirs' })
		expect(getMessageEcho(ACCOUNT, 'MSG-1')?.sts).toBe('mine')
		expect(getMessageEcho('5511999999999@s.whatsapp.net', 'MSG-1')?.sts).toBe('mine')
		expect(getMessageEcho(OTHER_ACCOUNT, 'MSG-1')?.sts).toBe('theirs')
		expect(getMessageEcho('5511777777777@s.whatsapp.net', 'MSG-1')).toBeUndefined()
	})

	it("one account's burst never evicts another account's echoes", () => {
		rememberMessageEcho(OTHER_ACCOUNT, 'KEEP-1', { sts: 'keep' })
		for (let i = 0; i <= 10_000; i++) {
			rememberMessageEcho(ACCOUNT, `MSG-${i}`, {})
		}

		expect(getMessageEcho(OTHER_ACCOUNT, 'KEEP-1')?.sts).toBe('keep')
	})

	it('re-remembering refreshes the entry (re-decrypted delivery)', () => {
		rememberMessageEcho(ACCOUNT, 'MSG-1', { sts: 'old' })
		rememberMessageEcho(ACCOUNT, 'MSG-1', { sts: 'new' })
		expect(takeMessageEcho(ACCOUNT, 'MSG-1')?.sts).toBe('new')
	})

	it('ignores empty ids and unknown lookups stay empty', () => {
		rememberMessageEcho(ACCOUNT, '', { sts: '4242' })
		rememberMessageEcho(ACCOUNT, null, { sts: '4242' })
		expect(getMessageEcho(ACCOUNT, '')).toBeUndefined()
		expect(takeMessageEcho(undefined, 'MSG-1')).toBeUndefined()
	})
})
