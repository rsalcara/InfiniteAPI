import { jest } from '@jest/globals'
import { DEFAULT_CONNECTION_CONFIG, NOISE_WA_HEADER } from '../../Defaults'
import {
	createApkCountriesTsvProvider,
	resetPhoneMetadataProvider,
	setPhoneMetadataProvider
} from '../../Utils/phone-metadata-provider'
import { resetProcessPhoneValidationRateLimiter } from '../../Utils/phone-validation'
import type { BinaryNode } from '../../WABinary'
import { decodeBinaryNode } from '../../WABinary'

/**
 * Map of phone → canonical JID. When set, the mock server returns the
 * canonical JID instead of echoing the queried phone. This simulates
 * old accounts where the JID has different digits (e.g. 10-digit JID
 * for an 11-digit query).
 */
let canonicalJidMap: Map<string, string> | null = null

const BR_TSV =
	'BR\tBrasil\t55\t724\t9,10,11\t0\tX\t' +
	'(\\d{4})(\\d{4});(\\d{5})(\\d{4});(\\d{3,5});(\\d{2})(\\d{4})(\\d{4});(\\d{2})(\\d{5})(\\d{4});(\\d{4})(\\d{4});([3589]00)(\\d{2,3})(\\d{4})\t' +
	'$1-$2;$1-$2;$1;$1 $2-$3;$1 $2-$3;$1-$2;$1 $2 $3\t' +
	'[2-9](?:[1-9]|0[1-9]);9(?:[1-9]|0[1-9]);1[125689];[1-9][1-9];(?:[14689][1-9]|2[12478]|3[1-578]|5[1-5]|7[13-579])9;(?:300|40(?:0|20));[3589]00\t' +
	'X\tBrazil\tX\trow\tX\tX\tX\tX\tX\tX\tX\tX\tX'

type FakeSocketClient = Record<string, any>

const clients: FakeSocketClient[] = []

const mockMakeFakeSocketClient = () =>
	class FakeSocketClient {
		readonly sentNodes: BinaryNode[] = []
		private readonly listeners = new Map<string, Set<(payload?: unknown) => void>>()

		constructor() {
			clients.push(this)
		}

		on(event: string, listener: (payload?: unknown) => void) {
			const listeners = this.listeners.get(event) ?? new Set()
			listeners.add(listener)
			this.listeners.set(event, listeners)
		}

		off(event: string, listener: (payload?: unknown) => void) {
			this.listeners.get(event)?.delete(listener)
		}

		removeAllListeners(event?: string) {
			if (event) this.listeners.delete(event)
			else this.listeners.clear()
		}

		emit(event: string, payload?: unknown) {
			for (const listener of [...(this.listeners.get(event) ?? [])]) listener(payload)
			return true
		}

		get isOpen() {
			return true
		}

		get isClosed() {
			return false
		}

		get isClosing() {
			return false
		}

		get isConnecting() {
			return false
		}

		connect() {}

		close() {
			this.emit('close', false)
		}

		send(data: Uint8Array | string, callback?: (error?: Error) => void) {
			void decodeWiringFrame(data).then(node => {
				this.sentNodes.push(node)
				const msgId = String(node.attrs.id ?? '')
				const usync = asNodeArray(node.content).find(child => child.tag === 'usync')
				const users = asNodeArray(asNodeArray(usync?.content).find(child => child.tag === 'list')?.content).filter(
					(child): child is BinaryNode => child.tag === 'user'
				)

				const response: BinaryNode = {
					tag: 'iq',
					attrs: {
						id: msgId,
						type: 'result'
					},
					content: [
						{
							tag: 'usync',
							attrs: {
								context: 'interactive',
								mode: 'query',
								last: 'true',
								index: '0'
							},
							content: [
								{
									tag: 'list',
									attrs: {},
									content:
										users?.map(user => {
											const phone = String(asNodeArray(user.content).at(-1)?.content)
											const phoneDigits = phone.replace('+', '').replace(/\D/g, '')
											const exists = phone === '+5583989128418' || (canonicalJidMap?.has(phoneDigits) ?? false)
											const jidPhone = canonicalJidMap?.get(phoneDigits) ?? phoneDigits
											return {
												tag: 'user',
												attrs: { jid: `${jidPhone}@s.whatsapp.net` },
												content: [
													{
														tag: 'contact',
														attrs: { type: exists ? 'in' : 'out' }
													}
												]
											}
										}) ?? []
								}
							]
						}
					]
				}

				setImmediate(() => {
					callback?.()
					this.emit(`TAG:${msgId}`, response)
				})
			})
			return true
		}
	}

const decodeWiringFrame = async (frame: Uint8Array | string): Promise<BinaryNode> => {
	if (typeof frame === 'string') throw new Error('phone validation wiring expected a binary frame')

	const offset =
		frame.length >= NOISE_WA_HEADER.length && NOISE_WA_HEADER.equals(frame.slice(0, NOISE_WA_HEADER.length))
			? NOISE_WA_HEADER.length
			: 0

	return await decodeBinaryNode(Buffer.from(frame.subarray(offset + 3)))
}

const asNodeArray = (content: BinaryNode['content']): BinaryNode[] => (Array.isArray(content) ? content : [])

jest.unstable_mockModule('../../Socket/Client/websocket', () => ({
	WebSocketClient: mockMakeFakeSocketClient()
}))
jest.unstable_mockModule('../../Socket/Client/tcp', () => ({
	TcpSocketClient: mockMakeFakeSocketClient()
}))

const makeWASocket = (await import('../../Socket')).default
const { initAuthCreds } = await import('../../Utils/auth-utils')

const makeTestLogger = () => {
	const logger: Record<string, any> = {
		level: 'warn',
		child: () => logger,
		trace: jest.fn(),
		debug: jest.fn(),
		info: jest.fn(),
		warn: jest.fn(),
		error: jest.fn(),
		fatal: jest.fn()
	}
	return logger
}

describe('validatePhone socket wiring (B1+B3)', () => {
	beforeEach(() => {
		resetProcessPhoneValidationRateLimiter()
		setPhoneMetadataProvider(createApkCountriesTsvProvider({ tsvContent: BR_TSV + '\n' }))
		canonicalJidMap = null
	})

	afterEach(() => {
		canonicalJidMap = null
	})

	afterAll(() => {
		resetPhoneMetadataProvider()
	})

	it('returns the single WhatsApp-confirmed JID without selecting a nonexistent legacy form', async () => {
		const logger = makeTestLogger()
		const socket = makeWASocket({
			...DEFAULT_CONNECTION_CONFIG,
			auth: { creds: initAuthCreds(), keys: {} },
			fireInitQueries: false,
			instanceId: 'phone-validation-wiring',
			logger
		} as never)

		const result = await socket.validatePhone('558389128418', {
			candidates: ['558389128418', '5583989128418']
		})

		// B1: with per-candidate queries, the result structure includes classificationSource.
		expect(result.normalizedPhone).toBe('558389128418')
		expect(result.acceptedJid).toBe('5583989128418@s.whatsapp.net')
		expect(result.classificationSource).toBeDefined()

		// B1: one USync query per candidate → 2 sentNodes.
		const client = clients.at(-1)
		expect(client?.sentNodes.length).toBeGreaterThanOrEqual(2)
		for (const node of client!.sentNodes) {
			expect(node).toMatchObject({
				tag: 'iq',
				attrs: { type: 'get', xmlns: 'usync' }
			})
		}

		await socket.end(new Error('phone validation wiring test complete'))
	})

	it('limits repeated validation for the same tenant and number', async () => {
		const logger = makeTestLogger()
		const socket = makeWASocket({
			...DEFAULT_CONNECTION_CONFIG,
			auth: { creds: initAuthCreds(), keys: {} },
			fireInitQueries: false,
			instanceId: 'phone-validation-rate-wiring',
			logger
		} as never)

		for (let index = 0; index < 5; index += 1) {
			await expect(socket.validatePhone('551131920164')).resolves.toMatchObject({
				acceptedJid: null
			})
		}

		await expect(socket.validatePhone('551131920164')).rejects.toMatchObject({
			output: {
				statusCode: 429,
				headers: expect.objectContaining({
					'retry-after': '60'
				})
			},
			data: expect.objectContaining({
				code: 'phone_validation_rate_limited'
			})
		})

		await socket.end(new Error('phone validation rate wiring test complete'))
	})

	// S7: Canonical JID — server returns JID with different digits than queried.
	// This is the case for old BR accounts without the 9th digit.
	it('accepts a canonical JID that differs from the queried digits (S7)', async () => {
		// Set up: when querying 5583989128418 (11-digit), server returns
		// 558389128418@s.whatsapp.net (10-digit canonical JID).
		canonicalJidMap = new Map([['5583989128418', '558389128418']])

		const logger = makeTestLogger()
		const socket = makeWASocket({
			...DEFAULT_CONNECTION_CONFIG,
			auth: { creds: initAuthCreds(), keys: {} },
			fireInitQueries: false,
			instanceId: 'canonical-jid-test',
			logger
		} as never)

		const result = await socket.validatePhone('558389128418', {
			candidates: ['558389128418', '5583989128418']
		})

		// The canonical JID is the 10-digit old account JID.
		expect(result.acceptedJid).toBe('558389128418@s.whatsapp.net')

		canonicalJidMap = null
		await socket.end(new Error('canonical JID test complete'))
	})

	// T1+T2: Provider per socket — socket B's custom provider doesn't leak to A.
	it('does not leak provider between sockets (T1+T2)', async () => {
		const logger = makeTestLogger()

		// Socket A: uses the default provider (from beforeEach).
		const socketA = makeWASocket({
			...DEFAULT_CONNECTION_CONFIG,
			auth: { creds: initAuthCreds(), keys: {} },
			fireInitQueries: false,
			instanceId: 'socket-a',
			logger
		} as never)

		// Verify socket A works with legacy-mobile detection.
		const resultA = await socketA.validatePhone('558389128418', {
			candidates: ['558389128418', '5583989128418']
		})
		expect(resultA.classificationSource).toBe('apk-countries-tsv')
		expect(resultA.candidates[0]!.classification).toBe('legacy-mobile')

		// Socket B: custom provider that classifies everything as 'unknown'.
		const customProvider = {
			source: 'custom-unknown',
			classify: () => 'unknown' as const
		}
		const socketB = makeWASocket({
			...DEFAULT_CONNECTION_CONFIG,
			auth: { creds: initAuthCreds(), keys: {} },
			fireInitQueries: false,
			instanceId: 'socket-b',
			phoneMetadataProvider: customProvider,
			logger
		} as never)

		// T2: socket B uses its own provider → classification is 'unknown',
		// and legacy-mobile detection doesn't work (no 9th digit variation).
		const resultB = await socketB.validatePhone('558389128418')
		expect(resultB.classificationSource).toBe('custom-unknown')
		expect(resultB.candidates[0]!.classification).toBe('unknown')

		// With 'unknown' classification, the9th digit variation is skipped,
		// so providing candidates that include the9-digit form should fail.
		await expect(
			socketB.validatePhone('558389128418', { candidates: ['558389128418', '5583989128418'] })
		).rejects.toMatchObject({ output: { statusCode: 400 } })

		// Socket A must NOT be affected by socket B's provider.
		const resultA2 = await socketA.validatePhone('551131920164')
		expect(resultA2.classificationSource).toBe('apk-countries-tsv')
		expect(resultA2.candidates[0]!.classification).toBe('landline')

		await socketA.end(new Error('socket A done'))
		await socketB.end(new Error('socket B done'))
	})

	// S8: 2 sockets with same organizationId share rate limit budget.
	it('shares rate limit between sockets with the same organizationId (S8)', async () => {
		const logger = makeTestLogger()

		const socketA = makeWASocket({
			...DEFAULT_CONNECTION_CONFIG,
			auth: { creds: initAuthCreds(), keys: {} },
			fireInitQueries: false,
			organizationId: 'shared-org',
			instanceId: 'instance-a',
			logger
		} as never)

		const socketB = makeWASocket({
			...DEFAULT_CONNECTION_CONFIG,
			auth: { creds: initAuthCreds(), keys: {} },
			fireInitQueries: false,
			organizationId: 'shared-org',
			instanceId: 'instance-b',
			logger
		} as never)

		// Socket A uses 5 slots.
		for (let i = 0; i < 5; i++) {
			await expect(socketA.validatePhone('551131920164')).resolves.toMatchObject({ acceptedJid: null })
		}

		// Socket B's 6th request should be blocked (shared budget).
		await expect(socketB.validatePhone('551131920164')).rejects.toMatchObject({
			output: { statusCode: 429 },
			data: expect.objectContaining({ code: 'phone_validation_rate_limited' })
		})

		await socketA.end(new Error('socket A done'))
		await socketB.end(new Error('socket B done'))
	})

	// S9: Socket without organizationId/instanceId uses accountJid for tenant key.
	// Two sockets with the same creds.me (same accountJid) share the budget.
	it('uses accountJid as tenant key when organizationId is absent (S9)', async () => {
		const logger = makeTestLogger()
		const credsA = initAuthCreds()
		credsA.me = { id: '5583999999999:0@s.whatsapp.net' } as any

		const credsB = initAuthCreds()
		credsB.me = { id: '5583999999999:0@s.whatsapp.net' } as any

		const socketA = makeWASocket({
			...DEFAULT_CONNECTION_CONFIG,
			auth: { creds: credsA, keys: {} },
			fireInitQueries: false,
			// No organizationId or instanceId → tenant = accountJid.
			logger
		} as never)

		const socketB = makeWASocket({
			...DEFAULT_CONNECTION_CONFIG,
			auth: { creds: credsB, keys: {} },
			fireInitQueries: false,
			// Same accountJid → same tenant.
			logger
		} as never)

		// Socket A uses 5 slots.
		for (let i = 0; i < 5; i++) {
			await expect(socketA.validatePhone('551131920164')).resolves.toMatchObject({ acceptedJid: null })
		}

		// Socket B (same accountJid) should be blocked.
		await expect(socketB.validatePhone('551131920164')).rejects.toMatchObject({
			output: { statusCode: 429 },
			data: expect.objectContaining({ code: 'phone_validation_rate_limited' })
		})

		await socketA.end(new Error('socket A done'))
		await socketB.end(new Error('socket B done'))
		socketA.ev.destroy()
		socketB.ev.destroy()
	})

	// S4+S10: 31 distinct numbers → 429 with scope 'tenant'.
	it('returns scope tenant when the global cap triggers via socket (S4+S10)', async () => {
		const logger = makeTestLogger()
		const socket = makeWASocket({
			...DEFAULT_CONNECTION_CONFIG,
			auth: { creds: initAuthCreds(), keys: {} },
			fireInitQueries: false,
			instanceId: 'global-cap-test',
			logger
		} as never)

		// 30 distinct numbers (the global cap).
		for (let i = 0; i < 30; i++) {
			await expect(socket.validatePhone(`5583${String(i).padStart(7, '0')}`)).resolves.toMatchObject({
				acceptedJid: null
			})
		}

		// The 31st should trigger the global cap.
		await expect(socket.validatePhone('558399999999')).rejects.toMatchObject({
			output: { statusCode: 429 },
			data: expect.objectContaining({
				code: 'phone_validation_rate_limited',
				scope: 'tenant'
			})
		})

		await socket.end(new Error('global cap test complete'))
	})
})
