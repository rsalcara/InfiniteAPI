import { LRUCache } from 'lru-cache'
import type { proto } from '../../WAProto/index.js'
import type { ILogger } from './logger'
import { metrics } from './prometheus-metrics.js'

/** Number of sent messages to cache in memory for handling retry receipts */
const RECENT_MESSAGES_SIZE = 512

const MESSAGE_KEY_SEPARATOR = '\u0000'

/** Timeout for session recreation - 1 hour */
const RECREATE_SESSION_TIMEOUT = 60 * 60 * 1000 // 1 hour in milliseconds
const PHONE_REQUEST_DELAY = 3000

/**
 * Retry reason codes from WhatsApp protocol
 * These map to the error codes sent in retry receipts
 *
 * @see https://github.com/WhiskeySockets/Baileys/pull/2307
 */
export enum RetryReason {
	/** Unknown or unspecified error */
	UnknownError = 0,
	/** No Signal session exists for recipient */
	SignalErrorNoSession = 1,
	/** Invalid key format or corrupted key */
	SignalErrorInvalidKey = 2,
	/** Invalid pre-key ID (key not found) */
	SignalErrorInvalidKeyId = 3,
	/** Invalid message - MAC verification failed */
	SignalErrorInvalidMessage = 4,
	/** Invalid signature on message or key */
	SignalErrorInvalidSignature = 5,
	/** Message from the future (timestamp issue) */
	SignalErrorFutureMessage = 6,
	/** Explicit MAC verification failure */
	SignalErrorBadMac = 7,
	/** Session is corrupted or invalid state */
	SignalErrorInvalidSession = 8,
	/** Invalid message key (decryption key issue) */
	SignalErrorInvalidMsgKey = 9,
	/** Bad broadcast ephemeral setting */
	BadBroadcastEphemeralSetting = 10,
	/** Unknown companion device without pre-key */
	UnknownCompanionNoPrekey = 11,
	/** ADV (Announcement Delivery Verification) failure */
	AdvFailure = 12,
	/** Status revoke was delayed */
	StatusRevokeDelay = 13
}

/** Error codes in the MAC/authentication failure family. */
export const MAC_ERROR_CODES = new Set<RetryReason>([
	RetryReason.SignalErrorInvalidMessage,
	RetryReason.SignalErrorBadMac
])

/**
 * Session-related error codes that may require session recreation
 */
export const SESSION_ERROR_CODES = new Set<RetryReason>([
	RetryReason.SignalErrorNoSession,
	RetryReason.SignalErrorInvalidSession,
	RetryReason.SignalErrorInvalidKey,
	RetryReason.SignalErrorInvalidKeyId
])

/**
 * Convert a retained decryption failure into the retry reason carried on the
 * wire. Only mappings verified against the Android client are emitted; an
 * unclassified failure remains `UnknownError`.
 */
export const retryReasonFromDecryptionError = (error: unknown): RetryReason => {
	const message = error instanceof Error ? error.message : String(error ?? '')
	if (message.includes('Bad MAC') || message.includes('Bad Mac!')) return RetryReason.SignalErrorBadMac
	if (message.includes('No matching sessions') || message.includes('No valid sessions')) {
		return RetryReason.SignalErrorInvalidSession
	}

	if (message.includes('Invalid signature')) return RetryReason.SignalErrorInvalidSignature
	if (message.includes('Over 2000 messages into the future')) return RetryReason.SignalErrorFutureMessage
	if (message.includes('No session record') || message.includes('No Session found')) {
		return RetryReason.SignalErrorNoSession
	}

	return RetryReason.UnknownError
}

export const parseRetryErrorCode = (errorAttr: string | undefined): RetryReason | undefined => {
	if (errorAttr === undefined || errorAttr === '') return undefined

	const code = Number.parseInt(errorAttr, 10)
	if (Number.isNaN(code)) return undefined
	if (code >= RetryReason.UnknownError && code <= RetryReason.StatusRevokeDelay) return code as RetryReason
	return RetryReason.UnknownError
}

export interface RecentMessageKey {
	to: string
	id: string
}

export interface RecentMessage {
	to: string
	message: proto.IMessage
	timestamp: number
	/**
	 * Transport metadata carried by the encrypted child rather than IMessage.
	 * It must survive an immediate retry so a live-location resend retains the
	 * official `<enc duration="…">` attribute.
	 */
	liveLocationDuration?: number
}

export interface SessionRecreateHistory {
	[jid: string]: number // timestamp
}

export interface RetryCounter {
	[messageId: string]: number
}

export type PendingPhoneRequest = Record<string, ReturnType<typeof setTimeout>>

export interface RetryStatistics {
	totalRetries: number
	successfulRetries: number
	failedRetries: number
	mediaRetries: number
	sessionRecreations: number
	phoneRequests: number
}

export interface RetryPayloadTransmissionOptions<T> {
	manager: MessageRetryManager | null
	to: string
	id: string
	message: proto.IMessage
	isDirectRetry: boolean
	liveLocationDuration?: number
	transmit: () => Promise<T>
}

/**
 * Minimal structural mirror for the `message_base_key` typed table. Satisfied
 * by `SignalTypedBackend` (its methods accept a superset key). Kept structural
 * so message-retry-manager doesn't depend on the multi-db-sqlite backend.
 */
export interface MessageBaseKeyMirror {
	putMessageBaseKey(key: { remoteJid: string; fromMe: boolean; msgId: string }, baseKey: Uint8Array): void
	deleteMessageBaseKey(key: { remoteJid: string; fromMe: boolean; msgId: string }): void
	clearMessageBaseKeys(): void
}

/**
 * Minimal structural mirror for the `unordered_stanza_queue` typed table.
 * Satisfied by `SignalTypedBackend`. The retry counter LRU (keyed by message
 * id) drives the DELETE: when a counter is removed or expires, the held-stanza
 * row for that message id is dropped too.
 *
 * Cleanup: a held stanza is an INBOUND stanza we could not decrypt, enqueued
 * at `sendRetryRequest`. Its row is dropped at the canonical "stanza processed"
 * trigger — the receive handler calls `deleteUnorderedStanza` on the
 * decrypt-success branch. This `dispose` is the backstop for the paths that
 * never reach success: `markRetryFailed` on retry exhaustion (prompt), the
 * 15-min TTL eviction, and the socket-close wipe. `reason === 'set'` is skipped
 * so `tryIncrement`'s per-retry overwrite bumps process_count instead.
 */
export interface UnorderedStanzaMirror {
	deleteUnorderedStanza(msgId: string): void
	clearUnorderedStanzas(): void
}

export class MessageRetryManager {
	private recentMessagesMap = new LRUCache<string, RecentMessage>({
		max: RECENT_MESSAGES_SIZE,
		ttl: 5 * 60 * 1000,
		ttlAutopurge: true,
		dispose: (_value: RecentMessage, key: string) => {
			const separatorIndex = key.lastIndexOf(MESSAGE_KEY_SEPARATOR)
			if (separatorIndex > -1) {
				const messageId = key.slice(separatorIndex + MESSAGE_KEY_SEPARATOR.length)
				this.removeMessageKeyIndexEntry(messageId, key)
			}
		}
	})
	private messageKeyIndex = new Map<string, { keys: Set<string>; fallbackAmbiguous: boolean }>()
	private sessionRecreateHistory = new LRUCache<string, number>({
		// M12 (upstream #2576): bound the cache. Without a max, a server that
		// targets us with a stream of unique-jid identity changes could grow
		// this map without bound. 10k entries × ~32 bytes per jid + timestamp
		// = ~320 KB ceiling.
		max: 10_000,
		ttl: RECREATE_SESSION_TIMEOUT * 2,
		ttlAutopurge: true
	})
	private retryCounters = new LRUCache<string, number>({
		// M12 (upstream #2576): bound the cache (see sessionRecreateHistory).
		max: 10_000,
		ttl: 15 * 60 * 1000,
		ttlAutopurge: true,
		updateAgeOnGet: true,
		// Backstop for the `unordered_stanza_queue` mirror. The primary delete is
		// at the decrypt-success branch of the receive handler (canonical "stanza
		// processed"); this dispose covers the paths that never reach success:
		// `markRetryFailed` on exhaustion (prompt), the 15-min TTL eviction, and
		// the socket-close wipe. `reason === 'set'` is skipped: `tryIncrement`
		// overwrites the counter on every retry, and that must bump
		// `process_count`, not delete the row. Wrapped so a mirror-delete
		// failure never disrupts the retry cache.
		dispose: (_value: number, key: string, reason: LRUCache.DisposeReason) => {
			if (reason === 'set' || !this.unorderedQueueBackend) return
			try {
				this.unorderedQueueBackend.deleteUnorderedStanza(key)
			} catch {
				/* mirror-delete failure never affects the retry cache */
			}
		}
	}) // 15 minutes TTL
	/**
	 * Tracks the open-session base key per `(addr, msgId)` for retry-collision
	 * detection. WA Web saves the base key at retry==2 and, on retry>2, deletes
	 * the local session if the stored base key is still in place (indicating
	 * neither side has rotated). 15-min TTL matches the retryCounters lifetime.
	 */
	private baseKeys = new LRUCache<string, Uint8Array>({
		max: 1024,
		ttl: 15 * 60 * 1000,
		ttlAutopurge: true,
		// The typed `message_base_key` mirror follows the in-memory lifetime
		// EXACTLY: when an entry is evicted, expires (15-min TTL), overwritten,
		// or deleted, drop the mirror row too. Without this, a base key saved at
		// retry==2 that then delivers successfully (no retry>2 → deleteBaseKey
		// never fires) would leak a row forever, contradicting the table's
		// transient nature and growing axolotl.db unbounded. Wrapped so a
		// mirror-delete failure never disrupts the retry cache itself.
		dispose: (_value: Uint8Array, key: string) => {
			if (!this.baseKeyBackend) return
			// key is `${addr}:${msgId}`; split on the LAST ':' since addr may
			// contain ':' (device address) but a message id never does.
			const sep = key.lastIndexOf(':')
			if (sep < 0) return
			try {
				this.baseKeyBackend.deleteMessageBaseKey({
					remoteJid: key.slice(0, sep),
					fromMe: true,
					msgId: key.slice(sep + 1)
				})
			} catch {
				/* mirror-delete failure never affects the retry cache */
			}
		}
	})
	private pendingPhoneRequests: PendingPhoneRequest = {}
	private readonly maxMsgRetryCount: number = 5
	private statistics: RetryStatistics = {
		totalRetries: 0,
		successfulRetries: 0,
		failedRetries: 0,
		mediaRetries: 0,
		sessionRecreations: 0,
		phoneRequests: 0
	}

	constructor(
		private logger: ILogger,
		maxMsgRetryCount: number,
		/**
		 * Optional best-effort mirror of the base-key cache into the typed
		 * `message_base_key` table (WhatsApp parity). The in-memory LRU stays
		 * authoritative for retry-collision detection; a mirror failure never
		 * affects it. `addr` (the signal session id) is used as `remoteJid` and
		 * `fromMe` is true — these anchors are for OUTBOUND messages we resend.
		 */
		private baseKeyBackend?: MessageBaseKeyMirror,
		/**
		 * Optional best-effort mirror of held (undecryptable-in-order) stanzas
		 * into the typed `unordered_stanza_queue` table. Populated at
		 * `sendRetryRequest`; rows are dropped by this manager's retry-counter
		 * dispose (success/failure/TTL). A mirror failure never affects retries.
		 */
		private unorderedQueueBackend?: UnorderedStanzaMirror
	) {
		this.maxMsgRetryCount = maxMsgRetryCount
	}

	/**
	 * Add a recent message to the cache for retry handling
	 */
	addRecentMessage(
		to: string,
		id: string,
		message: proto.IMessage,
		metadata?: { liveLocationDuration?: number }
	): void {
		const key: RecentMessageKey = { to, id }
		const keyStr = this.keyToString(key)

		// Add new message
		this.recentMessagesMap.set(keyStr, {
			to,
			message,
			timestamp: Date.now(),
			liveLocationDuration: metadata?.liveLocationDuration
		})
		const indexEntry = this.messageKeyIndex.get(id) || { keys: new Set<string>(), fallbackAmbiguous: false }
		if ([...indexEntry.keys].some(indexedKey => indexedKey !== keyStr)) {
			indexEntry.fallbackAmbiguous = true
		}

		indexEntry.keys.add(keyStr)
		this.messageKeyIndex.set(id, indexEntry)

		this.logger.debug(`Added message to retry cache: ${to}/${id}`)
	}

	/**
	 * Stages an outbound payload only when that exact destination and message id
	 * are not already retained. Returns true when this call created the entry,
	 * allowing its caller to roll back only its own failed transmission attempt.
	 */
	stageRecentMessage(
		to: string,
		id: string,
		message: proto.IMessage,
		metadata?: { liveLocationDuration?: number }
	): boolean {
		if (this.recentMessagesMap.has(this.keyToString({ to, id }))) return false

		this.addRecentMessage(to, id, message, metadata)
		return true
	}

	/**
	 * Get a recent message from the cache.
	 *
	 * First attempts an exact `to+id` key lookup. If that misses — which happens when
	 * the retry receipt arrives from a device-specific JID (e.g. `55123:82@s.whatsapp.net`)
	 * while the message was stored under the normalised base JID (`55123@s.whatsapp.net`),
	 * or when the JID domain flipped between LID and PN — falls back to the `messageKeyIndex`.
	 * The fallback is used only when the bare ID identifies exactly one live entry;
	 * reusing a custom ID across chats must never expose another chat's plaintext.
	 */
	getRecentMessage(to: string, id: string): RecentMessage | undefined {
		const key: RecentMessageKey = { to, id }
		const keyStr = this.keyToString(key)
		const exact = this.recentMessagesMap.get(keyStr)
		if (exact) return exact

		const indexedKeyStr = this.getUniqueRecentMessageKey(id)
		if (indexedKeyStr) return this.recentMessagesMap.get(indexedKeyStr)

		return undefined
	}

	/**
	 * Check if a session should be recreated based on retry count, history, and error code
	 *
	 * @param jid - The JID of the recipient
	 * @param hasSession - Whether a Signal session exists for this JID
	 * @param errorCode - Optional error code from the retry receipt (indicates type of failure)
	 * @returns Object with reason string and boolean indicating if session should be recreated
	 */
	shouldRecreateSession(
		jid: string,
		hasSession: boolean,
		errorCode?: RetryReason
	): { reason: string; recreate: boolean } {
		// Missing state still needs session establishment. Existing state is only
		// deleted by the registration-id and retry-count/base-key checks in the
		// retry-receipt handler; an error label alone is not sufficient evidence.
		if (!hasSession) {
			this.sessionRecreateHistory.set(jid, Date.now())
			this.statistics.sessionRecreations++
			metrics.signalSessionRecreations?.inc({ reason: 'no_session' })
			return {
				reason: "we don't have a Signal session with them",
				recreate: true
			}
		}

		if (errorCode !== undefined) {
			this.logger.debug(
				{ jid, errorCode: RetryReason[errorCode] ?? `code_${errorCode}` },
				'retry error retained for diagnostics; existing session preserved pending registration/base-key checks'
			)
		}

		return { reason: '', recreate: false }
	}

	/**
	 * Parse error code from retry receipt attribute
	 *
	 * @param errorAttr - The error attribute string from the retry receipt
	 * @returns Parsed RetryReason or undefined if invalid
	 */
	parseRetryErrorCode(errorAttr: string | undefined): RetryReason | undefined {
		return parseRetryErrorCode(errorAttr)
	}

	/**
	 * Check if an error code indicates a MAC verification failure
	 *
	 * @param errorCode - The retry error code to check
	 * @returns True if this is a MAC error requiring immediate session recreation
	 */
	isMacError(errorCode: RetryReason | undefined): boolean {
		return errorCode !== undefined && MAC_ERROR_CODES.has(errorCode)
	}

	/**
	 * Check if an error code indicates a session-related failure
	 *
	 * @param errorCode - The retry error code to check
	 * @returns True if this is a session error
	 */
	isSessionError(errorCode: RetryReason | undefined): boolean {
		return errorCode !== undefined && SESSION_ERROR_CODES.has(errorCode)
	}

	/**
	 * Increment retry counter for a message
	 */
	incrementRetryCount(messageId: string): number {
		this.retryCounters.set(messageId, (this.retryCounters.get(messageId) || 0) + 1)
		this.statistics.totalRetries++
		return this.retryCounters.get(messageId)!
	}

	/**
	 * Get retry count for a message
	 */
	getRetryCount(messageId: string): number {
		return this.retryCounters.get(messageId) || 0
	}

	/**
	 * Check if message has exceeded maximum retry attempts
	 */
	hasExceededMaxRetries(messageId: string): boolean {
		return this.getRetryCount(messageId) >= this.maxMsgRetryCount
	}

	/**
	 * Atomic check-and-increment (M12 — upstream #2576): returns
	 * `{ proceed: true, count }` if the retry attempt is allowed (and the
	 * counter was incremented), or `{ proceed: false, count }` if the message
	 * is already at or past the retry limit. JavaScript's single-threaded
	 * execution model means the read+increment happens within one sync block
	 * — no external `await` can interleave between the bound check and the
	 * `set`. Prefer this over calling `hasExceededMaxRetries` followed by
	 * `incrementRetryCount` separately, because the latter pattern has an
	 * `await` boundary between the two ops and a concurrent caller can
	 * race past the cap.
	 */
	tryIncrement(messageId: string): { proceed: boolean; count: number } {
		const current = this.getRetryCount(messageId)
		if (current >= this.maxMsgRetryCount) {
			return { proceed: false, count: current }
		}

		const next = current + 1
		this.retryCounters.set(messageId, next)
		this.statistics.totalRetries++
		return { proceed: true, count: next }
	}

	/** Completes state held for an inbound message that now decrypts. */
	markInboundRetrySuccess(messageId: string): boolean {
		this.cancelPendingPhoneRequest(messageId)
		if (!this.retryCounters.has(messageId)) return false

		this.statistics.successfulRetries++
		this.retryCounters.delete(messageId)
		return true
	}

	/**
	 * Records a successful outbound resend without removing the shared payload.
	 * A single message is encrypted independently for every companion device, so
	 * another device can still request its own retry after the first resend.
	 * The recent-message LRU/TTL remains responsible for eventual cleanup.
	 */
	markOutboundRetrySuccess(): void {
		this.statistics.successfulRetries++
	}

	/**
	 * Discards a payload that was staged before transmission when the stanza
	 * itself could not be sent. Successful sends remain in the TTL-bounded cache
	 * so every companion device can independently request a retry.
	 */
	discardRecentMessage(to: string, messageId: string): void {
		this.removeRecentMessage(to, messageId)
	}

	/**
	 * Mark retry as failed
	 */
	markRetryFailed(messageId: string): void {
		this.statistics.failedRetries++
		this.retryCounters.delete(messageId)
		this.cancelPendingPhoneRequest(messageId)
		const keyStr = this.getUniqueRecentMessageKey(messageId)
		if (keyStr) this.recentMessagesMap.delete(keyStr)
	}

	/**
	 * Schedule a phone request with delay
	 */
	schedulePhoneRequest(messageId: string, callback: () => void, delay: number = PHONE_REQUEST_DELAY): void {
		// Cancel any existing request for this message
		this.cancelPendingPhoneRequest(messageId)

		this.pendingPhoneRequests[messageId] = setTimeout(() => {
			delete this.pendingPhoneRequests[messageId]
			this.statistics.phoneRequests++
			callback()
		}, delay)

		this.logger.debug(`Scheduled phone request for message ${messageId} with ${delay}ms delay`)
	}

	/**
	 * Cancel pending phone request
	 */
	cancelPendingPhoneRequest(messageId: string): void {
		const timeout = this.pendingPhoneRequests[messageId]
		if (timeout) {
			clearTimeout(timeout)
			delete this.pendingPhoneRequests[messageId]
			this.logger.debug(`Cancelled pending phone request for message ${messageId}`)
		}
	}

	/**
	 * Save the open-session base key seen on a retry==2 receipt for a given
	 * `(sessionId, msgId)`. Used by retry==N (N>2) to detect whether the
	 * peer's session has rotated; if the same base key is still there, the
	 * caller forces a fresh session before resending.
	 */
	saveBaseKey(addr: string, msgId: string, baseKey: Uint8Array): void {
		this.baseKeys.set(`${addr}:${msgId}`, baseKey)
		try {
			this.baseKeyBackend?.putMessageBaseKey({ remoteJid: addr, fromMe: true, msgId }, baseKey)
		} catch (err) {
			this.logger.debug({ err }, 'multi-db-sqlite: message_base_key mirror (put) failed (non-fatal)')
		}
	}

	/**
	 * Plain byte-by-byte equality check of the stored base key vs `baseKey`.
	 * Early-exits on length mismatch and on the first differing byte — this is
	 * not constant-time, but timing resistance isn't required for these base
	 * keys (they live in-memory only, used to detect retry-cycle collisions,
	 * and are not high-value secrets like identity/signed-pre keys).
	 */
	hasSameBaseKey(addr: string, msgId: string, baseKey: Uint8Array): boolean {
		const stored = this.baseKeys.get(`${addr}:${msgId}`)
		if (stored?.length !== baseKey.length) {
			return false
		}

		for (let i = 0; i < stored.length; i++) {
			if (stored[i] !== baseKey[i]) return false
		}

		return true
	}

	deleteBaseKey(addr: string, msgId: string): void {
		// The mirror row is dropped by the LRU `dispose` hook this `.delete()`
		// triggers — no separate mirror call needed (keeps the two in lockstep).
		this.baseKeys.delete(`${addr}:${msgId}`)
	}

	private keyToString(key: RecentMessageKey): string {
		return `${key.to}${MESSAGE_KEY_SEPARATOR}${key.id}`
	}

	private removeMessageKeyIndexEntry(messageId: string, keyStr: string): void {
		const indexEntry = this.messageKeyIndex.get(messageId)
		if (!indexEntry) return

		indexEntry.keys.delete(keyStr)
		if (indexEntry.keys.size === 0) this.messageKeyIndex.delete(messageId)
	}

	private getUniqueRecentMessageKey(messageId: string): string | undefined {
		const indexEntry = this.messageKeyIndex.get(messageId)
		if (!indexEntry || indexEntry.fallbackAmbiguous) return undefined

		const liveKeys = [...indexEntry.keys].filter(keyStr => this.recentMessagesMap.has(keyStr))
		if (liveKeys.length !== 1) return undefined

		return liveKeys[0]
	}

	private removeRecentMessage(to: string, messageId: string): void {
		this.recentMessagesMap.delete(this.keyToString({ to, id: messageId }))
	}

	/** Release all caches and cancel pending phone-request timers (called on socket close). */
	clear(): void {
		for (const messageId of Object.keys(this.pendingPhoneRequests)) {
			clearTimeout(this.pendingPhoneRequests[messageId])
		}

		this.pendingPhoneRequests = {}
		this.recentMessagesMap.clear()
		this.messageKeyIndex.clear()
		this.sessionRecreateHistory.clear()
		this.retryCounters.clear()
		// `LRUCache.clear()` does NOT fire `dispose`, so wipe the typed mirror
		// explicitly — the in-memory base keys are gone, the table must follow.
		this.baseKeys.clear()
		try {
			this.baseKeyBackend?.clearMessageBaseKeys()
		} catch (err) {
			this.logger.debug({ err }, 'multi-db-sqlite: message_base_key mirror (clear) failed (non-fatal)')
		}

		// Same as above: `retryCounters.clear()` (line above) does not fire
		// dispose, so wipe the held-stanza mirror explicitly.
		try {
			this.unorderedQueueBackend?.clearUnorderedStanzas()
		} catch (err) {
			this.logger.debug({ err }, 'multi-db-sqlite: unordered_stanza_queue mirror (clear) failed (non-fatal)')
		}
	}
}

/**
 * Makes an outbound payload retryable before it reaches the wire and rolls
 * back only the cache entry created by this transmission attempt.
 */
export const transmitWithRetryPayload = async <T>({
	manager,
	to,
	id,
	message,
	isDirectRetry,
	liveLocationDuration,
	transmit
}: RetryPayloadTransmissionOptions<T>): Promise<T> => {
	const staged = Boolean(
		manager && !isDirectRetry && manager.stageRecentMessage(to, id, message, { liveLocationDuration })
	)

	try {
		return await transmit()
	} catch (error) {
		if (staged) manager?.discardRecentMessage(to, id)
		throw error
	}
}
