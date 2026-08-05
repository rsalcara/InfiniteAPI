/* eslint-disable max-depth, @typescript-eslint/no-unused-vars */
import NodeCache from '@cacheable/node-cache'
import { Boom } from '@hapi/boom'
import { randomBytes } from 'crypto'
import Long from 'long'
import { proto } from '../../WAProto/index.js'
import {
	DEFAULT_CACHE_MAX_KEYS,
	DEFAULT_CACHE_TTLS,
	DEFAULT_SESSION_CLEANUP_CONFIG,
	KEY_BUNDLE_TYPE,
	MIN_PREKEY_COUNT,
	PLACEHOLDER_MAX_AGE_SECONDS,
	STATUS_EXPIRY_SECONDS
} from '../Defaults'
import type {
	GroupParticipant,
	LIDMapping,
	MessageReceiptType,
	MessageRelayOptions,
	MessageUserReceipt,
	NewChatMessageCapInfo,
	PlaceholderMessageData,
	SocketConfig,
	WACallEvent,
	WACallParticipant,
	WACallUpdateType,
	WAMessage,
	WAMessageKey,
	WAPatchName
} from '../Types'
import { ReachoutTimelockEnforcementType, WAMessageStatus, WAMessageStubType } from '../Types'
import {
	ACCOUNT_RESTRICTED_TEXT,
	aesDecryptCTR,
	aesEncryptGCM,
	canonicalizeReceiptChatJid,
	cleanMessage,
	cleanupCorruptedSession,
	compactError,
	Curve,
	decodeMediaRetryNode,
	decodeMessageNode,
	decryptMessageNode,
	delay,
	derivePairingCodeKey,
	encodeBigEndian,
	encodeSignedDeviceIdentity,
	extractAddressingContext,
	extractE2ESessionFromRetryReceipt,
	getCallStatusFromNode,
	getDecryptionJid,
	getHistoryMsg,
	getMessageTypeLabel,
	getNextPreKeys,
	getStatusFromReceiptType,
	handleIdentityChange,
	hasRetrySendBudget,
	hkdf,
	isCorruptedSessionError,
	isNodeCacheFullError,
	makeMsmsgSecretCache,
	MISSING_KEYS_ERROR_TEXT,
	NACK_REASONS,
	NO_MESSAGE_FOUND_ERROR_TEXT,
	normalizeKeyLidToPn,
	normalizeMessageJids,
	parseRetryErrorCode,
	persistRetrySendReservation,
	resolveContactPictureIdentity,
	resolveLidToPn,
	resolveRetryReceiptRoute,
	RetryReason,
	retryReasonFromDecryptionError,
	safeCacheSet,
	shouldIncludeRetryKeysForSession,
	toNumber,
	unixTimestampSeconds,
	xmppPreKey,
	xmppSignedPreKey
} from '../Utils'
import { logMessageReceived, logTcToken } from '../Utils/baileys-logger'
import { applyDeviceListDelta } from '../Utils/device-list-delta'
import { makeLockManager } from '../Utils/lock-manager'
import { makeMutex } from '../Utils/make-mutex'
import { getMessageAckErrorPolicy } from '../Utils/message-ack-error'
import {
	buildMexDiagnostic,
	type MexDiagnosticReason,
	normalizeMexOperation,
	parseTextStatusSideSubNotification,
	parseTextStatusUpdateNotification
} from '../Utils/mex-notifications'
import {
	JidMapBackend,
	mapWebMessageStatusToAndroid,
	MessageStoreBackend,
	ReceiptBackend,
	type ReceiptKind,
	SignalTypedBackend,
	StatusBackend
} from '../Utils/multi-db-sqlite'
import { initOptionalMirror as initOptionalMirrorBase } from '../Utils/multi-db-sqlite/optional-mirror'
import { makeOfflineNodeProcessor, type MessageType } from '../Utils/offline-node-processor'
import { markPrekeyDirectDistributionIntent } from '../Utils/prekey-direct-distribution'
import { applyReconciledPrekeyCursors } from '../Utils/prekey-upload-cursors'
import {
	metrics,
	recordHistorySyncMessages,
	recordMessageFailure,
	recordMessageReceived,
	recordMessageRetry
} from '../Utils/prometheus-metrics.js'
import { isExpectedSocketTeardownError } from '../Utils/socket-teardown'
import { buildAckStanza } from '../Utils/stanza-ack'
import {
	isRegularUser,
	isTcTokenExpired,
	parseTrustedContactTokenNotification,
	resolveIncomingTcTokenAliases,
	resolveTcTokenAliases,
	selectNewestUsableTcToken
} from '../Utils/tc-token-utils'
import {
	handleUsernameDeleteNotification as handleUsernameDeleteNotificationImpl,
	handleUsernameSetNotification as handleUsernameSetNotificationImpl,
	handleUsernameSideSubNotification as handleUsernameSideSubNotificationImpl
} from '../Utils/username-notifications'
import {
	areJidsSameUser,
	type BinaryNode,
	encodeBinaryNode,
	type FullJid,
	getAllBinaryNodeChildren,
	getBinaryNodeChild,
	getBinaryNodeChildBuffer,
	getBinaryNodeChildren,
	getBinaryNodeChildString,
	getBinaryNodeChildUInt,
	isJidGroup,
	isJidNewsletter,
	isJidStatusBroadcast,
	isLidUser,
	isPnUser,
	jidDecode,
	jidNormalizedUser,
	S_WHATSAPP_NET
} from '../WABinary'

const summarizeInboundNode = (node: BinaryNode) => ({
	tag: node.tag,
	attrs: {
		id: node.attrs.id,
		from: node.attrs.from,
		participant: node.attrs.participant,
		recipient: node.attrs.recipient,
		type: node.attrs.type,
		t: node.attrs.t
	},
	contentTags: Array.isArray(node.content)
		? node.content.flatMap(child => (typeof child === 'object' && 'tag' in child ? [child.tag] : []))
		: []
})
import { extractGroupMetadata } from './groups'
import { createInboundTaskAdmission } from './inbound-task-admission'
import { makeMessagesSocket } from './messages-send'

// Set imutável de valores válidos do enum (port de upstream `c89d97b13b`,
// audit ROBUST-02). Mantido em escopo de módulo pra que múltiplas socket
// instances compartilhem a mesma estrutura — sem isso, 1k sessões teriam
// 1k Sets idênticas de 18 strings.
const ENFORCEMENT_TYPE_VALUES = new Set<string>(Object.values(ReachoutTimelockEnforcementType))
const isValidEnforcementType = (value: string | undefined): value is ReachoutTimelockEnforcementType =>
	value !== undefined && ENFORCEMENT_TYPE_VALUES.has(value)

/**
 * Maps a decoded receipt status to the msgstore.db receipt_user/_device
 * "kind" it should populate. Collapsing everything that isn't
 * DELIVERY_ACK into 'read' (an earlier revision's shortcut) silently
 * dropped PLAYED (voice-note listen) receipts into read_timestamp instead
 * of played_timestamp — confirmed real bug.
 */
const receiptKindFromStatus = (status: proto.WebMessageInfo.Status | undefined): ReceiptKind =>
	status === proto.WebMessageInfo.Status.PLAYED
		? 'played'
		: status === proto.WebMessageInfo.Status.DELIVERY_ACK
			? 'delivery'
			: 'read'

export const makeMessagesRecvSocket = (config: SocketConfig) => {
	const {
		logger,
		retryRequestDelayMs,
		maxMsgRetryCount,
		getMessage,
		shouldIgnoreJid,
		enableCTWARecovery,
		sessionCleanupConfig
	} = config
	// Use nullish coalescing to handle partial config properly
	const autoCleanCorrupted =
		sessionCleanupConfig?.autoCleanCorrupted ?? DEFAULT_SESSION_CLEANUP_CONFIG.autoCleanCorrupted
	const sock = makeMessagesSocket(config)
	const {
		userDevicesCache,
		devicesMutex,
		ev,
		authState,
		ws,
		messageMutex,
		notificationMutex,
		receiptMutex,
		signalRepository,
		sessionActivityTracker,
		query,
		upsertMessage,
		resyncAppState,
		onUnexpectedError,
		assertSessions,
		sendNode,
		relayMessage,
		sendReceipt,
		uploadPreKeys,
		sendPeerDataOperationMessage,
		messageRetryManager,
		issuePrivacyTokens,
		registerSocketEndHandler,
		registerSocketDrainHandler,
		isSocketClosed,
		// Port de upstream `4dbbba2891` (PR #2442)
		fetchAccountReachoutTimelock
	} = sock

	const getLIDForPN = signalRepository.lidMapping.getLIDForPN.bind(signalRepository.lidMapping)
	const getPNForLID = signalRepository.lidMapping.getPNForLID.bind(signalRepository.lidMapping)
	const initOptionalMirror = <T>(mirror: string, fallback: string, factory: () => T): T | undefined =>
		initOptionalMirrorBase(config.multiDbStore, logger, mirror, fallback, factory)

	/** this mutex ensures that each retryRequest will wait for the previous one to finish */
	const retryMutex = makeMutex()

	// Audit MEM-B3 — `maxKeys` previne crescimento ilimitado sob retry storm
	// (msgRetryCache com TTL 1h) e em paths que poucos consumers fornecem
	// cache custom. LRU eviction de entries velhas é equivalente ao expiry
	// natural pro caso de retry tardio. Valores em sync com DEFAULT_CACHE_MAX_KEYS.
	const msgRetryCache =
		config.msgRetryCounterCache ||
		new NodeCache<number>({
			stdTTL: DEFAULT_CACHE_TTLS.MSG_RETRY, // 1 hour
			useClones: false,
			maxKeys: DEFAULT_CACHE_MAX_KEYS.MSG_RETRY
		})
	const callOfferCache =
		config.callOfferCache ||
		new NodeCache<WACallEvent>({
			stdTTL: DEFAULT_CACHE_TTLS.CALL_OFFER, // 5 mins
			useClones: false,
			maxKeys: DEFAULT_CACHE_MAX_KEYS.CALL_OFFER
		})

	const placeholderResendCache =
		config.placeholderResendCache ||
		new NodeCache({
			stdTTL: DEFAULT_CACHE_TTLS.MSG_RETRY, // 1 hour
			useClones: false,
			maxKeys: DEFAULT_CACHE_MAX_KEYS.PLACEHOLDER_RESEND
		})

	// Mirrors status-view receipts (status_seen_receipt) into status.db when a
	// multi-db-sqlite store is configured. Same boundary-cast rationale as
	// chats.ts's appStateBackend — `multiDbStore` is typed `unknown` on
	// SocketConfig so this module doesn't need a hard dependency on the
	// SQLite types. `MultiDbSqliteStore.handle()` is idempotent (cached), so
	// this is the same underlying connection chats.ts's own StatusBackend
	// instance uses — just a second, cheap wrapper over it.
	const statusBackend = initOptionalMirror(
		'status.db.status_seen_receipt',
		'message_receipt_events',
		() => new StatusBackend((config.multiDbStore as any).handle('status.db'))
	)

	// Mirrors message receipts (receipt_user/receipt_device) into
	// msgstore.db when a multi-db-sqlite store is configured. Same
	// boundary-cast + fresh-JidMapBackend rationale as chats.ts's own
	// messageStoreBackend instantiation. A second, cheap MessageStoreBackend
	// wrapper (same underlying connection as chats.ts's own instance) is
	// needed here too — ReceiptBackend resolves `chat._id` through it rather
	// than a bare JidMapBackend (see ChatRowResolver's doc for why those are
	// different values).
	const receiptChatResolver = initOptionalMirror(
		'msgstore.db.receipt_chat_resolver',
		'message_receipt_events',
		() =>
			new MessageStoreBackend(
				(config.multiDbStore as any).handle('msgstore.db'),
				new JidMapBackend((config.multiDbStore as any).handle('msgstore.db'))
			)
	)
	const receiptBackend = receiptChatResolver
		? initOptionalMirror(
				'msgstore.db.receipts',
				'message_receipt_events',
				() =>
					new ReceiptBackend(
						(config.multiDbStore as any).handle('msgstore.db'),
						new JidMapBackend((config.multiDbStore as any).handle('msgstore.db')),
						receiptChatResolver
					)
			)
		: undefined

	// Typed access to the axolotl.db Signal tables. The pre-decrypt/pre-ack mirrors
	// below remain best-effort:
	//   - `preacks`               — pending pre-ack buffer (sendMessageAck)
	//   - `unordered_stanza_queue`— stanza held because it could not be
	//                               decrypted in order yet (sendRetryRequest)
	// Same boundary-cast + idempotent-handle rationale as the receipt/status
	// backends above. Their writes are wrapped in try/catch at the call site so a
	// mirror failure never blocks the real ack / retry flow (fallback = legacy).
	// Direct-distribution marking is deliberately different: a retry receipt only
	// exposes its one-time prekey after the durable typed row is confirmed, so that
	// security-sensitive path fails closed instead of falling back silently.
	const signalTypedBackend = initOptionalMirror(
		'axolotl.db.transient_signal_tables',
		'legacy_signal_flow',
		() => new SignalTypedBackend((config.multiDbStore as any).handle('axolotl.db'))
	)

	// Per-socket cache of Meta AI / FBID bot message secrets (msmsg). Bounded by
	// DEFAULT_CACHE_MAX_KEYS.MSMSG_SECRET (500) + 1h TTL. Cleared AND closed on
	// socket end (see registerSocketEndHandler below) to:
	//   1. mirror WAWebMsmsgMsgSecretCache's BackendEventBus.onLogout clear and
	//      avoid cross-account secret leakage when multiple sockets share the
	//      same Node process; AND
	//   2. stop the NodeCache `checkperiod` setInterval timer so frequent
	//      reconnects (network flap / multi-tenant pools) don't leak one timer
	//      per disconnect (audit P2 thread 8).
	// Upstream PR #2592 uses an unbounded module-global Map (cubic P1, coderabbit
	// Major) — we fix that AND the timer leak.
	const msmsgSecretCache = makeMsmsgSecretCache()
	registerSocketEndHandler(async () => {
		try {
			msmsgSecretCache.flushAll()
			// close() releases the periodic-check setInterval — without it each
			// reconnect leaves a stale timer alive.
			msmsgSecretCache.close()
		} catch {
			// flushAll/close never throw on a healthy cache, but defensive on shutdown
		}
	})

	/**
	 * Stage 9 (upstream #2579): single-flight guard for `requestPlaceholderResend`.
	 * The previous cache-based dedupe (`get → set`) had a race window: two
	 * concurrent calls for the same message id could both observe the cache
	 * as empty and both issue the placeholder resend. The lock collapses the
	 * get + set into one critical section per id.
	 *
	 * Coexists with Stage 3's `lidMigrationLocks` and Stage 6's `retryLocks` —
	 * disjoint namespaces (`__placeholder_resend__` vs `__lid_migration__` vs
	 * `msg-retry`), no deadlock risk.
	 */
	const placeholderResendLocks = makeLockManager()

	/**
	 * Stage 6 H9 (upstream #2576): per-(msgId, participant) keyed lock for
	 * the `msgRetryCache` read-modify-write. The cache is mutated by two call
	 * paths — `sendRetryRequest` and `reserveSendMessageAgainAttempt` — and the
	 * classic `await get → +1 → await set` sequence loses increments without
	 * a shared lock chain. Each path therefore performs its complete counter
	 * transition inside the same per-`(msgId, participant)` critical section.
	 *
	 * InfiniteAPI hybrid: we KEEP the outer `retryMutex` (line ~145) that
	 * wraps the inbound dispatch's retry handler — it serializes the whole
	 * preKey-upload-+-sendRetryRequest critical section, which is broader
	 * than per-msgId. Upstream removes retryMutex (their dispatch is already
	 * serialized by `messageMutex`); we preserve it because our custom
	 * pre-key error recovery logic depends on that broader serialization.
	 */
	const retryLocks = makeLockManager()
	// PR #462 review (Copilot): double-underscore prefix on the namespace
	// avoids future collisions with any real `SignalDataType` value.
	// LockManager docs (lock-manager.ts:9) require this convention for
	// namespaces that aren't backed by a record type. Matches the convention
	// already used by `__lid_migration__` (Stage 3 H8) and
	// `__placeholder_resend__` (Stage 9 — see above).
	const retryLockRef = (msgId: string, participant: string) => ({
		namespace: '__msg_retry__',
		id: `${msgId}:${participant}`
	})

	// Debounce identity-change session refreshes per JID to avoid bursts
	// Audit IDENTITY-CACHE — TTL 5s + uso esporádico mantém o cap baixo na
	// prática. Cap defensivo de 1000 (= ~200 identity asserts/s sustentados,
	// muito acima do realista). `NodeCache.set()` LANÇA ao atingir maxKeys,
	// então identity-change-handler.ts:219 envolve em try/catch silencioso
	// (mesmo padrão de BOT-001 em auth-utils.ts).
	const identityAssertDebounce = new NodeCache<boolean>({
		stdTTL: 5,
		useClones: false,
		maxKeys: 1000
	})

	// Stage 3 (upstream #2573 M11): in-flight Set for identity refreshes.
	// Created ONCE per socket lifetime so handleIdentityChange can dedup
	// concurrent refreshes that outlive the 5s debounce TTL above.
	const identityInFlightRefreshes = new Set<string>()

	// Stage 3 (upstream #2573 H8): per-(alt-jid) lock so two parallel inbound
	// messages from the same alt-jid participant don't each observe a null
	// mapping and each fire `storeLIDPNMappings` + `migrateSession` redundantly.
	// Complements InfiniteAPI's existing dedup layers:
	//   - libsignal `migrationInFlight` (Promise sharing for the SAME PN user
	//     reaching `migrateSession` — covers intra-call dedup)
	//   - libsignal `migratedSessionCache` (skip-if-already-migrated)
	//   - lidMigrationLocks (this) covers the BLOCK above migrateSession,
	//     not just the migrateSession call itself.
	const lidMigrationLocks = makeLockManager()

	let sendActiveReceipts = false

	// ======= tctoken index tracking for cross-session pruning =======
	const TC_TOKEN_INDEX_KEY = '__index'
	const TC_TOKEN_PRUNE_TS_KEY = '__prune_ts'
	const tcTokenKnownJids = new Set<string>()

	/**
	 * Dedupe global de `fetchAccountReachoutTimelock` em fire-and-forget.
	 * Em um burst de 463s (carrossel multi-destinatário, broadcast), sem o
	 * flag a função seria disparada N vezes em poucos ms — o estado é
	 * global por socket, basta uma checagem por janela curta. Reseta no
	 * `.finally()` da própria call. Audit PROTO-01 (RACE-01 mitigation).
	 */
	let inFlightReachoutCheck = false

	// Deduplicates retry requests per JID within a short window.
	// When a burst of Bad MAC errors arrives for the same contact,
	// only the first retry request is sent — the peer resends everything
	// with a single pkmsg, avoiding the close-session cascade.
	const retryRequestActiveJids = new Set<string>()
	let tcTokenIndexSaveTimer: ReturnType<typeof setTimeout> | undefined
	let lastTcTokenPruneTs = 0

	/**
	 * Audit memory-leak Finding 6 — timers de cleanup do PDO (8s) eram criados
	 * com `setTimeout(...)` sem rastreio. Em disconnect com PDOs in-flight, o
	 * timer disparava sobre cache fechado e retinha closures (stanzaId,
	 * placeholderResendCache, logger) por até 8s. Rastreamento permite
	 * cancelamento síncrono no `registerSocketEndHandler`.
	 */
	const pdoCleanupTimers = new Set<ReturnType<typeof setTimeout>>()

	// Load persisted JID index and last prune timestamp on startup
	const tcTokenIndexLoaded = (async () => {
		try {
			const data = await authState.keys.get('tctoken', [TC_TOKEN_INDEX_KEY, TC_TOKEN_PRUNE_TS_KEY])
			const entry = data[TC_TOKEN_INDEX_KEY]
			if (entry?.token) {
				const stored = JSON.parse(Buffer.from(entry.token).toString('utf8'))
				if (Array.isArray(stored)) {
					for (const jid of stored) tcTokenKnownJids.add(jid)
				}
			}

			const pruneEntry = data[TC_TOKEN_PRUNE_TS_KEY]
			if (pruneEntry?.timestamp) {
				lastTcTokenPruneTs = Number(pruneEntry.timestamp)
			}
		} catch {
			/* first run or corrupt index — start fresh */
		}
	})()

	// Capability belongs to the configured auth-state itself. `multiDbStore`
	// alone may be present only for unrelated mirrors, so it must never imply
	// that tctokens are relational/authoritative.
	const trustedContactTokens = authState.keys.trustedContactTokens
	const prekeyUploads = authState.keys.prekeyUploads
	/** Debounced save of the tctoken JID index (5s) */
	const scheduleTcTokenIndexSave = () => {
		// The authoritative adapter enumerates relational rows plus signal_kv ids
		// directly; only that exact capability makes the legacy __index obsolete.
		if (trustedContactTokens) return
		if (tcTokenIndexSaveTimer) clearTimeout(tcTokenIndexSaveTimer)
		tcTokenIndexSaveTimer = setTimeout(async () => {
			try {
				const arr = Array.from(tcTokenKnownJids)
				await authState.keys.set({
					tctoken: {
						[TC_TOKEN_INDEX_KEY]: {
							token: Buffer.from(JSON.stringify(arr), 'utf8'),
							timestamp: unixTimestampSeconds().toString()
						}
					}
				})
			} catch (err) {
				logger.debug({ err }, 'failed to persist tctoken index')
			}
		}, 5000)
	}

	/** Delete expired tctokens — runs at most once per 24h when coming online */
	const pruneExpiredTcTokens = async () => {
		if (trustedContactTokens) {
			await tcTokenIndexLoaded
			const candidates = new Set<string>()
			try {
				for (const { jid } of trustedContactTokens.listIncoming()) candidates.add(jid)
			} catch (err) {
				logger.warn(
					{ err, reason: 'relational-enumeration-failed', fallback: 'signal_kv-listIds' },
					'tctoken prune: relational enumeration failed; continuing with legacy superset'
				)
			}

			// signal_kv is deliberately retained as a complete superset, so its ids
			// cover pre-migration contacts and temporary relational-list failures
			// without relying on the race-prone __index value.
			if (authState.keys.listIds) {
				try {
					for await (const jid of authState.keys.listIds('tctoken')) {
						if (jid.includes('@')) candidates.add(jid)
					}
				} catch (err) {
					logger.warn(
						{ err, reason: 'signal-kv-enumeration-failed', fallback: 'legacy-__index' },
						'tctoken prune: signal_kv id enumeration failed; using persisted legacy index'
					)
					for (const jid of tcTokenKnownJids) if (jid.includes('@')) candidates.add(jid)
				}
			} else {
				for (const jid of tcTokenKnownJids) if (jid.includes('@')) candidates.add(jid)
			}

			if (candidates.size === 0) return
			const allData = await authState.keys.get('tctoken', Array.from(candidates))
			let pruned = 0
			let refreshed = 0
			for (const jid of candidates) {
				const entry = allData[jid]
				if (!entry?.token || entry.token.length === 0 || !isTcTokenExpired(entry.timestamp)) continue
				const expectedTimestamp = Number(entry.timestamp ?? 0)
				if (await trustedContactTokens.compareAndPrune(jid, expectedTimestamp, entry.token)) pruned++
				else refreshed++ // changed after the snapshot; leave the new token intact
			}

			if (pruned > 0 || refreshed > 0) {
				logTcToken('prune', {
					pruned,
					refreshedDuringPrune: refreshed,
					via: 'wa_trusted_contacts+signal_kv-superset'
				})
			}

			return
		}

		// Legacy (single-file / no multi-db): __index-backed enumeration.
		await tcTokenIndexLoaded
		const pruneSet: Record<string, null> = {}
		const survivingJids: string[] = []

		const jidsToCheck = Array.from(tcTokenKnownJids).filter(j => j !== TC_TOKEN_INDEX_KEY)
		if (!jidsToCheck.length) return

		try {
			const allData = await authState.keys.get('tctoken', jidsToCheck)
			for (const jid of jidsToCheck) {
				const entry = allData[jid]
				if (!entry?.token || isTcTokenExpired(entry.timestamp)) {
					pruneSet[jid] = null
				} else {
					survivingJids.push(jid)
				}
			}
		} catch {
			return // batch read failed — skip this pruning cycle
		}

		const pruneCount = Object.keys(pruneSet).length
		if (pruneCount > 0) {
			await authState.keys.set({ tctoken: pruneSet })
			tcTokenKnownJids.clear()
			for (const jid of survivingJids) tcTokenKnownJids.add(jid)
			scheduleTcTokenIndexSave()
			logTcToken('prune', { pruned: pruneCount, remaining: survivingJids.length })
		}
	}
	// ======= END tctoken index tracking =======

	const fetchMessageHistory = async (
		count: number,
		oldestMsgKey: WAMessageKey,
		oldestMsgTimestamp: number | Long
	): Promise<string> => {
		if (!authState.creds.me?.id) {
			throw new Boom('Not authenticated')
		}

		const pdoMessage: proto.Message.IPeerDataOperationRequestMessage = {
			historySyncOnDemandRequest: {
				chatJid: oldestMsgKey.remoteJid,
				oldestMsgFromMe: oldestMsgKey.fromMe,
				oldestMsgId: oldestMsgKey.id,
				oldestMsgTimestampMs: oldestMsgTimestamp,
				onDemandMsgCount: count
			},
			peerDataOperationRequestType: proto.Message.PeerDataOperationRequestType.HISTORY_SYNC_ON_DEMAND
		}

		return sendPeerDataOperationMessage(pdoMessage)
	}

	const requestPlaceholderResend = async (
		messageKey: WAMessageKey,
		msgData?: PlaceholderMessageData
	): Promise<string | undefined> => {
		if (!authState.creds.me?.id) {
			throw new Boom('Not authenticated')
		}

		// Stage 9 (upstream #2579): guard against an undefined `messageKey.id`.
		// Without this, the lock would acquire on the empty-string id
		// (serializing every id-less caller through a single bucket) and the
		// cache get/set would hit `undefined` as a key. Up the call stack
		// `messageKey` is non-optional so the `id` check is the only real
		// concern.
		if (!messageKey.id) {
			logger.warn({ messageKey }, 'requestPlaceholderResend called with undefined message id')
			return
		}

		const resendId = messageKey.id

		// Stage 9 (upstream #2579): collapse the previous `get → set` cache-
		// dedupe into one per-id critical section so two concurrent callers
		// can't both observe an empty cache and both fire the resend.
		//
		// PR #490 review (Cubic P1): track whether the marker was actually
		// persisted. `safeCacheSet` swallows maxKeys saturation, so if the
		// cache is full the marker write becomes a no-op — and the post-delay
		// `'RESOLVED'` check (which infers "message arrived during the delay"
		// from cache miss) would incorrectly drop the resend silently. When
		// the marker write fails, we still need to proceed with the PDO send
		// and skip the early-return branch entirely.
		let markerWritten = false
		const alreadyHandled = await placeholderResendLocks.withLock(
			{ namespace: '__placeholder_resend__', id: resendId },
			async () => {
				const alreadyRequested = await placeholderResendCache.get<PlaceholderMessageData | boolean>(resendId)
				if (alreadyRequested) {
					logger.debug({ messageKey }, 'already requested resend')
					return true
				}

				// Temporarily mark as requested using message ID to prevent race conditions.
				// BOT-001-B: maxKeys saturation falls back to debug log instead of throwing.
				// PR #490 Cubic P1 fix: track markerWritten explicitly so the post-delay
				// `'RESOLVED'` branch only fires when we genuinely persisted the marker —
				// `safeCacheSet`'s silent swallow would otherwise be indistinguishable from
				// the legitimate "message arrived during the delay" cache miss.
				try {
					await placeholderResendCache.set(resendId, true)
					markerWritten = true
				} catch (err) {
					const msg = (err as Error)?.message ?? ''
					if (!msg.includes('max keys') && !msg.includes('ECACHEFULL')) {
						throw err
					}

					logger.debug(
						{ resendId },
						'placeholderResendCache full, marker skipped (will still send PDO unconditionally)'
					)
				}

				return false
			}
		)
		if (alreadyHandled) return

		await delay(2000)

		// Check if message was received during delay.
		// PR #490 review (Cubic P1): only trust the cache-miss → 'RESOLVED' inference
		// when we actually persisted the marker. If markerWritten=false the cache miss
		// reflects "we never wrote it" (cache was full), NOT "message arrived during delay"
		// — skip the early return and let the PDO go out unconditionally.
		if (markerWritten && !(await placeholderResendCache.get<PlaceholderMessageData | boolean>(resendId))) {
			logger.debug({ messageKey }, 'message received while resend requested')
			return 'RESOLVED'
		}

		const pdoMessage = {
			placeholderMessageResendRequest: [
				{
					messageKey
				}
			],
			peerDataOperationRequestType: proto.Message.PeerDataOperationRequestType.PLACEHOLDER_MESSAGE_RESEND
		}

		// Send PDO and get stanzaId (PDO request ID)
		const stanzaId = await sendPeerDataOperationMessage(pdoMessage)

		// CRITICAL FIX: Store metadata using stanzaId (not messageKey.id)
		// The PDO response will use stanzaId to identify which request it's responding to.
		// BOT-001-B: safeCacheSet swallows maxKeys saturation — losing this entry only
		// means the eventual PDO response won't find its metadata, which is recoverable
		// (downstream code already handles missing cache entries).
		if (msgData && stanzaId) {
			await safeCacheSet(placeholderResendCache, stanzaId, msgData, logger, 'placeholderResendCache')
			logger.debug(
				{ messageKey: messageKey.id, stanzaId },
				'CTWA: Cached metadata using stanzaId for PDO response lookup'
			)
		}

		// Clean up message ID marker after storing with stanzaId
		await placeholderResendCache.del(resendId)

		// Cleanup timeout: if no response after 8s, assume phone is offline.
		// Audit memory-leak Finding 6 — timer agora rastreado em `pdoCleanupTimers`
		// pra que `registerSocketEndHandler` cancele todos os pendentes no disconnect.
		const cleanupTimer: ReturnType<typeof setTimeout> = setTimeout(async () => {
			pdoCleanupTimers.delete(cleanupTimer)
			if (await placeholderResendCache.get<PlaceholderMessageData | boolean>(stanzaId)) {
				logger.debug({ stanzaId }, 'PDO message without response after 8 seconds. Phone possibly offline')
				await placeholderResendCache.del(stanzaId)
			}
		}, 8_000)
		pdoCleanupTimers.add(cleanupTimer)

		return stanzaId
	}

	// ============================================================
	// Server-push mex notifications — port de upstream `c89d97b13b`
	// (PR #2445). Dispatch unificado entre os ops legados de
	// newsletter (que continuam usando `<mex>` child) e os ops novos
	// de reachout timelock + message capping (que vêm em `<update>`).
	// ============================================================

	const handleReachoutTimelockNotification = (data: Record<string, unknown>) => {
		const payload = data.xwa2_notify_account_reachout_timelock as
			| { is_active?: boolean; enforcement_type?: string; time_enforcement_ends?: string }
			| undefined

		if (!payload) {
			logger.warn('reachout timelock notification missing payload')
			return
		}

		if (!payload.is_active) {
			logger.info('reachout timelock restriction lifted')
			ev.emit('connection.update', {
				reachoutTimeLock: {
					isActive: false,
					enforcementType: ReachoutTimelockEnforcementType.DEFAULT
				}
			})
			return
		}

		// NaN guard — servidor pode mandar "abc", "0", "1abc"; sem proteção
		// caímos em `Invalid Date` ou epoch (1970). Fallback now+60s se o
		// timestamp for inválido OU ausente (audit SEC-01). WA Web tem o
		// mesmo default.
		const tsRaw = payload.time_enforcement_ends
		const tsParsed = tsRaw && tsRaw !== '0' ? parseInt(tsRaw, 10) : NaN
		const timeEnforcementEnds =
			Number.isFinite(tsParsed) && tsParsed > 0 ? new Date(tsParsed * 1000) : new Date(Date.now() + 60_000)

		const enforcementType = isValidEnforcementType(payload.enforcement_type)
			? payload.enforcement_type
			: ReachoutTimelockEnforcementType.DEFAULT

		logger.info({ enforcementType, timeEnforcementEnds }, 'reachout timelock restriction set')

		ev.emit('connection.update', {
			reachoutTimeLock: {
				isActive: true,
				timeEnforcementEnds,
				enforcementType
			}
		})
	}

	const handleMessageCappingNotification = (data: Record<string, unknown>) => {
		const payload = data.xwa2_notify_new_chat_messages_capping_info_update as NewChatMessageCapInfo | undefined
		if (!payload) {
			logger.warn('message capping notification missing payload')
			return
		}

		logger.info({ payload }, 'received message capping update')
		ev.emit('message-capping.update', payload)
	}

	// Username @-handle notifications (2026 rollout). The handler bodies
	// live in `Utils/username-notifications.ts` so they're testable
	// without a full socket bring-up — this file just provides the
	// `(ev, logger)` closure they need.
	const handleUsernameSetNotification = (data: Record<string, unknown>) =>
		handleUsernameSetNotificationImpl(data, ev, logger)
	const handleUsernameDeleteNotification = (data: Record<string, unknown>) =>
		handleUsernameDeleteNotificationImpl(data, ev, logger)
	const handleUsernameSideSubNotification = (data: Record<string, unknown>) =>
		handleUsernameSideSubNotificationImpl(data, logger)

	const mexDiagnosticCounters = new Map<string, { total: number; windowStart: number; emitted: number }>()
	const logMexDiagnostic = (node: BinaryNode, reason: MexDiagnosticReason, opName: string | null, content: unknown) => {
		const key = `${reason}:${(opName ?? '<missing>').slice(0, 128)}`
		const now = Date.now()
		if (!mexDiagnosticCounters.has(key) && mexDiagnosticCounters.size >= 256) {
			const oldestKey = mexDiagnosticCounters.keys().next().value
			if (oldestKey) mexDiagnosticCounters.delete(oldestKey)
		}

		const state = mexDiagnosticCounters.get(key) ?? { total: 0, windowStart: now, emitted: 0 }
		state.total++
		if (now - state.windowStart >= 60_000) {
			state.windowStart = now
			state.emitted = 0
		}

		mexDiagnosticCounters.set(key, state)
		if (state.emitted >= 5) return
		state.emitted++

		logger.warn(
			{
				...buildMexDiagnostic({
					reason,
					opName,
					from: node.attrs.from,
					stanzaId: node.attrs.id,
					timestamp: node.attrs.t,
					content
				}),
				occurrences: state.total
			},
			'MEX notification rejected'
		)
	}

	// Handles mex newsletter notifications
	const handleMexNewsletterNotification = async (node: BinaryNode) => {
		const mexNode = getBinaryNodeChild(node, 'mex')
		if (!mexNode?.content) {
			logMexDiagnostic(node, 'invalid_payload_shape', null, mexNode?.content)
			return
		}

		let data: any
		try {
			// Narrow payload content type before JSON.parse:
			// content can be string (UTF-16 internally), Uint8Array, Buffer, or
			// (defensively) an unexpected array of BinaryNodes.
			//
			// IMPORTANT: when content is already a JS string, parse it directly.
			// `Buffer.from(str, 'binary')` would treat it as latin1, corrupting any
			// non-ASCII payload (newsletter names with accents/emojis, etc.).
			const payloadContent = mexNode.content
			if (Array.isArray(payloadContent)) {
				logMexDiagnostic(node, 'invalid_payload_shape', mexNode.attrs?.op_name ?? null, payloadContent)
				return
			}

			const jsonText =
				typeof payloadContent === 'string' ? payloadContent : Buffer.from(payloadContent).toString('utf8')
			data = JSON.parse(jsonText)
		} catch (error) {
			logMexDiagnostic(node, 'invalid_json', mexNode.attrs?.op_name ?? null, mexNode.content)
			return
		}

		// Some mex payloads (e.g. xwa2_notify_linked_profiles) declare the operation
		// in the node `op_name` attribute rather than inside the JSON body. Without
		// this fallback the `!operation` guard below would silently drop them.
		const rawOperation = data?.operation ?? mexNode.attrs?.op_name
		const operation = normalizeMexOperation(rawOperation)
		let updates = data?.updates
		// xwa2_notify_linked_profiles payloads arrive with a different shape; normalize
		// into the same `updates` array consumed by the switch below.
		if (!updates) {
			const linkedProfiles = data?.data?.xwa2_notify_linked_profiles
			if (linkedProfiles) {
				updates = [linkedProfiles]
			}
		}

		if (!Array.isArray(updates) || !operation) {
			logMexDiagnostic(
				node,
				operation ? 'invalid_payload_shape' : 'missing_op_name',
				typeof rawOperation === 'string' ? rawOperation : null,
				mexNode.content
			)
			return
		}

		logger.debug({ operation, updateCount: Array.isArray(updates) ? updates.length : 0 }, 'got mex notification')

		switch (operation) {
			case 'notificationnewsletterupdate':
				for (const update of updates) {
					if (update.jid && update.settings && Object.keys(update.settings).length > 0) {
						ev.emit('newsletter-settings.update', {
							id: update.jid,
							update: update.settings
						})
					}
				}

				break

			case 'notificationnewsletteradminpromote':
				for (const update of updates) {
					if (update.jid && update.user) {
						const [resolvedAuthor, resolvedUser] = await Promise.all([
							resolveLidToPn(node.attrs.from, signalRepository.lidMapping, logger),
							resolveLidToPn(update.user, signalRepository.lidMapping, logger)
						])
						ev.emit('newsletter-participants.update', {
							id: update.jid,
							author: resolvedAuthor || node.attrs.from!,
							user: resolvedUser || update.user,
							new_role: 'ADMIN',
							action: 'promote'
						})
					}
				}

				break

			case 'notificationlinkedprofilesupdates': {
				// Collect LID→PN mappings from added_profiles into a single batched emit —
				// matches InfiniteAPI's centralized pattern (process-message.ts:441) so the
				// chats.ts:1560 listener performs one storeLIDPNMappings call per notification.
				const mappings: LIDMapping[] = []
				for (const update of updates) {
					const lid = update?.jid
					const addedProfiles = Array.isArray(update?.added_profiles) ? update.added_profiles : []
					for (const profile of addedProfiles) {
						const pn = typeof profile === 'string' ? profile : (profile?.pn ?? profile?.jid ?? null)
						if (lid && pn) {
							mappings.push({ lid, pn })
						}
					}
				}

				if (mappings.length > 0) {
					ev.emit('lid-mapping.update', mappings)
				}

				break
			}

			default:
				logMexDiagnostic(node, 'unknown_op_name', String(rawOperation), mexNode.content)
				break
		}
	}

	/**
	 * Dispatcher principal de mex notifications. Trata ops novos (reachout/capping)
	 * que vêm em `<update op_name=...>` e delega o resto pro handler legado de
	 * newsletter, que opera com `<mex>` child. Mantém compat com fluxos existentes.
	 *
	 * Declarado DEPOIS de `handleMexNewsletterNotification` pra eliminar a
	 * forward reference que o eslint/no-use-before-define flagaria (audit
	 * PROTO-02).
	 */
	const handleMexNotification = async (node: BinaryNode) => {
		const updateNode = getBinaryNodeChild(node, 'update')
		const rawOpName = updateNode?.attrs?.op_name
		const opName = normalizeMexOperation(rawOpName)

		if (updateNode && !opName) {
			logMexDiagnostic(node, 'missing_op_name', null, updateNode.content)
			return
		}

		if (updateNode && opName === 'textstatusupdatenotificationsidesub') {
			if (!updateNode.content || Array.isArray(updateNode.content)) {
				logger.warn({ opName }, 'text-status side-sub notification has no valid content')
				return
			}

			try {
				const update = parseTextStatusSideSubNotification(updateNode.content)
				if (!update) {
					logger.warn({ opName }, 'text-status side-sub notification is missing its hash')
					return
				}

				ev.emit('text-status-side-sub.update', { from: node.attrs.from, hash: update.hash })
				logger.debug({ opName }, 'received text-status side-sub notification')
			} catch (err) {
				logger.error({ err, opName }, 'failed to parse text-status side-sub notification')
			}

			return
		}

		if (updateNode && opName === 'textstatusupdatenotification') {
			if (!updateNode.content || Array.isArray(updateNode.content)) {
				logger.warn({ opName }, 'text-status notification has no valid content')
				return
			}

			try {
				const update = parseTextStatusUpdateNotification(updateNode.content)
				if (!update) {
					logger.warn({ opName }, 'text-status notification has invalid content')
					return
				}

				ev.emit('text-status.update', { from: node.attrs.from, ...update })
				logger.debug({ opName, jid: update.jid }, 'received text-status notification')
			} catch (err) {
				logger.error({ err, opName }, 'failed to parse text-status notification')
			}

			return
		}

		if (updateNode && opName === 'notificationuserreachouttimelockupdate') {
			// NULL-001 fix (PR #487 review): guard explicit `null/undefined content`
			// up-front instead of relying on the non-null assertion and the outer
			// catch. The try/catch already mitigated the TypeError, but skipping
			// the parse for a bodyless <update> avoids the noise log entry.
			if (!updateNode.content) {
				logger.debug({ opName }, 'reachout timelock notification has no content, skipping')
			} else if (Array.isArray(updateNode.content)) {
				logger.warn({ opName }, 'reachout timelock notification content is a node array, expected string/binary')
			} else {
				try {
					const raw = updateNode.content
					const text = typeof raw === 'string' ? raw : Buffer.from(raw).toString('utf8')
					const parsed = JSON.parse(text) as { data?: Record<string, unknown> }
					if (parsed?.data) handleReachoutTimelockNotification(parsed.data)
				} catch (err) {
					logger.error({ err, opName }, 'failed to parse reachout timelock notification')
				}
			}

			return
		}

		// Username @-handle notifications (2026 rollout). Same envelope
		// as reachout/capping above; just different op_name + xwa2_ key.
		const usernameOpHandlers: Record<string, (data: Record<string, unknown>) => void> = {
			usernamesetnotification: handleUsernameSetNotification,
			usernamedeletenotification: handleUsernameDeleteNotification,
			usernameupdatenotification: handleUsernameSideSubNotification
		}

		// `hasOwnProperty.call` (not `in`) — the latter would match
		// prototype keys like `constructor`/`toString`, letting a
		// malicious server route those op_names into our handlers.
		// (audit P2-1) `Object.hasOwn` would read cleaner but it is
		// ES2022 and tsconfig.lib here is older.
		if (updateNode && opName && Object.prototype.hasOwnProperty.call(usernameOpHandlers, opName)) {
			if (!updateNode.content) {
				logger.debug({ opName }, 'username notification has no content, skipping')
			} else {
				try {
					// `.toString()` on a Uint8Array (not a Buffer) yields
					// `"byte,byte,byte"` not the UTF-8 text — `JSON.parse`
					// then throws and the notification is silently lost.
					// Route through `Buffer.from(...).toString('utf8')`
					// which handles both string and binary content
					// uniformly. Matches the pattern in the newsletter
					// admin-promotion parser above (audit release-#583
					// review item #2). The neighbouring reachout-timelock
					// + message-capping branches in this same dispatcher
					// have the same latent bug and should be fixed in a
					// separate follow-up — out of scope for this PR.
					const raw = updateNode.content
					let text = ''
					if (typeof raw === 'string') {
						text = raw
					} else if (raw instanceof Uint8Array) {
						text = Buffer.from(raw).toString('utf8')
					}

					const parsed = JSON.parse(text) as { data?: Record<string, unknown> }
					if (parsed?.data) usernameOpHandlers[opName]!(parsed.data)
				} catch (err) {
					logger.error({ err, opName }, 'failed to parse username notification')
				}
			}

			return
		}

		if (updateNode && opName === 'messagecappinginfonotification') {
			// NULL-001 fix (PR #487 review): same guard as the reachout-timelock
			// branch above — explicit null/undefined check on content avoids the
			// non-null assertion and the TypeError-as-log noise.
			if (!updateNode.content) {
				logger.debug({ opName }, 'message capping notification has no content, skipping')
			} else if (Array.isArray(updateNode.content)) {
				logger.warn({ opName }, 'message capping notification content is a node array, expected string/binary')
			} else {
				try {
					const raw = updateNode.content
					const text = typeof raw === 'string' ? raw : Buffer.from(raw).toString('utf8')
					const parsed = JSON.parse(text) as { data?: Record<string, unknown> }
					if (parsed?.data) handleMessageCappingNotification(parsed.data)
				} catch (err) {
					logger.error({ err, opName }, 'failed to parse message capping notification')
				}
			}

			return
		}

		if (updateNode) {
			logMexDiagnostic(node, 'unknown_op_name', rawOpName ?? null, updateNode.content)
			return
		}

		// Legacy newsletter envelopes use a <mex> child instead of <update>.
		await handleMexNewsletterNotification(node)
	}

	// Handles newsletter notifications
	const handleNewsletterNotification = async (node: BinaryNode) => {
		const from = node.attrs.from!
		const children = getAllBinaryNodeChildren(node)
		const rawAuthor = node.attrs.participant!
		// Resolve author LID→PN (participant is a user JID that could be LID)
		const author = (await resolveLidToPn(rawAuthor, signalRepository.lidMapping, logger)) || rawAuthor

		for (const child of children) {
			logger.debug({ from, child }, 'got newsletter notification')

			switch (child.tag) {
				case 'reaction': {
					const reactionUpdate = {
						id: from,
						server_id: child.attrs.message_id!,
						reaction: {
							code: getBinaryNodeChildString(child, 'reaction'),
							count: 1
						}
					}
					ev.emit('newsletter.reaction', reactionUpdate)
					break
				}

				case 'view': {
					const viewUpdate = {
						id: from,
						server_id: child.attrs.message_id!,
						count: parseInt(child.content?.toString() || '0', 10)
					}
					ev.emit('newsletter.view', viewUpdate)
					break
				}

				case 'participant': {
					const resolvedParticipantUser =
						(await resolveLidToPn(child.attrs.jid, signalRepository.lidMapping, logger)) || child.attrs.jid!
					const participantUpdate = {
						id: from,
						author,
						user: resolvedParticipantUser,
						action: child.attrs.action!,
						new_role: child.attrs.role!
					}
					ev.emit('newsletter-participants.update', participantUpdate)
					break
				}

				case 'update': {
					const settingsNode = getBinaryNodeChild(child, 'settings')
					if (settingsNode) {
						const update: Record<string, any> = {}
						const nameNode = getBinaryNodeChild(settingsNode, 'name')
						if (nameNode?.content) update.name = nameNode.content.toString()

						const descriptionNode = getBinaryNodeChild(settingsNode, 'description')
						if (descriptionNode?.content) update.description = descriptionNode.content.toString()

						ev.emit('newsletter-settings.update', {
							id: from,
							update
						})
					}

					break
				}

				case 'message': {
					const plaintextNode = getBinaryNodeChild(child, 'plaintext')
					if (plaintextNode?.content) {
						try {
							const contentBuf =
								typeof plaintextNode.content === 'string'
									? Buffer.from(plaintextNode.content, 'binary')
									: Buffer.from(plaintextNode.content as Uint8Array)
							const messageProto = proto.Message.decode(contentBuf).toJSON()
							const fullMessage = proto.WebMessageInfo.fromObject({
								key: {
									remoteJid: from,
									id: child.attrs.message_id || child.attrs.server_id,
									fromMe: false // TODO: is this really true though
								},
								message: messageProto,
								messageTimestamp: +child.attrs.t!
							}).toJSON() as WAMessage
							await upsertMessage(fullMessage, 'append')
							logger.debug('Processed plaintext newsletter message')
						} catch (error) {
							logger.error({ error }, 'Failed to decode plaintext newsletter message')
						}
					}

					break
				}

				default:
					logger.warn(
						{ node: summarizeInboundNode(node), child: summarizeInboundNode(child) },
						'Unknown newsletter notification child'
					)
					break
			}
		}
	}

	const sendMessageAck = async (node: BinaryNode, errorCode?: number): Promise<boolean> => {
		// Once teardown starts, do not emit ACK/NACK on the closing transport.
		// The server can redeliver the unacknowledged stanza after reconnect;
		// this is safer than acknowledging work whose transaction may roll
		// back. The check is synchronous and adds no wait to message delivery.
		if (isSocketClosed()) {
			logger.debug({ tag: node.tag, msgId: node.attrs.id }, 'ack skipped because the socket is closing')
			return false
		}

		// buildAckStanza mirrors WA Web: always emit `type` when present, and `from=meId` for
		// message-class ACKs WHEN we know our id. We intentionally do NOT hard-fail when `me` is
		// momentarily unset (reconnect/pairing edge): buildAckStanza simply omits `from`, so the
		// ACK still goes out instead of throwing and letting the server retry forever (Codex #440).
		const meId = authState.creds.me?.id
		const stanza = buildAckStanza(node, errorCode, meId)

		// Best-effort pre-ack mirror (axolotl.db `preacks`): persist the encoded
		// ack BEFORE sending, drop THIS ack's row AFTER it goes out. During
		// teardown, delete the unsent row and leave server redelivery eligible;
		// we do not replay an ack that never reached the transport. Deleting by
		// exact row id (not a `_id <= ?` prefix drain) keeps concurrent acks
		// isolated. Any mirror error is logged and the ack still sends.
		let preackId: number | undefined
		if (signalTypedBackend && node.tag === 'message') {
			try {
				preackId = signalTypedBackend.enqueuePreack(encodeBinaryNode(stanza))
			} catch (err) {
				logger.debug({ err, msgId: node.attrs.id }, 'preacks mirror: enqueue failed (ignored)')
			}
		}

		try {
			await sendNode(stanza)
		} catch (error) {
			if (isExpectedSocketTeardownError(error)) {
				if (signalTypedBackend && preackId !== undefined) {
					try {
						signalTypedBackend.deletePreack(preackId)
					} catch (err) {
						logger.debug({ err, msgId: node.attrs.id }, 'preacks mirror: teardown cleanup failed (ignored)')
					}
				}

				logger.debug({ tag: node.tag, msgId: node.attrs.id }, 'ack cancelled by socket teardown')
				return false
			}

			throw error
		}

		logger.debug({ recv: { tag: node.tag, attrs: node.attrs }, sent: stanza.attrs }, 'sent ack')

		if (signalTypedBackend && preackId !== undefined) {
			try {
				signalTypedBackend.deletePreack(preackId)
			} catch (err) {
				logger.debug({ err, msgId: node.attrs.id }, 'preacks mirror: delete failed (ignored)')
			}
		}

		return true
	}

	const rejectCall = async (callId: string, callFrom: string) => {
		const meId = authState.creds.me?.id
		if (!meId) throw new Boom('Not authenticated', { statusCode: 401 })
		const stanza: BinaryNode = {
			tag: 'call',
			attrs: {
				from: meId,
				to: callFrom
			},
			content: [
				{
					tag: 'reject',
					attrs: {
						'call-id': callId,
						'call-creator': callFrom,
						count: '0'
					},
					content: undefined
				}
			]
		}
		await query(stanza)
	}

	/**
	 * Offer (initiate) a call to a JID.
	 * Structure verified via Frida capture on WhatsApp Android v2.26.
	 *
	 * @param jid - destination JID (e.g. "5511999999999@s.whatsapp.net" or LID)
	 * @param isVideo - true for video call, false/undefined for voice
	 * @returns callId (hex) and stanzaId used in the offer
	 */
	const offerCall = async (jid: string, isVideo?: boolean) => {
		const meId = authState.creds.me?.id
		if (!meId) throw new Boom('Not authenticated', { statusCode: 401 })

		const callId = randomBytes(16).toString('hex').toUpperCase()
		const stanzaId = randomBytes(16).toString('hex').toUpperCase()

		const offerContent: BinaryNode[] = [
			{ tag: 'privacy', attrs: {}, content: undefined },
			{ tag: 'audio', attrs: { rate: '8000', enc: 'opus' }, content: undefined },
			{ tag: 'audio', attrs: { rate: '16000', enc: 'opus' }, content: undefined }
		]

		if (isVideo) {
			offerContent.push({
				tag: 'video',
				attrs: {
					screen_width: '1080',
					screen_height: '2400',
					dec: 'H264,H265,AV1',
					device_orientation: '0',
					enc: 'h.264'
				},
				content: undefined
			})
		}

		offerContent.push(
			{ tag: 'net', attrs: { medium: '3' }, content: undefined },
			{ tag: 'capability', attrs: { ver: '1' }, content: undefined },
			{ tag: 'enc', attrs: { v: '2', type: isVideo ? 'msg' : 'pkmsg' }, content: undefined },
			{ tag: 'encopt', attrs: { keygen: '2' }, content: undefined }
		)

		// Voice calls include device-identity (verified via Frida capture)
		if (!isVideo) {
			offerContent.push({ tag: 'device-identity', attrs: {}, content: undefined })
		}

		const stanza: BinaryNode = {
			tag: 'call',
			attrs: {
				to: jid,
				id: stanzaId
			},
			content: [
				{
					tag: 'offer',
					attrs: {
						'call-creator': meId,
						'call-id': callId,
						device_class: '2013'
					},
					content: offerContent
				}
			]
		}

		await query(stanza)
		return { callId, stanzaId }
	}

	/**
	 * Terminate (hang up) an active or ringing call.
	 * Structure verified via Frida capture on WhatsApp Android v2.26.
	 *
	 * @param callId - the call-id from the offer
	 * @param callTo - JID of the other party
	 * @param callCreator - JID of who created the call (usually meId for outgoing)
	 * @param reason - terminate reason (omit for normal hangup, or 'timeout', 'busy', etc.)
	 * @param duration - call duration in ms (included when call was connected)
	 */
	const terminateCall = async (
		callId: string,
		callTo: string,
		callCreator?: string,
		reason?: string,
		duration?: number
	) => {
		const meId = authState.creds.me?.id
		if (!meId) throw new Boom('Not authenticated', { statusCode: 401 })

		const terminateAttrs: Record<string, string> = {
			'call-id': callId,
			'call-creator': callCreator || meId
		}

		if (reason) {
			terminateAttrs.reason = reason
		}

		if (typeof duration === 'number') {
			terminateAttrs.duration = String(duration)
			terminateAttrs.audio_duration = String(duration)
		}

		const stanza: BinaryNode = {
			tag: 'call',
			attrs: {
				to: callTo,
				id: randomBytes(16).toString('hex').toUpperCase()
			},
			content: [
				{
					tag: 'terminate',
					attrs: terminateAttrs,
					content: undefined
				}
			]
		}

		await query(stanza)
	}

	/**
	 * Accept (answer) an incoming call.
	 * Structure verified via Frida capture on WhatsApp Android v2.26.
	 *
	 * @param callId - the call-id from the incoming offer
	 * @param callFrom - JID of the caller (call-creator)
	 * @param isVideo - true for video call
	 */
	const acceptCall = async (callId: string, callFrom: string, isVideo?: boolean) => {
		const meId = authState.creds.me?.id
		if (!meId) throw new Boom('Not authenticated', { statusCode: 401 })

		const acceptContent: BinaryNode[] = [{ tag: 'audio', attrs: { rate: '16000', enc: 'opus' }, content: undefined }]

		if (isVideo) {
			acceptContent.push({
				tag: 'video',
				attrs: {
					dec: 'H264,AV1',
					device_orientation: '1'
				},
				content: undefined
			})
		}

		acceptContent.push(
			{ tag: 'net', attrs: { medium: '2' }, content: undefined },
			{ tag: 'encopt', attrs: { keygen: '2' }, content: undefined }
		)

		const stanza: BinaryNode = {
			tag: 'call',
			attrs: {
				from: meId,
				to: callFrom,
				id: randomBytes(16).toString('hex').toUpperCase()
			},
			content: [
				{
					tag: 'accept',
					attrs: {
						'call-id': callId,
						'call-creator': callFrom
					},
					content: acceptContent
				}
			]
		}

		await query(stanza)
	}

	/**
	 * Send preaccept signal for an incoming call (indicates device capabilities).
	 * Sent before accept to communicate supported codecs.
	 * Structure verified via Frida capture on WhatsApp Android v2.26.
	 *
	 * @param callId - the call-id from the incoming offer
	 * @param callCreator - JID of the caller
	 * @param isVideo - true for video call
	 */
	const preacceptCall = async (callId: string, callCreator: string, isVideo?: boolean) => {
		const preacceptContent: BinaryNode[] = [{ tag: 'audio', attrs: { rate: '16000', enc: 'opus' }, content: undefined }]

		if (isVideo) {
			preacceptContent.push({
				tag: 'video',
				attrs: {
					screen_width: '1080',
					screen_height: '2400',
					dec: 'H264,H265,AV1',
					device_orientation: '0'
				},
				content: undefined
			})
		}

		preacceptContent.push(
			{ tag: 'encopt', attrs: { keygen: '2' }, content: undefined },
			{ tag: 'capability', attrs: { ver: '1' }, content: undefined }
		)

		const stanza: BinaryNode = {
			tag: 'call',
			attrs: {
				to: callCreator,
				id: randomBytes(16).toString('hex').toUpperCase()
			},
			content: [
				{
					tag: 'preaccept',
					attrs: {
						'call-id': callId,
						'call-creator': callCreator
					},
					content: preacceptContent
				}
			]
		}

		await query(stanza)
	}

	/**
	 * Report relay latency measurements to the server.
	 * Sent after receiving relay info to report measured latency per relay server.
	 * Structure verified via Frida capture on WhatsApp Android v2.26.
	 *
	 * @param callId - the call-id
	 * @param callCreator - JID of the call creator
	 * @param relays - array of relay measurements
	 * @param transactionId - optional transaction ID for group calls
	 */
	const sendRelayLatency = async (
		callId: string,
		callCreator: string,
		relays: Array<{
			relayName?: string
			latency: number
			relayId?: string
			dlBw?: number
			ulBw?: number
		}>,
		transactionId?: string
	) => {
		const relayLatencyAttrs: Record<string, string> = {
			'call-id': callId,
			'call-creator': callCreator
		}

		if (transactionId) {
			relayLatencyAttrs['transaction-id'] = transactionId
		}

		const teChildren: BinaryNode[] = relays.map(r => {
			const teAttrs: Record<string, string> = {}
			if (r.relayName) {
				teAttrs.relay_name = r.relayName
			}

			teAttrs.latency = String(r.latency)
			if (r.relayId) {
				teAttrs.relay_id = r.relayId
			}

			if (r.dlBw !== undefined) {
				teAttrs.dl_bw = String(r.dlBw)
			}

			if (r.ulBw !== undefined) {
				teAttrs.ul_bw = String(r.ulBw)
			}

			return { tag: 'te', attrs: teAttrs, content: undefined }
		})

		const stanza: BinaryNode = {
			tag: 'call',
			attrs: {
				to: callCreator,
				id: randomBytes(16).toString('hex').toUpperCase()
			},
			content: [
				{
					tag: 'relaylatency',
					attrs: relayLatencyAttrs,
					content: teChildren
				}
			]
		}

		await sendNode(stanza)
	}

	/**
	 * Send transport (p2p/ICE) candidates for a call.
	 * Structure verified via Frida capture on WhatsApp Android v2.26.
	 *
	 * @param callId - the call-id
	 * @param callCreator - JID of the call creator
	 * @param to - destination JID
	 * @param candidates - array of candidate entries with priority
	 * @param round - p2p candidate round number
	 */
	const sendTransport = async (
		callId: string,
		callCreator: string,
		to: string,
		candidates: Array<{ priority: string; data?: Uint8Array }>,
		round?: number
	) => {
		const transportAttrs: Record<string, string> = {
			'call-id': callId,
			'call-creator': callCreator,
			'transport-message-type': '1'
		}

		if (round !== undefined) {
			transportAttrs['p2p-cand-round'] = String(round)
		}

		const teChildren: BinaryNode[] = candidates.map(c => ({
			tag: 'te',
			attrs: { priority: c.priority },
			content: c.data
		}))

		const stanza: BinaryNode = {
			tag: 'call',
			attrs: {
				to,
				id: randomBytes(16).toString('hex').toUpperCase()
			},
			content: [
				{
					tag: 'transport',
					attrs: transportAttrs,
					content: teChildren
				}
			]
		}

		await sendNode(stanza)
	}

	/**
	 * Send call duration log to the server after a call ends.
	 * Structure verified via Frida capture on WhatsApp Android v2.26.
	 *
	 * @param callId - the call-id
	 * @param callCreator - JID of the call creator
	 * @param peer - JID of the other party
	 * @param audioDuration - audio duration in ms
	 * @param callType - call type, defaults to '1x1'
	 */
	const sendCallDuration = async (
		callId: string,
		callCreator: string,
		peer: string,
		audioDuration: number,
		callType = '1x1'
	) => {
		const stanza: BinaryNode = {
			tag: 'call',
			attrs: {
				to: 'call',
				id: randomBytes(16).toString('hex').toUpperCase()
			},
			content: [
				{
					tag: 'duration',
					attrs: {
						'call-id': callId,
						'call-creator': callCreator,
						peer,
						audio_duration: String(audioDuration),
						type: callType
					},
					content: undefined
				}
			]
		}

		await sendNode(stanza)
	}

	/**
	 * Mute or unmute during a call (MUTE_V2).
	 * Structure verified via Frida capture on WhatsApp Android v2.26.
	 *
	 * @param callId - the call-id
	 * @param callCreator - JID of the call creator
	 * @param to - destination JID
	 * @param muted - true to mute, false to unmute
	 */
	const muteCall = async (callId: string, callCreator: string, to: string, muted: boolean) => {
		const stanza: BinaryNode = {
			tag: 'call',
			attrs: {
				to,
				id: randomBytes(16).toString('hex').toUpperCase()
			},
			content: [
				{
					tag: 'mute_v2',
					attrs: {
						'mute-state': muted ? '1' : '0',
						'call-id': callId,
						'call-creator': callCreator
					},
					content: undefined
				}
			]
		}

		await sendNode(stanza)
	}

	/**
	 * Send heartbeat to keep a group call alive.
	 * Structure verified via Frida capture on WhatsApp Android v2.26.
	 *
	 * @param callId - the call-id (also used as JID with @call)
	 * @param callCreator - JID of the call creator
	 */
	const sendHeartbeat = async (callId: string, callCreator: string) => {
		const stanza: BinaryNode = {
			tag: 'call',
			attrs: {
				to: `${callId}@call`,
				id: randomBytes(16).toString('hex').toUpperCase()
			},
			content: [
				{
					tag: 'heartbeat',
					attrs: {
						'call-id': callId,
						'call-creator': callCreator
					},
					content: undefined
				}
			]
		}

		await sendNode(stanza)
	}

	/**
	 * Send encryption re-key during a call.
	 * Structure verified via Frida capture on WhatsApp Android v2.26.
	 *
	 * @param callId - the call-id
	 * @param callCreator - JID of the call creator
	 * @param to - destination JID
	 * @param transactionId - transaction ID for the rekey
	 */
	const sendEncRekey = async (callId: string, callCreator: string, to: string, transactionId: string) => {
		const stanza: BinaryNode = {
			tag: 'call',
			attrs: {
				to,
				id: randomBytes(16).toString('hex').toUpperCase()
			},
			content: [
				{
					tag: 'enc_rekey',
					attrs: {
						'transaction-id': transactionId,
						'call-id': callId,
						'call-creator': callCreator
					},
					content: [
						{ tag: 'encopt', attrs: { keygen: '2' }, content: undefined },
						{ tag: 'enc', attrs: { v: '2', type: 'msg' }, content: undefined }
					]
				}
			]
		}

		await sendNode(stanza)
	}

	/**
	 * Send video state change during a call.
	 * Structure verified via Frida capture on WhatsApp Android v2.26.
	 *
	 * @param callId - the call-id
	 * @param callCreator - JID of the call creator
	 * @param to - destination JID
	 * @param enabled - true = video on (state=1), false = video off (state=0)
	 * @param orientation - device orientation (0=portrait, 1=landscape)
	 */
	const sendVideoState = async (
		callId: string,
		callCreator: string,
		to: string,
		enabled: boolean,
		orientation = '1'
	) => {
		const stanza: BinaryNode = {
			tag: 'call',
			attrs: {
				to,
				id: randomBytes(16).toString('hex').toUpperCase()
			},
			content: [
				{
					tag: 'video',
					attrs: {
						'call-id': callId,
						'call-creator': callCreator,
						state: enabled ? '1' : '0',
						device_orientation: orientation
					},
					content: undefined
				}
			]
		}

		await sendNode(stanza)
	}

	/**
	 * Create a call link that others can join.
	 * Structure verified via Frida capture on WhatsApp Android v2.26.
	 *
	 * @param media - 'video' or 'audio'
	 * @returns object with token, full URL, and raw server response
	 */
	const createCallLink = async (
		media: 'video' | 'audio' = 'video',
		event?: { startTime: number },
		timeoutMs?: number
	) => {
		const stanza: BinaryNode = {
			tag: 'call',
			attrs: {
				to: 'call',
				id: randomBytes(16).toString('hex').toUpperCase()
			},
			content: [
				{
					tag: 'link_create',
					attrs: { media },
					content: event
						? [{ tag: 'event', attrs: { start_time: String(event.startTime) }, content: undefined }]
						: undefined
				}
			]
		}

		const response = await query(stanza, timeoutMs)

		// Extract token from server response
		let token: string | undefined
		const linkCreateResp = getBinaryNodeChild(response, 'link_create')
		if (linkCreateResp) {
			token = linkCreateResp.attrs.token || linkCreateResp.attrs['link-token']
		}

		// Fallback: check response attrs directly
		if (!token) {
			token = response.attrs?.token || response.attrs?.['link-token']
		}

		// Fallback: search any child with token/link-token
		if (!token && Array.isArray(response.content)) {
			for (const child of response.content as BinaryNode[]) {
				if (child.attrs?.token || child.attrs?.['link-token']) {
					token = child.attrs.token || child.attrs['link-token']
					break
				}
			}
		}

		// URL format verified via Frida capture: https://call.whatsapp.com/<token>
		const url = token ? `https://call.whatsapp.com/${token}` : undefined

		return { token, url, response }
	}

	/**
	 * Query info about a call link before joining.
	 * Structure verified via Frida capture on WhatsApp Android v2.26.
	 *
	 * @param token - the call link token (from URL: https://call.whatsapp.com/<token>)
	 * @param media - 'video' or 'audio'
	 * @returns server response with call info
	 */
	const queryCallLink = async (token: string, media: 'video' | 'audio' = 'video') => {
		const stanza: BinaryNode = {
			tag: 'call',
			attrs: {
				to: 'call',
				id: randomBytes(16).toString('hex').toUpperCase()
			},
			content: [
				{
					tag: 'link_query',
					attrs: { media, token },
					content: undefined
				}
			]
		}

		return await query(stanza)
	}

	/**
	 * Join a call via its link token.
	 * Structure verified via Frida capture on WhatsApp Android v2.26.
	 *
	 * @param token - the call link token
	 * @param media - 'video' or 'audio'
	 * @returns server response with relay/group info
	 */
	const joinCallLink = async (token: string, media: 'video' | 'audio' = 'video') => {
		const joinContent: BinaryNode[] = [
			{ tag: 'audio', attrs: { rate: '16000', enc: 'opus' }, content: undefined },
			{ tag: 'net', attrs: { medium: '2' }, content: undefined },
			{ tag: 'capability', attrs: { ver: '1' }, content: undefined }
		]

		if (media === 'video') {
			joinContent.splice(1, 0, {
				tag: 'video',
				attrs: {
					screen_width: '1080',
					screen_height: '2400',
					dec: 'H264,H265,AV1',
					device_orientation: '0'
				},
				content: undefined
			})
		}

		const stanza: BinaryNode = {
			tag: 'call',
			attrs: {
				to: 'call',
				id: randomBytes(16).toString('hex').toUpperCase()
			},
			content: [
				{
					tag: 'link_join',
					attrs: { media, token },
					content: joinContent
				}
			]
		}

		return await query(stanza)
	}

	const sendRetryRequest = async (
		node: BinaryNode,
		forceIncludeKeys = false,
		retryReason: RetryReason = RetryReason.UnknownError
	) => {
		const { fullMessage } = decodeMessageNode(node, authState.creds.me!.id, authState.creds.me!.lid || '')
		const { key: msgKey } = fullMessage
		const msgId = msgKey.id!

		// Per-JID deduplication: when multiple messages from the same contact
		// fail with Bad MAC simultaneously, only send ONE retry request.
		// The peer will resend all failed messages when it receives the retry receipt.
		// For group messages, scope by participant (each participant has its own Signal session).
		const retryDedupeJid = msgKey.participant
			? jidNormalizedUser(msgKey.participant)
			: jidNormalizedUser(node.attrs.from)
		if (retryRequestActiveJids.has(retryDedupeJid)) {
			logger.debug(
				{ fromJid: retryDedupeJid, msgId },
				'Skipping duplicate retry request — already in-flight for this JID'
			)
			return
		}

		if (messageRetryManager) {
			// M12 fold (upstream #2576): atomic check-and-increment. `tryIncrement`
			// reads the counter and increments it within one sync block, so a
			// concurrent caller for the same msgId cannot both pass the limit
			// check before either increments. Replaces the split
			// `hasExceededMaxRetries` + `incrementRetryCount` pair which had
			// an await boundary between the two operations.
			const attempt = messageRetryManager.tryIncrement(msgId)
			if (!attempt.proceed) {
				logger.debug({ msgId, count: attempt.count }, 'reached retry limit with new retry manager, clearing')
				messageRetryManager.markRetryFailed(msgId)
				recordMessageFailure('retry', 'max_retries_reached')

				// Safety net: clean up corrupted sessions only after all retries exhausted.
				// This avoids the cascading delete loop that occurs when cleanup runs
				// on every Bad MAC in the hot path (decode-wa-message.ts).
				// The Signal Protocol recovers naturally via retry+pkmsg for most cases;
				// this cleanup only runs as a last resort.
				// For group messages, use participant JID (Signal sessions are per-participant, not per-group).
				if (autoCleanCorrupted) {
					const senderJid = msgKey.participant
						? jidNormalizedUser(msgKey.participant)
						: jidNormalizedUser(node.attrs.from)
					try {
						const decryptionJid = await getDecryptionJid(senderJid, signalRepository)
						const deletedCount = await cleanupCorruptedSession(decryptionJid, signalRepository, logger)
						if (deletedCount > 0) {
							logger.info(
								{ msgId, jid: decryptionJid, targetedDevices: deletedCount },
								`🔄 Session cleanup (retry exhausted) | Targeted: ${deletedCount} devices`
							)
						}
					} catch (cleanupErr) {
						logger.warn({ msgId, senderJid, err: cleanupErr }, 'Failed to cleanup session after retry exhaustion')
					}
				}

				return
			}

			recordMessageRetry('retry')

			// Best-effort mirror: this stanza could not be decrypted in order, so
			// we are asking the peer to resend — the exact condition the mobile
			// client parks a stanza in `unordered_stanza_queue`. Persist the raw
			// encoded stanza keyed by message id with the current process count.
			// The row is dropped when the resend decrypts (the success branch of
			// this handler calls `deleteUnorderedStanza`), or promptly on retry
			// exhaustion (markRetryFailed dispose); the 15-min TTL / socket-close
			// wipe are backstops. Never blocks the retry.
			if (signalTypedBackend) {
				try {
					const senderJid = msgKey.participant
						? jidNormalizedUser(msgKey.participant)
						: jidNormalizedUser(node.attrs.from)
					signalTypedBackend.enqueueUnorderedStanza({
						stanzaId: msgId,
						stanzaPayload: encodeBinaryNode(node),
						chatJid: msgKey.remoteJid ?? undefined,
						senderJid,
						chatType: isJidGroup(msgKey.remoteJid ?? undefined) ? 1 : 0,
						processCount: attempt.count
					})
				} catch (err) {
					logger.debug({ err, msgId }, 'unordered_stanza_queue mirror: enqueue failed (ignored)')
				}
			}

			// Stage 6 H9 (upstream #2576): mirror the retry count to the durable
			// cache via `retryLocks` so this set cannot race against
			// `reserveSendMessageAgainAttempt` for the same key. Both
			// paths now route through `retryLocks.withLock` on the same
			// `(msgId, participant)` ref.
			await retryLocks.withLock(retryLockRef(msgId, String(msgKey?.participant)), async () => {
				const key = `${msgId}:${msgKey?.participant}`
				// BOT-001-B: maxKeys saturation degrades to a debug log. Losing this
				// mirror only means the in-memory retry count diverges from the
				// durable one for this key until the next successful write — the
				// retry loop is bounded by `maxMsgRetryCount` either way.
				//
				// PR #490 review (Cubic P1 acceptable): yes, a saturated
				// `msgRetryCache` (10k entries × TTL 1h) could in theory let the
				// retry counter stall and exceed `maxMsgRetryCount` for that
				// key. The alternative — throwing to the receive handler — would
				// tear down message processing for ALL keys, not just one. We
				// accept the bounded over-retry as the lesser evil; if it does
				// happen, the `autoCleanCorrupted` path still handles the
				// corrupted session independently.
				await safeCacheSet(msgRetryCache, key, attempt.count, logger, 'msgRetryCache')
			})
		} else {
			// Fallback to old system
			const key = `${msgId}:${msgKey?.participant}`
			let retryCount = (await msgRetryCache.get<number>(key)) || 0
			if (retryCount >= maxMsgRetryCount) {
				logger.debug({ retryCount, msgId }, 'reached retry limit, clearing')
				await msgRetryCache.del(key)
				recordMessageFailure('retry', 'max_retries_reached')

				// Safety net cleanup (same as new system above)
				if (autoCleanCorrupted) {
					const senderJid = msgKey.participant
						? jidNormalizedUser(msgKey.participant)
						: jidNormalizedUser(node.attrs.from)
					try {
						const decryptionJid = await getDecryptionJid(senderJid, signalRepository)
						await cleanupCorruptedSession(decryptionJid, signalRepository, logger)
					} catch (cleanupErr) {
						logger.warn({ msgId, senderJid, err: cleanupErr }, 'Failed to cleanup session after retry exhaustion')
					}
				}

				return
			}

			retryCount += 1
			// BOT-001-B: same rationale as the new-system branch above.
			await safeCacheSet(msgRetryCache, key, retryCount, logger, 'msgRetryCache')
			recordMessageRetry('retry')
		}

		// Register dedup AFTER early-return checks so that max-retries paths
		// don't block subsequent messages from the same JID for 5 seconds.
		retryRequestActiveJids.add(retryDedupeJid)
		setTimeout(() => retryRequestActiveJids.delete(retryDedupeJid), 5_000)

		const key = `${msgId}:${msgKey?.participant}`
		const retryCount = (await msgRetryCache.get<number>(key)) || 1

		const { account, signedPreKey, signedIdentityKey: identityKey } = authState.creds
		if (retryCount <= 2) {
			// Use new retry manager for phone requests if available
			if (messageRetryManager) {
				// Schedule phone request with delay (like whatsmeow)
				messageRetryManager.schedulePhoneRequest(msgId, async () => {
					try {
						const requestId = await requestPlaceholderResend(msgKey)
						logger.debug(
							`sendRetryRequest: requested placeholder resend (${requestId}) for message ${msgId} (scheduled)`
						)
					} catch (error) {
						logger.warn({ error, msgId }, 'failed to send scheduled phone request')
					}
				})
			} else {
				// Fallback to immediate request
				const msgId = await requestPlaceholderResend(msgKey)
				logger.debug(`sendRetryRequest: requested placeholder resend for message ${msgId}`)
			}
		}

		if (!account) throw new Boom('Account not available', { statusCode: 401 })
		const deviceIdentity = encodeSignedDeviceIdentity(account, true)
		let receipt: BinaryNode | undefined
		let directDistributionKeyId: number | undefined
		let directDistributionKeysNode: BinaryNode | undefined
		let directDistributionCredsUpdate: Partial<(typeof authState)['creds']> | undefined
		let directDistributionMarkError: unknown
		let directDistributionWasAlreadyMarked = false
		let includeDirectDistributionKey = false
		let retrySessionExists: boolean | undefined
		if (config.enableAutoSessionRecreation && retryCount === 1 && !forceIncludeKeys) {
			const retryPeerJid = msgKey.participant || node.attrs.from
			const validation = await signalRepository.validateSession(retryPeerJid!)
			const validationFailed = validation.reason === 'validation error'
			retrySessionExists = validationFailed ? undefined : validation.exists
			if (validationFailed) {
				logger.warn(
					{ msgId, retryPeerJid, reason: validation.reason },
					'retry session validation failed; preserving the normal first-retry key policy'
				)
			} else if (!validation.exists) {
				logger.info(
					{ msgId, retryPeerJid, reason: validation.reason },
					'retry peer has no usable local session; including key bundle without deleting session state'
				)
			}
		}

		const shouldIncludeRetryKeys = shouldIncludeRetryKeysForSession(retryCount, forceIncludeKeys, retrySessionExists)
		if (shouldIncludeRetryKeys && prekeyUploads) {
			try {
				const firstUnsent = prekeyUploads.firstUnsentId()
				const nextGenerated = prekeyUploads.nextGeneratedId()
				const unsentCount = prekeyUploads.countUnsent()
				const cursorUpdate = applyReconciledPrekeyCursors(authState.creds, {
					firstUnsentId: firstUnsent,
					nextGeneratedId: nextGenerated,
					unsentCount
				})
				if (Object.keys(cursorUpdate).length > 0) {
					logger.info(
						{ cursorUpdate, firstUnsent, nextGenerated, unsentCount },
						'pre-keys: reconciled retry-receipt cursors before selecting direct-distribution key'
					)
					ev.emit('creds.update', cursorUpdate)
				}
			} catch (err) {
				logger.error(
					{ err },
					'multi-db-sqlite: failed to reconcile retry prekey before selection; refusing possible key reuse'
				)
				throw err
			}
		}

		await authState.keys.transaction(async () => {
			receipt = {
				tag: 'receipt',
				attrs: {
					id: msgId,
					type: 'retry',
					to: node.attrs.from!
				},
				content: [
					{
						tag: 'retry',
						attrs: {
							count: retryCount.toString(),
							id: node.attrs.id!,
							t: node.attrs.t!,
							v: '1',
							error: retryReason.toString()
						}
					},
					{
						tag: 'registration',
						attrs: {},
						content: encodeBigEndian(authState.creds.registrationId)
					}
				]
			}

			if (node.attrs.recipient) {
				receipt.attrs.recipient = node.attrs.recipient
			}

			if (node.attrs.participant) {
				receipt.attrs.participant = node.attrs.participant
			}

			if (shouldIncludeRetryKeys) {
				const { update, preKeys } = await getNextPreKeys(authState, 1)

				const [keyId] = Object.keys(preKeys)
				const key = preKeys[+keyId!]

				directDistributionKeysNode = {
					tag: 'keys',
					attrs: {},
					content: [
						{ tag: 'type', attrs: {}, content: Buffer.from(KEY_BUNDLE_TYPE) },
						{ tag: 'identity', attrs: {}, content: identityKey.public },
						xmppPreKey(key!, +keyId!),
						xmppSignedPreKey(signedPreKey),
						{ tag: 'device-identity', attrs: {}, content: deviceIdentity }
					]
				}

				directDistributionCredsUpdate = update
				directDistributionKeyId = keyId ? +keyId : undefined
				if (prekeyUploads && key && directDistributionKeyId !== undefined) {
					// For a freshly generated key, carry this intent through the pending
					// keys.set mutation so axolotl.db inserts + flags it atomically at
					// commit. Existing rows are deliberately marked only in afterCommit:
					// if another auth mutation fails, no key is removed from the upload
					// pool before the transaction has actually succeeded.
					try {
						directDistributionWasAlreadyMarked = prekeyUploads.isDirectDistribution(directDistributionKeyId)
					} catch (err) {
						directDistributionMarkError = err
					}

					if (!directDistributionWasAlreadyMarked) markPrekeyDirectDistributionIntent(key)
				}
			}

			authState.keys.afterCommit(() => {
				includeDirectDistributionKey = directDistributionKeysNode !== undefined
				if (directDistributionKeyId !== undefined && prekeyUploads) {
					let durableMark = false
					try {
						durableMark = prekeyUploads.isDirectDistribution(directDistributionKeyId)
						if (!durableMark && !directDistributionWasAlreadyMarked) {
							// Existing prekeys (and kill-switch mirror rows) were not part of
							// this transaction's typed INSERT. Mark them only now, after the
							// auth-key commit, but before releasing its operation lock.
							durableMark = prekeyUploads.markDirectDistribution(directDistributionKeyId)
						}
					} catch (err) {
						directDistributionMarkError = directDistributionMarkError ?? err
					}

					if (directDistributionWasAlreadyMarked) {
						includeDirectDistributionKey = false
						logger.error(
							{ keyId: directDistributionKeyId, reason: 'key-already-direct-distributed' },
							'multi-db-sqlite: selected retry prekey was already consumed; omitting it and advancing the stale cursor'
						)
					} else if (!durableMark) {
						includeDirectDistributionKey = false
						logger.error(
							{
								err: directDistributionMarkError ? compactError(directDistributionMarkError) : undefined,
								keyId: directDistributionKeyId,
								reason: 'typed-row-ineligible-or-not-persisted',
								retryReceiptAction: 'one-time-prekey-omitted',
								signalKvPreserved: true,
								serverUploadEligibilityPreserved: true,
								storagePath: 'authoritative-typed-prekeys-with-signal_kv-fallback'
							},
							'multi-db-sqlite: typed direct-distribution unavailable; key material retained, signal_kv fallback preserved, and one-time prekey omitted from retry receipt'
						)
					}
				} else if (directDistributionKeyId !== undefined && signalTypedBackend) {
					includeDirectDistributionKey = false
					logger.error(
						{
							keyId: directDistributionKeyId,
							reason: 'authoritative-prekey-capability-unavailable',
							retryReceiptAction: 'one-time-prekey-omitted',
							mirrorIgnored: true,
							signalKvPreserved: true
						},
						'multi-db-sqlite: prekey mirror is not authoritative; refusing direct distribution and preserving the legacy key material'
					)
				}

				if (directDistributionCredsUpdate) {
					// Keep this update under the same legacy lock until the durable
					// direct-distribution check finishes. A queued upload can only start
					// after it sees the matching cursor state.
					const update =
						includeDirectDistributionKey || directDistributionWasAlreadyMarked
							? directDistributionCredsUpdate
							: { nextPreKeyId: directDistributionCredsUpdate.nextPreKeyId }
					ev.emit('creds.update', update)
				}
			})
		}, authState?.creds?.me?.id || 'sendRetryRequest')

		if (!receipt) throw new Error('sendRetryRequest: retry receipt was not constructed')

		if (includeDirectDistributionKey && directDistributionKeysNode) {
			;(receipt.content! as BinaryNode[]).push(directDistributionKeysNode)
		}

		await sendNode(receipt)
		logger.info(
			{
				msgAttrs: node.attrs,
				retryCount,
				retryReason,
				retryReasonName: RetryReason[retryReason],
				includedDirectDistributionKey: includeDirectDistributionKey
			},
			'sent retry receipt'
		)
	}

	// Upstream #2432: dedupe re-issued PreKeyLow notifications by stanza id.
	// Mirrors WAWeb/Handle/PreKeyLow.js — if the server emits a second PreKeyLow with
	// the same stanza id while uploadPreKeys() is still running, skip the duplicate
	// instead of triggering a second concurrent upload.
	const inFlightPreKeyLow = new Set<string>()

	const handleEncryptNotification = async (node: BinaryNode) => {
		const from = node.attrs.from
		if (from === S_WHATSAPP_NET) {
			const stanzaId = node.attrs.id
			if (stanzaId && inFlightPreKeyLow.has(stanzaId)) {
				return
			}

			// CodeRabbit guard (PR #487 review): `getBinaryNodeChild` is typed to
			// return `BinaryNode | undefined` and `attrs.value` is itself optional.
			// The previous `countChild!.attrs.value!` would throw a `TypeError` if
			// the server ever sent a PreKeyLow notification without `<count>` (or
			// without a value attr). In production WAWeb always includes both, but
			// guarding here avoids a socket-tearing crash if the protocol ever
			// drifts. Skips quietly with a warn since it's harmless to ignore.
			const countChild = getBinaryNodeChild(node, 'count')
			const countValue = countChild?.attrs?.value
			if (!countValue) {
				logger.warn(
					{ node: summarizeInboundNode(node) },
					'PreKeyLow notification missing count child or value attr, skipping'
				)
				return
			}

			const count = +countValue
			const shouldUploadMorePreKeys = count < MIN_PREKEY_COUNT

			logger.debug({ count, shouldUploadMorePreKeys }, 'recv pre-key count')
			if (shouldUploadMorePreKeys) {
				if (stanzaId) inFlightPreKeyLow.add(stanzaId)
				try {
					await uploadPreKeys()
				} finally {
					if (stanzaId) inFlightPreKeyLow.delete(stanzaId)
				}
			}
		} else {
			const result = await handleIdentityChange(node, {
				meId: authState.creds.me?.id,
				meLid: authState.creds.me?.lid,
				validateSession: signalRepository.validateSession,
				assertSessions,
				debounceCache: identityAssertDebounce,
				inFlightRefreshes: identityInFlightRefreshes,
				logger
			})

			// When a session is refreshed (identity change), re-issue our token. The
			// issue helper records 0 before the IQ and NULL only after its ACK.
			if (result.action === 'session_refreshed') {
				const normalizedJid = jidNormalizedUser(from)
				resolveTcTokenAliases(normalizedJid, { getLIDForPN, getPNForLID })
					.then(async aliases => {
						const tcData = await authState.keys.get('tctoken', aliases)
						const selected = selectNewestUsableTcToken(aliases.map(alias => [alias, tcData[alias]] as const))
						if (selected.usable) {
							const senderTs = unixTimestampSeconds()
							logTcToken('reissue', { jid: normalizedJid, reason: 'session_refreshed' })
							issuePrivacyTokens([normalizedJid], senderTs)
								.then(() => {
									logTcToken('reissue_ok', { jid: normalizedJid, reason: 'session_refreshed' })
								})
								.catch(err => {
									logTcToken('reissue_fail', { jid: normalizedJid, error: err?.message })
								})
						}
					})
					.catch(() => {
						/* ignore resolution errors */
					})
			}

			if (result.action === 'no_identity_node') {
				logger.info({ node: summarizeInboundNode(node) }, 'unknown encrypt notification')
			}
		}
	}

	const handleGroupNotification = async (fullNode: BinaryNode, child: BinaryNode, msg: Partial<WAMessage>) => {
		const lidMapping = signalRepository.lidMapping

		const actingParticipantLid = fullNode.attrs.participant
		const actingParticipantPn = fullNode.attrs.participant_pn
		const actingParticipantUsername = fullNode.attrs.participant_username || fullNode.attrs.username

		const affectedParticipantLid = getBinaryNodeChild(child, 'participant')?.attrs?.jid || actingParticipantLid!
		const affectedParticipantPn = getBinaryNodeChild(child, 'participant')?.attrs?.phone_number || actingParticipantPn!

		// Resolve acting participant to PN — prefer inline PN, fall back to LID→PN resolution
		const actingParticipant = actingParticipantPn || (await resolveLidToPn(actingParticipantLid, lidMapping, logger))

		// Resolve affected participant to PN
		const affectedParticipant =
			affectedParticipantPn || (await resolveLidToPn(affectedParticipantLid, lidMapping, logger))

		// Store LID↔PN mappings from notification attributes
		const mappingsToStore: Array<{ lid: string; pn: string }> = []
		if (
			actingParticipantLid &&
			actingParticipantPn &&
			isLidUser(actingParticipantLid) &&
			isPnUser(actingParticipantPn)
		) {
			mappingsToStore.push({ lid: actingParticipantLid, pn: actingParticipantPn })
		}

		switch (child?.tag) {
			case 'create':
				const metadata = extractGroupMetadata(child)

				// Normalize group metadata participant IDs to PN
				for (const p of metadata.participants) {
					if (isLidUser(p.id)) {
						// Use inline phoneNumber if available, otherwise resolve via mapping
						if (p.phoneNumber) {
							// Store the mapping
							mappingsToStore.push({ lid: p.id, pn: p.phoneNumber })
							p.lid = p.id
							p.id = p.phoneNumber
						} else {
							const resolved = await resolveLidToPn(p.id, lidMapping, logger)
							if (resolved && resolved !== p.id) {
								p.lid = p.id
								p.id = resolved
							}
						}
					}
				}

				// Resolve metadata owner to PN
				if (metadata.owner && isLidUser(metadata.owner)) {
					const resolvedOwner = metadata.ownerPn || (await resolveLidToPn(metadata.owner, lidMapping, logger))
					if (resolvedOwner) metadata.owner = resolvedOwner
				}

				msg.messageStubType = WAMessageStubType.GROUP_CREATE
				msg.messageStubParameters = [metadata.subject]
				msg.key = { participant: actingParticipant }

				ev.emit('chats.upsert', [
					{
						id: metadata.id,
						name: metadata.subject,
						conversationTimestamp: metadata.creation
					}
				])
				ev.emit('groups.upsert', [
					{
						...metadata,
						author: actingParticipant,
						authorPn: actingParticipantPn,
						authorUsername: actingParticipantUsername
					}
				])
				break
			case 'ephemeral':
			case 'not_ephemeral':
				msg.message = {
					protocolMessage: {
						type: proto.Message.ProtocolMessage.Type.EPHEMERAL_SETTING,
						ephemeralExpiration: +(child.attrs.expiration || 0)
					}
				}
				break
			case 'modify':
				const oldNumbers = await Promise.all(
					getBinaryNodeChildren(child, 'participant').map(async p => {
						const resolved = await resolveLidToPn(p.attrs.jid, lidMapping, logger)
						return resolved || p.attrs.jid!
					})
				)
				msg.messageStubParameters = oldNumbers || []
				msg.messageStubType = WAMessageStubType.GROUP_PARTICIPANT_CHANGE_NUMBER
				break
			case 'promote':
			case 'demote':
			case 'remove':
			case 'add':
			case 'leave':
				const stubType = `GROUP_PARTICIPANT_${child.tag.toUpperCase()}`
				msg.messageStubType = WAMessageStubType[stubType as keyof typeof WAMessageStubType]

				const participants = await Promise.all(
					getBinaryNodeChildren(child, 'participant').map(async ({ attrs }) => {
						const rawJid = attrs.jid!
						let id = rawJid
						let phoneNumber: string | undefined
						let lid: string | undefined

						if (isLidUser(rawJid)) {
							// Primary is LID — resolve to PN
							phoneNumber = isPnUser(attrs.phone_number) ? attrs.phone_number : undefined
							if (phoneNumber) {
								mappingsToStore.push({ lid: rawJid, pn: phoneNumber })
								lid = rawJid
								id = phoneNumber
							} else {
								const resolved = await resolveLidToPn(rawJid, lidMapping, logger)
								if (resolved && resolved !== rawJid) {
									lid = rawJid
									id = resolved
								}
							}
						} else if (isPnUser(rawJid) && isLidUser(attrs.lid)) {
							// Primary is PN — store LID for reference
							lid = attrs.lid
							mappingsToStore.push({ lid: attrs.lid!, pn: rawJid })
						}

						return {
							id,
							phoneNumber,
							lid,
							username: attrs.participant_username || attrs.username || undefined,
							admin: (attrs.type || null) as GroupParticipant['admin']
						}
					})
				)

				if (
					participants.length === 1 &&
					// if recv. "remove" message and sender removed themselves
					// mark as left
					(areJidsSameUser(participants[0]!.id, actingParticipant) ||
						areJidsSameUser(participants[0]!.id, actingParticipantLid) ||
						areJidsSameUser(participants[0]!.id, actingParticipantPn)) &&
					child.tag === 'remove'
				) {
					msg.messageStubType = WAMessageStubType.GROUP_PARTICIPANT_LEAVE
				}

				msg.messageStubParameters = participants.map(a => JSON.stringify(a))
				break
			case 'subject':
				msg.messageStubType = WAMessageStubType.GROUP_CHANGE_SUBJECT
				msg.messageStubParameters = [child.attrs.subject!]
				break
			case 'description':
				const description = getBinaryNodeChild(child, 'body')?.content?.toString()
				msg.messageStubType = WAMessageStubType.GROUP_CHANGE_DESCRIPTION
				msg.messageStubParameters = description ? [description] : undefined
				break
			case 'announcement':
			case 'not_announcement':
				msg.messageStubType = WAMessageStubType.GROUP_CHANGE_ANNOUNCE
				msg.messageStubParameters = [child.tag === 'announcement' ? 'on' : 'off']
				break
			case 'locked':
			case 'unlocked':
				msg.messageStubType = WAMessageStubType.GROUP_CHANGE_RESTRICT
				msg.messageStubParameters = [child.tag === 'locked' ? 'on' : 'off']
				break
			case 'invite':
				msg.messageStubType = WAMessageStubType.GROUP_CHANGE_INVITE_LINK
				msg.messageStubParameters = [child.attrs.code!]
				break
			case 'member_add_mode':
				const addMode = child.content
				if (addMode) {
					msg.messageStubType = WAMessageStubType.GROUP_MEMBER_ADD_MODE
					msg.messageStubParameters = [addMode.toString()]
				}

				break
			case 'membership_approval_mode':
				const approvalMode = getBinaryNodeChild(child, 'group_join')
				if (approvalMode) {
					msg.messageStubType = WAMessageStubType.GROUP_MEMBERSHIP_JOIN_APPROVAL_MODE
					msg.messageStubParameters = [approvalMode.attrs.state!]
				}

				break
			case 'created_membership_requests':
				msg.messageStubType = WAMessageStubType.GROUP_MEMBERSHIP_JOIN_APPROVAL_REQUEST_NON_ADMIN_ADD
				// Persist the affected participant's LID↔PN pair when both are
				// present and well-formed. Mirrors upstream PR #2617; previously
				// only `create`/`add`/`promote`/`demote`/`remove`/`leave` cases
				// stored mappings here, leaving join-request flows blind when
				// `resolveLidToPn` later needed them.
				if (
					affectedParticipantLid &&
					affectedParticipantPn &&
					isLidUser(affectedParticipantLid) &&
					isPnUser(affectedParticipantPn)
				) {
					mappingsToStore.push({ lid: affectedParticipantLid, pn: affectedParticipantPn })
				}

				msg.messageStubParameters = [
					JSON.stringify({ lid: affectedParticipantLid, pn: affectedParticipant }),
					'created',
					child.attrs.request_method!
				]
				break
			case 'revoked_membership_requests':
				const isDenied = areJidsSameUser(affectedParticipantLid, actingParticipantLid)
				msg.messageStubType = WAMessageStubType.GROUP_MEMBERSHIP_JOIN_APPROVAL_REQUEST_NON_ADMIN_ADD
				if (
					affectedParticipantLid &&
					affectedParticipantPn &&
					isLidUser(affectedParticipantLid) &&
					isPnUser(affectedParticipantPn)
				) {
					mappingsToStore.push({ lid: affectedParticipantLid, pn: affectedParticipantPn })
				}

				msg.messageStubParameters = [
					JSON.stringify({ lid: affectedParticipantLid, pn: affectedParticipant }),
					isDenied ? 'revoked' : 'rejected'
				]
				break
		}

		// Persist any LID↔PN mappings discovered from notification attributes
		if (mappingsToStore.length) {
			await lidMapping.storeLIDPNMappings(mappingsToStore).catch(err => {
				logger.warn({ err, count: mappingsToStore.length }, 'Failed to store LID↔PN mappings from group notification')
			})
		}
	}

	const handleDevicesNotification = async (node: BinaryNode) => {
		const [child] = getAllBinaryNodeChildren(node)
		const from = jidNormalizedUser(node.attrs.from)

		if (!child) {
			logger.debug({ from }, 'devices notification missing child, skipping')
			return
		}

		const tag = child.tag as 'add' | 'remove' | 'update'
		const deviceHash = child.attrs.device_hash
		const devices = getBinaryNodeChildren(child, 'device')

		if (areJidsSameUser(from, authState.creds.me!.id) || areJidsSameUser(from, authState.creds.me!.lid)) {
			const deviceJids = devices.map(d => d.attrs.jid)
			logger.info({ deviceJids }, 'got my own devices')
		}

		if (!devices.length) {
			logger.debug({ from, tag }, 'no devices in notification, skipping')
			return
		}

		type DecodedDevice = FullJid & { jid: string; device: number }
		const decoded: DecodedDevice[] = []
		for (const d of devices) {
			const jid = d.attrs.jid
			if (!jid) continue
			const parts = jidDecode(jid)
			if (!parts) {
				logger.debug({ jid }, 'failed to decode device jid, skipping')
				continue
			}

			// Normalize the primary to `device: 0`. `jidDecode` returns `undefined`
			// for a `0` device suffix, but the cached device list (both the JSON
			// mirror and the typed store, which reads back `device: 0`) stores the
			// primary as `0`. Comparing `undefined` against `0` in the add/remove
			// delta below would miss the primary — `remove` wouldn't drop it and
			// `add` would append a duplicate entry. (#621 audit.)
			decoded.push({
				jid,
				user: parts.user,
				server: parts.server,
				domainType: parts.domainType,
				device: parts.device ?? 0
			})
		}

		if (!decoded.length) return

		await devicesMutex.mutex(async () => {
			const byUser = new Map<string, DecodedDevice[]>()
			for (const d of decoded) {
				const list = byUser.get(d.user) || []
				list.push(d)
				byUser.set(d.user, list)
			}

			for (const [user, entries] of byUser) {
				if (tag === 'update') {
					logger.debug({ user }, `${user}'s device list updated, dropping cached devices`)
					await userDevicesCache?.del(user)
					continue
				}

				if (tag === 'remove') {
					await signalRepository.deleteSession(entries.map(e => e.jid))
				}

				const existingCache = ((await userDevicesCache?.get(user)) as FullJid[] | undefined) || []
				if (!existingCache.length) {
					// No baseline yet; skip applying the delta so getUSyncDevices can
					// later fetch the full device list. Caching just the notification
					// entries would make a partial list look authoritative.
					logger.debug({ user, tag }, 'device list not cached, deferring to USync refresh')
					continue
				}

				if (tag !== 'add' && tag !== 'remove') {
					logger.debug({ tag }, 'Unknown device list change tag')
					continue
				}

				logger.info({ deviceHash, count: entries.length }, tag === 'add' ? 'devices added' : 'devices removed')
				// #621: normalized diff (primary = device 0 on both sides). See
				// applyDeviceListDelta.
				const updatedDevices = applyDeviceListDelta(existingCache, entries, tag)

				if (updatedDevices.length === 0) {
					await userDevicesCache?.del(user)
				} else if (userDevicesCache) {
					// PR #513 review (chatgpt-codex P2): mirror the ECACHEFULL
					// handling already in place for `userDevicesCache.set` in
					// messages-send.ts. With the `maxKeys` cap added in PR
					// #509, `@cacheable/node-cache` throws ECACHEFULL when
					// `keyCount() + 1 > maxKeys` — and that check is hit even
					// for an UPDATE of an already-cached key when the cache
					// is at capacity, because the underlying `set` doesn't
					// short-circuit on existing-key writes. `safeCacheSet`
					// swallows the throw with a debug log; the durable USync
					// state is unaffected (next message-send will re-fetch
					// via `getUSyncDevices`, same fallback semantics).
					await safeCacheSet(userDevicesCache, user, updatedDevices, logger, 'userDevicesCache')
				}
			}
		})
	}

	const processNotification = async (node: BinaryNode) => {
		const result: Partial<WAMessage> = {}
		const [child] = getAllBinaryNodeChildren(node)
		const nodeType = node.attrs.type
		const from = jidNormalizedUser(node.attrs.from)

		switch (nodeType) {
			case 'newsletter':
				await handleNewsletterNotification(node)
				break
			case 'mex':
				// Dispatcher unificado (newsletter legacy + reachout/capping novos)
				await handleMexNotification(node)
				break
			case 'w:gp2':
				await handleGroupNotification(node, child!, result)
				break
			case 'mediaretry':
				const event = decodeMediaRetryNode(node)
				// Normalize LID→PN in media retry key before emitting
				await normalizeKeyLidToPn(event.key, signalRepository.lidMapping, logger)
				ev.emit('messages.media-update', [event])
				break
			case 'encrypt':
				await handleEncryptNotification(node)
				break
			case 'devices':
				try {
					await handleDevicesNotification(node)
				} catch (error) {
					logger.error({ error, node: summarizeInboundNode(node) }, 'failed to handle devices notification')
				}

				break
			case 'server_sync':
				const update = getBinaryNodeChild(node, 'collection')
				if (update) {
					const name = update.attrs.name as WAPatchName
					await resyncAppState([name], false)
				}

				break
			case 'picture': {
				const setPicture = getBinaryNodeChild(node, 'set')
				const delPicture = getBinaryNodeChild(node, 'delete')
				const pictureNode = setPicture || delPicture
				const pictureFrom = jidNormalizedUser(node?.attrs?.from) || pictureNode?.attrs?.hash
				const pictureImgUrl = setPicture ? 'changed' : 'removed'

				if (isJidGroup(from)) {
					if (pictureFrom) {
						ev.emit('contacts.update', [{ id: pictureFrom, imgUrl: pictureImgUrl }])
					}

					result.messageStubType = WAMessageStubType.GROUP_CHANGE_ICON

					if (setPicture) {
						result.messageStubParameters = [setPicture.attrs.id!]
					}

					result.participant = pictureNode?.attrs.author
					result.key = {
						...(result.key || {}),
						participant: setPicture?.attrs.author
					}
				} else if (pictureFrom) {
					const identity = await resolveContactPictureIdentity(pictureFrom, {
						getPNForLID,
						getLIDForPN,
						meId: authState.creds.me?.id,
						meLid: authState.creds.me?.lid
					})
					ev.emit('contacts.update', [{ ...identity, imgUrl: pictureImgUrl }])
				}

				break
			}

			case 'account_sync':
				if (child!.tag === 'disappearing_mode') {
					const newDuration = +child!.attrs.duration!
					const timestamp = +child!.attrs.t!

					logger.info({ newDuration }, 'updated account disappearing mode')

					ev.emit('creds.update', {
						accountSettings: {
							...authState.creds.accountSettings,
							defaultDisappearingMode: {
								ephemeralExpiration: newDuration,
								ephemeralSettingTimestamp: timestamp
							}
						}
					})
				} else if (child!.tag === 'blocklist') {
					const blocklists = getBinaryNodeChildren(child, 'item')

					for (const { attrs } of blocklists) {
						const resolvedBlockJid =
							(await resolveLidToPn(attrs.jid, signalRepository.lidMapping, logger)) || attrs.jid!
						const blocklist = [resolvedBlockJid]
						const type = attrs.action === 'block' ? 'add' : 'remove'
						ev.emit('blocklist.update', { blocklist, type })
					}
				}

				break
			case 'link_code_companion_reg':
				const linkCodeCompanionReg = getBinaryNodeChild(node, 'link_code_companion_reg')
				const ref = toRequiredBuffer(getBinaryNodeChildBuffer(linkCodeCompanionReg, 'link_code_pairing_ref'))
				const primaryIdentityPublicKey = toRequiredBuffer(
					getBinaryNodeChildBuffer(linkCodeCompanionReg, 'primary_identity_pub')
				)
				const primaryEphemeralPublicKeyWrapped = toRequiredBuffer(
					getBinaryNodeChildBuffer(linkCodeCompanionReg, 'link_code_pairing_wrapped_primary_ephemeral_pub')
				)
				const codePairingPublicKey = await decipherLinkPublicKey(primaryEphemeralPublicKeyWrapped)
				const companionSharedKey = Curve.sharedKey(
					authState.creds.pairingEphemeralKeyPair.private,
					codePairingPublicKey
				)
				const random = randomBytes(32)
				const linkCodeSalt = randomBytes(32)
				const linkCodePairingExpanded = hkdf(companionSharedKey, 32, {
					salt: linkCodeSalt,
					info: 'link_code_pairing_key_bundle_encryption_key'
				})
				const encryptPayload = Buffer.concat([
					Buffer.from(authState.creds.signedIdentityKey.public),
					primaryIdentityPublicKey,
					random
				])
				const encryptIv = randomBytes(12)
				const encrypted = aesEncryptGCM(encryptPayload, linkCodePairingExpanded, encryptIv, Buffer.alloc(0))
				const encryptedPayload = Buffer.concat([linkCodeSalt, encryptIv, encrypted])
				const identitySharedKey = Curve.sharedKey(authState.creds.signedIdentityKey.private, primaryIdentityPublicKey)
				const identityPayload = Buffer.concat([companionSharedKey, identitySharedKey, random])
				authState.creds.advSecretKey = Buffer.from(hkdf(identityPayload, 32, { info: 'adv_secret' })).toString('base64')
				await query({
					tag: 'iq',
					attrs: {
						to: S_WHATSAPP_NET,
						type: 'set',
						id: sock.generateMessageTag(),
						xmlns: 'md'
					},
					content: [
						{
							tag: 'link_code_companion_reg',
							attrs: {
								jid: authState.creds.me!.id,
								stage: 'companion_finish'
							},
							content: [
								{
									tag: 'link_code_pairing_wrapped_key_bundle',
									attrs: {},
									content: encryptedPayload
								},
								{
									tag: 'companion_identity_public',
									attrs: {},
									content: authState.creds.signedIdentityKey.public
								},
								{
									tag: 'link_code_pairing_ref',
									attrs: {},
									content: ref
								}
							]
						}
					]
				})
				authState.creds.registered = true
				ev.emit('creds.update', authState.creds)
				break
			case 'privacy_token':
				await handlePrivacyTokenNotification(node)
				break
		}

		if (Object.keys(result).length) {
			return result
		}
	}

	const handlePrivacyTokenNotification = async (node: BinaryNode) => {
		const parsedTokens = parseTrustedContactTokenNotification(node)
		if (!parsedTokens.length) return
		const from = parsedTokens[0]!.from

		// Never persist a tctoken for PSA/bot/MetaAI contacts. Notifications are
		// the authoritative peer-token ingestion path.
		if (!isRegularUser(from)) return

		for (const { senderLid, timestamp, timestampSource, childTimestamp, outerTimestamp, token } of parsedTokens) {
			const aliases = await resolveIncomingTcTokenAliases(from, senderLid, { getLIDForPN, getPNForLID })
			const storageJid = aliases[0]!

			// Timestamp monotonicity applies across PN+LID, matching the official
			// ORDER BY incoming_tc_token_timestamp DESC LIMIT 1 read.
			const existingData = await authState.keys.get('tctoken', aliases)
			const existing = existingData[storageJid]
			const existingTs = Math.max(...aliases.map(alias => Number(existingData[alias]?.timestamp ?? 0)))
			const incomingTs = timestamp ? Number(timestamp) : 0
			if (existingTs > 0 && incomingTs > 0 && existingTs > incomingTs) {
				logger.debug(
					{ from, senderLid, storageJid, incomingTs, existingTs, action: 'ignored-stale-token' },
					'privacy-token notification did not overwrite a newer PN/LID token'
				)
				continue
			}

			// Don't store timestamp-less tokens — they expire immediately and would
			// corrupt a valid existing entry if one is already present
			if (!incomingTs) {
				logger.warn(
					{ from, senderLid, storageJid, childTimestamp, outerTimestamp, action: 'ignored-missing-timestamp' },
					'privacy-token notification omitted both child and outer timestamps'
				)
				continue
			}

			const bucket: Record<string, NonNullable<typeof existing> | null> = {
				[storageJid]: {
					...existing,
					token,
					timestamp
				}
			}
			// Official storage converges on LID. Remove only the incoming half of
			// a legacy PN alias while preserving any sent-state fields it carries.
			for (const alias of aliases.slice(1)) {
				const aliasEntry = existingData[alias]
				if (!aliasEntry?.token?.length) continue
				bucket[alias] =
					aliasEntry.senderTimestamp !== undefined
						? {
								token: Buffer.alloc(0),
								senderTimestamp: aliasEntry.senderTimestamp,
								realIssueTimestamp: aliasEntry.realIssueTimestamp
							}
						: null
			}

			await authState.keys.set({
				tctoken: bucket
			})

			logTcToken('stored', {
				jid: storageJid,
				from,
				senderLid,
				timestampSource,
				tokenLength: token.length
			})

			// Track JID for cross-session pruning
			tcTokenKnownJids.add(storageJid)
			scheduleTcTokenIndexSave()
		}
	}

	async function decipherLinkPublicKey(data: Uint8Array | Buffer) {
		const buffer = toRequiredBuffer(data)
		const salt = buffer.slice(0, 32)
		const secretKey = await derivePairingCodeKey(authState.creds.pairingCode!, salt)
		const iv = buffer.slice(32, 48)
		const payload = buffer.slice(48, 80)
		return aesDecryptCTR(payload, secretKey, iv)
	}

	function toRequiredBuffer(data: Uint8Array | Buffer | undefined) {
		if (data === undefined) {
			throw new Boom('Invalid buffer', { statusCode: 400 })
		}

		return data instanceof Buffer ? data : Buffer.from(data)
	}

	const reserveSendMessageAgainAttempt = async (id: string, participant: string) => {
		return retryLocks.withLock(retryLockRef(id, participant), async () => {
			const key = `${id}:${participant}`
			try {
				const attempt = await persistRetrySendReservation(msgRetryCache, key, maxMsgRetryCount)
				if (attempt.reservationFailure) {
					logger.warn(
						{ id, participant, reason: attempt.reservationFailure },
						'retry resend suppressed because its bounded counter could not be persisted'
					)
				}

				return attempt
			} catch (err) {
				if (!isNodeCacheFullError(err)) {
					logger.error(
						{ id, participant, err },
						'retry resend counter persistence failed; relay suppressed before sending'
					)
					throw err
				}

				logger.warn(
					{ id, participant, err },
					'retry resend suppressed because msgRetryCache is full and cannot enforce the retry cap'
				)
				return { proceed: false, count: maxMsgRetryCount, reservationFailure: 'write-rejected' as const }
			}
		})
	}

	const hasSendMessageAgainBudget = async (id: string, participant: string): Promise<boolean> => {
		return retryLocks.withLock(retryLockRef(id, participant), async () => {
			const key = `${id}:${participant}`
			const current = (await msgRetryCache.get<number>(key)) ?? 0
			return hasRetrySendBudget(current, maxMsgRetryCount)
		})
	}

	const sendMessagesAgain = async (
		key: WAMessageKey,
		ids: string[],
		retryNode: BinaryNode,
		receiptNode: BinaryNode
	) => {
		const remoteJid = key.remoteJid
		if (!remoteJid || !jidDecode(remoteJid)) {
			throw new Boom('Retry receipt has no valid relay destination', {
				statusCode: 400,
				data: { messageIds: ids, participant: key.participant, remoteJid }
			})
		}

		const participant = key.participant || remoteJid

		const retryCount = +retryNode.attrs.count! || 1
		const msgId = ids[0]
		const sessionId = signalRepository.jidToSignalProtocolAddress(participant)
		const retryErrorCode = parseRetryErrorCode(retryNode.attrs.error)
		if (retryNode.attrs.error !== undefined) {
			logger.debug(
				{
					participant,
					retryCount,
					retryErrorAttr: retryNode.attrs.error,
					retryErrorCode,
					retryErrorName: retryErrorCode === undefined ? 'unparseable' : RetryReason[retryErrorCode],
					sessionPolicy: 'registration-id-and-base-key'
				},
				'retry receipt error recorded; session mutation remains gated by registration/base-key evidence'
			)
		}

		// Helper: delete the session at BOTH the PN- and LID-addressed keys.
		// InfiniteAPI's signal storage (`signalStorage.loadSession`) canonicalizes
		// a PN signal-address to its LID counterpart when a `lidMapping` entry
		// exists — so the session that `getSessionInfo()` reads can live under
		// the LID key while `sessionId` is computed from the PN participant.
		// Clearing only `sessionId` would leave the canonical session intact.
		// Always clear both, wrap in the same transaction (meId) used elsewhere
		// to keep ordering vs sendMessage's session ops (race-prevention from a3dd21c9).
		const deleteCanonicalSession = async () => {
			const updates: { [key: string]: null } = { [sessionId]: null }
			if (!isLidUser(participant)) {
				const lid = await signalRepository.lidMapping.getLIDForPN(participant)
				if (lid) {
					updates[signalRepository.jidToSignalProtocolAddress(lid)] = null
				}
			}

			await authState.keys.transaction(async () => {
				await authState.keys.set({ session: updates })
			}, authState.creds.me?.id || 'session-operation')
		}

		/**
		 * TEMPORARY DIAGNOSTIC (TODO: remove after the reg-id-mismatch root cause is identified).
		 *
		 * Verifies that deleteCanonicalSession actually removed the session. Reads the raw session
		 * keys we just nulled (NOT getSessionInfo — that returns null in three different cases:
		 * truly deleted, session exists but has no open chain, or session exists but is missing
		 * baseKey/registrationId — would falsely look "deleted" in the latter two).
		 *
		 * Logging strategy (designed to be safe in production):
		 *  - deleted === true  → debug (expected path, no noise during retry storms)
		 *  - deleted === false → warn  (a real bug — silent transaction failure or LID/PN
		 *                                resolution missed the stored copy)
		 *
		 * The expensive part (keystore read) only runs when a delete just happened, which is
		 * naturally low-frequency in stable operation. Frequent only right after a fresh QR
		 * pairing when sessions are first established.
		 */
		const verifyCanonicalDelete = async (reason: string) => {
			try {
				const lookupKeys: string[] = [sessionId]
				if (!isLidUser(participant)) {
					const lid = await signalRepository.lidMapping.getLIDForPN(participant)
					if (lid) {
						lookupKeys.push(signalRepository.jidToSignalProtocolAddress(lid))
					}
				}

				const sessions = await authState.keys.get('session', lookupKeys)
				const stillStoredKeys = lookupKeys.filter(k => sessions[k] !== undefined && sessions[k] !== null)
				const deleted = stillStoredKeys.length === 0

				if (deleted) {
					logger.debug({ participant, reason }, '[DIAG] POST-DELETE canonical session removed')
					return
				}

				// Not deleted — fetch registrationId for context (the real problem case).
				const info = await signalRepository.getSessionInfo(participant)
				logger.warn(
					{
						participant,
						reason,
						stillStoredKeys,
						registrationId: info?.registrationId
					},
					'[DIAG] POST-DELETE canonical session STILL PRESENT — delete failed silently'
				)
			} catch (err) {
				logger.debug({ err, participant, reason }, '[DIAG] POST-DELETE verification failed')
			}
		}

		// Try to get messages from cache first, then fallback to getMessage
		const msgs: (proto.IMessage | undefined)[] = []
		const liveLocationDurations: (number | undefined)[] = []
		for (const id of ids) {
			let msg: proto.IMessage | undefined
			let liveLocationDuration: number | undefined

			// Try to get from retry cache first if enabled
			if (messageRetryManager) {
				const cachedMsg = messageRetryManager.getRecentMessage(remoteJid, id)
				if (cachedMsg) {
					msg = cachedMsg.message
					liveLocationDuration = cachedMsg.liveLocationDuration
					logger.debug({ jid: remoteJid, id }, 'found message in retry cache')
				}
			}

			// Fallback to getMessage if not found in cache
			if (!msg) {
				msg = await getMessage({ ...key, id })
				if (msg) {
					const persistedDuration = (msg as proto.IMessage & { liveLocationDuration?: number }).liveLocationDuration
					if (
						typeof persistedDuration === 'number' &&
						Number.isSafeInteger(persistedDuration) &&
						persistedDuration >= 0
					) {
						liveLocationDuration = persistedDuration
					}

					logger.debug({ jid: remoteJid, id }, 'found message via getMessage')
				}
			}

			msgs.push(msg)
			liveLocationDurations.push(liveLocationDuration)
		}

		const availableIds = ids.filter((id, index) => Boolean(id && msgs[index]))
		if (availableIds.length === 0) {
			logger.warn(
				{ jid: remoteJid, ids, participant },
				'retry receipt ignored because the outbound message payload is unavailable'
			)
			return
		}

		let hasRetryableMessage = false
		for (let i = 0; i < ids.length; i++) {
			const id = ids[i]
			if (id && msgs[i] && (await hasSendMessageAgainBudget(id, participant))) {
				hasRetryableMessage = true
				break
			}
		}

		if (!hasRetryableMessage) {
			logger.info(
				{ jid: remoteJid, ids: availableIds, participant },
				'retry receipt ignored because all available messages exhausted their per-device retry budget'
			)
			return
		}

		// if it's the primary jid sending the request
		// just re-send the message to everyone
		// prevents the first message decryption failure
		const sendToAll = !jidDecode(participant)?.device

		// --- 1b168592: process <keys> bundle from retry receipt (when present) ---
		// WA may attach a fresh prekey bundle so the resend lands on a usable session
		// without an extra IQ round-trip. If injection succeeds we SKIP the
		// session-recreation + assertSessions path below — the bundle already supplies
		// a valid outgoing session.
		let injectedFromBundle = false
		const bundle = extractE2ESessionFromRetryReceipt(receiptNode)
		if (bundle) {
			try {
				// Pass the CANONICAL JID (LID when PN has a mapping) so the SessionBuilder
				// transaction locks on the same key that `encryptMessage` uses. Without this,
				// a concurrent retry-inject and send/encrypt for the same logical peer would
				// hold different `parsedKeys.transaction` mutex keys (`PN` vs the resolved
				// LID), letting them mutate the same canonical session record concurrently.
				const lid = !isLidUser(participant) ? await signalRepository.lidMapping.getLIDForPN(participant) : null
				const canonicalJid = lid || participant
				await signalRepository.injectE2ESession({ jid: canonicalJid, session: bundle })
				injectedFromBundle = true
				logger.debug({ participant, canonicalJid, retryCount }, 'injected session from retry receipt key bundle')
			} catch (error) {
				logger.warn({ error, participant }, 'failed to inject session from retry receipt')
			}
		}

		if (!injectedFromBundle) {
			// No usable bundle — if the receipt's registration id no longer matches our
			// stored session's, the peer rotated their identity. Delete the stale session
			// so the next encryptMessage forces a fresh pkmsg. Use deleteCanonicalSession
			// so both PN and LID-keyed copies are cleared (signal storage resolves PN→LID).
			// Validate `<registration>` is exactly 4 bytes (same strictness as the bundle
			// parser) before trusting the decoded uint — overlong buffers would otherwise
			// silently pass the first-4-bytes decode.
			const regBuf = getBinaryNodeChildBuffer(receiptNode, 'registration')
			const receivedRegId = regBuf?.length === 4 ? getBinaryNodeChildUInt(receiptNode, 'registration', 4) : undefined
			if (typeof receivedRegId === 'number' && Number.isInteger(receivedRegId)) {
				const info = await signalRepository.getSessionInfo(participant)
				if (info && info.registrationId !== 0 && info.registrationId !== receivedRegId) {
					logger.info(
						{ participant, stored: info.registrationId, received: receivedRegId },
						'reg id mismatch on retry without bundle, deleting session'
					)
					await deleteCanonicalSession()
					await verifyCanonicalDelete('reg_id_mismatch')
				}
			}
		}

		// Base-key collision detection (WA Web RetryMsgJob):
		// retry==2 records the open-session base key for this (sessionId, msgId).
		// retry>2 with the same base key still in place means neither side rotated
		// — force a fresh session before resending so the peer can decrypt.
		const BASE_KEY_CHECK_RETRY = 2
		if (msgId && messageRetryManager) {
			const info = await signalRepository.getSessionInfo(participant)
			if (info) {
				if (retryCount === BASE_KEY_CHECK_RETRY) {
					messageRetryManager.saveBaseKey(sessionId, msgId, info.baseKey)
				} else if (retryCount > BASE_KEY_CHECK_RETRY) {
					if (messageRetryManager.hasSameBaseKey(sessionId, msgId, info.baseKey)) {
						logger.warn({ participant, retryCount }, 'base key collision on retry, forcing fresh session')
						await deleteCanonicalSession()
						await verifyCanonicalDelete('base_key_collision')
					}

					messageRetryManager.deleteBaseKey(sessionId, msgId)
				}
			}
		}

		if (!injectedFromBundle) {
			await assertSessions([participant], true)
		}

		if (isJidGroup(remoteJid)) {
			await authState.keys.set({ 'sender-key-memory': { [remoteJid]: null } })
		}

		logger.debug({ participant, sendToAll, injectedFromBundle }, 'prepared session for retry resend')

		for (const [i, msg] of msgs.entries()) {
			if (!ids[i]) continue

			if (msg) {
				const attempt = await reserveSendMessageAgainAttempt(ids[i], participant)
				if (!attempt.proceed) {
					logger.info(
						{ jid: remoteJid, id: ids[i], participant, retryCount: attempt.count },
						'will not send message again, as sent too many times'
					)
					continue
				}

				const msgRelayOpts: MessageRelayOptions = { messageId: ids[i] }
				msgRelayOpts.liveLocationDuration = liveLocationDurations[i]

				if (sendToAll) {
					msgRelayOpts.useUserDevicesCache = false
				} else {
					msgRelayOpts.participant = {
						jid: participant,
						count: +retryNode.attrs.count!
					}
				}

				await relayMessage(remoteJid, msg, msgRelayOpts)
				// A successful direct resend only repairs this participant's Signal
				// session. Keep the shared payload available because another linked
				// device can request a retry for the same message id milliseconds later.
				messageRetryManager?.markOutboundRetrySuccess()
			} else {
				logger.debug({ jid: key.remoteJid, id: ids[i] }, 'recv retry request, but message not available')
			}
		}
	}

	const handleReceipt = async (node: BinaryNode) => {
		const { attrs, content } = node
		const isLid = attrs.from!.includes('lid')
		const isNodeFromMe = areJidsSameUser(
			attrs.participant || attrs.from,
			isLid ? authState.creds.me?.lid : authState.creds.me?.id
		)
		const fromMe = !attrs.recipient || ((attrs.type === 'retry' || attrs.type === 'sender') && isNodeFromMe)
		const recentRetryMessage =
			attrs.type === 'retry' && fromMe && attrs.id && messageRetryManager
				? messageRetryManager.getRecentMessage(attrs.recipient ?? attrs.from!, attrs.id)
				: undefined
		const retryRoute = resolveRetryReceiptRoute({
			stanzaFrom: attrs.from!,
			recipient: attrs.recipient,
			isNodeFromMe,
			isGroup: isJidGroup(attrs.from) ?? false,
			isRetry: attrs.type === 'retry',
			recentMessageTo: recentRetryMessage?.to
		})
		let remoteJid = retryRoute.remoteJid

		if (attrs.type === 'retry' && fromMe && !attrs.recipient) {
			const routeContext = {
				id: attrs.id,
				stanzaFrom: attrs.from,
				resolvedRemoteJid: remoteJid,
				routeSource: retryRoute.source
			}
			if (recentRetryMessage) {
				logger.debug(
					routeContext,
					'retry receipt omitted recipient; restored original relay destination from recent-message cache'
				)
			} else {
				logger.warn(
					routeContext,
					'retry receipt omitted recipient and recent message was unavailable; refusing to infer the destination from the own-device stanza'
				)
			}
		}

		if (!remoteJid) {
			logger.error(
				{
					id: attrs.id,
					stanzaFrom: attrs.from,
					participant: attrs.participant,
					recipient: attrs.recipient,
					routeSource: retryRoute.source
				},
				'retry receipt omitted the original destination and no cached route exists; resend suppressed'
			)
			await sendMessageAck(node)
			return
		}

		const key: proto.IMessageKey = {
			remoteJid,
			id: '',
			fromMe,
			participant: attrs.participant
		}

		// Normalize LID→PN in the receipt key when the mapping is known. If
		// WhatsApp has not supplied the mapping yet, retain a bare LID rather
		// than inventing a PN; a device suffix never belongs in the chat key.
		const lidMapping = signalRepository.lidMapping
		const [resolvedRemoteJid, resolvedParticipant] = await Promise.all([
			resolveLidToPn(key.remoteJid, lidMapping, logger),
			resolveLidToPn(key.participant, lidMapping, logger)
		])
		if (resolvedRemoteJid || key.remoteJid) {
			key.remoteJid = canonicalizeReceiptChatJid(resolvedRemoteJid ?? key.remoteJid!)
		}

		if (resolvedParticipant) key.participant = resolvedParticipant
		remoteJid = key.remoteJid ?? remoteJid

		if (shouldIgnoreJid(remoteJid) && remoteJid !== S_WHATSAPP_NET) {
			logger.trace({ remoteJid }, 'ignoring receipt from jid')
			await sendMessageAck(node)
			return
		}

		const ids = [attrs.id!]
		if (Array.isArray(content)) {
			const items = getBinaryNodeChildren(content[0], 'item')
			ids.push(...items.map(i => i.attrs.id!))
		}

		try {
			await Promise.all([
				receiptMutex.mutex(jidNormalizedUser(remoteJid) || 'unknown', async () => {
					const status = getStatusFromReceiptType(attrs.type)
					if (
						typeof status !== 'undefined' &&
						// basically, we only want to know when a message from us has been delivered to/read by the other person
						// or another device of ours has read some messages
						(status >= proto.WebMessageInfo.Status.SERVER_ACK || !isNodeFromMe)
					) {
						if (isJidGroup(remoteJid) || isJidStatusBroadcast(remoteJid)) {
							if (attrs.participant) {
								const updateKey: keyof MessageUserReceipt =
									status === proto.WebMessageInfo.Status.DELIVERY_ACK ? 'receiptTimestamp' : 'readTimestamp'
								const resolvedReceiptUserJid =
									(await resolveLidToPn(attrs.participant, lidMapping, logger)) || jidNormalizedUser(attrs.participant)
								const normalizedReceiptUserJid = jidNormalizedUser(resolvedReceiptUserJid)
								ev.emit(
									'message-receipt.update',
									ids.map(id => ({
										key: { ...key, id },
										receipt: {
											userJid: normalizedReceiptUserJid,
											[updateKey]: +attrs.t!
										}
									}))
								)

								// Mirrors status-view receipts into status.db. Never allowed
								// to affect receipt processing: best-effort side channel,
								// same rule as the other optional multi-db-sqlite mirrors
								// in this codebase.
								if (statusBackend && isJidStatusBroadcast(remoteJid) && updateKey === 'readTimestamp') {
									try {
										for (const id of ids) {
											statusBackend.recordSeenReceipt({
												statusUuid: id,
												receiptUserJid: normalizedReceiptUserJid,
												seenTimestamp: +attrs.t!
											})
										}
									} catch (err) {
										logger.warn({ err }, 'failed to record status_seen_receipt row')
									}
								}

								// Mirrors group message receipts into msgstore.db's
								// receipt_user/receipt_device tables. Status broadcasts are
								// intentionally excluded — real Android tracks those in
								// status.db's own status_seen_receipt table (handled above),
								// not msgstore.db's receipt tables.
								if (receiptBackend && isJidGroup(remoteJid) && key.remoteJid) {
									try {
										const receiptKind = receiptKindFromStatus(status)
										for (const id of ids) {
											receiptBackend.recordUserReceipt({
												chatJid: key.remoteJid,
												fromMe: !!key.fromMe,
												keyId: id,
												receiptUserJid: normalizedReceiptUserJid,
												kind: receiptKind,
												timestamp: +attrs.t!
											})
											// Device-level ack: `attrs.from` is the GROUP's own jid
											// for a group receipt (the group member is only
											// identified by `attrs.participant`), so it can't be
											// used here the way the 1:1 branch below uses it. This
											// keys by the participant's bare jid instead of a true
											// per-device jid — not device-granular, but far more
											// correct than collapsing every member into one row
											// under the group's jid (confirmed real bug).
											if (attrs.participant) {
												receiptBackend.recordDeviceReceipt({
													chatJid: key.remoteJid,
													fromMe: !!key.fromMe,
													keyId: id,
													receiptDeviceJid: normalizedReceiptUserJid,
													timestamp: +attrs.t!
												})
											}
										}
									} catch (err) {
										logger.warn({ err }, 'failed to record receipt_user/receipt_device row')
									}
								}
							}
						} else {
							ev.emit(
								'messages.update',
								ids.map(id => ({
									key: { ...key, id },
									update: { status, messageTimestamp: toNumber(+(attrs.t ?? 0)) }
								}))
							)

							// Android's msgstore status integers are not the same
							// numbers as WebMessageInfo.Status. Advance the typed
							// message row using the confirmed Android mapping.
							if (receiptChatResolver && key.remoteJid) {
								const androidStatus = mapWebMessageStatusToAndroid(status)
								if (androidStatus !== null) {
									try {
										for (const id of ids) {
											receiptChatResolver.updateMessageStatus(key.remoteJid, !!key.fromMe, id, androidStatus)
										}
									} catch (err) {
										logger.warn({ err }, 'failed to advance message status mirror')
									}
								}
							}

							// Mirrors 1:1 message receipts into msgstore.db. The other
							// party IS the receipt_user for a 1:1 chat (no separate
							// participant field the way group/status receipts have one).
							if (receiptBackend && key.remoteJid) {
								try {
									const receiptKind = receiptKindFromStatus(status)
									for (const id of ids) {
										receiptBackend.recordUserReceipt({
											chatJid: key.remoteJid,
											fromMe: !!key.fromMe,
											keyId: id,
											receiptUserJid: jidNormalizedUser(key.remoteJid),
											kind: receiptKind,
											timestamp: +(attrs.t ?? 0)
										})
										if (attrs.from) {
											receiptBackend.recordDeviceReceipt({
												chatJid: key.remoteJid,
												fromMe: !!key.fromMe,
												keyId: id,
												receiptDeviceJid: attrs.from,
												timestamp: +(attrs.t ?? 0)
											})
										}
									}
								} catch (err) {
									logger.warn({ err }, 'failed to record receipt_user/receipt_device row')
								}
							}
						}
					}

					if (attrs.type === 'retry') {
						// correctly set who is asking for the retry
						key.participant = key.participant || attrs.from
						const retryNode = getBinaryNodeChild(node, 'retry')
						if (ids[0] && key.participant) {
							if (key.fromMe) {
								try {
									logger.debug({ attrs, key }, 'recv retry request')
									await sendMessagesAgain(key, ids, retryNode!, node)
								} catch (error: unknown) {
									if (isExpectedSocketTeardownError(error)) {
										logger.debug({ key, ids }, 'message retry cancelled by socket teardown')
									} else {
										logger.error(
											{ key, ids, trace: error instanceof Error ? error.stack : 'Unknown error' },
											'error in sending message again'
										)
									}
								}
							} else {
								logger.info({ attrs, key }, 'recv retry for not fromMe message')
							}
						} else {
							logger.warn(
								{ attrs, key, reason: ids[0] ? 'missing-retry-participant' : 'missing-message-id' },
								'retry receipt is incomplete; resend suppressed before consuming an attempt'
							)
						}
					}
				})
			])
		} finally {
			await sendMessageAck(node).catch(ackErr => logger.error({ ackErr }, 'failed to ack receipt'))
		}
	}

	const handleNotification = async (node: BinaryNode) => {
		const remoteJid = node.attrs.from
		if (shouldIgnoreJid(remoteJid!) && remoteJid !== S_WHATSAPP_NET) {
			logger.trace({ remoteJid }, 'ignored notification')
			await sendMessageAck(node)
			return
		}

		try {
			await Promise.all([
				notificationMutex.mutex(jidNormalizedUser(remoteJid) || 'unknown', async () => {
					const msg = await processNotification(node)
					if (msg) {
						const fromMe = areJidsSameUser(node.attrs.participant || remoteJid, authState.creds.me!.id)
						const { senderAlt: participantAlt, addressingMode } = extractAddressingContext(node)
						const extendedKey: WAMessageKey = {
							remoteJid,
							fromMe,
							participant: node.attrs.participant,
							participantAlt,
							participantUsername: node.attrs.participant_username || node.attrs.username,
							addressingMode,
							id: node.attrs.id,
							...(msg.key || {})
						}
						msg.key = extendedKey
						msg.participant ??= node.attrs.participant
						msg.messageTimestamp = +node.attrs.t!

						// proto.WebMessageInfo.fromObject only copies the WAProto schema
						// fields (remoteJid, fromMe, id, participant) and drops our TS-only
						// extensions (participantAlt, participantUsername, addressingMode,
						// remoteJidUsername, etc.). Reattach the full key after conversion.
						const fullMsg = proto.WebMessageInfo.fromObject(msg) as WAMessage
						fullMsg.key = { ...fullMsg.key, ...extendedKey }
						await upsertMessage(fullMsg, 'append')
					}
				})
			])
		} finally {
			await sendMessageAck(node).catch(ackErr => logger.error({ ackErr }, 'failed to ack notification'))
		}
	}

	const handleMessage = async (node: BinaryNode) => {
		if (shouldIgnoreJid(node.attrs.from!) && node.attrs.from !== S_WHATSAPP_NET) {
			logger.trace({ from: node.attrs.from }, 'ignored message')
			// Send a clean ACK (no error code) so the server considers the
			// message delivered. Using error 500 (UnhandledError) previously
			// caused the server to retry delivery, generating duplicate traffic.
			await sendMessageAck(node)
			return
		}

		// Note on `<enc type="msmsg">`: upstream baileys (and the previous InfiniteAPI
		// release) NACK'd these unconditionally with MissingMessageSecret because the
		// Meta AI / FBID bot decryption was unimplemented. We now route msmsg into
		// `decryptMessageNode` via the per-socket `msmsgSecretCache` — see the algorithm
		// notes in `src/Utils/meta-ai-msmsg.ts` (HKDF + AES-GCM derivation validated
		// against the WA Web `WAWebBotMessageSecret` source). If decryption ultimately
		// fails (no secret in cache → `OrphanMsmsgError`), the outer catch below NACKs
		// the stanza the same as any other handle-time failure.

		// `acked` tracks whether ANY ack/receipt was already sent for this node.
		// The outer catch below uses it to send a single NACK on unexpected errors
		// (matching upstream c4e5d126) — closing the window where a throw in decode/decrypt
		// setup / alt-mapping / migrateSession / normalizeMessageJids / the mutex body
		// previously left the message un-acked and the server retrying forever.
		let acked = false

		try {
			// decryptMessageNode runs decodeMessageNode, which can throw synchronously on a
			// malformed stanza (missing participant / unknown type). Keep it INSIDE the try so
			// such failures are NACKed by the guard below instead of escaping the handler un-acked.
			const {
				fullMessage: msg,
				category,
				author,
				decrypt
			} = decryptMessageNode(
				node,
				authState.creds.me!.id,
				authState.creds.me!.lid || '',
				signalRepository,
				logger,
				msmsgSecretCache,
				config.onMessageQuarantine
			)

			const alt = msg.key.participantAlt || msg.key.remoteJidAlt
			// Handle LID/PN mappings with hybrid approach:
			// - Store mapping operation runs in background (non-critical for decrypt)
			// - Session migration MUST complete before decrypt() to avoid "No session record" errors
			// This addresses Codex/Copilot review concerns about race conditions with decrypt()
			//
			// Stage 3 (upstream #2573 H8): wrap the whole `getPN/LIDFor… →
			// storeLIDPNMappings → migrateSession` block in a per-(alt-jid)
			// `lidMigrationLocks` lock. Two parallel inbound messages from the
			// same alt-jid participant previously each observed a null mapping
			// and each fired the migration. The lock serializes the whole
			// read-then-write so only one branch runs through the migration
			// and the others see the post-mapping state.
			if (!!alt) {
				const altServer = jidDecode(alt)?.server
				const primaryJid = msg.key.participant || msg.key.remoteJid!

				// PR #461 review (Copilot): double-underscore prefix on the namespace
				// avoids future collisions with any real `SignalDataType` value.
				// LockManager docs (lock-manager.ts:9) require this convention for
				// namespaces that aren't backed by a record type.
				await lidMigrationLocks.withLock({ namespace: '__lid_migration__', id: alt }, async () => {
					if (altServer === 'lid') {
						// HYBRID guard — covers two distinct bugs:
						//   Bug B (upstream #2574 P1): equality check, not bare existence.
						//     `if (!existingPn)` would freeze a STALE mapping forever — if
						//     `alt` previously mapped to LID X and a new message announces
						//     LID Y, the old "X" stays in the store and the user state
						//     diverges from session state. Comparing against `primaryJid`
						//     updates the mapping when stale and skips the store when it
						//     already matches.
						//   Bug A (our prior fix): mapping existence doesn't imply session
						//     migration. USync device lookup (messages-send.ts:310-319) and
						//     other paths call storeLIDPNMappings without migrateSession,
						//     leaving sessions under the wrong key. Upstream's full guard
						//     skips BOTH on match, relying on Stage 3 (#2573) libsignal
						//     canonicalization which we don't have — so we keep the
						//     ALWAYS-migrate safety even when the mapping was already
						//     correct. `migrateSession` is idempotent via migratedSessionCache.
						const existingPn = await signalRepository.lidMapping.getPNForLID(alt)
						if (existingPn !== primaryJid) {
							// MUST await: normalizeMessageJids() runs after this and needs the mapping
							// in the LIDMappingStore to resolve LID→PN for events delivered to consumers
							await signalRepository.lidMapping
								.storeLIDPNMappings([{ lid: alt, pn: primaryJid }])
								.catch(error => logger.warn({ error, alt, primaryJid, existingPn }, 'LID mapping storage failed'))
						}

						await signalRepository.migrateSession(primaryJid, alt)
					} else {
						// Symmetric hybrid guard for the PN-alt branch.
						const existingLid = await signalRepository.lidMapping.getLIDForPN(alt)
						if (existingLid !== primaryJid) {
							// MUST await: normalizeMessageJids() runs after this and needs the mapping
							// in the LIDMappingStore to resolve LID→PN for events delivered to consumers
							await signalRepository.lidMapping
								.storeLIDPNMappings([{ lid: primaryJid, pn: alt }])
								.catch(error => logger.warn({ error, alt, primaryJid, existingLid }, 'LID mapping storage failed'))
						}

						await signalRepository.migrateSession(alt, primaryJid)
					}
				})
			}

			if (msg.key?.remoteJid && msg.key?.id && messageRetryManager) {
				messageRetryManager.addRecentMessage(msg.key.remoteJid, msg.key.id, msg.message!)
				logger.debug(
					{
						jid: msg.key.remoteJid,
						id: msg.key.id
					},
					'Added message to recent cache for retry receipts'
				)
			}

			// CRITICAL: Normalize JIDs BEFORE acquiring mutex to ensure messages from the same
			// chat (arriving with different JID formats - LID vs PN) use the SAME mutex key.
			// This prevents parallel processing of messages from the same conversation which
			// would break message ordering guarantees.
			// Addresses Copilot/Codex PR #75 critical review: JID normalization vulnerability
			await normalizeMessageJids(msg, signalRepository, logger)

			// Use KeyedMutex with NORMALIZED remoteJid for parallel processing across different chats
			// while maintaining sequential order within the same chat
			// Fallback chain: remoteJid (normalized) > msg.key.id (unique) > 'unknown' (serializes all)
			let mutexKey = msg.key.remoteJid
			if (!mutexKey) {
				logger.warn(
					{ msgId: msg.key.id, fromMe: msg.key.fromMe },
					'Missing remoteJid after normalization, using msg.key.id as fallback'
				)
				mutexKey = msg.key.id || 'unknown'
			}

			await messageMutex.mutex(mutexKey, async () => {
				await decrypt()
				// message failed to decrypt
				if (msg.messageStubType === proto.WebMessageInfo.StubType.CIPHERTEXT && msg.category !== 'peer') {
					// Handle "Missing keys" - standard decryption failure
					// Return NACK with parsing error to signal the issue
					if (msg?.messageStubParameters?.[0] === MISSING_KEYS_ERROR_TEXT) {
						acked = await sendMessageAck(node, NACK_REASONS.ParsingError)
						return
					}

					// `OrphanMsmsgError` from `decryptMsmsgBotMessage` (Meta AI / FBID bot
					// reply that arrived before we cached the matching outgoing
					// `messageContextInfo.messageSecret`). Without this guard the stub
					// string falls through to the Signal retry/PDO path below — pointless
					// because a missing CACHE entry can't be recovered by a Signal retry,
					// and we'd burn the retry budget asking the bot for prekeys it has
					// no business issuing. Send a plain ACK (no NACK) so the server
					// considers the message delivered; the next bot reply that arrives
					// after the outgoing-secret cache populates will decrypt cleanly
					// (audit thread 2 / chatgpt P2 on release PR #521).
					//
					// Narrow match on `'no messageSecret for '` (not the broader
					// `'decryptMsmsgBotMessage:'` prefix): `decryptMsmsgBotMessage`
					// also raises for real decryption failures — missing
					// `meta.target_id`, missing `encIv`/`encPayload`, AES-GCM auth-tag
					// mismatch — which deserve the Signal retry path, NOT a silent
					// ACK. cubic audit thread 13 (PR #521).
					if (msg?.messageStubParameters?.[0]?.startsWith('decryptMsmsgBotMessage: no messageSecret for ')) {
						acked = await sendMessageAck(node)
						return
					}

					// Audit RETRY-A2 — sender-key stale em skmsg de grupo: o counter
					// avançou no remetente mas a chain local não acompanhou. Reenviar
					// o mesmo skmsg via sendRetryRequest sempre falha (mesma sender-key,
					// mesmo counter). O loop só para quando msgRetryManager bate o cap
					// (~5 retries × ~20s = ~100s de loop por mensagem). NACK 496
					// (SignalErrorOldCounter) sinaliza ao servidor que a mensagem é
					// irrecuperável; o próximo SKDM do remetente resincroniza a chain.
					// Guard `enc.type === 'skmsg'` isola só grupos — pkmsg/msg (DMs,
					// onde vivem carrossel/botões/listas) seguem o caminho padrão.
					const stubError = msg?.messageStubParameters?.[0] || ''
					const isOldCounterErr =
						stubError.includes('old counter') || stubError.includes('Over 2000 messages into the future')
					if (isOldCounterErr) {
						const encChild = getBinaryNodeChild(node, 'enc')
						if (encChild?.attrs?.type === 'skmsg') {
							logger.warn(
								{ msgId: msg.key?.id, remoteJid: msg.key?.remoteJid, error: stubError },
								'skmsg sender-key stale: NACK 496 to stop retry loop (waiting for fresh SKDM)'
							)
							acked = await sendMessageAck(node, NACK_REASONS.SignalErrorOldCounter)
							return
						}
					}

					// Handle "Message absent from node" - likely a CTWA (Click-to-WhatsApp) ads message
					// These messages are only encrypted for the primary phone, not linked devices
					// We need to request the message content from the phone via PDO (Peer Data Operation)
					if (msg.messageStubParameters?.[0] === NO_MESSAGE_FOUND_ERROR_TEXT) {
						// Skip unavailable fanout types - these messages will never have content available
						// These are system messages that cannot be decrypted or retrieved
						const messageType = msg.messageStubParameters?.[2]
						if (
							messageType === 'bot_unavailable_fanout' ||
							messageType === 'hosted_unavailable_fanout' ||
							messageType === 'view_once_unavailable_fanout'
						) {
							logger.debug(
								{ msgId: msg.key?.id, messageType },
								'CTWA: Skipping placeholder resend for unavailable fanout type'
							)
							metrics.ctwaRecoveryFailures.inc({ reason: 'unavailable_fanout' })
							acked = await sendMessageAck(node)
							return
						}

						// Skip old messages - don't request resend for messages older than 7 days
						const messageAge = unixTimestampSeconds() - toNumber(msg.messageTimestamp)

						if (messageAge > PLACEHOLDER_MAX_AGE_SECONDS) {
							logger.debug(
								{ msgId: msg.key?.id, messageAge, maxAge: PLACEHOLDER_MAX_AGE_SECONDS },
								'CTWA: Skipping placeholder resend for old message'
							)
							metrics.ctwaRecoveryFailures.inc({ reason: 'message_too_old' })
							acked = await sendMessageAck(node)
							return
						}

						if (enableCTWARecovery && msg.key) {
							const startTime = Date.now()
							const msgId = msg.key.id!
							const msgKey = msg.key

							// Prepare metadata to preserve original message details
							// The phone may not send all metadata in PDO response (e.g., pushName, participantAlt)
							// Caching these ensures we don't lose critical information like sender name and LID mappings
							const msgData: PlaceholderMessageData = {
								key: { ...msgKey },
								pushName: msg.pushName,
								messageTimestamp: msg.messageTimestamp,
								participant: msg.key.participant,
								participantAlt: msg.key.participantAlt
							}

							logger.info(
								{ msgId, remoteJid: msgKey.remoteJid, messageAge },
								'CTWA: Message absent from node detected, scheduling placeholder resend from phone'
							)

							// Use messageRetryManager to schedule the phone request with delay
							// This aligns with the upstream philosophy: centralize phone requests in the manager
							// Benefits: 3s delay (avoids spam), auto-cancellation if message arrives
							if (messageRetryManager) {
								metrics.ctwaRecoveryRequests.inc({ status: 'scheduled' })

								messageRetryManager.schedulePhoneRequest(msgId, async () => {
									try {
										const requestId = await requestPlaceholderResend(msgKey, msgData)
										if (requestId && requestId !== 'RESOLVED') {
											logger.debug({ msgId, requestId }, 'CTWA: Placeholder resend request sent successfully')
											metrics.ctwaRecoveryRequests.inc({ status: 'sent' })
											// Note: The actual message will be emitted via 'messages.upsert'
											// when the PEER_DATA_OPERATION_REQUEST_RESPONSE_MESSAGE is processed
											// in the PDO response handler in src/Utils/process-message.ts
										} else if (requestId === 'RESOLVED') {
											// Message was received while we were waiting
											logger.debug({ msgId }, 'CTWA: Message received during resend delay')
											metrics.ctwaMessagesRecovered.inc()
											metrics.ctwaRecoveryLatency.observe(Date.now() - startTime)
										} else {
											// Already requested (duplicate request prevented by cache)
											logger.debug({ msgId }, 'CTWA: Resend already requested, skipping duplicate')
										}
									} catch (error) {
										logger.warn({ error, msgId }, 'CTWA: Failed to request placeholder resend')
										metrics.ctwaRecoveryFailures.inc({ reason: 'request_failed' })
									}
								})
							} else {
								// Fallback: direct call if messageRetryManager is not available
								metrics.ctwaRecoveryRequests.inc({ status: 'requested' })

								try {
									const requestId = await requestPlaceholderResend(msgKey, msgData)
									if (requestId && requestId !== 'RESOLVED') {
										logger.debug({ msgId, requestId }, 'CTWA: Placeholder resend request sent successfully (direct)')
									} else if (requestId === 'RESOLVED') {
										// Message arrived during the internal 2s delay in requestPlaceholderResend
										logger.debug({ msgId }, 'CTWA: Message received before direct resend request completed')
										metrics.ctwaMessagesRecovered.inc()
										metrics.ctwaRecoveryLatency.observe(Date.now() - startTime)
									} else {
										// Already requested (duplicate request prevented by cache)
										logger.debug({ msgId }, 'CTWA: Resend already requested, skipping duplicate (direct)')
									}
								} catch (error) {
									logger.warn({ error, msgId }, 'CTWA: Failed to request placeholder resend')
									metrics.ctwaRecoveryFailures.inc({ reason: 'request_failed' })
								}
							}
						} else {
							logger.debug(
								{ msgId: msg.key?.id, enableCTWARecovery },
								'CTWA recovery disabled or missing key, skipping placeholder resend'
							)
						}

						acked = await sendMessageAck(node)
						return
					}

					// Skip retry for expired status messages (>24h old)
					if (isJidStatusBroadcast(msg.key.remoteJid!)) {
						const messageAge = unixTimestampSeconds() - toNumber(msg.messageTimestamp)
						if (messageAge > STATUS_EXPIRY_SECONDS) {
							logger.debug(
								{ msgId: msg.key.id, messageAge, remoteJid: msg.key.remoteJid },
								'skipping retry for expired status message'
							)
							acked = await sendMessageAck(node)
							return
						}
					}

					const errorMessage = msg?.messageStubParameters?.[0] || ''
					const isPreKeyError = errorMessage.includes('PreKey')

					logger.debug(`[handleMessage] Attempting retry request for failed decryption`)

					// Handle both pre-key and normal retries in single mutex
					await retryMutex.mutex(async () => {
						try {
							if (!ws.isOpen) {
								logger.debug({ node: summarizeInboundNode(node) }, 'Connection closed, skipping retry')
								return
							}

							// Handle pre-key errors with upload and delay
							if (isPreKeyError) {
								logger.info({ error: errorMessage }, 'PreKey error detected, uploading and retrying')

								try {
									logger.debug('Uploading pre-keys for error recovery')
									await uploadPreKeys(5)
									logger.debug('Waiting for server to process new pre-keys')
									await delay(1000)
								} catch (uploadErr) {
									logger.error({ uploadErr }, 'Pre-key upload failed, proceeding with retry anyway')
								}
							}

							const encNode = getBinaryNodeChild(node, 'enc')
							const retryReason = retryReasonFromDecryptionError(errorMessage)
							await sendRetryRequest(node, !encNode, retryReason)
							if (retryRequestDelayMs) {
								await delay(retryRequestDelayMs)
							}
						} catch (err) {
							logger.error({ err, isPreKeyError }, 'Failed to handle retry, attempting basic retry')
							// Still attempt retry even if pre-key upload failed
							try {
								const encNode = getBinaryNodeChild(node, 'enc')
								const retryReason = retryReasonFromDecryptionError(errorMessage)
								await sendRetryRequest(node, !encNode, retryReason)
							} catch (retryErr) {
								logger.error({ retryErr }, 'Failed to send retry after error handling')
							}
						}

						acked = await sendMessageAck(node, NACK_REASONS.UnhandledError)
					})
				} else {
					if (messageRetryManager && msg.key.id) {
						messageRetryManager.cancelPendingPhoneRequest(msg.key.id)
					}

					// Best-effort: a previously-held stanza's resend just decrypted —
					// drop its `unordered_stanza_queue` row at the canonical "stanza
					// processed" trigger. This is the SUCCESS-only branch, so it never
					// runs on a decrypt failure (where `sendRetryRequest` re-enqueues
					// and bumps process_count) — placing it before the CIPHERTEXT check
					// would reset process_count on every retry. The retry-counter TTL /
					// socket-close wipe remain as backstops for the exhaustion path.
					if (signalTypedBackend && msg.key.id) {
						try {
							signalTypedBackend.deleteUnorderedStanza(msg.key.id)
						} catch (err) {
							logger.debug({ err, msgId: msg.key.id }, 'unordered_stanza_queue mirror: success-delete failed (ignored)')
						}
					}

					const isNewsletter = isJidNewsletter(msg.key.remoteJid!)
					if (!isNewsletter) {
						// no type in the receipt => message delivered
						let type: MessageReceiptType = undefined
						let participant = msg.key.participant
						if (category === 'peer') {
							// special peer message
							type = 'peer_msg'
						} else if (msg.key.fromMe) {
							// message was sent by us from a different device
							type = 'sender'
							// `author` is decodeMessageNode's raw stanza `from`/`participant` —
							// our own device's JID exactly as the server addressed THIS stanza,
							// in whichever mode (LID or PN) it picked. That's independent of
							// `msg.key.remoteJid`'s addressing, which normalizeMessageJids()
							// above may already have flipped LID→PN — so the old LID-only guard
							// here left `participant` unset (and sendReceipt() throwing) for any
							// fromMe sync copy of a PN-addressed chat. Always use `author`.
							participant = author
						} else if (!sendActiveReceipts) {
							type = 'inactive'
						}

						await sendReceipt(msg.key.remoteJid!, participant!, [msg.key.id!], type)
						acked = true

						// send ack for history message
						const isAnyHistoryMsg = getHistoryMsg(msg.message!)
						if (isAnyHistoryMsg) {
							const jid = jidNormalizedUser(msg.key.remoteJid!)
							await sendReceipt(jid, undefined, [msg.key.id!], 'hist_sync') // TODO: investigate
						}
					} else {
						if (!(acked = await sendMessageAck(node))) return
						logger.debug({ key: msg.key }, 'processed newsletter message without receipts')
					}
				}

				// JID normalization moved BEFORE mutex acquisition (line 1273) to prevent race conditions
				// cleanMessage still runs inside mutex to ensure atomic message processing
				cleanMessage(msg, authState.creds.me!.id, authState.creds.me!.lid!)

				await upsertMessage(msg, node.attrs.offline ? 'append' : 'notify')

				const msgType = getMessageTypeLabel(msg.message, { isViewOnce: !!msg.key.isViewOnce })

				// Log with [BAILEYS] prefix and the actual normalized content
				// type, including media wrapped as view-once or ephemeral.
				if (msg.key.id && msg.key.remoteJid) {
					logMessageReceived(msg.key.id, msg.key.remoteJid, undefined, msgType)
				}

				// Record message received metric
				recordMessageReceived(msgType)

				// Track session activity for cleanup
				if (sessionActivityTracker && msg.key.remoteJid) {
					sessionActivityTracker.recordActivity(msg.key.remoteJid)

					// For groups, also track participant activity
					if (msg.key.participant) {
						sessionActivityTracker.recordActivity(msg.key.participant)
					}
				}
			})
		} catch (error) {
			if (isExpectedSocketTeardownError(error)) {
				logger.debug(
					{ from: node.attrs?.from, msgId: node.attrs?.id },
					'message processing cancelled by socket teardown; server redelivery remains eligible'
				)
				return
			}

			// For recoverable Signal Protocol failures (Bad MAC, MessageCounterError,
			// old counter, missing prekey) the retry+pkmsg flow recovers automatically.
			// Logging the full stanza here just floods the log with the raw ciphertext
			// hex — operators can't act on it. Emit a compact one-liner at `warn` and
			// let the unrecoverable branch keep the full payload for real debugging.
			if (isCorruptedSessionError(error)) {
				logger.warn(
					{
						err: compactError(error),
						from: node.attrs?.from,
						msgId: node.attrs?.id,
						msgType: node.attrs?.type
					},
					'message handle failed (auto-recovering via retry+pkmsg)'
				)
			} else {
				logger.error({ error, node: summarizeInboundNode(node) }, 'error in handling message')
			}

			// If nothing acked the message yet (a throw in alt-mapping / migrateSession /
			// normalizeMessageJids / decrypt / upsert), send a single NACK so the server
			// stops retrying. Guarded by `acked` to avoid double-ack on paths that already
			// sent a receipt/ack. (.catch so an ack failure here doesn't escape the handler.)
			if (!acked) {
				await sendMessageAck(node, NACK_REASONS.UnhandledError).catch(ackErr =>
					logger.error({ ackErr }, 'failed to ack message after error')
				)
			}
		}
	}

	/**
	 * Sanitizes caller phone number to fix known decoder bugs
	 *
	 * Brazilian Phone Format:
	 * - Mobile: 55 + DD + 9XXXXXXXX (13 digits total)
	 *   Example: 5515991000000 (55 + 15 + 991000000)
	 * - Landline: 55 + DD + XXXXXXXX (12 digits total)
	 *   Example: 551541410000 (55 + 15 + 41410000)
	 *
	 * Decoder Bug: Landlines incorrectly get trailing zero
	 * Example: 551738025555 → 5517380255550 (should be 12, not 13)
	 *
	 * Detection Logic:
	 * - Extract first digit after DDD (position 4 in string)
	 * - If digit is 2-5: It's a LANDLINE
	 *   → 13 digits is ERROR → Remove trailing zero
	 * - If digit is 6-9: It's a MOBILE
	 *   → 13 digits is CORRECT → Don't touch!
	 *
	 * @param pn - Raw phone number from caller_pn attribute
	 * @returns Sanitized phone number
	 */
	const sanitizeCallerPn = (pn: string | undefined): string | undefined => {
		if (!pn) {
			return undefined
		}

		// Only process Brazilian numbers (country code 55)
		if (!pn.startsWith('55')) {
			return pn
		}

		// Check if it's a 13-digit number (potential landline bug)
		if (pn.length === 13) {
			// Extract first digit after DDD (position 4)
			// Format: 55 DD X...
			//         01 23 4...
			const firstDigitAfterDDD = pn.charAt(4)

			// Landline: first digit is 2-5
			// If 13 digits, it's an error (should be 12) - remove trailing zero
			if (['2', '3', '4', '5'].includes(firstDigitAfterDDD)) {
				// Extra validation: only sanitize if ends with 0 (the bug pattern)
				if (pn.endsWith('0')) {
					const sanitized = pn.slice(0, -1)
					logger.debug(
						{ original: pn, sanitized, firstDigit: firstDigitAfterDDD, type: 'landline' },
						'Call: Sanitized Brazilian landline number (removed trailing zero)'
					)
					return sanitized
				}
			}

			// Mobile: first digit is 6-9
			// 13 digits is CORRECT for mobile - don't sanitize!
			if (['6', '7', '8', '9'].includes(firstDigitAfterDDD)) {
				logger.trace(
					{ pn, firstDigit: firstDigitAfterDDD, type: 'mobile' },
					'Call: Valid Brazilian mobile number (13 digits correct, not sanitizing)'
				)
				return pn
			}
		}

		return pn
	}

	/** Extract participants from a node containing <user> children */
	const extractParticipants = (parentNode: BinaryNode): WACallParticipant[] | undefined => {
		const userNodes = getBinaryNodeChildren(parentNode, 'user')
		if (!userNodes.length) return undefined
		return userNodes.map(u => ({
			jid: u.attrs.jid,
			state: u.attrs.state,
			userPn: u.attrs.user_pn,
			type: u.attrs.type
		}))
	}

	const handleCallInner = async (node: BinaryNode) => {
		const { attrs } = node
		const children = getAllBinaryNodeChildren(node)

		if (!children.length) {
			throw new Boom('Missing call info in call node')
		}

		// Process ALL children — a <call> node can carry multiple
		// sibling stanzas (e.g. <transport> + <mute_v2>)
		for (const infoChild of children) {
			const status = getCallStatusFromNode(infoChild)

			const callId = infoChild.attrs['call-id']!
			const from = infoChild.attrs.from! || infoChild.attrs['call-creator']!

			const call: WACallEvent = {
				chatId: attrs.from!,
				from,
				id: callId,
				date: new Date(+attrs.t! * 1000),
				offline: !!attrs.offline,
				status
			}

			if (status === 'relaylatency') {
				const latencyValue = infoChild.attrs.latency || infoChild.attrs['latency_ms'] || infoChild.attrs['latency-ms']
				const latencyMs = latencyValue ? Number(latencyValue) : undefined
				if (Number.isFinite(latencyMs)) {
					call.latencyMs = latencyMs
				}
			}

			if (status === 'offer') {
				call.isVideo = !!getBinaryNodeChild(infoChild, 'video')
				call.isGroup = infoChild.attrs.type === 'group' || !!infoChild.attrs['group-jid']
				call.groupJid = infoChild.attrs['group-jid']
				// Extract and sanitize caller phone number
				call.callerPn = sanitizeCallerPn(infoChild.attrs['caller_pn'])

				// Extract call link info from group_info child
				const groupInfo = getBinaryNodeChild(infoChild, 'group_info')
				if (groupInfo) {
					call.isGroup = true
					call.linkToken = groupInfo.attrs['link-token']
					call.media = groupInfo.attrs.media
					call.connectedLimit = groupInfo.attrs['connected-limit']
						? Number(groupInfo.attrs['connected-limit'])
						: undefined
					call.participants = extractParticipants(groupInfo)
				}

				// Extract link_info (who created the link)
				const linkInfo = getBinaryNodeChild(infoChild, 'link_info')
				if (linkInfo) {
					call.linkCreator = linkInfo.attrs.link_creator
					call.linkCreatorPn = linkInfo.attrs.link_creator_pn
				}

				// BOT-001-B: safeCacheSet swallows maxKeys saturation. Losing this
				// offer entry only affects subsequent reject/accept correlation for
				// the same call.id — at worst the call event is emitted standalone.
				await safeCacheSet(callOfferCache, call.id, call, logger, 'callOfferCache')
			}

			// Extract call link data from group_update
			if (status === 'group_update') {
				const groupInfo = getBinaryNodeChild(infoChild, 'group_info')
				if (groupInfo) {
					call.isGroup = true
					call.linkToken = groupInfo.attrs['link-token']
					call.media = groupInfo.attrs.media
					call.connectedLimit = groupInfo.attrs['connected-limit']
						? Number(groupInfo.attrs['connected-limit'])
						: undefined
					call.participants = extractParticipants(groupInfo)
				}
			}

			// Extract reminder data (e.g. link_creator_call_started)
			if (status === 'reminder') {
				const groupInfo = getBinaryNodeChild(infoChild, 'group_info')
				if (groupInfo) {
					call.isGroup = true
					call.linkToken = groupInfo.attrs['link-token']
					call.media = groupInfo.attrs.media
				}
			}

			// Extract terminate data (reason, duration, call_summary)
			if (status === 'terminate') {
				call.terminateReason = infoChild.attrs.reason
				const callSummary = getBinaryNodeChild(infoChild, 'call_summary')
				if (callSummary) {
					call.media = callSummary.attrs.media
					call.duration = callSummary.attrs.call_duration ? Number(callSummary.attrs.call_duration) : undefined
					call.participants = extractParticipants(callSummary)
				}
			}

			// Extract video info from accept/preaccept
			if (status === 'accept' || status === 'preaccept') {
				call.isVideo = !!getBinaryNodeChild(infoChild, 'video')
			}

			const existingCall = await callOfferCache.get<WACallEvent>(call.id)

			// use existing call info to populate this event
			if (existingCall) {
				call.isVideo = call.isVideo ?? existingCall.isVideo
				call.isGroup = call.isGroup ?? existingCall.isGroup
				call.groupJid = call.groupJid ?? existingCall.groupJid
				// Preserve callerPn across call state updates
				call.callerPn = call.callerPn || existingCall.callerPn
				// Preserve call link data across updates
				call.linkToken = call.linkToken || existingCall.linkToken
				call.linkCreator = call.linkCreator || existingCall.linkCreator
				call.linkCreatorPn = call.linkCreatorPn || existingCall.linkCreatorPn
				call.media = call.media || existingCall.media
				call.connectedLimit = call.connectedLimit ?? existingCall.connectedLimit
			}

			// delete data once call has ended
			if (status === 'reject' || status === 'accept' || status === 'timeout' || status === 'terminate') {
				await callOfferCache.del(call.id)
			}

			// Normalize LID→PN in call event JIDs before emitting to consumers
			const callLidMapping = signalRepository.lidMapping
			const [resolvedChatId, resolvedFrom, resolvedLinkCreator] = await Promise.all([
				resolveLidToPn(call.chatId, callLidMapping, logger),
				resolveLidToPn(call.from, callLidMapping, logger),
				resolveLidToPn(call.linkCreator, callLidMapping, logger)
			])
			if (resolvedChatId) call.chatId = resolvedChatId
			if (resolvedFrom) call.from = resolvedFrom
			if (resolvedLinkCreator) call.linkCreator = resolvedLinkCreator
			// Resolve participant JIDs in parallel
			if (call.participants) {
				await Promise.all(
					call.participants.map(async p => {
						if (p.jid) {
							const resolved = p.userPn || (await resolveLidToPn(p.jid, callLidMapping, logger))
							if (resolved) p.jid = resolved
						}
					})
				)
			}

			ev.emit('call', [call])
		}
	}

	// Wrap call handling so the ACK is ALWAYS sent — even if a child parse,
	// sanitizeCallerPn, or LID→PN resolution throws (matches upstream c4e5d126).
	// The inner function keeps every InfiniteAPI customization untouched.
	const handleCall = async (node: BinaryNode) => {
		try {
			await handleCallInner(node)
		} catch (error) {
			logger.error({ error, node: summarizeInboundNode(node) }, 'error in handling call')
		} finally {
			await sendMessageAck(node).catch(ackErr => logger.error({ ackErr }, 'failed to ack call'))
		}
	}

	const handleBadAck = async ({ attrs }: BinaryNode) => {
		// Error acks can come from an alternate/device/own-domain JID. The retry
		// cache records the actual destination used by relayMessage, so prefer it
		// over attrs.from when correlating the failed outbound stanza.
		const recentMessage = attrs.id ? messageRetryManager?.getRecentMessage(attrs.from ?? '', attrs.id) : undefined
		const outboundJid = jidNormalizedUser(recentMessage?.to ?? attrs.from ?? '')
		const key: WAMessageKey = { remoteJid: outboundJid, fromMe: true, id: attrs.id }
		await normalizeKeyLidToPn(key, signalRepository.lidMapping, logger)

		// WARNING: REFRAIN FROM ENABLING THIS FOR NOW. IT WILL CAUSE A LOOP
		// // current hypothesis is that if pash is sent in the ack
		// // it means -- the message hasn't reached all devices yet
		// // we'll retry sending the message here
		// if(attrs.phash) {
		// 	logger.info({ attrs }, 'received phash in ack, resending message...')
		// 	const msg = await getMessage(key)
		// 	if(msg) {
		// 		await relayMessage(key.remoteJid!, msg, { messageId: key.id!, useUserDevicesCache: false })
		// 	} else {
		// 		logger.warn({ attrs }, 'could not send message again, as it was not found')
		// 	}
		// }

		// error in acknowledgement,
		// device could not display the message
		if (attrs.error) {
			const errorPolicy = getMessageAckErrorPolicy(attrs.error)
			// 463 is an account/reachout restriction. A privacy `type=set` IQ only
			// announces our token and cannot fetch the peer token, so retrying the
			// message after that IQ is both ineffective and capable of worsening the
			// restriction. Match the official fail-closed behavior and refresh the
			// reachout state solely for actionable diagnostics.
			const is463 = errorPolicy.kind === 'message-account-restriction'
			if (is463) {
				const msgId = attrs.id
				const jid = outboundJid
				logTcToken('error_463', { jid, msgId })

				// Fire-and-forget — detecta reachout timelock quando 463 vem por
				// restrição de conta. Em burst de 463 (carrossel/broadcast) a
				// flag `inFlightReachoutCheck` evita N queries paralelas; o
				// `emitUpdate=false` evita double-emit em caso de o push
				// `NotificationUserReachoutTimelockUpdate` chegar em paralelo
				// (audit PROTO-01 / RACE-01).
				if (!inFlightReachoutCheck) {
					inFlightReachoutCheck = true
					fetchAccountReachoutTimelock(false)
						.catch(err => logger.warn({ err: err?.message }, 'failed to fetch reachout timelock on 463'))
						.finally(() => {
							inFlightReachoutCheck = false
						})
				}

				logger.warn(
					{
						jid,
						msgId,
						reason: 'message-account-restriction',
						tokenAction: 'none-issuance-iq-is-not-a-fetch',
						retryAction: 'suppressed'
					},
					'463 message rejected by account/reachout policy; automatic retry is disabled'
				)
			} else if (errorPolicy.kind === 'smax-invalid') {
				const jid479 = outboundJid
				logTcToken('error_479', { jid: jid479, msgId: attrs.id })
				const decoded = jidDecode(jid479)
				const messageShape = recentMessage?.message ? Object.keys(recentMessage.message).sort() : []
				logger.error(
					{
						jid: jid479,
						msgId: attrs.id,
						ackFrom: attrs.from,
						domain: decoded?.server,
						device: decoded?.device,
						messageShape,
						reason: 'server-smax-invalid',
						tokenAction: 'none-official-client-does-not-refetch-on-479',
						retryAction: 'suppressed'
					},
					'479 smax-invalid: inspect the correlated outbound stanza shape and addressing'
				)
			} else {
				logger.warn({ attrs }, 'received error in ack')
			}

			ev.emit('messages.update', [
				{
					key,
					update: {
						status: WAMessageStatus.ERROR,
						messageStubParameters: is463 ? [attrs.error, ACCOUNT_RESTRICTED_TEXT] : [attrs.error]
					}
				}
			])
		}
	}

	/// processes a node with the given function
	/// and adds the task to the existing buffer if we're buffering events
	const processNodeWithBuffer = async <T>(
		node: BinaryNode,
		identifier: string,
		exec: (node: BinaryNode, offline: boolean) => Promise<T>
	) => {
		ev.buffer()
		await execTask()
		ev.flush()

		function execTask() {
			return exec(node, false).catch(err => onUnexpectedError(err, identifier))
		}
	}

	/** Yields control to the event loop to prevent blocking */
	const yieldToEventLoop = (): Promise<void> => {
		return new Promise(resolve => setImmediate(resolve))
	}

	const inboundTaskAdmission = createInboundTaskAdmission(onUnexpectedError)
	const trackInboundTask = (identifier: string, factory: () => Promise<void>): void => {
		inboundTaskAdmission.track(identifier, factory)
	}

	const nodeProcessorMap: Map<MessageType, (node: BinaryNode) => Promise<void>> = new Map([
		['message', handleMessage],
		['call', handleCall],
		['receipt', handleReceipt],
		['notification', handleNotification]
	])

	// Keep batchSize=25 (InfiniteAPI tuning from PR #239 / 3d9d7baf) — the extracted
	// processor adds per-node `.catch()` so a handler error no longer kills the drain loop.
	const offlineNodeProcessor = makeOfflineNodeProcessor(
		nodeProcessorMap,
		{
			isWsOpen: () => ws.isOpen,
			onUnexpectedError,
			yieldToEventLoop
		},
		25
	)

	registerSocketDrainHandler(async () => {
		const admittedTasks = inboundTaskAdmission.close()
		logger.debug({ admittedTasks }, 'socket teardown: inbound admission closed; draining work accepted before shutdown')
		await offlineNodeProcessor.stopAndDrain()
		const drainResult = await inboundTaskAdmission.drain()
		if (drainResult.timedOut) {
			logger.warn(
				{ pendingTasks: drainResult.pendingTasks, waitedMs: drainResult.waitedMs },
				'socket teardown: inbound drain timed out; active admission tokens expired'
			)
		} else {
			logger.debug(
				{ waitedMs: drainResult.waitedMs },
				'socket teardown: inbound work drained; auth stores can now close safely'
			)
		}
	})

	const processNode = async (
		type: MessageType,
		node: BinaryNode,
		identifier: string,
		exec: (node: BinaryNode) => Promise<void>
	) => {
		// Fast-path: ack e descarte de JIDs ignorados antes de enfileirar /
		// bufferizar — port de upstream `c727b42605` (PR #2352). Para receipts
		// é LID-aware: quando o nó é nosso e não é grupo, usamos `attrs.recipient`
		// em vez de `attrs.from` (a outra ponta), evitando filtrar receipts
		// próprios. Os 3 `shouldIgnoreJid` internos em handleReceipt /
		// handleNotification / handleMessage são preservados como defesa em
		// profundidade (o fork tem código sensível depois deles que pressupõe
		// o JID já filtrado).
		const from = node.attrs.from
		let ignoreJid = from
		// Só aplica a lógica LID-aware pra receipts quando o socket JÁ
		// autenticou (creds.me populado). Sem creds.me, `areJidsSameUser`
		// retornaria false → trataríamos receipts próprios como "de outro
		// JID" e poderíamos descartá-los via shouldIgnoreJid em janelas
		// raras de reconexão (audit LOSS-02).
		if (type === 'receipt' && from && authState.creds.me?.id) {
			const attrs = node.attrs
			const isLid = attrs.from!.includes('@lid')
			const isNodeFromMe = areJidsSameUser(
				attrs.participant || attrs.from,
				isLid ? authState.creds.me?.lid : authState.creds.me?.id
			)
			ignoreJid = !isNodeFromMe || isJidGroup(attrs.from) ? attrs.from : attrs.recipient
		}

		if (ignoreJid && ignoreJid !== S_WHATSAPP_NET && shouldIgnoreJid(ignoreJid)) {
			// Plain ACK (no error code) — InfiniteAPI's pre-existing semantics
			// for ignored stanzas. NACK 500 (UnhandledError) would tell the
			// server the message failed processing and trigger redelivery,
			// producing a duplicate-traffic storm on filtered JIDs (status,
			// newsletter, blocked contacts). This restores commit c46889db43
			// after upstream PR #2352 port (b8edacb7ce) reintroduced the NACK.
			// Audit ref: messages-recv P1 from the 2026-06-10 review.
			await sendMessageAck(node).catch(ackErr => logger.error({ ackErr }, 'failed to ack ignored stanza'))
			return
		}

		const isOffline = !!node.attrs.offline

		if (isOffline) {
			offlineNodeProcessor.enqueue(type, node)
		} else {
			await processNodeWithBuffer(node, identifier, exec)
		}
	}

	// recv a message
	ws.on('CB:message', (node: BinaryNode) => {
		trackInboundTask('processing message', () => processNode('message', node, 'processing message', handleMessage))
	})

	ws.on('CB:call', (node: BinaryNode) => {
		trackInboundTask('handling call', () => processNode('call', node, 'handling call', handleCall))
	})

	// Top-level <relay> stanzas carry TURN server info, tokens and crypto keys
	ws.on('CB:relay', (node: BinaryNode) => {
		trackInboundTask('handling relay', async () => {
			const callId = node.attrs['call-id']
			const rawCallCreator = node.attrs['call-creator']
			// Both callId and callCreator must be present to emit a valid event
			// (call link relays may arrive without these attrs — just log them)
			if (callId && rawCallCreator) {
				// Resolve LID→PN for call creator
				const callCreator =
					(await resolveLidToPn(rawCallCreator, signalRepository.lidMapping, logger)) || rawCallCreator
				logger.debug({ callId, callCreator, uuid: node.attrs.uuid }, 'received relay info')
				ev.emit('call', [
					{
						chatId: callCreator,
						from: callCreator,
						id: callId,
						date: new Date(),
						offline: false,
						status: 'relay' as WACallUpdateType
					}
				])
			} else {
				logger.debug({ attrs: node.attrs }, 'received relay stanza without call-id/call-creator')
			}
		})
	})

	ws.on('CB:receipt', node => {
		trackInboundTask('handling receipt', () => processNode('receipt', node, 'handling receipt', handleReceipt))
	})

	ws.on('CB:notification', (node: BinaryNode) => {
		trackInboundTask('handling notification', () =>
			processNode('notification', node, 'handling notification', handleNotification)
		)
	})
	ws.on('CB:ack,class:message', (node: BinaryNode) => {
		trackInboundTask('handling bad ack', () => handleBadAck(node))
	})

	ev.on('call', ([call]) => {
		trackInboundTask('recording call message', async () => {
			if (!call) {
				return
			}

			// missed call + group call notification message generation
			if (call.status === 'timeout' || (call.status === 'offer' && call.isGroup)) {
				const msg: WAMessage = {
					key: {
						remoteJid: call.chatId,
						id: call.id,
						fromMe: false
					},
					messageTimestamp: unixTimestampSeconds(call.date)
				}
				if (call.status === 'timeout') {
					if (call.isGroup) {
						msg.messageStubType = call.isVideo
							? WAMessageStubType.CALL_MISSED_GROUP_VIDEO
							: WAMessageStubType.CALL_MISSED_GROUP_VOICE
					} else {
						msg.messageStubType = call.isVideo
							? WAMessageStubType.CALL_MISSED_VIDEO
							: WAMessageStubType.CALL_MISSED_VOICE
					}
				} else {
					msg.message = { call: { callKey: Buffer.from(call.id) } }
				}

				const protoMsg = proto.WebMessageInfo.fromObject(msg) as WAMessage
				await upsertMessage(protoMsg, call.offline ? 'append' : 'notify')
			}
		})
	})

	ev.on('connection.update', ({ isOnline, connection }) => {
		// Flush pending tctoken index save on disconnect to avoid writing after close
		if (connection === 'close' && tcTokenIndexSaveTimer) {
			clearTimeout(tcTokenIndexSaveTimer)
			tcTokenIndexSaveTimer = undefined
			// Await index load first — prevents overwriting a more complete persisted index
			// if the connection closes before the initial load finishes.
			tcTokenIndexLoaded
				.then(() => {
					Promise.resolve(
						authState.keys.set({
							tctoken: {
								[TC_TOKEN_INDEX_KEY]: {
									token: Buffer.from(JSON.stringify([...tcTokenKnownJids]), 'utf8'),
									timestamp: unixTimestampSeconds().toString()
								}
							}
						})
					).catch(() => {
						/* non-critical */
					})
				})
				.catch(() => {
					/* non-critical */
				})
		}

		if (typeof isOnline !== 'undefined') {
			sendActiveReceipts = isOnline
			logger.trace(`sendActiveReceipts set to "${sendActiveReceipts}"`)

			// Prune expired tctokens when coming online (max once per 24h)
			if (isOnline) {
				const now = Date.now()
				const ONE_DAY_MS = 86400000
				if (now - lastTcTokenPruneTs > ONE_DAY_MS) {
					lastTcTokenPruneTs = now
					// Persist prune timestamp so it survives restarts
					Promise.resolve(
						authState.keys.set({
							tctoken: {
								[TC_TOKEN_PRUNE_TS_KEY]: {
									token: Buffer.alloc(0),
									timestamp: now.toString()
								}
							}
						})
					).catch(() => {
						/* non-critical */
					})
					pruneExpiredTcTokens().catch(err => {
						logger.debug({ err: err?.message }, 'tctoken pruning failed')
					})
				}
			}
		}
	})

	registerSocketEndHandler(() => {
		// close() stops the NodeCache check-period timer; flushAll() drops the entries so they're
		// released immediately rather than waiting for the whole cache to be GC'd.
		if (!config.msgRetryCounterCache) {
			msgRetryCache.close?.()
			msgRetryCache.flushAll?.()
		}

		if (!config.callOfferCache) {
			callOfferCache.close?.()
			callOfferCache.flushAll?.()
		}

		identityAssertDebounce.close?.()
		identityAssertDebounce.flushAll?.()

		// Audit memory-leak Finding 8: o cleanup do `placeholderResendCache`
		// JÁ acontece em chats.ts:1631-1640 (que roda DEPOIS deste handler
		// na cadeia de close). chats.ts:138-140 faz back-assign
		// `config.placeholderResendCache = placeholderResendCache` quando o
		// consumer não supre, então uma guarda `!config.placeholderResendCache`
		// aqui seria sempre false — código morto. Cobertura é total via
		// chats.ts; nada a fazer aqui (review Copilot #476).

		// Audit memory-leak Finding 1+9 — limpa Sets de dedup/in-flight pra
		// soltar suas closures imediatamente em vez de esperar expiração
		// natural dos timers internos (5s/60s).
		//
		// NÃO limpar `tcTokenKnownJids` aqui: o handler de `connection.update`
		// em :3772 agenda um flush assíncrono via `tcTokenIndexLoaded.then(...)`
		// que serializa `[...tcTokenKnownJids]` pro auth state. Limpar
		// síncrono aqui faria o spread capturar Set vazio antes do `then`
		// rodar, persistindo índice vazio (review Codex P2 #476).
		// O conteúdo de `tcTokenKnownJids` é solto naturalmente pelo GC
		// quando o socket for descartado.
		retryRequestActiveJids.clear()
		identityInFlightRefreshes.clear()
		// `tcTokenIndexSaveTimer` é cancelado pelo handler de connection.update
		// (:3774) ANTES de agendar o flush final; aqui só limpamos defensivamente
		// caso a sequência de eventos seja invertida em algum caminho de erro.
		if (tcTokenIndexSaveTimer) {
			clearTimeout(tcTokenIndexSaveTimer)
			tcTokenIndexSaveTimer = undefined
		}

		// Audit memory-leak Finding 6 — cancela qualquer cleanup PDO ainda
		// pendente (até 8s). Sem isso, o timer disparava sobre o cache
		// fechado e retinha as closures até resolver.
		for (const t of pdoCleanupTimers) clearTimeout(t)
		pdoCleanupTimers.clear()
	})

	return {
		...sock,
		sendMessageAck,
		sendRetryRequest,
		rejectCall,
		offerCall,
		acceptCall,
		preacceptCall,
		terminateCall,
		sendRelayLatency,
		sendTransport,
		sendCallDuration,
		muteCall,
		sendHeartbeat,
		sendEncRekey,
		sendVideoState,
		createCallLink,
		queryCallLink,
		joinCallLink,
		fetchMessageHistory,
		requestPlaceholderResend,
		messageRetryManager
	}
}
