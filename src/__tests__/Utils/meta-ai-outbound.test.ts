import { proto } from '../../../WAProto/index.js'
import { hkdf } from '../../Utils/crypto'
import {
	buildMetaAiPromptContext,
	buildMetaAiSendResult,
	META_AI_PUBLIC_ALIAS,
	normalizeMetaAiSendRequest,
	resolveMetaAiPrompt,
	toPublicMetaAiDestination
} from '../../Utils/meta-ai-outbound'

const BOT_JID = '718584497008509@bot'

describe('resolveMetaAiPrompt', () => {
	it('resolves a direct FBID bot destination', () => {
		expect(resolveMetaAiPrompt(BOT_JID, undefined)).toEqual({
			resolvedBotJid: BOT_JID
		})
	})

	it('keeps the concrete transport JID behind the public alias', () => {
		expect(resolveMetaAiPrompt(META_AI_PUBLIC_ALIAS, undefined)).toEqual({
			resolvedBotJid: BOT_JID
		})
		expect(
			normalizeMetaAiSendRequest({
				to: META_AI_PUBLIC_ALIAS,
				text: 'Who are you?'
			}).to
		).toBe(BOT_JID)
		expect(
			normalizeMetaAiSendRequest({
				to: META_AI_PUBLIC_ALIAS,
				text: 'Continue the previous answer',
				threadId: 'existing-thread'
			}).options.type
		).toBe('text_input')
		expect(
			normalizeMetaAiSendRequest({
				to: META_AI_PUBLIC_ALIAS,
				text: 'Continue the previous answer',
				thread: { id: 'existing-thread' }
			}).options.type
		).toBe('text_input')
	})

	it('masks only the official Meta AI transport identity', () => {
		expect(toPublicMetaAiDestination('718584497008509@bot')).toBe(META_AI_PUBLIC_ALIAS)
		expect(toPublicMetaAiDestination('718584497008509:2@bot')).toBe(META_AI_PUBLIC_ALIAS)
		expect(toPublicMetaAiDestination('999999999999@bot')).toBe('999999999999@bot')
		expect(toPublicMetaAiDestination('5511999999999@s.whatsapp.net')).toBe('5511999999999@s.whatsapp.net')
		// Same user, different server: pins the `server === 'bot'` half of the
		// identity check. Without these, dropping that half passes the suite.
		expect(toPublicMetaAiDestination('718584497008509@s.whatsapp.net')).toBe('718584497008509@s.whatsapp.net')
		expect(toPublicMetaAiDestination('718584497008509@lid')).toBe('718584497008509@lid')
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

	it('rejects an arbitrary botJid for a legacy bot destination', () => {
		expect(() =>
			resolveMetaAiPrompt('13135550002@c.us', {
				botJid: 'evil@s.whatsapp.net'
			})
		).toThrow('botJid')
	})

	it('accepts a matching legacy botJid', () => {
		expect(
			resolveMetaAiPrompt('13135550002@c.us', {
				botJid: '13135550002@c.us'
			})
		).toMatchObject({
			botJid: '13135550002@c.us',
			resolvedBotJid: '13135550002@c.us'
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

	it('uses the group invocation entry point for group prompts by default', () => {
		const context = buildMetaAiPromptContext(
			'120363012345678900@g.us',
			{
				botJid: BOT_JID
			},
			'5511000000000@c.us'
		)
		expect(context.botMetadata.botMetricsMetadata?.destinationEntryPoint).toBe(
			proto.BotMetricsEntryPoint.INVOKE_META_AI_GROUP
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

describe('public Meta AI send contract', () => {
	it('normalizes a direct prompt and the simple thread shortcut', () => {
		expect(
			normalizeMetaAiSendRequest({
				to: META_AI_PUBLIC_ALIAS,
				text: 'Who are you?',
				type: 'request_welcome'
			})
		).toEqual({
			to: BOT_JID,
			text: 'Who are you?',
			options: { type: 'request_welcome' }
		})

		expect(
			normalizeMetaAiSendRequest({
				to: BOT_JID,
				text: 'Who are you?',
				type: 'request_welcome'
			})
		).toEqual({
			to: BOT_JID,
			text: 'Who are you?',
			options: { type: 'request_welcome' }
		})

		expect(
			normalizeMetaAiSendRequest({
				to: BOT_JID,
				text: 'Continue',
				type: 'prompt',
				threadId: 'thread-id'
			}).options
		).toEqual({
			type: 'prompt',
			thread: { id: 'thread-id' }
		})
	})

	it('treats a blank thread id the same in both spellings', () => {
		expect(
			normalizeMetaAiSendRequest({
				to: META_AI_PUBLIC_ALIAS,
				text: 'x',
				threadId: '   '
			}).options
		).toEqual({})

		expect(
			normalizeMetaAiSendRequest({
				to: META_AI_PUBLIC_ALIAS,
				text: 'x',
				thread: { id: '   ' }
			}).options
		).toEqual({})
	})

	it('preserves legitimate thread fields when only the id is blank', () => {
		// This pins the middle arm of the normalizedThread ternary. Without it,
		// collapsing that arm to `undefined` passes the suite while silently
		// downgrading a side_chat prompt to a default thread — and disabling the
		// sourceChatJid validation that exists to catch exactly that.
		const options = normalizeMetaAiSendRequest({
			to: META_AI_PUBLIC_ALIAS,
			text: 'x',
			thread: { id: '   ', type: 'side_chat', sourceChatJid: '5511999999999@s.whatsapp.net' }
		}).options

		expect(options.thread).toMatchObject({
			type: 'side_chat',
			sourceChatJid: '5511999999999@s.whatsapp.net'
		})
		expect(options.thread?.id).toBeUndefined()
		// No id means no continuation, so no text_input default either.
		expect(options.type).toBeUndefined()
	})

	it('preserves thread fields when the thread has no id key at all', () => {
		const options = normalizeMetaAiSendRequest({
			to: META_AI_PUBLIC_ALIAS,
			text: 'x',
			thread: { type: 'side_chat', sourceChatJid: '5511999999999@s.whatsapp.net' }
		}).options

		expect(options.thread).toMatchObject({ type: 'side_chat' })
	})

	it('keeps advanced protocol fields available to SDK consumers', () => {
		const group = '120363012345678900@g.us'
		expect(
			normalizeMetaAiSendRequest({
				to: group,
				text: 'Prompt in group',
				type: 'prompt',
				botJid: BOT_JID,
				entryPoint: 'context_menu'
			}).options
		).toEqual({
			type: 'prompt',
			botJid: BOT_JID,
			entryPoint: 'context_menu'
		})
	})

	it('rejects destinations that would send an ordinary WhatsApp message', () => {
		expect(() =>
			normalizeMetaAiSendRequest({
				to: '5511999999999@s.whatsapp.net',
				text: 'ordinary message'
			})
		).toThrow('direct @bot')
	})

	it('rejects conflicting thread identifiers', () => {
		expect(() =>
			normalizeMetaAiSendRequest({
				to: BOT_JID,
				text: 'Continue',
				threadId: 'shortcut-id',
				thread: { id: 'nested-id' }
			})
		).toThrow('threadId')
	})

	it('maps the prepared protocol metadata to a stable consumer result', () => {
		expect(
			buildMetaAiSendResult(
				{
					key: {
						id: 'MESSAGE-ID',
						remoteJid: BOT_JID
					}
				},
				{
					botJid: BOT_JID,
					clientThreadId: 'thread-id',
					type: 'request_welcome',
					threadType: 'default',
					createdNewThread: true
				}
			)
		).toEqual({
			messageId: 'MESSAGE-ID',
			chatJid: META_AI_PUBLIC_ALIAS,
			botJid: META_AI_PUBLIC_ALIAS,
			type: 'request_welcome',
			threadId: 'thread-id',
			threadType: 'default',
			createdNewThread: true
		})
	})

	it('rejects metadata that would produce an empty public bot identity', () => {
		expect(() =>
			buildMetaAiSendResult(
				{ key: { id: 'MESSAGE-ID', remoteJid: BOT_JID } },
				{
					botJid: '',
					clientThreadId: 'thread-id',
					type: 'request_welcome',
					threadType: 'default',
					createdNewThread: true
				}
			)
		).toThrow('metadata is incomplete')
	})
})
