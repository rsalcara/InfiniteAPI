/**
 * Meta AI / FBID bot message decryption (`<enc type="msmsg">`).
 *
 * The algorithm here was reverse-engineered from WhatsApp Web's
 * `WAWebBotMessageSecret` module and validated empirically via CDP capture
 * (Chrome --remote-debugging-port=9223 + WA Web + Meta AI "oi", 2026-06-07).
 * See `memory/meta_ai_msmsg_decryption_validated.md` for the raw capture and
 * step-by-step derivation.
 *
 * Why not just port upstream PR #2592:
 *   - PR brute-forces 12 HKDF strategies (author didn't decode the algorithm
 *     deterministically). WA Web uses exactly ONE recipe per (FBID, edit-type)
 *     combination.
 *   - PR has an unbounded module-global `Map` for the secret cache (cubic P1,
 *     coderabbit Major). Multiple sockets in the same Node process share secrets
 *     across tenants — leaks cross-account.
 *   - PR drops `botType ∉ {'full', 'last'}`, missing 7 of 8 chunks in a real
 *     Meta AI streaming response (captured: `first` → 6× `inner` → `last`).
 *   - PR's cache key is the raw msgId, colliding across chats. Real key is
 *     `${fromMe}_${remoteJid}_${id}` (mirrors WAWebMsgKey.toString()).
 *
 * What this module provides:
 *   - `extractMsmsgStanzaInfo(stanza)`: pull target_id / target_sender_jid /
 *     edit / edit_target_id out of the `<meta>` and `<bot>` child nodes.
 *   - `makeMsmsgSecretCache()`: per-socket bounded LRU cache (NodeCache,
 *     maxKeys=500, ttl=1h). Caller clears on socket close.
 *   - `buildMsmsgCacheKey(...)`: tri-partite key matching WAWebMsgKey format.
 *   - `decryptMsmsgBotMessage(...)`: 2-step HKDF + AES-GCM, ONE strategy per
 *     case (FBID with `inner`/`last` → use `botEditTargetId` as the HKDF
 *     stanzaId; otherwise use the enc-node's own stanzaId).
 *   - `cacheMessageSecretIfPresent(...)`: scan a decrypted `IMessage` for
 *     `messageContextInfo.messageSecret` and stash it into the cache. Called
 *     after EVERY successful decryption so subsequent bot replies referencing
 *     this msg's id can find the secret.
 *
 * Outside the scope of this module:
 *   - Plumbing into `decryptMessageNode` (Utils/decode-wa-message.ts) — that
 *     adds a `case 'msmsg'` branch and calls into `decryptMsmsgBotMessage`.
 *   - Removing the early-return NACK in `messages-recv.ts` — done in the same PR.
 */

import NodeCache from '@cacheable/node-cache'
import { proto } from '../../WAProto/index.js'
import { DEFAULT_CACHE_MAX_KEYS, DEFAULT_CACHE_TTLS } from '../Defaults'
import type { BinaryNode } from '../WABinary'
import { isJidGroup, isJidMetaAI, jidDecode, jidNormalizedUser } from '../WABinary/jid-utils'
import { isNodeCacheFullError } from './cache-utils'
import { aesDecryptGCM, hkdf } from './crypto'
import { compactError } from './error-log-utils'
import { unpadRandomMax16 } from './generics'
import type { ILogger } from './logger'

/**
 * HKDF info string used for the first derivation step.
 *
 * Confirmed via CDP extraction of `WAWebBotMessageSecret`:
 *   `var u=32, c="Bot Message"`
 */
const BOT_MESSAGE_INFO = 'Bot Message'

/**
 * Key length for both HKDF derivations and AES-256-GCM. WA Web uses 32 bytes
 * (`var u=32`).
 */
const KEY_LENGTH = 32

/**
 * Edit-type values seen on `<bot edit="...">` for Meta AI streaming responses.
 * Confirmed via CDP capture:
 *   call 1: edit="first" edit_target_id=""              (initial chunk)
 *   calls 2-7: edit="inner" edit_target_id=<first.id>   (streaming updates)
 *   call 8: edit="last"  edit_target_id=<first.id>      (final chunk)
 *
 * `full` is also documented in `WAWebBotTypes.BotMsgEditType` for non-streaming
 * single-shot replies (not seen in the "oi" capture but kept for compat).
 */
export type MsmsgBotEditType = 'first' | 'inner' | 'last' | 'full' | undefined

/**
 * Parsed view of the metadata children of an incoming msmsg stanza.
 * Mirrors `WAWebHandleMsgParser.S(e)` output for the `<bot>` node plus the
 * `target_*` attrs of the `<meta>` node.
 */
export interface MsmsgStanzaInfo {
	/** From `<meta target_id="...">`. Identifies the OUTGOING msg whose
	 *  messageSecret decrypts this incoming msmsg. Required. */
	targetId?: string
	/** From `<meta target_sender_jid="...">`. Identifies who created the
	 *  secret. Often absent — defaults to me when absent. */
	targetSenderJid?: string
	/** From `<bot edit="...">`. Drives the choice of stanzaId for HKDF
	 *  derivation in the FBID-bot path. */
	botEditType?: MsmsgBotEditType
	/** From `<bot edit_target_id="...">`. For `inner`/`last` chunks in a
	 *  streaming response, this is the id of the `first` chunk and becomes the
	 *  HKDF stanzaId so all chunks derive the same key. Empty on `first`. */
	botEditTargetId?: string
}

/**
 * Per-socket bounded TTL cache of (cacheKey → messageSecret bytes). Capped at
 * `DEFAULT_CACHE_MAX_KEYS.MSMSG_SECRET` (500) and TTLed at
 * `DEFAULT_CACHE_TTLS.MSMSG_SECRET` (1h).
 *
 * NOT an LRU — `@cacheable/node-cache` v2.x raises `ECACHEFULL` on `.set()`
 * once `maxKeys` is reached rather than evicting the oldest entry. Caller-side
 * writes are guarded with `isNodeCacheFullError` so a saturated cache logs at
 * debug and drops the write instead of crashing the decrypt path.
 *
 * The caller MUST `flushAll()` AND `close()` on socket end (see
 * `registerSocketEndHandler` in `messages-recv.ts`) to mirror WA Web's
 * `BackendEventBus.onLogout` behaviour AND to stop the NodeCache `setInterval`
 * timer, avoiding a per-reconnect timer leak across long-running processes.
 */
export type MsmsgSecretCache = NodeCache<Buffer>

export const makeMsmsgSecretCache = (): MsmsgSecretCache =>
	new NodeCache<Buffer>({
		stdTTL: DEFAULT_CACHE_TTLS.MSMSG_SECRET,
		maxKeys: DEFAULT_CACHE_MAX_KEYS.MSMSG_SECRET,
		useClones: false
	})

/**
 * Pull the meta/bot metadata out of a `<message>` stanza's children. Returns
 * `null` if the stanza has no msmsg enc child or no `target_id` — the latter
 * is required by the WA Web decryption code path.
 */
export const extractMsmsgStanzaInfo = (stanza: BinaryNode): MsmsgStanzaInfo | null => {
	if (!Array.isArray(stanza.content)) return null

	let hasMsmsgEnc = false
	const info: MsmsgStanzaInfo = {}

	for (const child of stanza.content) {
		const attrs = child.attrs as Record<string, string> | undefined
		switch (child.tag) {
			case 'enc':
				if (attrs?.type === 'msmsg') hasMsmsgEnc = true
				break
			case 'meta':
				if (attrs?.target_id) info.targetId = attrs.target_id
				if (attrs?.target_sender_jid) info.targetSenderJid = attrs.target_sender_jid
				break
			case 'bot':
				if (attrs && 'edit_target_id' in attrs) info.botEditTargetId = attrs.edit_target_id
				if (attrs?.edit) info.botEditType = attrs.edit as MsmsgBotEditType
				break
		}
	}

	if (!hasMsmsgEnc || !info.targetId) return null
	return info
}

/**
 * Build the cache key that locates a messageSecret by (sender, chat, msg id).
 *
 * Format matches WAWebMsgKey.toString(): `${fromMe}_${remote}_${id}` and for
 * group conversations `${fromMe}_${remote}_${id}_${participant}`.
 *
 * The defaults capture the common case (the secret was stored when WE sent
 * the original message to the bot): `fromMe=true`, `remote=conversation chat`,
 * `id=msgMeta.targetId`. For group chats with FBID bots WA Web pushes the LID
 * through `toPn()` before using it as the participant — we mirror that via
 * `lidToPn`, with a fallback to the raw LID when the mapping is absent so the
 * key still has SOME participant component.
 */
export const buildMsmsgCacheKey = (params: {
	fromMe: boolean
	remoteJid: string
	id: string
	participant?: string
}): string => {
	const { fromMe, remoteJid, id, participant } = params
	const base = `${fromMe}_${remoteJid}_${id}`
	return participant ? `${base}_${participant}` : base
}

/**
 * Cache the `messageContextInfo.messageSecret` (if present) on a freshly
 * decrypted message. Called from `decryptMessageNode` after every successful
 * decode — covers both messages we received (cache entry for OUR follow-up
 * bot replies) and messages we sent that were echoed back via deviceSentMessage.
 *
 * `cache.set` raises `ECACHEFULL` once `MSMSG_SECRET` (500) is reached. The
 * guard distinguishes that case (debug-log + drop the write — losing one
 * cache entry just means the next bot reply for the same id will raise
 * `OrphanMsmsgError`, which is operationally recoverable) from every other
 * exception (re-thrown — those are bugs we want surfaced).
 */
export const cacheMessageSecretIfPresent = (
	cache: MsmsgSecretCache | undefined,
	msg: proto.IMessage,
	msgKey: { fromMe?: boolean | null; remoteJid?: string | null; id?: string | null; participant?: string | null },
	logger?: ILogger
): void => {
	if (!cache) return
	const secret = msg.messageContextInfo?.messageSecret
	if (!secret || !msgKey.remoteJid || !msgKey.id) return

	const cacheKey = buildMsmsgCacheKey({
		fromMe: !!msgKey.fromMe,
		remoteJid: msgKey.remoteJid,
		id: msgKey.id,
		participant: msgKey.participant ?? undefined
	})

	const buf = Buffer.isBuffer(secret) ? secret : Buffer.from(secret as Uint8Array)
	try {
		cache.set(cacheKey, buf)
	} catch (err) {
		if (!isNodeCacheFullError(err)) throw err
		logger?.debug(
			{ cacheKey, msmsgCacheSize: cache.keys().length },
			'msmsg secret cache full (ECACHEFULL), dropping write'
		)
	}
}

/**
 * Strip device suffix from a JID (e.g. `123:5@lid` → `123@lid`). Mirrors
 * WA Web's `widToUserJid` which produces the form used for HKDF info bytes
 * and the AAD.
 */
const userOnlyJid = (jid: string | undefined): string => {
	if (!jid) return ''
	return jidNormalizedUser(jid) || jid
}

/**
 * Inputs to `decryptMsmsgBotMessage`. The caller (Utils/decode-wa-message.ts)
 * builds this from the stanza + repository + the just-extracted MsmsgStanzaInfo.
 */
export interface DecryptMsmsgInput {
	/** The MessageSecretMessage protobuf bytes (the `<enc type="msmsg">` content). */
	ciphertext: Uint8Array
	/** Parsed metadata children of the stanza. */
	stanzaInfo: MsmsgStanzaInfo
	/** Stanza's own `id` attr — this msg's externalId. */
	stanzaId: string
	/** Stanza's `from` (or `participant` for groups) — the BOT. */
	authorJid: string
	/** The chat this msg belongs to (remoteJid). */
	chatJid: string
	/** Whether the chat is a group. */
	isGroup: boolean
	/** Whether the bot author is on the `@bot` server (Meta AI / other FBID
	 *  bots). Drives which `me` JID is used as `originalUserJid` fallback. */
	isFbidBot: boolean
	/** Our own LID (`<num>@lid`). Used as default `originalUserJid` for FBID
	 *  bots when `targetSenderJid` is absent. */
	meLid: string
	/** Our own PN JID (`<num>@s.whatsapp.net`). Used as default
	 *  `originalUserJid` for non-FBID bots. */
	meId: string
	/** Per-socket secret cache. */
	cache: MsmsgSecretCache
	/** Optional logger for trace-level details. */
	logger?: ILogger
	/** Optional LID→PN mapping function for FBID bots in group chats. The
	 *  cache lookup uses the participant in PN form there (mirrors
	 *  `LidMigrationUtils.toPn` in WA Web). If absent or returns falsy, the
	 *  raw LID is used as a fallback. */
	lidToPn?: (lidJid: string) => string | undefined
}

/**
 * The dedicated error thrown when neither the cache nor any fallback yields a
 * messageSecret. Callers may catch this and NACK the stanza with
 * `MissingMessageSecret` (487-equivalent) instead of letting it crash the
 * message-handle path. Mirrors `WAWebOrphanBotMsgError`.
 */
export class OrphanMsmsgError extends Error {
	readonly targetCacheKey: string
	constructor(targetCacheKey: string) {
		super(`decryptMsmsgBotMessage: no messageSecret for ${targetCacheKey}`)
		this.name = 'OrphanMsmsgError'
		this.targetCacheKey = targetCacheKey
	}
}

const INNER_OR_LAST: ReadonlySet<MsmsgBotEditType> = new Set<MsmsgBotEditType>(['inner', 'last'])

/**
 * Decrypt one `<enc type="msmsg">` payload.
 *
 * Algorithm summary (full derivation in `meta_ai_msmsg_decryption_validated.md`):
 *
 *   1. Resolve `originalUserJid`:
 *        FBID bot     → targetSenderJid || meLid    (then normalize → strip device)
 *        non-FBID bot → targetSenderJid || meId     (then normalize)
 *
 *   2. Resolve `senderJid`:
 *        widToUserJid(authorJid) — strip device suffix from bot jid
 *
 *   3. Resolve `hkdfStanzaId` (drives both HKDF info and AAD):
 *        FBID + edit ∈ {inner, last} + botEditTargetId present → botEditTargetId
 *        otherwise (FBID first/full, or any non-FBID first attempt)            → stanzaId
 *
 *   4. Lookup messageSecret in the per-socket cache via
 *        WAWebMsgKey-shaped key (fromMe_remote_id [_participant]).
 *      Fallback to `OrphanMsmsgError` (caller decides NACK strategy).
 *
 *   5. Two-step HKDF:
 *        baseSecret   = HKDF(messageSecret, info="Bot Message", L=32)
 *        infoBytes    = utf8(hkdfStanzaId) || utf8(originalUserJid) || utf8(senderJid)
 *        decryptionKey = HKDF(baseSecret, info=infoBytes, L=32)
 *
 *   6. AES-256-GCM decrypt with AAD = utf8(hkdfStanzaId) || 0x00 || utf8(senderJid).
 *      The ciphertext layout matches our existing `aesDecryptGCM` helper
 *      (auth tag is the trailing 16 bytes of encPayload).
 *
 *   7. For non-FBID bots only, one retry with `hkdfStanzaId = botEditTargetId`
 *      if the first attempt fails. WA Web does this same try/catch only on
 *      the non-FBID path; on FBID it picks the right id deterministically
 *      based on `botEditType` and doesn't retry.
 *
 * Returns the decoded `Message` protobuf. The caller is responsible for
 * applying `unpadRandomMax16` semantics and walking `deviceSentMessage`.
 */
export const decryptMsmsgBotMessage = (input: DecryptMsmsgInput): proto.IMessage => {
	const {
		ciphertext,
		stanzaInfo,
		stanzaId,
		authorJid,
		chatJid,
		isGroup,
		isFbidBot,
		meLid,
		meId,
		cache,
		logger,
		lidToPn
	} = input

	if (!stanzaInfo.targetId) {
		throw new Error('decryptMsmsgBotMessage: missing meta.target_id')
	}

	const msMsg = proto.MessageSecretMessage.decode(ciphertext)
	if (!msMsg.encIv || !msMsg.encPayload) {
		throw new Error('decryptMsmsgBotMessage: MessageSecretMessage missing encIv/encPayload')
	}

	// Step 1 — originalUserJid: who created the secret. For FBID bots this is
	// us-as-LID by default; for non-FBID it's us-as-PN. `targetSenderJid` (when
	// the server included it on the stanza) overrides.
	const rawOriginalUserJid = stanzaInfo.targetSenderJid || (isFbidBot ? meLid : meId)
	const originalUserJid = userOnlyJid(rawOriginalUserJid)

	// Step 2 — senderJid: the bot's user-only jid (no device).
	const senderJid = userOnlyJid(authorJid)

	// Step 3 — cache lookup. For FBID bots in groups, the participant in the
	// cache key was stored in PN form (WAWebLidMigrationUtils.toPn).
	let participantForKey: string | undefined
	if (isGroup) {
		if (isFbidBot) {
			participantForKey = lidToPn?.(originalUserJid) || originalUserJid
		} else {
			participantForKey = originalUserJid
		}
	}

	const fromMeForKey = isMeJid(originalUserJid, meId, meLid)
	const cacheKey = buildMsmsgCacheKey({
		fromMe: fromMeForKey,
		remoteJid: chatJid,
		id: stanzaInfo.targetId,
		participant: participantForKey
	})

	const messageSecret = cache.get(cacheKey)
	if (!messageSecret) throw new OrphanMsmsgError(cacheKey)

	// Step 4 — hkdfStanzaId selection. The FBID streaming chain anchors all
	// chunks to the first chunk's id when botEditType is inner/last.
	const useEditTargetForHkdf =
		isFbidBot && INNER_OR_LAST.has(stanzaInfo.botEditType) && !!stanzaInfo.botEditTargetId

	const primaryHkdfStanzaId =
		useEditTargetForHkdf ? (stanzaInfo.botEditTargetId as string) : stanzaId

	// Step 5+6 — derive the AES key and decrypt. Wrapped so we can retry with
	// `botEditTargetId` for the non-FBID path (matches WA Web's f() try/catch).
	try {
		const plaintext = deriveKeyAndDecrypt({
			messageSecret,
			hkdfStanzaId: primaryHkdfStanzaId,
			originalUserJid,
			senderJid,
			encIv: msMsg.encIv,
			encPayload: msMsg.encPayload
		})
		logger?.trace(
			{ cacheKey, hkdfStanzaId: primaryHkdfStanzaId, isFbidBot, botEditType: stanzaInfo.botEditType },
			'msmsg decrypted'
		)
		return decodeDecryptedMsmsg(plaintext)
	} catch (firstErr) {
		// Non-FBID path: WA Web retries with botEditTargetId on failure.
		if (!isFbidBot && stanzaInfo.botEditTargetId && stanzaInfo.botEditTargetId !== primaryHkdfStanzaId) {
			try {
				const plaintext = deriveKeyAndDecrypt({
					messageSecret,
					hkdfStanzaId: stanzaInfo.botEditTargetId,
					originalUserJid,
					senderJid,
					encIv: msMsg.encIv,
					encPayload: msMsg.encPayload
				})
				logger?.debug(
					{ cacheKey, fallbackHkdfStanzaId: stanzaInfo.botEditTargetId },
					'msmsg decrypted after botEditTargetId fallback'
				)
				return decodeDecryptedMsmsg(plaintext)
			} catch (fallbackErr) {
				logger?.warn(
					{
						cacheKey,
						isFbidBot,
						botEditType: stanzaInfo.botEditType,
						primaryErr: compactError(firstErr),
						fallbackErr: compactError(fallbackErr)
					},
					'msmsg decryption failed on both primary and fallback stanzaIds'
				)
				throw fallbackErr
			}
		}
		logger?.warn(
			{ cacheKey, isFbidBot, botEditType: stanzaInfo.botEditType, err: compactError(firstErr) },
			'msmsg decryption failed'
		)
		throw firstErr
	}
}

const deriveKeyAndDecrypt = (params: {
	messageSecret: Buffer
	hkdfStanzaId: string
	originalUserJid: string
	senderJid: string
	encIv: Uint8Array
	encPayload: Uint8Array
}): Buffer => {
	const { messageSecret, hkdfStanzaId, originalUserJid, senderJid, encIv, encPayload } = params

	// Two-step HKDF — confirmed via CDP capture of genBotMsgSecretFromMsgSecret
	// and genBotDecryptionKey in WAWebBotMessageSecret. The first step uses the
	// literal ASCII "Bot Message" as info; the second step uses the UTF-8
	// concatenation of (stanzaId, originalUserJid, senderJid) WITH NO length
	// prefix (WA Web's `Binary.build(...)` writes strings as raw UTF-8 bytes).
	//
	// `hkdf` (whatsapp-rust-bridge) takes `info` as a JS string and re-encodes
	// it to UTF-8 bytes on the Rust side, so passing a plain string works as
	// long as the inputs are ASCII — which they always are for stanzaIds (hex)
	// and JIDs (digits + ASCII servers like `@s.whatsapp.net` / `@bot`).
	const baseSecret = Buffer.from(hkdf(Buffer.from(messageSecret), KEY_LENGTH, { info: BOT_MESSAGE_INFO }))
	const infoStr = hkdfStanzaId + originalUserJid + senderJid
	const decryptionKey = Buffer.from(hkdf(baseSecret, KEY_LENGTH, { info: infoStr }))

	// AAD = utf8(stanzaId) || 0x00 || utf8(senderJid). The `\0` byte is a literal
	// NUL between the two ASCII strings.
	const aad = Buffer.concat([
		Buffer.from(hkdfStanzaId, 'utf8'),
		Buffer.from([0]),
		Buffer.from(senderJid, 'utf8')
	])

	return Buffer.from(aesDecryptGCM(encPayload, decryptionKey, encIv, aad))
}

/**
 * Decode the AES-GCM plaintext into an IMessage. WhatsApp pads outgoing
 * msmsg payloads using the same random-suffix scheme as regular e2e messages,
 * so we try unpadded first and fall back to the raw buffer if the unpadded
 * decode comes out empty.
 */
const decodeDecryptedMsmsg = (plaintext: Buffer): proto.IMessage => {
	try {
		const unpadded = Buffer.from(unpadRandomMax16(plaintext))
		const msg = proto.Message.decode(unpadded)
		const hasUsefulContent = Object.keys(msg).some(k => {
			if (k === 'messageContextInfo') return false
			const value = (msg as unknown as Record<string, unknown>)[k]
			return value !== null && value !== undefined
		})
		if (hasUsefulContent) return msg
	} catch {
		// fall through to unpadded decode below
	}
	return proto.Message.decode(plaintext)
}

const isMeJid = (jid: string, meId: string, meLid: string): boolean => {
	if (!jid) return false
	const target = jidDecode(jid)
	if (!target) return false
	const me1 = jidDecode(meId)
	const me2 = jidDecode(meLid)
	return target.user === me1?.user || target.user === me2?.user
}

/**
 * Returns true ONLY for the `@bot` server. That's the authoritative signal
 * that the AUTHOR of an incoming stanza is a Meta AI / FBID bot — the cipher
 * layer needs that distinction to pick the FBID HKDF derivation.
 *
 * Intentionally does NOT match the user-facing chat jid (e.g. Meta AI shows
 * up as `13135550202@c.us` in the chat list). `@c.us` is shared with regular
 * 1:1 user chats, so matching it here would risk taking the FBID code path
 * for a non-bot conversation. The `<bot>` xml node on the stanza is the only
 * authoritative tag; for jid-based detection we restrict to `@bot`.
 */
export const isMsmsgBotConversation = (chatOrAuthorJid: string | undefined): boolean => {
	if (!chatOrAuthorJid) return false
	return !!isJidMetaAI(chatOrAuthorJid)
}

/** Re-export for the test suite + decoder. */
export const __internal = {
	BOT_MESSAGE_INFO,
	KEY_LENGTH,
	isMeJid,
	deriveKeyAndDecrypt,
	decodeDecryptedMsmsg,
	userOnlyJid,
	isJidGroup
}
