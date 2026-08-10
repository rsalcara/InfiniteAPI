import NodeCache from '@cacheable/node-cache'
import { Boom } from '@hapi/boom'
import { randomBytes } from 'crypto'
import { LRUCache } from 'lru-cache'
import { proto } from '../../WAProto/index.js'
import {
	DEFAULT_CACHE_MAX_KEYS,
	DEFAULT_CACHE_TTLS,
	HISTORY_SYNC_PAUSED_TIMEOUT_MS,
	PROCESSABLE_HISTORY_TYPES
} from '../Defaults'
import type {
	BotListInfo,
	CacheStore,
	ChatModification,
	ChatMutation,
	ChatUpdate,
	Contact,
	LTHashState,
	MessageUpsertType,
	PresenceData,
	SocketConfig,
	WABusinessHoursConfig,
	WABusinessProfile,
	WAMediaUpload,
	WAMessage,
	WAPatchCreate,
	WAPatchName,
	WAPresence,
	WAPrivacyCallValue,
	WAPrivacyGroupAddValue,
	WAPrivacyMessagesValue,
	WAPrivacyOnlineValue,
	WAPrivacyValue,
	WAReadReceiptsValue
} from '../Types'
import { ALL_WA_PATCH_NAMES } from '../Types'
import type { QuickReplyAction } from '../Types/Bussines.js'
import type { LabelActionBody } from '../Types/Label'
import { SyncState } from '../Types/State'
import type {
	UsernameCheckResponse,
	UsernameGetResponse,
	UsernameMutationOptions,
	UsernameMutationResponse
} from '../Types/Username'
import { UsernameQueryIds, XWAUsernamePaths } from '../Types/Username'
import {
	buildCompanionDeviceProps,
	chatModificationToAppPatch,
	type ChatMutationMap,
	decodePatches,
	decodeSyncdSnapshot,
	encodeSyncdPatch,
	ensureLTHashStateVersion,
	extractSyncdPatches,
	generateProfilePicture,
	getHistoryMsg,
	isAppStateSyncIrrecoverable,
	isMissingKeyError,
	MAX_SYNC_ATTEMPTS,
	newLTHashState,
	OrphanQueue,
	processSyncAction,
	type RawSyncdMutation,
	resolveLidToPn
} from '../Utils'
import {
	AdaptiveHistoryBatchController,
	DurableHistorySyncCoordinator,
	markHistorySyncCheckpointComplete
} from '../Utils/history-sync-coordinator'
import type { ILogger } from '../Utils/logger'
import { makeKeyedMutex, makeMutex } from '../Utils/make-mutex'
import { encryptHistorySyncRetryRequest } from '../Utils/messages-media'
import {
	AppStateBackend,
	ChatSettingsBackend,
	type ChatSettingsRow,
	CompanionDevicesBackend,
	JidMapBackend,
	LocationBackend,
	type LocationCacheRow,
	type LocationSharerRow,
	MessageAddOnBackend,
	MessageMediaBackend,
	MessageStoreBackend,
	ReceiptBackend,
	StatusBackend,
	StickersBackend,
	type StoredCompanionDeviceRow,
	type StoredRecentStickerRow,
	type StoredStarredStickerRow,
	WaContactsBackend
} from '../Utils/multi-db-sqlite'
import { initOptionalMirror as initOptionalMirrorBase } from '../Utils/multi-db-sqlite/optional-mirror'
import { resolveStoredContact } from '../Utils/multi-db-sqlite/wa-contacts-backend'
import processMessage, { applyProcessedHistorySync, emitProcessedHistorySync } from '../Utils/process-message'
import { mapParticipantFanout } from '../Utils/relay-stanza'
import {
	buildTcTokenFromJid,
	buildTcTokenNode,
	isRegularUser,
	resolveTcTokenAliases,
	resolveTcTokenBucketPolicy,
	resolveUsableTcTokenForAliases,
	resolveUsableTcTokenForJid
} from '../Utils/tc-token-utils'
import {
	type BinaryNode,
	getBinaryNodeChild,
	getBinaryNodeChildren,
	isAnyLidUser,
	isAnyPnUser,
	jidDecode,
	jidNormalizedUser,
	reduceBinaryNodeToDictionary,
	S_WHATSAPP_NET
} from '../WABinary'
import { USyncQuery, USyncUser } from '../WAUSync'
import { settleInitialSyncTasks } from './initial-sync-tasks'
import {
	buildMexContactProfileVariables,
	executeWMexQuery as genericExecuteWMexQuery,
	MEX_CONTACT_PROFILE_BATCH_SIZE,
	MEX_CONTACT_PROFILE_QUERY_ID,
	type MexContactProfileQueryUser
} from './mex'
import { makeSocket } from './socket.js'

/**
 * Mirror one decoded app-state mutation into `sync.db`'s
 * `syncd_mutations` table. `index[0]` is always the action name, and for
 * MOST actions `index[1]` is the target chat jid — verified against
 * `chatModificationToAppPatch` in chat-utils.ts, which builds outgoing
 * patches with that convention (`['mute', jid]`, `['archive', jid]`,
 * `['pin_v1', jid]`). It is NOT universal, though: action-only entries like
 * `['setting_disableLinkPreviews']` have no jid at all, and label mutations
 * (`[LabelAssociationType.Chat, labelId, jid]`) put the jid at index[2], with
 * a label id at index[1] instead. `chatJid` below is only populated when
 * `index[1]` actually looks like a jid, so those cases store `null` rather
 * than a mislabeled value.
 *
 * Never allowed to affect the sync flow: `appStateBackend` is a best-effort
 * side channel (same rule as `onQuarantine`), so any throw here
 * (e.g. a busy SQLite writer) is swallowed and logged, not propagated.
 */
const recordRawMutation = (
	appStateBackend: AppStateBackend,
	collectionName: WAPatchName,
	raw: RawSyncdMutation & { version: number },
	logger?: ILogger
) => {
	try {
		const index = raw.mutation.index
		appStateBackend.insertMutation({
			mutationIndex: Buffer.from(raw.indexMac).toString('base64'),
			mutationValue: Buffer.from(proto.SyncActionData.encode(raw.mutation.syncAction).finish()),
			mutationVersion: raw.version,
			collectionName,
			areDependenciesMissing: 0,
			mutationMac: Buffer.from(raw.valueMac),
			// Real Android's device_id/epoch key the app-state-sync-key rotation
			// (crypto_info.device_id/epoch) — Baileys doesn't track that epoch
			// counter today, so these default to 0 (the schema's own default)
			// rather than fabricate a value with no confirmed source.
			deviceId: 0,
			epoch: 0,
			chatJid: typeof index[1] === 'string' && index[1].includes('@') ? index[1] : null,
			mutationName: index[0]
		})
	} catch (err) {
		logger?.warn?.({ err, collectionName }, 'failed to record syncd_mutation')
	}
}

export const makeChatsSocket = (config: SocketConfig) => {
	const tcTokenBucketPolicy = resolveTcTokenBucketPolicy(config.transportProfile, config.tcTokenAbProps)
	const {
		logger,
		markOnlineOnConnect,
		fireInitQueries,
		appStateMacVerification,
		shouldIgnoreJid,
		shouldSyncHistoryMessage,
		getMessage
	} = config
	const sock = makeSocket(config)
	const {
		ev,
		ws,
		authState,
		generateMessageTag,
		sendNode,
		query,
		signalRepository,
		onUnexpectedError,
		sendUnifiedSession,
		skipOfflineBuffer: socketSkippedOfflineBuffer,
		registerSocketEndHandler,
		registerSocketDrainHandler
	} = sock

	const getLIDForPN = signalRepository.lidMapping.getLIDForPN.bind(signalRepository.lidMapping)
	const getPNForLID = signalRepository.lidMapping.getPNForLID.bind(signalRepository.lidMapping)
	/**
	 * Local-only LID resolver (port of upstream PR #2614). Use on
	 * profile-picture / similar paths where we OPPORTUNISTICALLY attach
	 * metadata: a USync miss should NOT bubble out as a network round-trip
	 * because that traffic profile diverges from WA Web / whatsmeow and
	 * smells like a custom client.
	 */
	const getKnownLIDForPN = signalRepository.lidMapping.getKnownLIDForPN.bind(signalRepository.lidMapping)
	const initOptionalMirror = <T>(mirror: string, fallback: string, factory: () => T): T | undefined =>
		initOptionalMirrorBase(config.multiDbStore, logger, mirror, fallback, factory)

	let privacySettings: { [_: string]: string } | undefined

	let syncState: SyncState = SyncState.Connecting

	/** this mutex ensures that messages from the same chat are processed in order, while allowing parallel processing of messages from different chats */
	const messageMutex = makeKeyedMutex()

	/** this mutex ensures that receipts from the same chat are processed in order, while allowing parallel processing across chats */
	const receiptMutex = makeKeyedMutex()

	/** this mutex ensures that app state patches are processed in order */
	const appStatePatchMutex = makeMutex()

	/** this mutex ensures that notifications from the same chat are processed in order, while allowing parallel processing across chats */
	const notificationMutex = makeKeyedMutex()

	// Timeout for AwaitingInitialSync state
	let awaitingSyncTimeout: NodeJS.Timeout | undefined

	// In-memory history sync completion tracking (resets on reconnection)
	const historySyncStatus = {
		initialBootstrapComplete: false,
		recentSyncComplete: false,
		recentSyncPaused: false,
		fullSyncComplete: false
	}
	let historySyncPausedTimeout: NodeJS.Timeout | undefined
	const markHistorySyncCommitted = (notification: proto.Message.IHistorySyncNotification): void => {
		const syncType = notification.syncType as proto.HistorySync.HistorySyncType
		if (markHistorySyncCheckpointComplete(historySyncStatus, notification)) {
			if (syncType === proto.HistorySync.HistorySyncType.RECENT) {
				clearTimeout(historySyncPausedTimeout)
				historySyncPausedTimeout = undefined
			}

			ev.emit('messaging-history.status', { syncType, status: 'complete', explicit: true })
		}
	}

	// Collections blocked on missing app state sync keys (mirrors WA Web's "Blocked" state).
	// When a key arrives via APP_STATE_SYNC_KEY_SHARE, these are re-synced.
	const blockedCollections = new Set<WAPatchName>()

	// Mirrors app-state sync (collection_versions + syncd_mutations
	// + peer_messages) into sync.db when a multi-db-sqlite store is configured.
	// Boundary cast: `multiDbStore` is typed `unknown` on SocketConfig so
	// consumers of this module don't need a hard dependency on the SQLite
	// types (same pattern as libsignal.ts's LID-mapping wiring).

	const appStateBackend = initOptionalMirror(
		'sync.db.app_state',
		'auth_state_keys',
		() => new AppStateBackend((config.multiDbStore as any).handle('sync.db'))
	)

	// Mirrors contact events into `wa_contacts` (wa.db) — the canonical mobile
	// central contact table. Persistent (no socket-close wipe). Populated from
	// every `contacts.upsert`/`contacts.update` and backfilled on
	// `lid-mapping.update`; read back PN-transparently. All writes best-effort:
	// a mirror failure never blocks the contact event flow (fallback = legacy
	// event-driven handling). Same boundary-cast rationale as appStateBackend.
	const waContactsBackend = initOptionalMirror(
		'wa.db.wa_contacts',
		'contacts_events',
		() => new WaContactsBackend((config.multiDbStore as any).handle('wa.db'))
	)

	// Mirrors THIS client's own device registration into `companion_devices.db`
	// on connection open. InfiniteAPI is a companion (not the primary that owns
	// companions), so it stores a single row: itself, with the DeviceProps it
	// declared at pairing. Best-effort; the reconnect session lives in creds.db,
	// not here. Same boundary-cast rationale as appStateBackend.
	const companionDevicesBackend = initOptionalMirror(
		'companion_devices.db.companion_devices',
		'creds_device_state',
		() => new CompanionDevicesBackend((config.multiDbStore as any).handle('companion_devices.db'))
	)

	// Mirrors static/live location (location_cache/location_sharer)
	// into location.db when a multi-db-sqlite store is configured. Same
	// boundary-cast rationale as appStateBackend above.

	const locationBackend = initOptionalMirror(
		'location.db.location',
		'message_proto_location',
		() => new LocationBackend((config.multiDbStore as any).handle('location.db'))
	)

	// Mirrors mute/pin chat settings into chatsettings.db when a
	// multi-db-sqlite store is configured. Same boundary-cast rationale as
	// appStateBackend above.

	const chatSettingsBackend = initOptionalMirror(
		'chatsettings.db.chat_settings',
		'chat_events',
		() => new ChatSettingsBackend((config.multiDbStore as any).handle('chatsettings.db'))
	)

	// Mirrors received status/story updates (status/status_info)
	// into status.db when a multi-db-sqlite store is configured. Same
	// boundary-cast rationale as appStateBackend above.

	const statusBackend = initOptionalMirror(
		'status.db.status',
		'status_message_events',
		() => new StatusBackend((config.multiDbStore as any).handle('status.db'))
	)

	// Mirrors starred/recent stickers into stickers.db from the
	// app-state `stickerAction`/`removeRecentStickerAction` (validated source).
	const stickersBackend = initOptionalMirror(
		'stickers.db.stickers',
		'app_state_sticker_actions',
		() => new StickersBackend((config.multiDbStore as any).handle('stickers.db'))
	)

	// Mirrors real messages (message/chat tables) + delete-for-everyone
	// (message_revoked) into msgstore.db when a multi-db-sqlite store is
	// configured. Same boundary-cast rationale as appStateBackend above.
	// Resolves a fresh JidMapBackend against the shared msgstore.db handle
	// for chat/sender jid_row_id lookups — cheap (stateless prepared-
	// statement wrapper over the same connection the LID mapping already
	// uses), same pattern as factories.ts's createMessageQuarantineRecorder.
	const messageStoreBackend = initOptionalMirror(
		'msgstore.db.message',
		'legacy_message_proto',
		() =>
			new MessageStoreBackend(
				(config.multiDbStore as any).handle('msgstore.db'),
				new JidMapBackend((config.multiDbStore as any).handle('msgstore.db'))
			)
	)
	const receiptReplayBackend = messageStoreBackend
		? initOptionalMirror(
				'msgstore.db.receipt_orphaned',
				'live_receipt_events',
				() =>
					new ReceiptBackend(
						(config.multiDbStore as any).handle('msgstore.db'),
						new JidMapBackend((config.multiDbStore as any).handle('msgstore.db')),
						messageStoreBackend
					)
			)
		: undefined

	// Mirrors media metadata (message_media/message_thumbnail/audio_data/
	// message_streaming_sidecar) into msgstore.db. Same boundary-cast
	// rationale as messageStoreBackend above.
	const mediaBackend = initOptionalMirror(
		'msgstore.db.message_media',
		'message_proto_media',
		() => new MessageMediaBackend((config.multiDbStore as any).handle('msgstore.db'))
	)

	// Mirrors reactions/polls/locations/vcards attached to a message
	// (message_add_on(+_reaction)/message_poll(+_option)/message_location/
	// message_vcard) into msgstore.db. Same boundary-cast + fresh-
	// JidMapBackend rationale as messageStoreBackend above.
	const addOnBackend = messageStoreBackend
		? initOptionalMirror(
				'msgstore.db.message_add_on',
				'legacy_message_proto',
				() =>
					new MessageAddOnBackend(
						(config.multiDbStore as any).handle('msgstore.db'),
						new JidMapBackend((config.multiDbStore as any).handle('msgstore.db')),
						messageStoreBackend
					)
			)
		: undefined
	const historyBatchController = new AdaptiveHistoryBatchController()
	const hadProcessedHistory = !!authState.creds.processedHistoryMessages?.length
	const historySyncCoordinator = authState.historySync
		? new DurableHistorySyncCoordinator({
				store: authState.historySync,
				requestOptions: config.options,
				logger,
				initialHistorySyncComplete: hadProcessedHistory,
				recentHistorySyncComplete: hadProcessedHistory,
				allowMissingHistoryCheckpoint: hadProcessedHistory,
				apply: async (job, data, signal) => {
					const notification = proto.Message.HistorySyncNotification.decode(job.notification)
					await applyProcessedHistorySync(
						data,
						{ signalRepository, keyStore: authState.keys, logger, messageStoreBackend },
						historyBatchController,
						true,
						signal
					)
					emitProcessedHistorySync(data, ev, {
						isLatest: !authState.creds.processedHistoryMessages?.length,
						chunkOrder: notification.chunkOrder,
						peerDataRequestSessionId: notification.peerDataRequestSessionId
					})
				},
				requestReupload: async (job, mediaKey) => {
					const meId = authState.creds.me?.id
					if (!meId) throw new Error('cannot request history sync reupload before authentication')
					await sendNode(encryptHistorySyncRetryRequest(job.messageId, mediaKey, meId))
				},
				onCommitted: async (job, { recovered }) => {
					const notification = proto.Message.HistorySyncNotification.decode(job.notification)
					if (notification.syncType !== proto.HistorySync.HistorySyncType.ON_DEMAND) {
						const alreadyRecorded = authState.creds.processedHistoryMessages?.some(
							entry => entry.key.id === job.messageKey.id
						)
						if (!alreadyRecorded) {
							ev.emit('creds.update', {
								processedHistoryMessages: [
									...(authState.creds.processedHistoryMessages || []),
									{ key: job.messageKey, messageTimestamp: job.messageTimestamp }
								]
							})
						}
					}

					if (!recovered) markHistorySyncCommitted(notification)
				}
			})
		: undefined
	const mirrorAppStateVersion = (name: WAPatchName, state: LTHashState, source: 'snapshot' | 'patch'): void => {
		try {
			appStateBackend?.setCollectionVersion({
				collectionName: name,
				version: state.version,
				ltHash: Buffer.from(state.hash),
				dirtyVersion: -1
			})
		} catch (err) {
			logger.warn(
				{ err, collectionName: name, version: state.version, mirror: 'sync.db.collection', source },
				'multi-db-sqlite: failed to mirror collection version; auth state remains authoritative'
			)
		}
	}

	const ownsPlaceholderResendCache = !config.placeholderResendCache
	const placeholderResendCache =
		config.placeholderResendCache ||
		(new NodeCache<number>({
			stdTTL: DEFAULT_CACHE_TTLS.MSG_RETRY, // 1 hour
			useClones: false,
			// Audit memory — this is the cache instantiation that REALLY
			// runs in the standard socket chain (chats is the base; it
			// mutates `config.placeholderResendCache` so the duplicated
			// instantiation in messages-recv.ts with the same cap never
			// fires). Without `maxKeys`, the NodeCache TTL of 1h plus
			// re-extend-on-set means it grows unbounded under a stream of
			// unique-id placeholder retries.
			maxKeys: DEFAULT_CACHE_MAX_KEYS.PLACEHOLDER_RESEND
		}) as CacheStore)

	if (!config.placeholderResendCache) {
		config.placeholderResendCache = placeholderResendCache
	}

	// Holding pen for REVOKE/event-response that arrive before their target/parent
	// message does (out-of-order delivery, common during history sync catch-up).
	// See src/Utils/orphan-queue.ts for the full rationale.
	const orphanQueue = new OrphanQueue(logger)

	/** helper function to fetch the given app state sync key */
	const getAppStateSyncKey = async (keyId: string) => {
		const { [keyId]: key } = await authState.keys.get('app-state-sync-key', [keyId])
		return key
	}

	/**
	 * App State Sync Key Cache with LRU eviction policy
	 * Prevents repeated database lookups for same keys during sync operations.
	 *
	 * MEMORY SAFETY: Limited by DEFAULT_CACHE_MAX_KEYS.SIGNAL_STORE with 1-hour TTL.
	 * Auto-purges expired entries to maintain memory bounds.
	 *
	 * TYPE SAFETY: Only successful lookups (non-null values) are cached.
	 * Null/undefined values are NOT cached to prevent blocking newly arrived keys.
	 * LRUCache.get() returns undefined for missing keys.
	 */
	const appStateSyncKeyCache = new LRUCache<string, proto.Message.IAppStateSyncKeyData>({
		max: DEFAULT_CACHE_MAX_KEYS.SIGNAL_STORE, // Use constant from Defaults (10,000)
		ttl: DEFAULT_CACHE_TTLS.MSG_RETRY * 1000, // 1 hour TTL (convert seconds to ms)
		ttlAutopurge: true, // Automatically remove expired entries
		updateAgeOnGet: true // LRU refresh on access
	})

	/**
	 * Cached version of getAppStateSyncKey
	 * Uses LRU cache to reduce database calls during snapshot/patch decoding.
	 *
	 * Performance: 5x faster sync operations by eliminating redundant key fetches.
	 * Memory: Bounded by LRU policy (max 1000 keys, 1h TTL)
	 *
	 * CRITICAL FIX: Only cache successful lookups (non-null values) to prevent
	 * stale null values from blocking newly arrived keys via APP_STATE_SYNC_KEY_SHARE.
	 */
	const getCachedAppStateSyncKey = async (keyId: string) => {
		// Use get() directly to avoid race between has() and get() (Fix: Copilot C)
		const cached = appStateSyncKeyCache.get(keyId)
		if (cached !== undefined) {
			// Cache hit - return the cached key
			return cached
		}

		// Cache miss - fetch from database
		const key = await getAppStateSyncKey(keyId)

		// CRITICAL: Only cache non-null values
		// Null/undefined means key doesn't exist YET, but may arrive via APP_STATE_SYNC_KEY_SHARE
		// If we cache null, the cache (TTL 1h) will block newly arrived keys
		if (key) {
			appStateSyncKeyCache.set(keyId, key)
		}

		return key
	}

	const fetchPrivacySettings = async (force = false) => {
		if (!privacySettings || force) {
			const { content } = await query({
				tag: 'iq',
				attrs: {
					xmlns: 'privacy',
					to: S_WHATSAPP_NET,
					type: 'get'
				},
				content: [{ tag: 'privacy', attrs: {} }]
			})
			privacySettings = reduceBinaryNodeToDictionary(content?.[0] as BinaryNode, 'category')
		}

		return privacySettings
	}

	/** helper function to run a privacy IQ query */
	const privacyQuery = async (name: string, value: string) => {
		await query({
			tag: 'iq',
			attrs: {
				xmlns: 'privacy',
				to: S_WHATSAPP_NET,
				type: 'set'
			},
			content: [
				{
					tag: 'privacy',
					attrs: {},
					content: [
						{
							tag: 'category',
							attrs: { name, value }
						}
					]
				}
			]
		})
	}

	const updateMessagesPrivacy = async (value: WAPrivacyMessagesValue) => {
		await privacyQuery('messages', value)
	}

	const updateCallPrivacy = async (value: WAPrivacyCallValue) => {
		await privacyQuery('calladd', value)
	}

	const updateLastSeenPrivacy = async (value: WAPrivacyValue) => {
		await privacyQuery('last', value)
	}

	const updateOnlinePrivacy = async (value: WAPrivacyOnlineValue) => {
		await privacyQuery('online', value)
	}

	const updateProfilePicturePrivacy = async (value: WAPrivacyValue) => {
		await privacyQuery('profile', value)
	}

	const updateStatusPrivacy = async (value: WAPrivacyValue) => {
		await privacyQuery('status', value)
	}

	const updateReadReceiptsPrivacy = async (value: WAReadReceiptsValue) => {
		await privacyQuery('readreceipts', value)
	}

	const updateGroupsAddPrivacy = async (value: WAPrivacyGroupAddValue) => {
		await privacyQuery('groupadd', value)
	}

	const updateDefaultDisappearingMode = async (duration: number) => {
		await query({
			tag: 'iq',
			attrs: {
				xmlns: 'disappearing_mode',
				to: S_WHATSAPP_NET,
				type: 'set'
			},
			content: [
				{
					tag: 'disappearing_mode',
					attrs: {
						duration: duration.toString()
					}
				}
			]
		})
	}

	const getBotListV2 = async () => {
		const resp = await query({
			tag: 'iq',
			attrs: {
				xmlns: 'bot',
				to: S_WHATSAPP_NET,
				type: 'get'
			},
			content: [
				{
					tag: 'bot',
					attrs: {
						v: '2'
					}
				}
			]
		})

		const botNode = getBinaryNodeChild(resp, 'bot')

		const botList: BotListInfo[] = []
		for (const section of getBinaryNodeChildren(botNode, 'section')) {
			if (section.attrs.type === 'all') {
				for (const bot of getBinaryNodeChildren(section, 'bot')) {
					const jid = bot.attrs.jid
					const personaId = bot.attrs['persona_id']
					if (!jid || !personaId) continue
					botList.push({
						jid,
						personaId
					})
				}
			}
		}

		return botList
	}

	const buildTcTokenUsers = (jids: string[]) =>
		mapParticipantFanout(jids, async jid => {
			const user = new USyncUser().withId(jid)
			const privacyToken = await resolveUsableTcTokenForJid({
				authState,
				jid,
				getLIDForPN,
				getPNForLID,
				bucketPolicy: tcTokenBucketPolicy
			})
			if (privacyToken.buffer) user.withPrivacyToken(privacyToken.buffer, privacyToken.timestamp)
			return user
		})

	const fetchStatus = async (...jids: string[]) => {
		const usyncQuery = new USyncQuery().withStatusProtocol()
		for (const user of await buildTcTokenUsers(jids)) usyncQuery.withUser(user)

		const result = await sock.executeUSyncQuery(usyncQuery)
		if (result) {
			return result.list
		}
	}

	const fetchDisappearingDuration = async (...jids: string[]) => {
		const usyncQuery = new USyncQuery().withDisappearingModeProtocol()
		for (const user of await buildTcTokenUsers(jids)) usyncQuery.withUser(user)

		const result = await sock.executeUSyncQuery(usyncQuery)
		if (result) {
			return result.list
		}
	}

	/** update the profile picture for yourself or a group */
	const updateProfilePicture = async (
		jid: string,
		content: WAMediaUpload,
		dimensions?: { width: number; height: number }
	) => {
		let targetJid
		if (!jid) {
			throw new Boom(
				'Illegal no-jid profile update. Please specify either your ID or the ID of the chat you wish to update'
			)
		}

		const me = authState.creds.me
		if (!me) throw new Boom('Not authenticated', { statusCode: 401 })
		if (jidNormalizedUser(jid) !== jidNormalizedUser(me.id)) {
			targetJid = jidNormalizedUser(jid) // in case it is someone other than us
		} else {
			targetJid = undefined
		}

		const { img } = await generateProfilePicture(content, dimensions)
		await query({
			tag: 'iq',
			attrs: {
				to: S_WHATSAPP_NET,
				type: 'set',
				xmlns: 'w:profile:picture',
				...(targetJid ? { target: targetJid } : {})
			},
			content: [
				{
					tag: 'picture',
					attrs: { type: 'image' },
					content: img
				}
			]
		})
	}

	/** remove the profile picture for yourself or a group */
	const removeProfilePicture = async (jid: string) => {
		let targetJid
		if (!jid) {
			throw new Boom(
				'Illegal no-jid profile update. Please specify either your ID or the ID of the chat you wish to update'
			)
		}

		const me = authState.creds.me
		if (!me) throw new Boom('Not authenticated', { statusCode: 401 })
		if (jidNormalizedUser(jid) !== jidNormalizedUser(me.id)) {
			targetJid = jidNormalizedUser(jid) // in case it is someone other than us
		} else {
			targetJid = undefined
		}

		await query({
			tag: 'iq',
			attrs: {
				to: S_WHATSAPP_NET,
				type: 'set',
				xmlns: 'w:profile:picture',
				...(targetJid ? { target: targetJid } : {})
			}
		})
	}

	/** update the profile status for yourself */
	const updateProfileStatus = async (status: string) => {
		await query({
			tag: 'iq',
			attrs: {
				to: S_WHATSAPP_NET,
				type: 'set',
				xmlns: 'status'
			},
			content: [
				{
					tag: 'status',
					attrs: {},
					content: Buffer.from(status, 'utf-8')
				}
			]
		})
	}

	const updateProfileName = async (name: string) => {
		await chatModify({ pushNameSetting: name }, '')
	}

	// ─────────────────────────────────────────────────────────────────────
	// @username CRUD (WhatsApp 2026 feature)
	//
	// All four operations ride the SAME `executeWMexQuery` helper the
	// newsletter code uses — only the query_id + variable shape + xwa2_*
	// data-path differ. See `src/Types/Username.ts` for protocol notes
	// and origin of the doc IDs.
	//
	// CAVEAT: WhatsApp Web companion is GATED OUT of editing (the bundle
	// logs `Requiring unknown module "WAWebUsernameFlow"` when the user
	// opens the panel, and the UI shows "edit on your primary phone").
	// InfiniteAPI authenticates as a regular companion device so the
	// server may reject these mutations with a 400 / MexFatalExtensionError
	// until the `username_enabled_on_companion` gate flips. The query side
	// (GET / CHECK) is observed working on companion today.
	// ─────────────────────────────────────────────────────────────────────

	const executeWMexQuery = <T>(variables: Record<string, unknown>, queryId: string, dataPath: string): Promise<T> => {
		return genericExecuteWMexQuery<T>(variables, queryId, dataPath, query, generateMessageTag)
	}

	/**
	 * Explicit Android-compatible MEX profile enrichment. It is intentionally
	 * opt-in: unrelated username/newsletter MEX operations have different
	 * variable contracts and must not receive a privacy token globally.
	 */
	const fetchContactProfiles = async (jids: string[]): Promise<Record<string, unknown>[]> => {
		const users = new Map<string, MexContactProfileQueryUser>()
		for (const requestedJid of jids) {
			const normalized = jidNormalizedUser(requestedJid)
			if (!isRegularUser(normalized)) continue

			let aliases = [normalized]
			try {
				aliases = await resolveTcTokenAliases(normalized, { getLIDForPN, getPNForLID })
			} catch (error) {
				logger.debug({ error, requestedJid }, 'MEX profile LID canonicalization skipped')
			}

			const canonicalJid = aliases[0] ?? normalized

			if (users.has(canonicalJid)) continue

			const token = await resolveUsableTcTokenForAliases({
				authState,
				aliases,
				bucketPolicy: tcTokenBucketPolicy
			})
			users.set(canonicalJid, {
				jid: canonicalJid,
				...(token.buffer ? { privacyToken: { token: token.buffer, timestamp: token.timestamp } } : {})
			})
		}

		const entries = [...users.values()]
		const results: Record<string, unknown>[] = []
		for (let offset = 0; offset < entries.length; offset += MEX_CONTACT_PROFILE_BATCH_SIZE) {
			const variables = buildMexContactProfileVariables(entries.slice(offset, offset + MEX_CONTACT_PROFILE_BATCH_SIZE))
			results.push(
				await genericExecuteWMexQuery<Record<string, unknown>>(
					variables,
					MEX_CONTACT_PROFILE_QUERY_ID,
					'',
					query,
					generateMessageTag,
					{ includeQueryId: true, includeTrace: true }
				)
			)
		}

		return results
	}

	const newMexSessionId = () => randomBytes(8).toString('hex')

	/**
	 * Read the account's own `@username` and lifecycle state. Pass `pin`
	 * to additionally retrieve the stored anti-spoof PIN — the server
	 * only echoes `pin` back when the supplied value matches the stored
	 * one, so this doubles as a "verify pin" probe.
	 *
	 * Throws (via `executeWMexQuery`'s Boom) when the server response
	 * omits the `xwa2_username_get` field — observed for accounts that
	 * have never claimed a handle. Callers that want a "did the user
	 * even reserve?" probe should catch that Boom (`statusCode: 400`)
	 * and treat it as "no handle".
	 */
	const getMyUsername = async (opts: { pin?: string } = {}): Promise<UsernameGetResponse> => {
		return executeWMexQuery<UsernameGetResponse>(
			opts.pin !== undefined ? { pin: opts.pin } : {},
			UsernameQueryIds.GET,
			XWAUsernamePaths.GET
		)
	}

	/**
	 * Reserve / change the account's own `@username`.
	 *
	 * The server enforces three rules independently of this client:
	 *   - Format: lowercase ASCII letters/digits/underscore, length 3-30
	 *   - Uniqueness: returns `result: 'TAKEN'` if claimed
	 *   - Rollout gate: while `username_reservation_only_mode` is set
	 *     server-side, an existing RESERVED handle cannot be transitioned
	 *     to ACTIVE — the mutation may succeed but the state stays
	 *     RESERVED until the global toggle flips
	 *
	 * `reserved` defaults to `true` (current rollout state). Override to
	 * `false` once the public ACTIVE flow opens.
	 */
	const setMyUsername = async (
		username: string,
		opts: UsernameMutationOptions & { reserved?: boolean } = {}
	): Promise<UsernameMutationResponse> => {
		// Strip a leading `@` defensively, same convention as
		// `getUserByUsername` — the server expects the bare handle and
		// rejects `@tuoli` with INVALID. (audit release #583 review #4)
		const normalized = username.startsWith('@') ? username.slice(1) : username
		return executeWMexQuery<UsernameMutationResponse>(
			{
				username: normalized,
				reserved: opts.reserved ?? true,
				session_id: opts.sessionId ?? newMexSessionId(),
				source: opts.source ?? 'USER_INPUT'
			},
			UsernameQueryIds.SET,
			XWAUsernamePaths.SET
		)
	}

	/**
	 * Release the account's own `@username`. The server soft-deletes —
	 * the handle is held in a grace-period quarantine before being
	 * re-issuable, to prevent immediate impersonation.
	 *
	 * Mirrors the Web client's pattern: the SET mutation with EMPTY
	 * variables (no `username` field) is the documented delete signal.
	 */
	const deleteMyUsername = async (): Promise<UsernameMutationResponse> => {
		return executeWMexQuery<UsernameMutationResponse>({}, UsernameQueryIds.SET, XWAUsernamePaths.SET)
	}

	/**
	 * Pre-validate handle availability before calling `setMyUsername`.
	 * On `result: 'TAKEN'` the server populates `suggestions` with
	 * adjacent free handles the UI can offer.
	 *
	 * The `sessionId` should be REUSED across the check + the subsequent
	 * SET, so the server's telemetry can correlate them; pass the same
	 * value to both calls when wiring a "type → debounce → check → set"
	 * UI flow.
	 */
	const checkUsernameAvailability = async (
		username: string,
		opts: UsernameMutationOptions = {}
	): Promise<UsernameCheckResponse> => {
		// Strip a leading `@` (audit release #583 review #4) — same as
		// `setMyUsername`, so a "user types `@tuoli` → debounce → check
		// → set" UI doesn't have to manually trim at every hop.
		const normalized = username.startsWith('@') ? username.slice(1) : username
		return executeWMexQuery<UsernameCheckResponse>(
			{
				username: normalized,
				session_id: opts.sessionId ?? newMexSessionId(),
				source: opts.source ?? 'USER_INPUT'
			},
			UsernameQueryIds.CHECK,
			XWAUsernamePaths.CHECK
		)
	}

	/**
	 * Set or rotate the anti-spoof PIN ("chave") protecting the username.
	 * WhatsApp Web shows "Você pode editar o nome de usuário e a chave no
	 * seu celular principal" — the server appears to currently restrict
	 * this mutation to the PRIMARY device. Expect `MexFatalExtensionError`
	 * with `error_code: 403` (not_authorized) on companion devices until
	 * the gate flips.
	 */
	const setMyUsernameKey = async (pin: string): Promise<UsernameMutationResponse> => {
		return executeWMexQuery<UsernameMutationResponse>({ pin }, UsernameQueryIds.PIN_SET, XWAUsernamePaths.PIN_SET)
	}

	/**
	 * Resolve a `@username` to the underlying LID. Uses the existing
	 * `USyncUsernameProtocol` (already wired into `USyncQuery`) — the
	 * server matches on the `username` attr and returns the user node
	 * with `id` populated to the LID JID.
	 *
	 * Returns `null` when the username is not registered. The username
	 * argument is taken WITHOUT the leading `@` (e.g. `'tuoli'`, not
	 * `'@tuoli'`); the leading `@` is stripped defensively for callers
	 * that pass it.
	 */
	const getUserByUsername = async (username: string) => {
		const normalized = username.startsWith('@') ? username.slice(1) : username
		const usyncQuery = new USyncQuery().withUsernameProtocol().withUser(new USyncUser().withUsername(normalized))

		const result = await sock.executeUSyncQuery(usyncQuery)
		return result?.list?.[0] ?? null
	}

	const fetchBlocklist = async () => {
		const result = await query({
			tag: 'iq',
			attrs: {
				xmlns: 'blocklist',
				to: S_WHATSAPP_NET,
				type: 'get'
			}
		})

		const listNode = getBinaryNodeChild(result, 'list')
		return getBinaryNodeChildren(listNode, 'item').map(n => n.attrs.jid)
	}

	const updateBlockStatus = async (jid: string, action: 'block' | 'unblock') => {
		const normalizedJid = jidNormalizedUser(jid)
		let lid: string
		let pn_jid: string | undefined

		if (isAnyLidUser(normalizedJid)) {
			lid = normalizedJid
			if (action === 'block') {
				const pn = await signalRepository.lidMapping.getPNForLID(normalizedJid)
				if (!pn) {
					throw new Boom(`Unable to resolve PN JID for LID: ${jid}`, { statusCode: 400 })
				}

				pn_jid = jidNormalizedUser(pn)
			}
		} else if (isAnyPnUser(normalizedJid)) {
			const mapped = await signalRepository.lidMapping.getLIDForPN(normalizedJid)
			if (!mapped) {
				throw new Boom(`Unable to resolve LID for PN JID: ${jid}`, { statusCode: 400 })
			}

			lid = mapped
			if (action === 'block') {
				pn_jid = normalizedJid
			}
		} else {
			throw new Boom(`Invalid jid for block/unblock: ${jid}`, { statusCode: 400 })
		}

		const itemAttrs: { action: 'block' | 'unblock'; jid: string; pn_jid?: string } = {
			action,
			jid: lid
		}

		if (action === 'block' && pn_jid) {
			itemAttrs.pn_jid = pn_jid
		}

		await query({
			tag: 'iq',
			attrs: {
				xmlns: 'blocklist',
				to: S_WHATSAPP_NET,
				type: 'set'
			},
			content: [
				{
					tag: 'item',
					attrs: itemAttrs
				}
			]
		})
	}

	const getBusinessProfile = async (jid: string): Promise<WABusinessProfile | void> => {
		const results = await query({
			tag: 'iq',
			attrs: {
				to: 's.whatsapp.net',
				xmlns: 'w:biz',
				type: 'get'
			},
			content: [
				{
					tag: 'business_profile',
					attrs: { v: '244' },
					content: [
						{
							tag: 'profile',
							attrs: { jid }
						}
					]
				}
			]
		})

		const profileNode = getBinaryNodeChild(results, 'business_profile')
		const profiles = getBinaryNodeChild(profileNode, 'profile')
		if (profiles) {
			const address = getBinaryNodeChild(profiles, 'address')
			const description = getBinaryNodeChild(profiles, 'description')
			const website = getBinaryNodeChild(profiles, 'website')
			const email = getBinaryNodeChild(profiles, 'email')
			const category = getBinaryNodeChild(getBinaryNodeChild(profiles, 'categories'), 'category')
			const businessHours = getBinaryNodeChild(profiles, 'business_hours')
			const businessHoursConfig = businessHours
				? getBinaryNodeChildren(businessHours, 'business_hours_config')
				: undefined
			const websiteStr = website?.content?.toString()
			return {
				wid: profiles.attrs?.jid,
				address: address?.content?.toString(),
				description: description?.content?.toString() || '',
				website: websiteStr ? [websiteStr] : [],
				email: email?.content?.toString(),
				category: category?.content?.toString(),
				business_hours: {
					timezone: businessHours?.attrs?.timezone,
					business_config: businessHoursConfig?.map(({ attrs }) => attrs as unknown as WABusinessHoursConfig)
				}
			}
		}
	}

	const cleanDirtyBits = async (type: 'account_sync' | 'groups', fromTimestamp?: number | string) => {
		logger.info({ fromTimestamp }, 'clean dirty bits ' + type)
		await sendNode({
			tag: 'iq',
			attrs: {
				to: S_WHATSAPP_NET,
				type: 'set',
				xmlns: 'urn:xmpp:whatsapp:dirty',
				id: generateMessageTag()
			},
			content: [
				{
					tag: 'clean',
					attrs: {
						type,
						...(fromTimestamp ? { timestamp: fromTimestamp.toString() } : null)
					}
				}
			]
		})
	}

	const newAppStateChunkHandler = (isInitialSync: boolean) => {
		return {
			onMutation(mutation: ChatMutation) {
				const me = authState.creds.me
				if (!me) throw new Boom('Not authenticated', { statusCode: 401 })
				processSyncAction(
					mutation,
					ev,
					me,
					isInitialSync ? { accountSettings: authState.creds.accountSettings } : undefined,
					logger,
					chatSettingsBackend,
					stickersBackend
				)
			}
		}
	}

	const resyncAppState = ev.createBufferedFunction(
		async (collections: readonly WAPatchName[], isInitialSync: boolean) => {
			// we use this to determine which events to fire
			// otherwise when we resync from scratch -- all notifications will fire
			const initialVersionMap: { [T in WAPatchName]?: number } = {}
			const globalMutationMap: ChatMutationMap = {}
			const forceSnapshotCollections = new Set<WAPatchName>()

			await authState.keys.transaction(async () => {
				const collectionsToHandle = new Set<string>(collections)
				// in case something goes wrong -- ensure we don't enter a loop that cannot be exited from
				const attemptsMap: { [T in WAPatchName]?: number } = {}
				// keep executing till all collections are done
				// sometimes a single patch request will not return all the patches (God knows why)
				// so we fetch till they're all done (this is determined by the "has_more_patches" flag)
				while (collectionsToHandle.size) {
					const states = {} as { [T in WAPatchName]: LTHashState }
					const nodes: BinaryNode[] = []

					for (const name of collectionsToHandle as Set<WAPatchName>) {
						const result = await authState.keys.get('app-state-sync-version', [name])
						let state = result[name]

						if (state) {
							state = ensureLTHashStateVersion(state)
							if (typeof initialVersionMap[name] === 'undefined') {
								initialVersionMap[name] = state.version
							}
						} else {
							state = newLTHashState()
						}

						states[name] = state

						const shouldForceSnapshot = forceSnapshotCollections.has(name)
						if (shouldForceSnapshot) {
							forceSnapshotCollections.delete(name)
						}

						logger.info(`resyncing ${name} from v${state.version}${shouldForceSnapshot ? ' (forcing snapshot)' : ''}`)

						nodes.push({
							tag: 'collection',
							attrs: {
								name,
								version: state.version.toString(),
								// return snapshot if syncing from scratch or forcing after a failed attempt
								return_snapshot: (shouldForceSnapshot || !state.version).toString()
							}
						})
					}

					const result = await query({
						tag: 'iq',
						attrs: {
							to: S_WHATSAPP_NET,
							xmlns: 'w:sync:app:state',
							type: 'set'
						},
						content: [
							{
								tag: 'sync',
								attrs: {},
								content: nodes
							}
						]
					})

					// extract from binary node
					const decoded = await extractSyncdPatches(result, config?.options)
					for (const key in decoded) {
						const name = key as WAPatchName
						const { patches, hasMorePatches, snapshot } = decoded[name]
						try {
							if (snapshot) {
								const { state: newState, mutationMap } = await decodeSyncdSnapshot(
									name,
									snapshot,
									getCachedAppStateSyncKey,
									initialVersionMap[name],
									appStateMacVerification.snapshot,
									appStateBackend ? raw => recordRawMutation(appStateBackend, name, raw) : undefined
								)
								states[name] = newState
								Object.assign(globalMutationMap, mutationMap)

								logger.info(`restored state of ${name} from snapshot to v${newState.version} with mutations`)

								await authState.keys.set({ 'app-state-sync-version': { [name]: newState } })
								// See AppStateBackend's class doc: `dirty_version=-1` mirrors the
								// real schema's "converged" default — this gateway only persists
								// server-confirmed state, never a pending local-first mutation.
								mirrorAppStateVersion(name, newState, 'snapshot')
							}

							// only process if there are syncd patches
							if (patches.length) {
								const { state: newState, mutationMap } = await decodePatches(
									name,
									patches,
									states[name],
									getCachedAppStateSyncKey,
									config.options,
									initialVersionMap[name],
									logger,
									appStateMacVerification.patch,
									appStateBackend ? raw => recordRawMutation(appStateBackend, name, raw) : undefined
								)

								await authState.keys.set({ 'app-state-sync-version': { [name]: newState } })
								mirrorAppStateVersion(name, newState, 'patch')

								logger.info(`synced ${name} to v${newState.version}`)
								initialVersionMap[name] = newState.version

								Object.assign(globalMutationMap, mutationMap)
							}

							if (hasMorePatches) {
								logger.info(`${name} has more patches...`)
							} else {
								// collection is done with sync
								collectionsToHandle.delete(name)
							}
						} catch (error: any) {
							attemptsMap[name] = (attemptsMap[name] || 0) + 1

							const logData = {
								name,
								attempt: attemptsMap[name],
								version: states[name].version,
								statusCode: error.output?.statusCode,
								errorType: error.name,
								error: error.stack
							}

							if (isMissingKeyError(error) && attemptsMap[name] >= MAX_SYNC_ATTEMPTS) {
								// WA Web treats missing keys as "Blocked" — park the collection
								// until the key arrives via APP_STATE_SYNC_KEY_SHARE.
								logger.warn(
									logData,
									`${name} blocked on missing key from v${states[name].version}, parking after ${attemptsMap[name]} attempts`
								)
								blockedCollections.add(name)
								collectionsToHandle.delete(name)
							} else if (isMissingKeyError(error)) {
								// Retry with a snapshot which may use a different key.
								logger.info(
									logData,
									`${name} blocked on missing key from v${states[name].version}, retrying with snapshot`
								)
								forceSnapshotCollections.add(name)
							} else if (isAppStateSyncIrrecoverable(error, attemptsMap[name])) {
								logger.warn(logData, `failed to sync ${name} from v${states[name].version}, giving up`)
								// reset persisted version to null so the next resyncAppState call
								// requests a full snapshot instead of reusing the stale version that caused the error
								await authState.keys.set({ 'app-state-sync-version': { [name]: null } })
								collectionsToHandle.delete(name)
							} else {
								logger.info(logData, `failed to sync ${name} from v${states[name].version}, forcing snapshot retry`)
								// force a full snapshot on retry to recover from
								// corrupted local state (e.g. LTHash MAC mismatch)
								forceSnapshotCollections.add(name)
							}
						}
					}
				}
			}, authState?.creds?.me?.id || 'resync-app-state')

			const { onMutation } = newAppStateChunkHandler(isInitialSync)
			const lidMapping = signalRepository.lidMapping
			for (const key in globalMutationMap) {
				const mutation = globalMutationMap[key]
				if (!mutation) continue
				// Normalize LID→PN in sync action index[1] (chat/contact ID)
				if (mutation.index[1] && isAnyLidUser(mutation.index[1])) {
					const resolved = await resolveLidToPn(mutation.index[1], lidMapping, logger)
					if (resolved) mutation.index[1] = resolved
				}

				onMutation(mutation)
			}
		}
	)

	/**
	 * Fetch the profile picture URL of a user/group.
	 *
	 * `type`:        "preview" for a low-res picture, "image" for the high-res picture.
	 * `existingId`:  the `id` of the last known picture for this JID. If supplied AND the
	 *                picture has not changed, the server responds with a `304`-style empty
	 *                result (sentinel for "use cached URL") instead of returning a fresh URL.
	 *                Saves a CDN re-fetch per refresh — matches WA Web `pictureId` and
	 *                whatsmeow `ExistingID`.
	 * `invite`:      group-invite code. Allows fetching a group's picture without joining,
	 *                used by the "preview before accepting invite" flow. Mutually exclusive
	 *                with `tctoken` (server doesn't require it for invite-code lookups).
	 * `personaId`:   Meta-AI bot persona id. Required to fetch the picture of an AI persona.
	 * `commonGid`:   a group jid both parties belong to. Required when the target's privacy
	 *                is set to "My contacts" and we are NOT in their contacts but share a
	 *                group — without it the server returns 401/403. Matches WA Web.
	 *
	 * Stanza shape (matches WA Web `WASmaxOutProfilePictureGetRequest` + whatsmeow):
	 *
	 *   <iq xmlns="w:profile:picture" type="get" target="{jid}" to="s.whatsapp.net">
	 *     <picture type="..." query="url" [id] [invite] [persona_id] [common_gid]>
	 *       [<tctoken>...</tctoken>]   ← nested CHILD (not sibling)
	 *     </picture>
	 *   </iq>
	 */
	const profilePictureUrl = async (
		jid: string,
		type: 'preview' | 'image' = 'preview',
		timeoutMs?: number,
		opts?: {
			existingId?: string
			invite?: string
			personaId?: string
			commonGid?: string
		}
	) => {
		const normalizedJid = jidNormalizedUser(jid)
		const isUserJid = isAnyPnUser(normalizedJid) || isAnyLidUser(normalizedJid)
		const me = authState.creds.me
		const isSelf =
			me && (normalizedJid === jidNormalizedUser(me.id) || (me.lid && normalizedJid === jidNormalizedUser(me.lid)))

		// Build the <picture> attrs — include only the fields the caller supplied,
		// so unset ones map to DROP_ATTR (matching WA Web's OPTIONAL serializer behavior).
		const pictureAttrs: { [k: string]: string } = { type, query: 'url' }
		if (opts?.existingId) pictureAttrs.id = opts.existingId
		if (opts?.invite) pictureAttrs.invite = opts.invite
		if (opts?.personaId) pictureAttrs.persona_id = opts.personaId
		if (opts?.commonGid) pictureAttrs.common_gid = opts.commonGid

		const pictureNode: BinaryNode = { tag: 'picture', attrs: pictureAttrs }

		// Attach tctoken (if known) as a CHILD of <picture>. Match WA Web
		// (WASmaxOutProfilePictureTCTokenMixin) and whatsmeow (pictureContent).
		// WA Web only includes tctoken for user JIDs (not groups/newsletters)
		// and never for own profile pic — including it for self causes the
		// server to never respond. Invite-code lookups also skip the token
		// (the invite IS the authorization).
		if (isUserJid && !isSelf && !opts?.invite) {
			const tctokenNode = await buildTcTokenNode({
				authState,
				jid: normalizedJid,
				// Port of upstream PR #2614: never fire USync from the profile-picture
				// path. If the LID mapping is unknown we send the IQ without the
				// tctoken and let the server tell us (vs. doing a USync round trip
				// that fingerprints us as non-WA-Web).
				getLIDForPN: getKnownLIDForPN,
				getPNForLID,
				bucketPolicy: tcTokenBucketPolicy
			})
			if (tctokenNode) {
				pictureNode.content = [tctokenNode]
			}
		}

		const result = await query(
			{
				tag: 'iq',
				attrs: {
					target: normalizedJid,
					to: S_WHATSAPP_NET,
					type: 'get',
					xmlns: 'w:profile:picture'
				},
				content: [pictureNode]
			},
			timeoutMs
		)
		const child = getBinaryNodeChild(result, 'picture')
		return child?.attrs?.url
	}

	const createCallLink = async (type: 'audio' | 'video', event?: { startTime: number }, timeoutMs?: number) => {
		const result = await query(
			{
				tag: 'call',
				attrs: {
					id: generateMessageTag(),
					to: '@call'
				},
				content: [
					{
						tag: 'link_create',
						attrs: { media: type },
						content: event ? [{ tag: 'event', attrs: { start_time: String(event.startTime) } }] : undefined
					}
				]
			},
			timeoutMs
		)
		const child = getBinaryNodeChild(result, 'link_create')
		return child?.attrs?.token
	}

	const sendPresenceUpdate = async (type: WAPresence, toJid?: string) => {
		const me = authState.creds.me
		if (!me) throw new Boom('Not authenticated', { statusCode: 401 })
		if (type === 'available' || type === 'unavailable') {
			if (!me.name) {
				logger.warn('no name present, ignoring presence update request...')
				return
			}

			ev.emit('connection.update', { isOnline: type === 'available' })

			await sendNode({
				tag: 'presence',
				attrs: {
					name: me.name.replace(/@/g, ''),
					type
				}
			})

			// Send unified_session telemetry when going online
			// This mimics official WhatsApp Web client behavior
			if (type === 'available') {
				sendUnifiedSession('presence').catch(err => {
					logger.debug({ err }, 'Failed to send unified_session on presence available')
				})
			}
		} else {
			if (!toJid) {
				logger.warn('sendPresenceUpdate: toJid is missing, skipping')
				return
			}

			const decoded = jidDecode(toJid)
			if (!decoded) {
				logger.warn({ toJid }, 'sendPresenceUpdate: failed to decode toJid, skipping')
				return
			}

			const { server } = decoded
			const isLid = server === 'lid'

			await sendNode({
				tag: 'chatstate',
				attrs: {
					from: isLid ? me.lid || me.id : me.id,
					to: toJid
				},
				content: [
					{
						tag: type === 'recording' ? 'composing' : type,
						attrs: type === 'recording' ? { media: 'audio' } : {}
					}
				]
			})
		}
	}

	/**
	 * @param toJid the jid to subscribe to
	 * @param tcToken token for subscription, use if present
	 */
	const presenceSubscribe = async (toJid: string) => {
		// Only include tctoken for user JIDs — groups/newsletters don't use tctokens
		const normalizedToJid = jidNormalizedUser(toJid)
		const isUserJid = isAnyPnUser(normalizedToJid) || isAnyLidUser(normalizedToJid)
		const tcTokenContent = isUserJid
			? await buildTcTokenFromJid({
					authState,
					jid: normalizedToJid,
					getLIDForPN,
					getPNForLID,
					bucketPolicy: tcTokenBucketPolicy
				})
			: undefined

		return sendNode({
			tag: 'presence',
			attrs: {
				to: toJid,
				id: generateMessageTag(),
				type: 'subscribe'
			},
			content: tcTokenContent
		})
	}

	const handlePresenceUpdate = async ({ tag, attrs, content }: BinaryNode) => {
		let presence: PresenceData | undefined
		const rawJid = attrs.from
		const rawParticipant = attrs.participant || attrs.from
		if (!rawJid) {
			logger.warn({ attrs }, 'handlePresenceUpdate: jid (attrs.from) is missing, skipping')
			return
		}

		if (shouldIgnoreJid(rawJid) && rawJid !== S_WHATSAPP_NET) {
			return
		}

		if (tag === 'presence') {
			presence = {
				lastKnownPresence: attrs.type === 'unavailable' ? 'unavailable' : 'available',
				lastSeen: attrs.last && attrs.last !== 'deny' ? +attrs.last : undefined,
				groupOnlineCount: attrs.count ? +attrs.count : undefined
			}
		} else if (Array.isArray(content)) {
			const [firstChild] = content
			if (!firstChild) {
				logger.warn({ jid: rawJid }, 'handlePresenceUpdate: firstChild content is empty, skipping')
				return
			}

			let type = firstChild.tag as WAPresence
			if (type === 'paused') {
				type = 'available'
			}

			if (firstChild.attrs?.media === 'audio') {
				type = 'recording'
			}

			presence = { lastKnownPresence: type }
		} else {
			logger.error({ tag, attrs, content }, 'recv invalid presence node')
		}

		if (presence) {
			if (!rawParticipant) {
				logger.warn({ jid: rawJid }, 'handlePresenceUpdate: participant is missing, skipping')
				return
			}

			// Resolve LID→PN so consumers always see phone-number JIDs
			const lidMapping = signalRepository.lidMapping
			const [jid, participant] = await Promise.all([
				resolveLidToPn(rawJid, lidMapping, logger),
				resolveLidToPn(rawParticipant, lidMapping, logger)
			])

			ev.emit('presence.update', { id: jid!, presences: { [participant!]: presence } })
		}
	}

	const appPatch = async (patchCreate: WAPatchCreate) => {
		const name = patchCreate.type
		const myAppStateKeyId = authState.creds.myAppStateKeyId
		if (!myAppStateKeyId) {
			throw new Boom('App state key not present!', { statusCode: 400 })
		}

		let initial: LTHashState
		let encodeResult: { patch: proto.ISyncdPatch; state: LTHashState }

		await appStatePatchMutex.mutex(async () => {
			await authState.keys.transaction(async () => {
				logger.debug({ patch: patchCreate }, 'applying app patch')

				await resyncAppState([name], false)

				const { [name]: currentSyncVersion } = await authState.keys.get('app-state-sync-version', [name])
				initial = currentSyncVersion ? ensureLTHashStateVersion(currentSyncVersion) : newLTHashState()

				encodeResult = await encodeSyncdPatch(patchCreate, myAppStateKeyId, initial, getAppStateSyncKey)
				const { patch, state } = encodeResult

				const node: BinaryNode = {
					tag: 'iq',
					attrs: {
						to: S_WHATSAPP_NET,
						type: 'set',
						xmlns: 'w:sync:app:state'
					},
					content: [
						{
							tag: 'sync',
							attrs: {},
							content: [
								{
									tag: 'collection',
									attrs: {
										name,
										version: (state.version - 1).toString(),
										return_snapshot: 'false'
									},
									content: [
										{
											tag: 'patch',
											attrs: {},
											content: proto.SyncdPatch.encode(patch).finish()
										}
									]
								}
							]
						}
					]
				}
				await query(node)

				await authState.keys.set({ 'app-state-sync-version': { [name]: state } })
			}, authState?.creds?.me?.id || 'app-patch')

			// Only publish to sync.db after the auth-state transaction has fully
			// committed. A post-callback commit failure must never leave the mirror
			// ahead of the authoritative version. The server already accepted this
			// patch, and the helper remains best-effort/non-blocking.
			mirrorAppStateVersion(name, encodeResult!.state, 'patch')
		})

		if (config.emitOwnEvents) {
			const { onMutation } = newAppStateChunkHandler(false)
			const { mutationMap } = await decodePatches(
				name,
				[{ ...encodeResult!.patch, version: { version: encodeResult!.state.version } }],
				initial!,
				getAppStateSyncKey,
				config.options,
				undefined,
				logger
			)
			const lidMapping = signalRepository.lidMapping
			for (const key in mutationMap) {
				const mutation = mutationMap[key]!
				// Normalize LID→PN in sync action index[1] (chat/contact ID)
				if (mutation.index[1] && isAnyLidUser(mutation.index[1])) {
					const resolved = await resolveLidToPn(mutation.index[1], lidMapping, logger)
					if (resolved) mutation.index[1] = resolved
				}

				onMutation(mutation)
			}
		}
	}

	/** fetch AB props */
	const fetchProps = async () => {
		// Upstream #2473: query AB props using `abt` xmlns with protocol 1.
		// Previously used `w` xmlns + protocol 2 which the server rejects with
		// "bad-request" on current WA versions. Hash is now conditionally
		// included only when we have one stored (vs. always sending empty
		// string), matching server expectations.
		const resultNode = await query({
			tag: 'iq',
			attrs: {
				to: S_WHATSAPP_NET,
				xmlns: 'abt',
				type: 'get'
			},
			content: [
				{
					tag: 'props',
					attrs: {
						protocol: '1',
						...(authState?.creds?.lastPropHash ? { hash: authState.creds.lastPropHash } : {})
					}
				}
			]
		})

		const propsNode = getBinaryNodeChild(resultNode, 'props')

		let props: { [_: string]: string } = {}
		if (propsNode) {
			if (propsNode.attrs?.hash) {
				// on some clients, the hash is returning as undefined
				authState.creds.lastPropHash = propsNode?.attrs?.hash
				ev.emit('creds.update', authState.creds)
			}

			props = reduceBinaryNodeToDictionary(propsNode, 'prop')
		}

		logger.debug('fetched props')

		return props
	}

	/**
	 * modify a chat -- mark unread, read etc.
	 * lastMessages must be sorted in reverse chronologically
	 * requires the last messages till the last message received; required for archive & unread
	 */
	const chatModify = (mod: ChatModification, jid: string) => {
		const patch = chatModificationToAppPatch(mod, jid)
		return appPatch(patch)
	}

	/**
	 * Enable/Disable link preview privacy, not related to baileys link preview generation
	 */
	const updateDisableLinkPreviewsPrivacy = (isPreviewsDisabled: boolean) => {
		return chatModify(
			{
				disableLinkPreviews: { isPreviewsDisabled }
			},
			''
		)
	}

	/**
	 * Star or Unstar a message
	 */
	const star = (jid: string, messages: { id: string; fromMe?: boolean }[], star: boolean) => {
		return chatModify(
			{
				star: {
					messages,
					star
				}
			},
			jid
		)
	}

	/**
	 * Add or Edit Contact
	 */
	const addOrEditContact = (jid: string, contact: proto.SyncActionValue.IContactAction) => {
		return chatModify(
			{
				contact
			},
			jid
		)
	}

	/**
	 * Remove Contact
	 */
	const removeContact = (jid: string) => {
		return chatModify(
			{
				contact: null
			},
			jid
		)
	}

	/**
	 * Adds label
	 */
	const addLabel = (jid: string, labels: LabelActionBody) => {
		return chatModify(
			{
				addLabel: {
					...labels
				}
			},
			jid
		)
	}

	/**
	 * Adds label for the chats
	 */
	const addChatLabel = (jid: string, labelId: string) => {
		return chatModify(
			{
				addChatLabel: {
					labelId
				}
			},
			jid
		)
	}

	/**
	 * Removes label for the chat
	 */
	const removeChatLabel = (jid: string, labelId: string) => {
		return chatModify(
			{
				removeChatLabel: {
					labelId
				}
			},
			jid
		)
	}

	/**
	 * Adds label for the message
	 */
	const addMessageLabel = (jid: string, messageId: string, labelId: string) => {
		return chatModify(
			{
				addMessageLabel: {
					messageId,
					labelId
				}
			},
			jid
		)
	}

	/**
	 * Removes label for the message
	 */
	const removeMessageLabel = (jid: string, messageId: string, labelId: string) => {
		return chatModify(
			{
				removeMessageLabel: {
					messageId,
					labelId
				}
			},
			jid
		)
	}

	/**
	 * Add or Edit Quick Reply
	 */
	const addOrEditQuickReply = (quickReply: QuickReplyAction) => {
		return chatModify(
			{
				quickReply
			},
			''
		)
	}

	/**
	 * Remove Quick Reply
	 */
	const removeQuickReply = (timestamp: string) => {
		return chatModify(
			{
				quickReply: { timestamp, deleted: true }
			},
			''
		)
	}

	/**
	 * queries need to be fired on connection open
	 * help ensure parity with WA Web
	 * */
	const executeInitQueries = async () => {
		await Promise.all([fetchProps(), fetchBlocklist(), fetchPrivacySettings()])
	}

	const upsertMessage = ev.createBufferedFunction(async (msg: WAMessage, type: MessageUpsertType) => {
		ev.emit('messages.upsert', { messages: [msg], type })

		if (!!msg.pushName) {
			let jid = msg.key.fromMe ? authState.creds.me!.id : msg.key.participant || msg.key.remoteJid
			jid = jidNormalizedUser(jid!)

			if (!msg.key.fromMe) {
				ev.emit('contacts.update', [{ id: jid, notify: msg.pushName, verifiedName: msg.verifiedBizName! }])
			}

			// update our pushname too
			if (msg.key.fromMe && msg.pushName && authState.creds.me?.name !== msg.pushName) {
				ev.emit('creds.update', { me: { ...authState.creds.me!, name: msg.pushName } })
			}
		}

		const historyMsg = getHistoryMsg(msg.message!)
		const shouldProcessHistoryMsg = historyMsg
			? shouldSyncHistoryMessage(historyMsg) &&
				PROCESSABLE_HISTORY_TYPES.includes(historyMsg.syncType! as proto.HistorySync.HistorySyncType)
			: false

		if (historyMsg && shouldProcessHistoryMsg) {
			const syncType = historyMsg.syncType as proto.HistorySync.HistorySyncType

			// Reset 120s paused timeout on any RECENT chunk (like WA Web's handleChunkProgress)
			if (syncType === proto.HistorySync.HistorySyncType.RECENT && !historySyncStatus.recentSyncComplete) {
				historySyncStatus.recentSyncPaused = false
				clearTimeout(historySyncPausedTimeout)
				historySyncPausedTimeout = setTimeout(() => {
					if (!historySyncStatus.recentSyncComplete && !historySyncStatus.recentSyncPaused) {
						historySyncStatus.recentSyncPaused = true
						ev.emit('messaging-history.status', {
							syncType: proto.HistorySync.HistorySyncType.RECENT,
							status: 'paused',
							explicit: false
						})
					}

					historySyncPausedTimeout = undefined
				}, HISTORY_SYNC_PAUSED_TIMEOUT_MS)
			}
		}

		// State machine: decide on sync and flush
		if (historyMsg && syncState === SyncState.AwaitingInitialSync) {
			if (awaitingSyncTimeout) {
				clearTimeout(awaitingSyncTimeout)
				awaitingSyncTimeout = undefined
			}

			if (shouldProcessHistoryMsg) {
				syncState = SyncState.Syncing
				logger.info('Transitioned to Syncing state')
				// Let doAppStateSync handle the final flush after it's done
			} else {
				syncState = SyncState.Online
				logger.info('History sync skipped, transitioning to Online state and flushing buffer')
				ev.flush()
			}
		}

		let appStateSyncCompleted = false
		const doAppStateSync = async () => {
			if (syncState === SyncState.Syncing) {
				// All collections will be synced, so clear any blocked ones
				blockedCollections.clear()

				logger.info('Doing app state sync')
				await resyncAppState(ALL_WA_PATCH_NAMES, true)

				// Mark app-state complete, but do not flush yet. processMessage()
				// runs concurrently and can still be decoding the history payload
				// and emitting hundreds of LID mappings. Flushing here disables
				// buffering too early and turns the remaining mappings into
				// singleton DB writes while w:sync:app:state is still active.
				syncState = SyncState.Online
				appStateSyncCompleted = true

				const accountSyncCounter = (authState.creds.accountSyncCounter || 0) + 1
				ev.emit('creds.update', { accountSyncCounter })
			}
		}

		await settleInitialSyncTasks(
			[
				(async () => {
					if (shouldProcessHistoryMsg) {
						await doAppStateSync()
					}
				})(),
				processMessage(msg, {
					signalRepository,
					shouldProcessHistoryMsg,
					placeholderResendCache,
					ev,
					creds: authState.creds,
					keyStore: authState.keys,
					logger,
					options: config.options,
					getMessage,
					orphanQueue,
					appStateBackend,
					locationBackend,
					statusBackend,
					messageStoreBackend,
					mediaBackend,
					addOnBackend,
					historySyncCoordinator,
					onHistorySyncCommitted: markHistorySyncCommitted,
					receiptBackend: receiptReplayBackend
				})
			],
			() => appStateSyncCompleted,
			failed => {
				logger.info(
					failed
						? 'Initial app-state or history processing failed, releasing buffered events before propagating the error'
						: 'Initial app-state and history processing complete, transitioning to Online state and flushing buffer'
				)
				ev.flush()
			},
			() => {
				// onUnexpectedError logs the propagated task failure without closing
				// the socket. Once the buffer is released this connection must no
				// longer advertise itself as Syncing, otherwise every later history
				// chunk retries the complete app-state sync on the same open socket.
				if (syncState === SyncState.Syncing) {
					syncState = SyncState.Online
				}
			},
			error => {
				logger.warn(
					{ error },
					'Initial sync failure-state preparation failed; continuing with mandatory buffer release'
				)
			}
		)

		// If the app state key arrives and we are waiting to sync, trigger the sync now.
		if (msg.message?.protocolMessage?.appStateSyncKeyShare && syncState === SyncState.Syncing) {
			logger.info('App state sync key arrived, triggering app state sync')
			await doAppStateSync()
			if (appStateSyncCompleted) {
				logger.info('Initial app-state key processing complete, transitioning to Online state and flushing buffer')
				ev.flush()
			}
		}
	})

	ws.on('CB:presence', (node: BinaryNode) => {
		handlePresenceUpdate(node).catch(err => onUnexpectedError(err, 'handling presence update'))
	})
	ws.on('CB:chatstate', (node: BinaryNode) => {
		handlePresenceUpdate(node).catch(err => onUnexpectedError(err, 'handling chatstate update'))
	})

	ws.on('CB:ib,,dirty', async (node: BinaryNode) => {
		const { attrs } = getBinaryNodeChild(node, 'dirty')!
		const type = attrs.type
		switch (type) {
			case 'account_sync':
				if (attrs.timestamp) {
					let { lastAccountSyncTimestamp } = authState.creds
					if (lastAccountSyncTimestamp) {
						await cleanDirtyBits('account_sync', lastAccountSyncTimestamp)
					}

					lastAccountSyncTimestamp = +attrs.timestamp
					ev.emit('creds.update', { lastAccountSyncTimestamp })
				}

				break
			case 'groups':
				// handled in groups.ts
				break
			default:
				logger.info({ node }, 'received unknown sync')
				break
		}
	})

	/**
	 * Persists THIS client's own device registration into `companion_devices.db`
	 * on connection open — the DeviceProps declared at pairing (same source as
	 * the wire payload, via buildCompanionDeviceProps) plus its device jid and
	 * ADV key index. Single row, upserted per connection. Best-effort: a mirror
	 * failure never affects the connection.
	 */
	const mirrorOwnDevice = () => {
		if (!companionDevicesBackend || !authState.creds.me?.id) {
			return
		}

		try {
			const props = buildCompanionDeviceProps(config)
			const hsc = props.historySyncConfig
			let advKeyIndex = 0
			try {
				const details = authState.creds.account?.details
				if (details) {
					advKeyIndex = proto.ADVDeviceIdentity.decode(details).keyIndex ?? 0
				}
			} catch {
				/* keyIndex stays 0 if the account identity can't be decoded */
			}

			companionDevicesBackend.upsertOwnDevice({
				deviceId: authState.creds.me.id,
				deviceOs: props.os,
				platformType: props.platformType,
				loginTime: Math.floor(Date.now() / 1000),
				advKeyIndex,
				fullSyncRequired: props.requireFullSync ?? undefined,
				fullSyncDaysLimit: hsc?.fullSyncDaysLimit ?? undefined,
				fullSyncSizeMbLimit: hsc?.fullSyncSizeMbLimit ?? undefined,
				storageQuotaMb: hsc?.storageQuotaMb ?? undefined,
				inlineInitialHistSyncPayloadEnabled: hsc?.inlineInitialPayloadInE2EeMsg ?? undefined,
				recentSyncDaysLimit: hsc?.recentSyncDaysLimit ?? undefined,
				supportCallLogHistory: hsc?.supportCallLogHistory ?? undefined,
				supportBotUserAgentChatHistory: hsc?.supportBotUserAgentChatHistory ?? undefined,
				supportCagReactionsAndPollsHistory: hsc?.supportCagReactionsAndPolls ?? undefined,
				supportRecentSyncChunkMessageTuning: hsc?.supportRecentSyncChunkMessageCountTuning ?? undefined,
				supportHostedGroupMsg: hsc?.supportHostedGroupMsg ?? undefined,
				supportFbidBotChatHistory: hsc?.supportFbidBotChatHistory ?? undefined,
				supportBizHostedMsg: hsc?.supportBizHostedMsg ?? undefined,
				supportAddOnHistorySyncMigration: hsc?.supportAddOnHistorySyncMigration ?? undefined,
				supportMessageAssociation: hsc?.supportMessageAssociation ?? undefined,
				supportGroupHistory: hsc?.supportGroupHistory ?? undefined,
				supportGuestChat: hsc?.supportGuestChat ?? undefined,
				onDemandReady: hsc?.onDemandReady ?? undefined,
				historySyncConfigProtobuf: hsc ? proto.DeviceProps.HistorySyncConfig.encode(hsc).finish() : null,
				supportManusHistory: hsc?.supportManusHistory ?? undefined,
				supportHatchHistory: hsc?.supportHatchHistory ?? undefined,
				supportedBotChannelFbids: hsc?.supportedBotChannelFbids ?? undefined
			})
		} catch (err) {
			logger.debug({ err }, 'companion_devices mirror: own-device upsert failed (ignored)')
		}
	}

	ev.on('connection.update', ({ connection, receivedPendingNotifications }) => {
		if (connection === 'open') {
			mirrorOwnDevice()
			historySyncCoordinator?.startRecovery().catch(error => onUnexpectedError(error, 'durable history sync recovery'))

			if (fireInitQueries) {
				executeInitQueries().catch(error => onUnexpectedError(error, 'init queries'))
			}

			sendPresenceUpdate(markOnlineOnConnect ? 'available' : 'unavailable').catch(error =>
				onUnexpectedError(error, 'presence update requests')
			)
		}

		// Clean up app state sync key cache on connection close
		if (connection === 'close') {
			blockedCollections.clear()
			clearTimeout(historySyncPausedTimeout)
			historySyncPausedTimeout = undefined
			appStateSyncKeyCache.clear()
			logger.debug('App state sync key cache cleared on connection close')
		}

		if (!receivedPendingNotifications || syncState !== SyncState.Connecting) {
			return
		}

		historySyncStatus.initialBootstrapComplete = false
		historySyncStatus.recentSyncComplete = false
		historySyncStatus.recentSyncPaused = false
		historySyncStatus.fullSyncComplete = false
		clearTimeout(historySyncPausedTimeout)
		historySyncPausedTimeout = undefined

		syncState = SyncState.AwaitingInitialSync
		logger.info('Connection is now AwaitingInitialSync, buffering events')
		ev.buffer()

		// On reconnections, app state was already synced in a previous session.
		// Skip the AwaitingInitialSync wait and go directly to Online so that
		// live incoming messages are not held in the buffer for up to 4 seconds.
		//
		// Two signals indicate a reconnect (either is sufficient):
		// 1. accountSyncCounter > 0  — at least one full sync completed before
		// 2. socketSkippedOfflineBuffer — socket.ts already determined this is a
		//    reconnect (e.g. stale routingInfo was cleared) and skipped the offline
		//    phase buffer. Keeping the second buffer active while the first was already
		//    skipped would cause a mismatch: events flow immediately then stall for 4s.
		const isReconnection = (authState.creds.accountSyncCounter ?? 0) > 0 || socketSkippedOfflineBuffer
		if (isReconnection) {
			logger.info(
				{ accountSyncCounter: authState.creds.accountSyncCounter, socketSkippedOfflineBuffer },
				'Reconnection detected, skipping AwaitingInitialSync wait. Transitioning to Online immediately.'
			)
			blockedCollections.clear()
			syncState = SyncState.Online
			const accountSyncCounter = (authState.creds.accountSyncCounter || 0) + 1
			ev.emit('creds.update', { accountSyncCounter })
			// Fire-and-forget: pick up patches missed during downtime (mute/archive/pin/read state).
			// Runs in background so live incoming messages are not blocked.
			resyncAppState(ALL_WA_PATCH_NAMES, true).catch(err =>
				logger.warn({ err }, 'Background app state resync failed (non-critical on reconnection)')
			)
			setTimeout(() => ev.flush(), 0)
			return
		}

		const willSyncHistory = shouldSyncHistoryMessage(
			proto.Message.HistorySyncNotification.create({
				syncType: proto.HistorySync.HistorySyncType.RECENT
			})
		)

		if (!willSyncHistory) {
			logger.info('History sync is disabled by config, not waiting for notification. Transitioning to Online.')
			syncState = SyncState.Online
			setTimeout(() => ev.flush(), 0)
			return
		}

		// On first connection wait briefly for the history-sync notification so
		// app-state/history establishes its baseline before live events are
		// released. Four seconds matches the documented event-buffer ordering
		// contract; the previous accidental 2s value routinely released live
		// events before the first history chunk arrived.
		const initialHistorySyncWaitMs = 4_000
		// perf(inbound-latency): reduced from 20s → 8s → 4s. On first connection we wait for
		// the history-sync notification so that doAppStateSync runs before live messages are
		// emitted.  If the notification does not arrive within 4s we stop waiting, go Online,
		// and flush so that any live message arriving after connection is never held more than 4s.
		// History that arrives late is still processed via processMessage regardless of state.
		// This 4s timeout fires before the event-buffer's own adaptive safety timer
		// (BAILEYS_BUFFER_TIMEOUT_MS defaults to 5s), ensuring the buffer cannot stall
		// beyond 4s on a first connect regardless of event rate.
		logger.info('First connection, awaiting history sync notification with a 4s timeout.')

		if (awaitingSyncTimeout) {
			clearTimeout(awaitingSyncTimeout)
		}

		awaitingSyncTimeout = setTimeout(() => {
			if (syncState === SyncState.AwaitingInitialSync) {
				logger.warn(
					{ timeoutMs: initialHistorySyncWaitMs },
					'Timeout in AwaitingInitialSync, forcing state to Online and flushing buffer'
				)
				syncState = SyncState.Online
				ev.flush()

				// Increment so subsequent reconnections skip the wait entirely.
				// Late-arriving history is still processed via processMessage
				// regardless of the state machine phase.
				const accountSyncCounter = (authState.creds.accountSyncCounter || 0) + 1
				ev.emit('creds.update', { accountSyncCounter })
			}
		}, initialHistorySyncWaitMs)
	})

	// When an app state sync key arrives (myAppStateKeyId is set) and there are
	// collections blocked on a missing key, trigger a re-sync for just those collections.
	// This mirrors WA Web's Blocked → retry-on-key-arrival behavior.
	ev.on('creds.update', ({ myAppStateKeyId }) => {
		if (!myAppStateKeyId || blockedCollections.size === 0) {
			return
		}

		// If we're in the middle of a full sync, doAppStateSync handles all collections
		if (syncState === SyncState.Syncing) {
			blockedCollections.clear()
			return
		}

		const collections = [...blockedCollections] as WAPatchName[]
		blockedCollections.clear()

		logger.info({ collections }, 'app state sync key arrived, re-syncing blocked collections')
		resyncAppState(collections, false).catch(error => onUnexpectedError(error, 'blocked collections resync'))
	})

	/**
	 * Best-effort mirror of a contact event into `wa_contacts` as the LID+PN
	 * pair, matching how the mobile client stores two rows per contact. The side
	 * carried by the event is written directly; the other side is resolved via
	 * the LID↔PN mapping (or backfilled later by the `lid-mapping.update`
	 * listener below when the mapping first becomes known). Wrapped so a mirror
	 * failure never disrupts the contact event delivered to the consumer.
	 */
	const mirrorContactToWaDb = async (c: Partial<Contact>) => {
		if (!waContactsBackend || !c.id) return
		try {
			const id = jidNormalizedUser(c.id)
			// Only mirror real user contacts. Group / @newsletter / @bot jids also
			// arrive on contacts.update (e.g. group picture notifications) — without
			// this guard the else-branch below would treat them as PN and store them
			// with is_whatsapp_user=1, and getStoredContact(groupJid) would then
			// serve a bogus contact instead of falling back.
			if (!isAnyPnUser(id) && !isAnyLidUser(id)) {
				return
			}

			let pn: string | undefined
			let lid: string | undefined
			if (isAnyLidUser(id)) {
				lid = id
				pn = c.phoneNumber
					? jidNormalizedUser(c.phoneNumber)
					: (await signalRepository.lidMapping.getPNForLID(id)) || undefined
			} else {
				pn = id
				lid = c.lid ? jidNormalizedUser(c.lid) : (await signalRepository.lidMapping.getLIDForPN(id)) || undefined
			}

			const fields = { waName: c.notify, displayName: c.name, status: c.status, username: c.username }
			if (pn) {
				waContactsBackend.upsertRow({ jid: pn, ...fields })
			}

			if (lid) {
				waContactsBackend.upsertRow({ jid: lid, ...fields })
			}
		} catch (err) {
			logger.debug({ err, id: c.id }, 'wa_contacts mirror: upsert failed (ignored)')
		}
	}

	const contactMirrorChains = new Map<string, Promise<void>>()
	const enqueueContactMirror = (contact: Partial<Contact>): void => {
		if (!contact.id) return
		const key = jidNormalizedUser(contact.id)
		const previous = contactMirrorChains.get(key) ?? Promise.resolve()
		const next = previous
			.catch(() => undefined)
			.then(() => mirrorContactToWaDb(contact))
			.finally(() => {
				if (contactMirrorChains.get(key) === next) contactMirrorChains.delete(key)
			})
		contactMirrorChains.set(key, next)
	}

	/**
	 * Copies whichever wa_contacts row exists onto its pair, so the store holds
	 * both the LID and PN rows like the mobile client once the mapping is known.
	 * Best-effort; a named helper keeps the `lid-mapping.update` loop shallow.
	 */
	const backfillWaContactPair = (pnUser: string, lidUser: string) => {
		if (!waContactsBackend) {
			return
		}

		try {
			waContactsBackend.copyFieldsTo(pnUser, lidUser)
			waContactsBackend.copyFieldsTo(lidUser, pnUser)
		} catch (err) {
			logger.debug({ err, lid: lidUser, pn: pnUser }, 'wa_contacts mirror: backfill failed (ignored)')
		}
	}

	if (waContactsBackend) {
		ev.on('contacts.upsert', contacts => {
			for (const c of contacts) {
				enqueueContactMirror(c)
			}
		})
		ev.on('contacts.update', updates => {
			for (const c of updates) {
				enqueueContactMirror(c)
			}
		})
		// Contacts learned during history sync arrive here (not via
		// contacts.upsert), so a session whose contacts come only from history
		// sync would otherwise leave wa_contacts empty until a live event.
		ev.on('messaging-history.set', ({ contacts }) => {
			for (const c of contacts) {
				enqueueContactMirror(c)
			}
		})
	}

	ev.on('lid-mapping.update', async mappings => {
		try {
			const result = await signalRepository.lidMapping.storeLIDPNMappings(mappings)
			logger.debug(
				{ count: mappings.length, stored: result.stored, skipped: result.skipped, errors: result.errors },
				'stored LID-PN mappings from update event'
			)
			if (result.stored > 0) {
				logger.info(
					{ count: mappings.length, stored: result.stored },
					'fallback LID mappings are now available from update event'
				)
			}

			// Automatic chat merge: notify consumers about LID→PN mapping
			// This allows ZPRO and other consumers to merge/rename chats accordingly
			// Collect all merge notifications to emit in a single batch
			const mergeNotifications: ChatUpdate[] = []
			const mergedAt = Date.now()

			for (const mapping of mappings) {
				const lidUser = jidNormalizedUser(mapping.lid)
				const pnUser = jidNormalizedUser(mapping.pn)

				if (lidUser && pnUser && lidUser !== pnUser) {
					logger.debug({ lid: lidUser, pn: pnUser }, 'collected chat update for LID→PN merge notification')

					mergeNotifications.push({
						id: pnUser,
						merged: true,
						previousId: lidUser,
						mergedAt
					})

					// Backfill the wa_contacts pair now that the mapping is known (an
					// earlier contact event may have written only one side). Helper
					// keeps this out of a 5th nesting level.
					backfillWaContactPair(pnUser, lidUser)
				}
			}

			// Emit single batch of merge notifications for better performance
			if (mergeNotifications.length > 0) {
				logger.debug({ count: mergeNotifications.length }, 'emitting batch of chat merge notifications')
				ev.emit('chats.update', mergeNotifications)
			}

			// Log warning if some mappings failed to store
			if (result.errors > 0) {
				logger.warn(
					{ errors: result.errors, total: mappings.length, notified: mergeNotifications.length },
					'some LID-PN mappings failed to store, but merge notifications were sent'
				)
			}
		} catch (error) {
			logger.warn({ count: mappings.length, error }, 'Failed to store LID-PN mappings')
		}
	})

	if (historySyncCoordinator) {
		registerSocketDrainHandler(() => historySyncCoordinator.stop())
	}

	registerSocketEndHandler(() => {
		if (awaitingSyncTimeout) {
			clearTimeout(awaitingSyncTimeout)
			awaitingSyncTimeout = undefined
		}

		if (historySyncPausedTimeout) {
			clearTimeout(historySyncPausedTimeout)
			historySyncPausedTimeout = undefined
		}

		// Close + flush our own placeholderResendCache so its NodeCache check-period timer stops
		// and the entries don't pin the old socket via closure. NEVER touch a consumer-provided
		// cache — they reuse it across reconnects intentionally (CTWA recovery continuity).
		if (ownsPlaceholderResendCache) {
			placeholderResendCache.close?.()
			placeholderResendCache.flushAll?.()
			// Reset the back-assignment so a reconnect using the same config object doesn't pick
			// our just-closed cache up as "consumer-provided" (ownership flip-flop) — that would
			// leave the new socket using a timer-stopped cache where entries accumulate forever
			// without TTL eviction.
			if (config.placeholderResendCache === placeholderResendCache) {
				config.placeholderResendCache = undefined
			}
		}

		orphanQueue.clear()
	})

	/**
	 * PN-transparent contact read from the `wa_contacts` mirror. Given any jid
	 * (LID or PN), it prefers the mapped PN row and falls back to the original
	 * LID row when that PN row is absent. The returned id is the known PN, or the
	 * original LID when no mapping exists. Returns `null` on miss, missing store,
	 * or error so the caller falls back to legacy event-driven handling.
	 */
	const getStoredContact = async (jid: string): Promise<Contact | null> => {
		if (!waContactsBackend || !jid) {
			return null
		}

		try {
			// PN-transparent read with LID-row fallback (#630) — see
			// resolveStoredContact.
			return await resolveStoredContact(
				jid,
				j => waContactsBackend.getByJid(j),
				async lid => (await signalRepository.lidMapping.getPNForLID(lid)) || undefined
			)
		} catch (err) {
			// Logged (not silent) so a schema/migration issue is diagnosable; the
			// caller still falls back to the legacy path on the null return.
			logger.debug({ err, jid }, 'wa_contacts getStoredContact failed (fallback to legacy)')
			return null
		}
	}

	/**
	 * Reads this client's own device registration from `companion_devices.db`.
	 * Returns the stored row or `null` on miss / no store / error — the caller
	 * falls back to the live `buildCompanionDeviceProps(config)` source.
	 */
	const getOwnDeviceRegistration = (): StoredCompanionDeviceRow | null => {
		if (!companionDevicesBackend || !authState.creds.me?.id) {
			return null
		}

		try {
			return companionDevicesBackend.getByDeviceId(authState.creds.me.id)
		} catch {
			return null
		}
	}

	/**
	 * Reads a chat's synced per-chat settings (mute end + pin) from
	 * `chatsettings.db`. Returns the stored row or `null` on miss / no store /
	 * error — the caller falls back to the legacy `chats.update` event state.
	 * Keyed by the chat jid. Only mute/pin are stored (the only per-chat
	 * settings WhatsApp syncs across devices — wallpaper/tone/etc. are
	 * device-local by protocol design; see ChatSettingsBackend).
	 */
	const getChatSettings = (jid: string): ChatSettingsRow | null => {
		if (!chatSettingsBackend || !jid) {
			return null
		}

		try {
			return chatSettingsBackend.getSettings(jidNormalizedUser(jid))
		} catch (err) {
			logger.debug({ err, jid }, 'chatsettings getChatSettings failed (fallback to legacy)')
			return null
		}
	}

	// Reads the location.db live-location mirror. Best-effort:
	// returns null/[] on miss or error so the consumer falls back to the live
	// `messages.upsert` stream (each liveLocationMessage arrives as a message).
	// `expires` follows the Android millisecond contract. Received duration is
	// decoded from `<enc duration>`; zero-duration shares use the open-ended
	// sentinel until a final-location update closes them.
	const getLiveLocation = (jid: string): LocationCacheRow | null => {
		if (!locationBackend || !jid) {
			return null
		}

		try {
			return locationBackend.getLocationCache(jidNormalizedUser(jid))
		} catch (err) {
			logger.debug({ err, jid }, 'location getLiveLocation failed (fallback to legacy)')
			return null
		}
	}

	const getActiveLiveLocations = (): LocationSharerRow[] => {
		if (!locationBackend) {
			return []
		}

		try {
			return locationBackend.listActiveLocationSharers(Date.now())
		} catch (err) {
			logger.debug({ err }, 'location getActiveLiveLocations failed (fallback to legacy)')
			return []
		}
	}

	// Reads the status.db mirror. Best-effort: `[]` on miss
	// or error → the consumer falls back to the live `messages.upsert` stream
	// (each received status@broadcast arrives as a message).
	const getStatusFeed = (jid: string): ReturnType<StatusBackend['listActiveStatusesForSender']> => {
		if (!statusBackend || !jid) {
			return []
		}

		try {
			// Active-only: the 24h window is enforced on READ too, so a status
			// that expired between throttled prunes is never surfaced (audit #637).
			return statusBackend.listActiveStatusesForSender(jidNormalizedUser(jid))
		} catch (err) {
			logger.debug({ err, jid }, 'status getStatusFeed failed (fallback to legacy)')
			return []
		}
	}

	// Who has viewed a given status (by its uuid = the status message id).
	// NOTE: only resolves viewers for statuses recorded locally (received, or own
	// posts that flowed through processMessage while connected). For a status not
	// in the mirror, returns [] — consume viewer info live via
	// `message-receipt.update` instead. (We deliberately don't store null-FK
	// receipts; see StatusBackend.recordSeenReceipt.)
	const getStatusViewers = (statusUuid: string): ReturnType<StatusBackend['listSeenReceiptsForStatus']> => {
		if (!statusBackend || !statusUuid) {
			return []
		}

		try {
			return statusBackend.listSeenReceiptsForStatus(statusUuid)
		} catch (err) {
			logger.debug({ err, statusUuid }, 'status getStatusViewers failed (fallback to legacy)')
			return []
		}
	}

	// Reads the user's favourited stickers (from app-state, kept
	// in sync via `stickerAction`). Best-effort: `[]` on miss/error.
	const getStarredStickers = (): StoredStarredStickerRow[] => {
		if (!stickersBackend) {
			return []
		}

		try {
			return stickersBackend.listStarred()
		} catch (err) {
			logger.debug({ err }, 'stickers getStarredStickers failed (fallback to legacy)')
			return []
		}
	}

	const getRecentStickers = (): StoredRecentStickerRow[] => {
		if (!stickersBackend) {
			return []
		}

		try {
			return stickersBackend.listRecent()
		} catch (err) {
			logger.debug({ err }, 'stickers getRecentStickers failed (fallback to legacy)')
			return []
		}
	}

	return {
		...sock,
		createCallLink,
		getBotListV2,
		getStoredContact,
		getOwnDeviceRegistration,
		getChatSettings,
		getLiveLocation,
		getActiveLiveLocations,
		getStatusFeed,
		getStatusViewers,
		getStarredStickers,
		getRecentStickers,
		orphanQueue,
		messageMutex,
		receiptMutex,
		appStatePatchMutex,
		notificationMutex,
		fetchPrivacySettings,
		upsertMessage,
		appPatch,
		sendPresenceUpdate,
		presenceSubscribe,
		profilePictureUrl,
		fetchBlocklist,
		fetchStatus,
		fetchDisappearingDuration,
		updateProfilePicture,
		removeProfilePicture,
		updateProfileStatus,
		updateProfileName,
		fetchContactProfiles,
		getMyUsername,
		setMyUsername,
		deleteMyUsername,
		checkUsernameAvailability,
		setMyUsernameKey,
		getUserByUsername,
		updateBlockStatus,
		updateDisableLinkPreviewsPrivacy,
		updateCallPrivacy,
		updateMessagesPrivacy,
		updateLastSeenPrivacy,
		updateOnlinePrivacy,
		updateProfilePicturePrivacy,
		updateStatusPrivacy,
		updateReadReceiptsPrivacy,
		updateGroupsAddPrivacy,
		updateDefaultDisappearingMode,
		getBusinessProfile,
		resyncAppState,
		chatModify,
		cleanDirtyBits,
		addOrEditContact,
		removeContact,
		addLabel,
		addChatLabel,
		removeChatLabel,
		addMessageLabel,
		removeMessageLabel,
		star,
		addOrEditQuickReply,
		removeQuickReply
	}
}
