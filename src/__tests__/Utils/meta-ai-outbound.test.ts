import { proto } from '../../../WAProto/index.js'
import { hkdf } from '../../Utils/crypto'
import { buildMetaAiPromptContext, resolveMetaAiPrompt } from '../../Utils/meta-ai-outbound'

const BOT_JID = '718584497008509@bot'

describe('resolveMetaAiPrompt', () => {
	it('resolves a direct FBID bot destination', () => {
		expect(resolveMetaAiPrompt(BOT_JID, undefined)).toEqual({
			resolvedBotJid: BOT_JID
		})
	})

	it('does not treat an ordinary @c.us contact as Meta AI', () => {
		expect(resolveMetaAiPrompt('5511999999999@c.us', undefined)).toBeUndefined()
		expect(resolveMetaAiPrompt('5511999999999@c.us', { botJid: BOT_JID })).toBeUndefined()
	})

	it('requires an explicit @bot destination for a group prompt', () => {
		const group = '120363012345678900@g.us'
		expect(resolveMetaAiPrompt(group, undefined)).toBeUndefined()
		expect(resolveMetaAiPrompt(group, { botJid: BOT_JID })).toEqual({
			botJid: BOT_JID,
			resolvedBotJid: BOT_JID
		})
	})
})

describe('buildMetaAiPromptContext', () => {
	it('creates a native thread, bot metadata and the Android wire secret', () => {
		const messageSecret = Buffer.alloc(32, 7)
		const context = buildMetaAiPromptContext(
			BOT_JID,
			{
				type: 'prompt',
				thread: { id: 'thread-id' }
			},
			'5511000000000@c.us',
			messageSecret
		)

		expect(context.botNode).toEqual({
			attrs: {
				type: 'prompt',
				client_thread_id: 'thread-id'
			}
		})
		expect(context.metadata).toMatchObject({
			botJid: BOT_JID,
			clientThreadId: 'thread-id',
			type: 'prompt',
			threadType: 'default',
			createdNewThread: false
		})
		expect(context.messageSecret).toEqual(messageSecret)
		expect(context.botMessageSecret).toEqual(Buffer.from(hkdf(messageSecret, 32, { info: 'Bot Message' })))
		expect(context.botMetadata.invokerJid).toBe('5511000000000@c.us')
		expect(context.botMetadata.botMetricsMetadata?.destinationId).toBe(BOT_JID)
	})

	it('defaults thread id/type and marks a new thread', () => {
		const context = buildMetaAiPromptContext(BOT_JID, undefined, '5511000000000@c.us')
		expect(context.metadata.clientThreadId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i)
		expect(context.metadata.createdNewThread).toBe(true)
		expect(context.botMetadata.botThreadInfo?.clientInfo?.type).toBe(
			proto.AIThreadInfo.AIThreadClientInfo.AIThreadType.DEFAULT
		)
	})

	it('rejects a side-chat thread without its source chat', () => {
		expect(() =>
			buildMetaAiPromptContext(
				BOT_JID,
				{
					thread: { type: 'side_chat' }
				},
				'5511000000000@c.us'
			)
		).toThrow('sourceChatJid')
	})
})
