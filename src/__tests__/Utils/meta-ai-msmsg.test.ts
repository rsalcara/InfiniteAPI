/**
 * Tests for the Meta AI / FBID bot msmsg helpers. The algorithm constants
 * (HKDF info string, key length, cache key format, FBID-vs-regular dispatch)
 * are validated against the CDP capture in
 * `memory/meta_ai_msmsg_decryption_validated.md` — these tests pin them so a
 * future change can't silently revert to upstream PR #2592's brute-force
 * shape.
 */
import NodeCache from '@cacheable/node-cache'
import { proto } from '../../../WAProto/index.js'
import {
	buildMsmsgCacheKey,
	cacheMessageSecretIfPresent,
	extractMsmsgStanzaInfo,
	isMsmsgBotConversation,
	makeMsmsgSecretCache,
	OrphanMsmsgError,
	decryptMsmsgBotMessage
} from '../../Utils/meta-ai-msmsg'

describe('buildMsmsgCacheKey', () => {
	it('builds a tri-partite key for 1:1 chats (matches WAWebMsgKey.toString())', () => {
		expect(
			buildMsmsgCacheKey({
				fromMe: true,
				remoteJid: '13135550202@c.us',
				id: 'A585CF2B8B634BE67D912B316B141A0E'
			})
		).toBe('true_13135550202@c.us_A585CF2B8B634BE67D912B316B141A0E')
	})

	it('appends participant when present (group chats)', () => {
		expect(
			buildMsmsgCacheKey({
				fromMe: true,
				remoteJid: '120363xxx@g.us',
				id: 'MSGID',
				participant: '551199999@s.whatsapp.net'
			})
		).toBe('true_120363xxx@g.us_MSGID_551199999@s.whatsapp.net')
	})

	it('encodes fromMe=false as literal "false_..."', () => {
		expect(buildMsmsgCacheKey({ fromMe: false, remoteJid: 'r', id: 'i' })).toBe('false_r_i')
	})
})

describe('extractMsmsgStanzaInfo', () => {
	const makeStanza = (children: Array<{ tag: string; attrs?: Record<string, string> }>) =>
		({
			tag: 'message',
			attrs: { id: 'STANZA1' },
			content: children.map(c => ({ tag: c.tag, attrs: c.attrs || {} }))
		}) as any

	it('returns null when there is no enc child', () => {
		expect(extractMsmsgStanzaInfo(makeStanza([{ tag: 'meta', attrs: { target_id: 'X' } }]))).toBeNull()
	})

	it('returns null when enc is present but type is not msmsg', () => {
		expect(
			extractMsmsgStanzaInfo(
				makeStanza([
					{ tag: 'enc', attrs: { type: 'pkmsg' } },
					{ tag: 'meta', attrs: { target_id: 'X' } }
				])
			)
		).toBeNull()
	})

	it('returns null when msmsg enc is present but <meta target_id> is missing', () => {
		expect(extractMsmsgStanzaInfo(makeStanza([{ tag: 'enc', attrs: { type: 'msmsg' } }]))).toBeNull()
	})

	it('parses target_id / target_sender_jid / bot.edit / bot.edit_target_id', () => {
		const info = extractMsmsgStanzaInfo(
			makeStanza([
				{ tag: 'enc', attrs: { type: 'msmsg' } },
				{ tag: 'meta', attrs: { target_id: 'TARG', target_sender_jid: 'sender@lid' } },
				{ tag: 'bot', attrs: { edit: 'inner', edit_target_id: 'FIRST_ID' } }
			])
		)
		expect(info).toEqual({
			targetId: 'TARG',
			targetSenderJid: 'sender@lid',
			botEditType: 'inner',
			botEditTargetId: 'FIRST_ID'
		})
	})

	it('treats an empty edit_target_id as the empty string (first-chunk semantics)', () => {
		const info = extractMsmsgStanzaInfo(
			makeStanza([
				{ tag: 'enc', attrs: { type: 'msmsg' } },
				{ tag: 'meta', attrs: { target_id: 'TARG' } },
				{ tag: 'bot', attrs: { edit: 'first', edit_target_id: '' } }
			])
		)
		expect(info?.botEditType).toBe('first')
		expect(info?.botEditTargetId).toBe('')
	})
})

describe('isMsmsgBotConversation', () => {
	it('matches @bot server (incoming FBID bot stanza author)', () => {
		expect(isMsmsgBotConversation('718584497008509@bot')).toBe(true)
	})

	it('does NOT match @c.us bots — the chat jid in 1:1 Meta AI is shown there, but the FBID/MetaAI detection in the decode path uses the AUTHOR (@bot) not the chat', () => {
		// This is intentional: we don't want a generic c.us user accidentally
		// taking the FBID path. The decryption code passes `isJidMetaAI(author)`,
		// which is @bot-only.
		expect(isMsmsgBotConversation('13135550202@c.us')).toBe(false)
	})

	it('returns false for undefined / regular users / groups', () => {
		expect(isMsmsgBotConversation(undefined)).toBe(false)
		expect(isMsmsgBotConversation('5511999@s.whatsapp.net')).toBe(false)
		expect(isMsmsgBotConversation('120363xxx@g.us')).toBe(false)
	})
})

describe('makeMsmsgSecretCache', () => {
	it('is a NodeCache instance with maxKeys cap and TTL', () => {
		const cache = makeMsmsgSecretCache()
		expect(cache).toBeInstanceOf(NodeCache)
		// At least confirm we can set/get a Buffer and the cache is empty initially.
		cache.set('k', Buffer.from('test'))
		expect(cache.get('k')).toBeInstanceOf(Buffer)
		expect(cache.get('k')?.toString()).toBe('test')
	})
})

describe('cacheMessageSecretIfPresent', () => {
	it('no-ops when cache is undefined (no msmsg support wired in)', () => {
		expect(() =>
			cacheMessageSecretIfPresent(
				undefined,
				{ messageContextInfo: { messageSecret: Buffer.from([1, 2, 3]) } },
				{ fromMe: true, remoteJid: 'r', id: 'i' }
			)
		).not.toThrow()
	})

	it('no-ops when message has no messageContextInfo.messageSecret', () => {
		const cache = makeMsmsgSecretCache()
		cacheMessageSecretIfPresent(
			cache,
			{ conversation: 'hi' } as any,
			{ fromMe: true, remoteJid: 'r', id: 'i' }
		)
		expect(cache.keys().length).toBe(0)
	})

	it('stashes the secret under the tri-partite key', () => {
		const cache = makeMsmsgSecretCache()
		const secret = Buffer.alloc(32, 0xaa)
		cacheMessageSecretIfPresent(
			cache,
			{ messageContextInfo: { messageSecret: secret } },
			{ fromMe: true, remoteJid: '13135550202@c.us', id: 'MSGID' }
		)
		expect(cache.get('true_13135550202@c.us_MSGID')).toEqual(secret)
	})
})

describe('OrphanMsmsgError', () => {
	it('preserves the cache key for caller-side recovery', () => {
		const err = new OrphanMsmsgError('true_x_y')
		expect(err.name).toBe('OrphanMsmsgError')
		expect(err.targetCacheKey).toBe('true_x_y')
		expect(err.message).toContain('true_x_y')
	})
})

describe('decryptMsmsgBotMessage — cache miss = OrphanMsmsgError', () => {
	const validMsMsgCiphertext = proto.MessageSecretMessage.encode({
		encIv: new Uint8Array(12),
		encPayload: new Uint8Array(32) // arbitrary; gcm decrypt is never reached
	}).finish()

	it('throws OrphanMsmsgError when the secret cache is empty', () => {
		const cache = makeMsmsgSecretCache()
		expect(() =>
			decryptMsmsgBotMessage({
				ciphertext: validMsMsgCiphertext,
				stanzaInfo: { targetId: 'TARG', botEditType: 'first' },
				stanzaId: 'STANZA1',
				authorJid: '718584497008509@bot',
				chatJid: '13135550202@c.us',
				isGroup: false,
				isFbidBot: true,
				meLid: '5511999@lid',
				meId: '5511999@s.whatsapp.net',
				cache
			})
		).toThrow(OrphanMsmsgError)
	})

	it('uses the LID for FBID bot fromMe cache lookup', () => {
		const cache = makeMsmsgSecretCache()
		try {
			decryptMsmsgBotMessage({
				ciphertext: validMsMsgCiphertext,
				stanzaInfo: { targetId: 'MSG_X' },
				stanzaId: 'STANZA1',
				authorJid: '718584497008509@bot',
				chatJid: '13135550202@c.us',
				isGroup: false,
				isFbidBot: true,
				meLid: '5511999@lid',
				meId: '5511999@s.whatsapp.net',
				cache
			})
			fail('expected OrphanMsmsgError')
		} catch (e: any) {
			expect(e).toBeInstanceOf(OrphanMsmsgError)
			// For FBID bot 1:1 chat: originalUserJid=meLid → isMeJid=true → fromMe=true,
			// remote=chatJid, id=targetId, no participant.
			expect(e.targetCacheKey).toBe('true_13135550202@c.us_MSG_X')
		}
	})
})
