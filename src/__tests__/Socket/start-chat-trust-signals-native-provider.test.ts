import { jest } from '@jest/globals'
import {
	buildStartChatContextIntegrityVariables,
	createStartChatTrustSignalsNativeProvider,
	startChatTrustSignalsStateFromRecord,
	toStartChatTrustSignalsPrivacyToken
} from '../../Socket/start-chat-trust-signals-native-provider'
import type { BinaryNode } from '../../WABinary'

const pn = '5511999999999@s.whatsapp.net'
const lid = '123456@lid'

const createResponseNode = (users: unknown): BinaryNode => ({
	tag: 'iq',
	attrs: {},
	content: [
		{
			tag: 'result',
			attrs: {},
			content: Buffer.from(JSON.stringify({ data: { xwa2_fetch_wa_users: users } }))
		}
	]
})

describe('start-chat trust-signals native provider', () => {
	it('converts a resolver buffer to the GraphQL token and never synthesizes one', () => {
		expect(toStartChatTrustSignalsPrivacyToken({ buffer: Buffer.from([7, 8, 9]), timestamp: '1786000000000' })).toEqual(
			{ token: Buffer.from([7, 8, 9]), timestamp: '1786000000000' }
		)
		expect(toStartChatTrustSignalsPrivacyToken({ buffer: Buffer.alloc(0), timestamp: '1' })).toBeUndefined()
		expect(toStartChatTrustSignalsPrivacyToken({})).toBeUndefined()
	})

	it('reuses a durable observation while preserving absent booleans', () => {
		const base = { jid: '5511999999999@s.whatsapp.net', observedAt: 2_000 }
		expect(
			startChatTrustSignalsStateFromRecord(
				{ jid: '123456@lid', isSenderNewAccount: false, isSenderSuspicious: true, observedAt: 1_000 },
				base
			)
		).toEqual({
			jid: base.jid,
			useCase: 'CHAT_FMX',
			status: 'known',
			observedAt: base.observedAt,
			signals: { isSenderNewAccount: false, isSenderSuspicious: true, createdTs: 1_000 }
		})
		expect(startChatTrustSignalsStateFromRecord({ jid: '123456@lid', observedAt: 3_000 }, base).signals).toEqual({
			createdTs: 3_000
		})
	})

	it('builds the exact Android CHAT_FMX variable envelope', () => {
		expect(
			buildStartChatContextIntegrityVariables({
				jid: pn,
				privacyToken: { token: Buffer.from([1, 2, 3]), timestamp: 1_786_000_000_000 }
			})
		).toEqual({
			input: {
				query_input: [
					{
						jid: pn,
						integrity_signals: { dhash: null, use_case: 'CHAT_FMX' },
						privacy_token: {
							tctoken: Buffer.from([1, 2, 3]).toString('base64'),
							timestamp: '1786000000000'
						}
					}
				],
				telemetry: { context: 'INTERACTIVE' }
			}
		})
	})

	it('preserves a received token with absent timestamp metadata', () => {
		expect(
			buildStartChatContextIntegrityVariables({
				jid: pn,
				privacyToken: { token: Buffer.from([1, 2, 3]) }
			})
		).toEqual({
			input: {
				query_input: [
					{
						jid: pn,
						integrity_signals: { dhash: null, use_case: 'CHAT_FMX' },
						privacy_token: { tctoken: Buffer.from([1, 2, 3]).toString('base64') }
					}
				],
				telemetry: { context: 'INTERACTIVE' }
			}
		})
	})

	it('omits privacy_token when no received token exists', async () => {
		let variables: unknown
		let queryNode: BinaryNode | undefined
		const provider = createStartChatTrustSignalsNativeProvider({
			query: async node => {
				queryNode = node
				const queryChild = node.content?.[0] as BinaryNode
				variables = JSON.parse(queryChild.content!.toString())
				return createResponseNode([
					{
						jid: pn,
						integrity_signals_info: { is_new_account: true, is_suspicious_start_chat: false }
					}
				])
			},
			generateMessageTag: () => 'native-tag'
		})

		await expect(provider({ jid: pn, useCase: 'CHAT_FMX' })).resolves.toEqual({
			isSenderNewAccount: true,
			isSenderSuspicious: false,
			createdTs: expect.any(Number)
		})

		expect(queryNode?.tag).toBe('iq')
		expect(queryNode?.attrs).toMatchObject({ to: '@s.whatsapp.net', type: 'get', xmlns: 'w:mex' })
		expect(queryNode?.content?.[0]).toMatchObject({
			tag: 'query',
			attrs: { query_id: '26204539559207163' }
		})
		expect(variables).not.toHaveProperty('input.query_input[0].privacy_token')
	})

	it('lets the resolver use the freshly resolved PN alias without fabricating a timestamp', async () => {
		let variables: unknown
		const resolver = jest.fn(async ({ jid, pnJid }: { jid: string; pnJid?: string }) => {
			expect(jid).toBe(lid)
			expect(pnJid).toBe(pn)
			return { token: Buffer.from([4, 5, 6]) }
		})
		const provider = createStartChatTrustSignalsNativeProvider({
			query: async node => {
				variables = JSON.parse((node.content?.[0] as BinaryNode).content!.toString())
				return createResponseNode([
					{
						jid: lid,
						integrity_signals_info: { is_new_account: true, is_suspicious_start_chat: false }
					}
				])
			},
			generateMessageTag: () => 'native-tag',
			resolvePrivacyToken: resolver
		})

		await expect(provider({ jid: lid, pnJid: pn, useCase: 'CHAT_FMX' })).resolves.toEqual({
			isSenderNewAccount: true,
			isSenderSuspicious: false,
			createdTs: expect.any(Number)
		})
		expect(resolver).toHaveBeenCalledTimes(1)
		expect(variables).toMatchObject({
			variables: {
				input: {
					query_input: [
						{
							jid: lid,
							privacy_token: { tctoken: Buffer.from([4, 5, 6]).toString('base64') }
						}
					]
				}
			}
		})
	})

	it('only selects the response user whose JID exactly matches the request', async () => {
		const provider = createStartChatTrustSignalsNativeProvider({
			query: async () =>
				createResponseNode([
					{
						jid: '571000000000@s.whatsapp.net',
						integrity_signals_info: { is_new_account: false, is_suspicious_start_chat: false }
					}
				]),
			generateMessageTag: () => 'native-tag'
		})

		await expect(provider({ jid: pn, useCase: 'CHAT_FMX' })).rejects.toThrow('no valid fields')
	})

	it('accepts a partial official response and preserves absent booleans as absent', async () => {
		const provider = createStartChatTrustSignalsNativeProvider({
			query: async () =>
				createResponseNode([
					{
						jid: pn,
						integrity_signals_info: { is_new_account: false, is_suspicious_start_chat: undefined }
					}
				]),
			generateMessageTag: () => 'native-tag'
		})

		await expect(provider({ jid: pn, useCase: 'CHAT_FMX' })).resolves.toEqual({
			isSenderNewAccount: false,
			createdTs: expect.any(Number)
		})
	})

	it('rejects an aborted request before dispatch', async () => {
		const controller = new AbortController()
		controller.abort()
		const query = jest.fn()
		const provider = createStartChatTrustSignalsNativeProvider({
			query: query as unknown as (node: BinaryNode) => Promise<BinaryNode>,
			generateMessageTag: () => 'native-tag'
		})

		await expect(provider({ jid: pn, useCase: 'CHAT_FMX', signal: controller.signal })).rejects.toThrow(
			'aborted before dispatch'
		)
		expect(query).not.toHaveBeenCalled()
	})

	it('rejects after privacy-token resolution when the deadline aborted the request', async () => {
		const controller = new AbortController()
		const query = jest.fn()
		const provider = createStartChatTrustSignalsNativeProvider({
			query: query as unknown as (node: BinaryNode) => Promise<BinaryNode>,
			generateMessageTag: () => 'native-tag',
			resolvePrivacyToken: async () => {
				controller.abort()
				return { token: Buffer.from([1]) }
			}
		})

		await expect(provider({ jid: pn, useCase: 'CHAT_FMX', signal: controller.signal })).rejects.toThrow(
			'aborted after privacy-token resolution'
		)
		expect(query).not.toHaveBeenCalled()
	})
})
