/* eslint-disable @typescript-eslint/no-unused-vars */
import { Boom } from '@hapi/boom'
import Long from 'long'
import { proto } from '../../WAProto/index.js'
import type { LIDMappingStore } from '../Signal/lid-mapping'
import type {
	AuthenticationCreds,
	BaileysEventEmitter,
	CacheStore,
	Chat,
	GroupMetadata,
	GroupParticipant,
	LIDMapping,
	ParticipantAction,
	PlaceholderMessageData,
	RequestJoinAction,
	RequestJoinMethod,
	SignalKeyStoreWithTransaction,
	SignalRepositoryWithLIDStore,
	SocketConfig,
	WAMessage,
	WAMessageKey
} from '../Types'
import { WAMessageStubType } from '../Types'
import { getContentType, normalizeMessageContent } from '../Utils/messages'
import {
	areJidsSameUser,
	isAnyLidUser,
	isAnyPnUser,
	isHostedLidUser,
	isHostedPnUser,
	isJidBroadcast,
	isJidGroup,
	isJidStatusBroadcast,
	isLidUser,
	jidDecode,
	jidEncode,
	jidNormalizedUser
} from '../WABinary'
import { aesDecryptGCM, hmacSign, sha256 } from './crypto'
import { getKeyAuthor, toNumber } from './generics'
import { downloadAndProcessHistorySyncNotification } from './history'
import {
	AdaptiveHistoryBatchController,
	type DurableHistorySyncCoordinator,
	type ProcessedHistorySync
} from './history-sync-coordinator'
import type { ILogger } from './logger'
import {
	ANDROID_VIEW_ONCE_STATE,
	type AppStateBackend,
	isAndroidViewOnceMessageType,
	LOCATION_OPEN_ENDED_EXPIRES_MS,
	type LocationBackend,
	mapMessageToAndroidType,
	mapWebMessageStatusToAndroid,
	type MessageAddOnBackend,
	type MessageMediaBackend,
	type MessageStoreBackend,
	PEER_MESSAGE_TYPE_APP_STATE_SYNC_KEY_SHARE,
	type ReceiptBackend,
	type RecordMessageInput,
	type StatusBackend,
	UI_ELEMENT_TYPE
} from './multi-db-sqlite'
import { type OrphanEntry, OrphanQueue } from './orphan-queue'
import { metrics, recordHistorySyncMessages } from './prometheus-metrics.js'

type ProcessMessageContext = {
	shouldProcessHistoryMsg: boolean
	placeholderResendCache?: CacheStore
	creds: AuthenticationCreds
	keyStore: SignalKeyStoreWithTransaction
	ev: BaileysEventEmitter
	logger?: ILogger
	options: RequestInit
	signalRepository: SignalRepositoryWithLIDStore
	getMessage: SocketConfig['getMessage']
	/** Optional — holding pen for REVOKE/event-response whose parent message
	 * hasn't arrived yet. Omitting it keeps today's behavior (no queueing);
	 * `chats.ts` wires a real instance in production. */
	orphanQueue?: OrphanQueue
	/** Optional sync.db mirror (collection_versions/syncd_mutations/peer_messages). */
	appStateBackend?: AppStateBackend
	/** Optional location.db mirror (location_cache/location_sharer). */
	locationBackend?: LocationBackend
	/** Optional status.db mirror (status/status_info). */
	statusBackend?: StatusBackend
	/** Optional msgstore.db mirror — real message store (message/chat/revoke). */
	messageStoreBackend?: MessageStoreBackend
	/** Optional msgstore.db receipt holding-pen replayer. */
	receiptBackend?: ReceiptBackend
	/** Optional msgstore.db mirror — media metadata (message_media/message_thumbnail/audio_data). */
	mediaBackend?: MessageMediaBackend
	/** Optional msgstore.db mirror — reactions/polls/locations/vcards attached to a message. */
	addOnBackend?: MessageAddOnBackend
	/** Durable admission path. Enqueue returns after persistence; processing runs off the live-message path. */
	historySyncCoordinator?: Pick<DurableHistorySyncCoordinator, 'enqueue'>
	/** Marks compatibility-path completion after synchronous history apply succeeds. */
	onHistorySyncCommitted?: (notification: proto.Message.IHistorySyncNotification) => void
}

/**
 * Persist history-sync messages into the same typed message/chat tables used
 * by live traffic. History events remain available to consumers, but the
 * relational store no longer stays nearly empty after a successful bootstrap.
 */
const HISTORY_MIRROR_BATCH_SIZE = 50

const yieldHistoryMirror = (): Promise<void> => new Promise(resolve => setImmediate(resolve))

const assertHistoryApplyActive = (signal?: AbortSignal): void => {
	if (signal?.aborted) throw new Error('history sync apply interrupted by socket teardown')
}

export const isUnavailableViewOnceMessage = (message: WAMessage): boolean => {
	if (getContentType(normalizeMessageContent(message.message))) return false

	const hasSerializedPlaceholder =
		Array.isArray(message.messageStubParameters) && message.messageStubParameters.includes('view_once_unavailable')
	return !!message.key?.isViewOnce || hasSerializedPlaceholder
}

const mapStickerPackToMirror = (
	pack: proto.Message.IStickerPackMessage | null | undefined
): NonNullable<RecordMessageInput['stickerPack']> | null => {
	if (!pack) return null

	return {
		// Generated protobuf strings default to empty in the official client.
		// The three matching Android columns are NOT NULL, so preserve that
		// behavior instead of dropping a structurally valid pack.
		stickerPackId: pack.stickerPackId ?? '',
		trayIconFileName: pack.trayIconFileName ?? '',
		packName: pack.name ?? '',
		packDescription: pack.packDescription ?? '',
		publisher: pack.publisher ?? '',
		imageDataHash: pack.imageDataHash ?? '',
		stickerPackSize:
			pack.stickerPackSize === null || pack.stickerPackSize === undefined ? null : toNumber(pack.stickerPackSize),
		stickerPackOrigin: pack.stickerPackOrigin ?? 0,
		fileLength: pack.fileLength === null || pack.fileLength === undefined ? null : toNumber(pack.fileLength),
		mediaKey: pack.mediaKey ? Buffer.from(pack.mediaKey) : null,
		// Android's FMessage mapper converts the protobuf seconds value to
		// milliseconds before message_media persistence.
		mediaKeyTimestamp:
			pack.mediaKeyTimestamp === null || pack.mediaKeyTimestamp === undefined
				? null
				: toNumber(pack.mediaKeyTimestamp) * 1000,
		directPath: pack.directPath ?? null,
		fileSha256: pack.fileSha256 ? Buffer.from(pack.fileSha256) : null,
		fileEncSha256: pack.fileEncSha256 ? Buffer.from(pack.fileEncSha256) : null,
		stickers: (pack.stickers ?? []).map(sticker => ({
			fileName: sticker.fileName ?? '',
			isAnimated: !!sticker.isAnimated,
			// Official mapper joins the repeated protobuf field with ", ".
			emojis: (sticker.emojis ?? []).join(', '),
			accessibilityLabel: sticker.accessibilityLabel ?? '',
			isLottie: !!sticker.isLottie,
			mimetype: sticker.mimetype ?? ''
		}))
	}
}

export const mirrorHistoryMessagesToStore = async (
	messages: WAMessage[],
	messageStoreBackend: MessageStoreBackend,
	logger?: ILogger,
	batchController = new AdaptiveHistoryBatchController(HISTORY_MIRROR_BATCH_SIZE),
	signal?: AbortSignal
): Promise<{ stored: number; failed: number }> => {
	let stored = 0
	let failed = 0
	const inputs: RecordMessageInput[] = []

	for (const message of messages) {
		const remoteJid = message.key?.remoteJid
		const keyId = message.key?.id
		const content = normalizeMessageContent(message.message)
		const isUnavailableViewOnce = isUnavailableViewOnceMessage(message)
		if (!remoteJid || !keyId || (!content && !isUnavailableViewOnce)) continue

		try {
			const timestamp = toNumber(message.messageTimestamp ?? 0)
			const senderJid = message.key.fromMe
				? null
				: jidNormalizedUser(message.key.participant || message.key.remoteJid || '')
			const androidMessageType = mapMessageToAndroidType(message.message)
			const isViewOnce = isUnavailableViewOnce || isAndroidViewOnceMessageType(androidMessageType)
			inputs.push({
				chatJid: jidNormalizedUser(getChatId(message.key)),
				fromMe: !!message.key.fromMe,
				keyId,
				senderJid,
				// Web ERROR=0 has no lossless Android status equivalent. Preserve
				// NULL instead of silently upgrading a failed own message to ACK=4.
				status:
					message.status === proto.WebMessageInfo.Status.ERROR
						? null
						: (mapWebMessageStatusToAndroid(message.status) ?? (message.key.fromMe ? 4 : 0)),
				timestamp,
				receivedTimestamp: timestamp > 0 ? timestamp * 1000 : null,
				messageType: androidMessageType,
				textData: content?.extendedTextMessage?.text ?? content?.conversation ?? null,
				viewMode: isViewOnce ? 0 : null,
				viewOnceState: isViewOnce ? ANDROID_VIEW_ONCE_STATE.UNOPENED : null,
				authorDeviceJid: senderJid,
				messageSecret: content?.messageContextInfo?.messageSecret
					? Buffer.from(content.messageContextInfo.messageSecret)
					: null,
				album: content?.albumMessage
					? {
							expectedImageCount: content.albumMessage.expectedImageCount ?? 0,
							expectedVideoCount: content.albumMessage.expectedVideoCount ?? 0
						}
					: null,
				stickerPack: mapStickerPackToMirror(content?.stickerPackMessage),
				incrementUnread: false
			})
		} catch (err) {
			failed++
			logger?.warn({ err, messageId: keyId, chatJid: remoteJid }, 'multi-db-sqlite: history message mirror failed')
		}
	}

	const persistBatch = async (batch: readonly RecordMessageInput[]): Promise<void> => {
		try {
			const rowIds = messageStoreBackend.recordMessages(batch)
			stored += rowIds.length
		} catch (err) {
			// A batch is atomic. Split only the failed batch until the malformed
			// row is isolated, preserving best-effort history import without
			// reverting successfully validated neighbouring rows.
			if (batch.length > 1) {
				const midpoint = Math.ceil(batch.length / 2)
				await persistBatch(batch.slice(0, midpoint))
				await persistBatch(batch.slice(midpoint))
				return
			}

			failed++
			const input = batch[0]
			logger?.warn(
				{ err, messageId: input?.keyId, chatJid: input?.chatJid },
				'multi-db-sqlite: history message mirror failed'
			)
		}
	}

	for (let offset = 0; offset < inputs.length; ) {
		assertHistoryApplyActive(signal)
		const batchSize = batchController.current()
		const startedAt = Date.now()
		await persistBatch(inputs.slice(offset, offset + batchSize))
		batchController.record(Date.now() - startedAt)
		offset += batchSize
		// The official Android client executes history chunks in background
		// workers. Node has one event loop, so yield between bounded commits to
		// keep Noise frames, keepalive and close callbacks responsive.
		await yieldHistoryMirror()
	}

	assertHistoryApplyActive(signal)

	return { stored, failed }
}

/** Applies one decoded chunk. The durable coordinator checkpoints only after this resolves. */
export const applyProcessedHistorySync = async (
	data: ProcessedHistorySync,
	context: Pick<ProcessMessageContext, 'signalRepository' | 'logger' | 'messageStoreBackend'>,
	batchController?: AdaptiveHistoryBatchController,
	strictPersistence = true,
	signal?: AbortSignal
): Promise<void> => {
	const { messageStoreBackend, signalRepository, logger } = context
	assertHistoryApplyActive(signal)
	if (data.lidPnMappings?.length) {
		let result: Awaited<ReturnType<typeof signalRepository.lidMapping.storeLIDPNMappings>> | undefined
		try {
			result = await signalRepository.lidMapping.storeLIDPNMappings(data.lidPnMappings)
		} catch (error) {
			if (strictPersistence) throw error
			logger?.warn({ error }, 'Failed to store LID-PN mappings from history sync')
		}

		if (result) {
			logger?.debug(
				{ stored: result.stored, skipped: result.skipped, errors: result.errors },
				'stored LID-PN mappings from history sync'
			)
			if (strictPersistence && result.errors > 0) {
				throw new Error(`history sync LID mapping persistence failed for ${result.errors} row(s)`)
			}

			if (result.stored > 0) {
				logger?.info({ stored: result.stored }, 'fallback LID mappings are now available from history sync')
			}
		}
	}

	assertHistoryApplyActive(signal)
	if (messageStoreBackend && data.messages?.length) {
		const result = await mirrorHistoryMessagesToStore(
			data.messages,
			messageStoreBackend,
			logger,
			batchController,
			signal
		)
		logger?.info(
			{ input: data.messages.length, stored: result.stored, failed: result.failed },
			'multi-db-sqlite: history messages mirrored'
		)
		if (strictPersistence && result.failed > 0) {
			throw new Error(`history sync message persistence failed for ${result.failed} row(s)`)
		}
	}

	assertHistoryApplyActive(signal)
}

/** Emits unchanged consumer events after local apply; a failed checkpoint is replayed at least once. */
export const emitProcessedHistorySync = (
	data: ProcessedHistorySync,
	ev: BaileysEventEmitter,
	metadata: {
		isLatest: boolean
		chunkOrder?: number | null
		peerDataRequestSessionId?: string | null
	}
): void => {
	if (data.lidPnMappings?.length) ev.emit('lid-mapping.update', data.lidPnMappings)
	ev.emit('messaging-history.set', {
		...data,
		isLatest: data.syncType !== proto.HistorySync.HistorySyncType.ON_DEMAND ? metadata.isLatest : undefined,
		chunkOrder: metadata.chunkOrder,
		peerDataRequestSessionId: metadata.peerDataRequestSessionId
	})

	if (data.messages?.length) recordHistorySyncMessages(data.messages.length)
}

const REAL_MSG_STUB_TYPES = new Set([
	WAMessageStubType.CALL_MISSED_GROUP_VIDEO,
	WAMessageStubType.CALL_MISSED_GROUP_VOICE,
	WAMessageStubType.CALL_MISSED_VIDEO,
	WAMessageStubType.CALL_MISSED_VOICE
])

const REAL_MSG_REQ_ME_STUB_TYPES = new Set([WAMessageStubType.GROUP_PARTICIPANT_ADD])

// Self-only protocol types must originate from our own device; an attacker could otherwise spoof
// one from a third party to manipulate local state (history sync, app-state keys, LID migration,
// PDO responses). Cross-user types (REVOKE / EDIT / EPHEMERAL_SETTING / member label) are NOT in
// this set — they legitimately arrive from others. (upstream #2557/whatsmeow). Module-level so it
// isn't reallocated on every processed protocol message.
const SELF_ONLY_PROTOCOL_TYPES = new Set<proto.Message.ProtocolMessage.Type>([
	proto.Message.ProtocolMessage.Type.HISTORY_SYNC_NOTIFICATION,
	proto.Message.ProtocolMessage.Type.APP_STATE_SYNC_KEY_SHARE,
	proto.Message.ProtocolMessage.Type.LID_MIGRATION_MAPPING_SYNC,
	proto.Message.ProtocolMessage.Type.PEER_DATA_OPERATION_REQUEST_RESPONSE_MESSAGE
])

/** Cleans a received message to further processing */
export const cleanMessage = (message: WAMessage, meId: string, meLid: string) => {
	// ensure remoteJid and participant doesn't have device or agent in it
	if (isHostedPnUser(message.key.remoteJid!) || isHostedLidUser(message.key.remoteJid!)) {
		message.key.remoteJid = jidEncode(
			jidDecode(message.key?.remoteJid!)?.user!,
			isHostedPnUser(message.key.remoteJid!) ? 's.whatsapp.net' : 'lid'
		)
	} else {
		message.key.remoteJid = jidNormalizedUser(message.key.remoteJid!)
	}

	if (isHostedPnUser(message.key.participant!) || isHostedLidUser(message.key.participant!)) {
		message.key.participant = jidEncode(
			jidDecode(message.key.participant!)?.user!,
			isHostedPnUser(message.key.participant!) ? 's.whatsapp.net' : 'lid'
		)
	} else {
		message.key.participant = jidNormalizedUser(message.key.participant!)
	}

	const content = normalizeMessageContent(message.message)
	// if the message has a reaction, ensure fromMe & remoteJid are from our perspective
	if (content?.reactionMessage) {
		const reactionKey = content.reactionMessage.key
		if (reactionKey) {
			normaliseKey(reactionKey)
		}
	}

	if (content?.pollUpdateMessage) {
		const pollCreationKey = content.pollUpdateMessage.pollCreationMessageKey
		if (pollCreationKey) {
			normaliseKey(pollCreationKey)
		}
	}

	function normaliseKey(msgKey: WAMessageKey) {
		// if the reaction is from another user
		// we've to correctly map the key to this user's perspective
		if (!message.key.fromMe) {
			// if the sender believed the message being reacted to is not from them
			// we've to correct the key to be from them, or some other participant
			msgKey.fromMe = !msgKey.fromMe
				? areJidsSameUser(msgKey.participant || msgKey.remoteJid!, meId) ||
					areJidsSameUser(msgKey.participant || msgKey.remoteJid!, meLid)
				: // if the message being reacted to, was from them
					// fromMe automatically becomes false
					false
			// set the remoteJid to being the same as the chat the message came from
			// TODO: investigate inconsistencies
			msgKey.remoteJid = message.key.remoteJid
			// set participant of the message
			msgKey.participant = msgKey.participant || message.key.participant
		} else {
			// fromMe reactions/polls: normalise remoteJid to match the chat JID
			// ensures DM reaction keys are consistent with group behavior
			msgKey.remoteJid = message.key.remoteJid
			// in groups, normalise participant for own messages too
			if (message.key.participant) {
				msgKey.participant = msgKey.participant || message.key.participant
			}
		}
	}
}

/**
 * Resolves a LID JID to its PN equivalent using the LID mapping store.
 * Returns the original JID if it's not a LID or if no mapping is found.
 * Safe to call with any JID type (group, newsletter, PN, etc.).
 */
export const resolveLidToPn = async (
	jid: string | undefined | null,
	lidMapping: LIDMappingStore,
	logger?: ILogger
): Promise<string | undefined> => {
	if (!jid) {
		return undefined
	}

	if (isAnyLidUser(jid)) {
		const pn = await lidMapping.getPNForLID(jid)
		if (pn) {
			logger?.debug({ lid: jid, pn }, 'Resolved LID to PN')
		}

		return pn || jid
	}

	return jid
}

/**
 * Normalizes a WAMessageKey by resolving LID→PN for remoteJid and participant.
 */
export const normalizeKeyLidToPn = async (
	key: WAMessageKey,
	lidMapping: LIDMappingStore,
	logger?: ILogger
): Promise<void> => {
	const [resolvedRemoteJid, resolvedParticipant] = await Promise.all([
		resolveLidToPn(key.remoteJid, lidMapping, logger),
		resolveLidToPn(key.participant, lidMapping, logger)
	])
	if (resolvedRemoteJid) {
		key.remoteJid = resolvedRemoteJid
	}

	if (resolvedParticipant) {
		key.participant = resolvedParticipant
	}
}

export const normalizeMessageJids = async (
	message: WAMessage,
	signalRepository: SignalRepositoryWithLIDStore,
	logger?: ILogger
): Promise<void> => {
	const lidMapping = signalRepository.lidMapping
	const key = message.key

	// FAST PATH: Use alt JIDs directly when available (avoids LIDMappingStore race condition).
	// The stanza always carries both formats (LID + PN) in the attributes.
	// When addressing_mode=lid, remoteJid is LID and remoteJidAlt is PN.
	// When addressing_mode=pn, remoteJid is already PN (no conversion needed).
	if (key.remoteJid && isAnyLidUser(key.remoteJid) && key.remoteJidAlt && isAnyPnUser(key.remoteJidAlt)) {
		logger?.debug({ lid: key.remoteJid, pn: key.remoteJidAlt }, 'Resolved remoteJid LID→PN via alt (fast path)')
		key.remoteJid = key.remoteJidAlt
	}

	if (key.participant && isAnyLidUser(key.participant) && key.participantAlt && isAnyPnUser(key.participantAlt)) {
		logger?.debug({ lid: key.participant, pn: key.participantAlt }, 'Resolved participant LID→PN via alt (fast path)')
		key.participant = key.participantAlt
	}

	// SLOW PATH: Resolve any remaining LIDs via LIDMappingStore lookup
	await normalizeKeyLidToPn(key, lidMapping, logger)

	// Also normalize participantAlt (the alternative JID format — can be LID when addressing_mode=pn)
	if (key.participantAlt && isAnyLidUser(key.participantAlt)) {
		const resolved = await resolveLidToPn(key.participantAlt, lidMapping, logger)
		if (resolved) {
			key.participantAlt = resolved
		}
	}

	// Normalize nested message keys (reaction, poll) that may contain LID JIDs
	const content = normalizeMessageContent(message.message)
	if (content?.reactionMessage?.key) {
		await normalizeKeyLidToPn(content.reactionMessage.key, lidMapping, logger)
	}

	if (content?.pollUpdateMessage?.pollCreationMessageKey) {
		await normalizeKeyLidToPn(content.pollUpdateMessage.pollCreationMessageKey, lidMapping, logger)
	}
}

// TODO: target:audit AUDIT THIS FUNCTION AGAIN
export const isRealMessage = (message: WAMessage) => {
	if (isUnavailableViewOnceMessage(message)) return true
	const normalizedContent = normalizeMessageContent(message.message)
	const hasSomeContent = !!getContentType(normalizedContent)
	const stubType = message.messageStubType ?? 0
	return (
		(!!normalizedContent || REAL_MSG_STUB_TYPES.has(stubType) || REAL_MSG_REQ_ME_STUB_TYPES.has(stubType)) &&
		hasSomeContent &&
		!normalizedContent?.protocolMessage &&
		!normalizedContent?.reactionMessage &&
		!normalizedContent?.pollUpdateMessage
	)
}

export const shouldIncrementChatUnread = (message: WAMessage) => !message.key.fromMe && !message.messageStubType

/**
 * Get the ID of the chat from the given key.
 * Typically -- that'll be the remoteJid, but for broadcasts, it'll be the participant
 */
export const getChatId = ({ remoteJid, participant, fromMe }: WAMessageKey): string => {
	if (!remoteJid) {
		throw new Boom('Cannot derive chat id: message key is missing remoteJid', {
			data: { remoteJid, participant, fromMe }
		})
	}

	if (isJidBroadcast(remoteJid) && !isJidStatusBroadcast(remoteJid) && !fromMe) {
		if (!participant) {
			throw new Boom('Cannot derive chat id: broadcast message key is missing participant', {
				data: { remoteJid, fromMe }
			})
		}

		return participant
	}

	return remoteJid
}

type PollContext = {
	/** normalised jid of the person that created the poll */
	pollCreatorJid: string
	/** ID of the poll creation message */
	pollMsgId: string
	/** poll creation message enc key */
	pollEncKey: Uint8Array
	/** jid of the person that voted */
	voterJid: string
}

const getKeyAddressingCandidates = (key: WAMessageKey): string[] =>
	[key.participant, key.remoteJid, key.participantAlt, key.remoteJidAlt].filter(
		(jid, index, all): jid is string => !!jid && all.indexOf(jid) === index
	)

/**
 * Resolves the exact identity domain used by the sender when deriving poll
 * vote encryption keys. Storage normalisation may turn the primary LID into a
 * PN, but the cryptographic transcript must continue to follow
 * `addressing_mode`; PN and LID strings are not interchangeable in its HMAC/AAD.
 */
export const resolvePollCryptoAuthor = async (
	key: WAMessageKey,
	addressingMode: string | undefined,
	meId: string,
	meLid: string | undefined,
	lidMapping: LIDMappingStore
): Promise<string> => {
	const mode = key.addressingMode || addressingMode
	const candidates = getKeyAddressingCandidates(key)

	if (key.fromMe) {
		if (mode === 'lid') {
			return (
				(meLid && jidNormalizedUser(meLid)) ||
				(await lidMapping.getLIDForPN(jidNormalizedUser(meId))) ||
				jidNormalizedUser(meId)
			)
		}

		return jidNormalizedUser(meId)
	}

	if (mode === 'lid') {
		const lid = candidates.find(isAnyLidUser)
		if (lid) return jidNormalizedUser(lid)

		const pn = candidates.find(isAnyPnUser)
		if (pn) {
			const mapped = await lidMapping.getLIDForPN(jidNormalizedUser(pn))
			if (mapped) return jidNormalizedUser(mapped)
		}
	} else {
		const pn = candidates.find(isAnyPnUser)
		if (pn) return jidNormalizedUser(pn)

		const lid = candidates.find(isAnyLidUser)
		if (lid) {
			const mapped = await lidMapping.getPNForLID(jidNormalizedUser(lid))
			if (mapped) return jidNormalizedUser(mapped)
		}
	}

	return jidNormalizedUser(getKeyAuthor(key, jidNormalizedUser(meId)))
}

type EventContext = {
	/** normalised jid of the person that created the event */
	eventCreatorJid: string
	/** ID of the event creation message */
	eventMsgId: string
	/** event creation message enc key */
	eventEncKey: Uint8Array
	/** jid of the person that responded */
	responderJid: string
}

/**
 * Decrypt a poll vote
 * @param vote encrypted vote
 * @param ctx additional info about the poll required for decryption
 * @returns list of SHA256 options
 */
export function decryptPollVote(
	{ encPayload, encIv }: proto.Message.IPollEncValue,
	{ pollCreatorJid, pollMsgId, pollEncKey, voterJid }: PollContext
) {
	const sign = Buffer.concat([
		toBinary(pollMsgId),
		toBinary(pollCreatorJid),
		toBinary(voterJid),
		toBinary('Poll Vote'),
		new Uint8Array([1])
	])

	const key0 = hmacSign(pollEncKey, new Uint8Array(32), 'sha256')
	const decKey = hmacSign(sign, key0, 'sha256')
	const aad = toBinary(`${pollMsgId}\u0000${voterJid}`)

	if (!encPayload || !encIv) {
		throw new Error('Missing encPayload or encIv for poll vote decryption')
	}

	const decrypted = aesDecryptGCM(encPayload, decKey, encIv, aad)
	return proto.Message.PollVoteMessage.decode(decrypted)

	function toBinary(txt: string) {
		return Buffer.from(txt)
	}
}

/**
 * Decrypt an event response
 * @param response encrypted event response
 * @param ctx additional info about the event required for decryption
 * @returns event response message
 */
export function decryptEventResponse(
	{ encPayload, encIv }: proto.Message.IPollEncValue,
	{ eventCreatorJid, eventMsgId, eventEncKey, responderJid }: EventContext
) {
	const sign = Buffer.concat([
		toBinary(eventMsgId),
		toBinary(eventCreatorJid),
		toBinary(responderJid),
		toBinary('Event Response'),
		new Uint8Array([1])
	])

	const key0 = hmacSign(eventEncKey, new Uint8Array(32), 'sha256')
	const decKey = hmacSign(sign, key0, 'sha256')
	const aad = toBinary(`${eventMsgId}\u0000${responderJid}`)

	if (!encPayload || !encIv) {
		throw new Error('Missing encPayload or encIv for event response decryption')
	}

	const decrypted = aesDecryptGCM(encPayload, decKey, encIv, aad)
	return proto.Message.EventResponseMessage.decode(decrypted)

	function toBinary(txt: string) {
		return Buffer.from(txt)
	}
}

type UiElement = Omit<import('./multi-db-sqlite').RecordUiElementWithContextInput, 'messageRowId'>

type MessageMirrorOperation =
	| 'message_record'
	| 'media_record'
	| 'media_thumbnail'
	| 'media_mms_thumbnail'
	| 'media_audio_data'
	| 'media_streaming_sidecar'
	| 'poll_record'
	| 'poll_option_record'
	| 'vcard_record'
	| 'ui_elements_replace'

const MESSAGE_MIRROR_TABLE: Record<MessageMirrorOperation, string> = {
	message_record: 'message,chat',
	media_record: 'message_media',
	media_thumbnail: 'message_thumbnail',
	media_mms_thumbnail: 'mms_thumbnail_metadata',
	media_audio_data: 'audio_data',
	media_streaming_sidecar: 'message_streaming_sidecar',
	poll_record: 'message_poll',
	poll_option_record: 'message_poll_option',
	vcard_record: 'message_vcard,message_vcard_jid',
	ui_elements_replace: 'message_ui_elements,message_ui_element_context'
}

const classifyMessageMirrorFailure = (operation: MessageMirrorOperation, err: unknown) => {
	const errorMessage = err instanceof Error ? err.message : String(err)
	const sqliteCode =
		typeof err === 'object' && err !== null && 'code' in err && typeof err.code === 'string' ? err.code : undefined
	const prefix = `MESSAGE_MIRROR_${operation.toUpperCase()}`
	let suffix = 'WRITE_FAILED'
	if (/no such (table|column)/i.test(errorMessage)) suffix = 'SCHEMA_MISMATCH'
	else if (sqliteCode?.startsWith('SQLITE_BUSY') || sqliteCode?.startsWith('SQLITE_LOCKED')) suffix = 'DB_LOCKED'
	else if (sqliteCode?.startsWith('SQLITE_CORRUPT') || sqliteCode?.startsWith('SQLITE_NOTADB')) suffix = 'DB_CORRUPT'
	else if (sqliteCode?.startsWith('SQLITE_READONLY')) suffix = 'DB_READ_ONLY'
	else if (
		sqliteCode?.startsWith('SQLITE_IOERR') ||
		sqliteCode?.startsWith('SQLITE_FULL') ||
		sqliteCode?.startsWith('SQLITE_CANTOPEN')
	)
		suffix = 'DB_IO_FAILURE'
	else if (sqliteCode?.startsWith('SQLITE_CONSTRAINT')) suffix = 'DB_CONSTRAINT'

	return { reason: `${prefix}_${suffix}`, sqliteCode, errorMessage }
}

/**
 * Runs one optional message mirror without allowing its failure to suppress
 * later, unrelated mirrors or the legacy message-processing path.
 */
const runOptionalMessageMirror = (
	logger: ILogger | undefined,
	operation: Exclude<MessageMirrorOperation, 'message_record'>,
	messageId: string,
	action: () => void
): void => {
	try {
		action()
	} catch (err) {
		logger?.warn(
			{
				err,
				...classifyMessageMirrorFailure(operation, err),
				operation,
				table: MESSAGE_MIRROR_TABLE[operation],
				messageId,
				primary: 'multi_db_sqlite',
				fallback: 'legacy_message_proto'
			},
			'multi-db-sqlite: message mirror fallback'
		)
	}
}

const nativeFlowButtonLabel = (buttonParamsJson: string | null | undefined): string | null => {
	if (!buttonParamsJson) return null
	try {
		const params = JSON.parse(buttonParamsJson) as Record<string, unknown>
		const label = params.display_text ?? params.displayText ?? params.title
		return typeof label === 'string' && label.trim() ? label : null
	} catch {
		// The raw payload and action name are still preserved. A future primary
		// consumer can detect the missing label and fall back to the legacy proto.
		return null
	}
}

/**
 * Extracts renderable UI elements (quick-reply buttons, list rows, template
 * buttons, native-flow CTAs) from an interactive message's content. Returns
 * an empty array for non-interactive messages. Pure — the message proto stays
 * the source of truth; this is just a derived render-mirror.
 */
const extractUiElements = (content: proto.IMessage | undefined | null): UiElement[] => {
	if (!content) return []
	const out: UiElement[] = []

	const bm = content.buttonsMessage
	if (bm) {
		const description = bm.contentText ?? bm.text ?? null
		for (const btn of bm.buttons ?? []) {
			out.push({
				elementType: UI_ELEMENT_TYPE.QUICK_REPLY,
				buttonText: btn.buttonText?.displayText ?? null,
				elementContent: btn.buttonId ?? null,
				footerText: bm.footerText ?? null,
				description
			})
		}
	}

	const lm = content.listMessage
	if (lm) {
		for (const section of lm.sections ?? []) {
			for (const row of section.rows ?? []) {
				out.push({
					elementType: UI_ELEMENT_TYPE.LIST,
					buttonText: row.title ?? lm.buttonText ?? null,
					elementContent: row.rowId ?? null,
					description: row.description ?? row.title ?? null,
					footerText: lm.footerText ?? null
				})
			}
		}
	}

	const tm = content.templateMessage
	const hydrated = tm?.hydratedTemplate ?? tm?.hydratedFourRowTemplate
	if (tm && hydrated) {
		for (const btn of hydrated.hydratedButtons ?? []) {
			const label =
				btn.quickReplyButton?.displayText ?? btn.urlButton?.displayText ?? btn.callButton?.displayText ?? null
			const value = btn.quickReplyButton?.id ?? btn.urlButton?.url ?? btn.callButton?.phoneNumber ?? null
			out.push({
				elementType: UI_ELEMENT_TYPE.TEMPLATE,
				templateId: tm.templateId ?? null,
				buttonText: label,
				elementContent: value,
				footerText: hydrated.hydratedFooterText ?? null,
				description: hydrated.hydratedContentText ?? null
			})
		}
	}

	for (const im of [content.interactiveMessage, tm?.interactiveMessageTemplate]) {
		if (!im) continue
		const nativeFlow = im.nativeFlowMessage
		if (nativeFlow) {
			for (const btn of nativeFlow.buttons ?? []) {
				out.push({
					elementType: UI_ELEMENT_TYPE.NATIVE_FLOW,
					buttonText: nativeFlowButtonLabel(btn.buttonParamsJson),
					elementContent: btn.buttonParamsJson ?? null,
					footerText: im.footer?.text ?? null,
					description: im.body?.text ?? null,
					nativeFlowName: btn.name ?? null
				})
			}
		} else if (im.carouselMessage) {
			for (const [cardIndex, card] of (im.carouselMessage.cards ?? []).entries()) {
				for (const [buttonIndex, btn] of (card.nativeFlowMessage?.buttons ?? []).entries()) {
					out.push({
						elementType: UI_ELEMENT_TYPE.NATIVE_FLOW,
						buttonText: nativeFlowButtonLabel(btn.buttonParamsJson),
						elementContent: btn.buttonParamsJson ?? null,
						footerText: card.footer?.text ?? im.footer?.text ?? null,
						description: card.body?.text ?? im.body?.text ?? null,
						nativeFlowName: btn.name ?? null,
						context: { containerType: 'carousel', cardIndex, buttonIndex }
					})
				}
			}
		}
	}

	return out
}

const processMessage = async (
	message: WAMessage,
	{
		shouldProcessHistoryMsg,
		placeholderResendCache,
		ev,
		creds,
		signalRepository,
		keyStore,
		logger,
		options,
		getMessage,
		orphanQueue,
		appStateBackend,
		locationBackend,
		statusBackend,
		messageStoreBackend,
		receiptBackend,
		mediaBackend,
		addOnBackend,
		historySyncCoordinator,
		onHistorySyncCommitted
	}: ProcessMessageContext
) => {
	const meUser = creds.me
	if (!meUser) {
		logger?.warn({ messageKey: message.key }, 'processMessage: creds.me not set, skipping message')
		return
	}

	const meId = meUser.id
	const { accountSettings } = creds

	const chat: Partial<Chat> = { id: jidNormalizedUser(getChatId(message.key)) }
	const isUnavailableViewOnce = isUnavailableViewOnceMessage(message)
	const isRealMsg = isRealMessage(message)

	if (isRealMsg) {
		chat.messages = [{ message }]
		chat.conversationTimestamp = toNumber(message.messageTimestamp)
		// only increment unread count if not CIPHERTEXT and from another person
		if (shouldIncrementChatUnread(message)) {
			chat.unreadCount = (chat.unreadCount || 0) + 1
		}
	}

	/** Emits the REVOKE update once the target message is confirmed to exist —
	 * shared by the live path (case REVOKE below) and orphan replay. */
	const emitRevokeUpdate = (revokeStanza: WAMessage, revokeProtocolMsg: proto.Message.IProtocolMessage): void => {
		const targetKey: WAMessageKey = {
			...revokeProtocolMsg.key,
			remoteJid: revokeProtocolMsg.key?.remoteJid ?? revokeStanza.key.remoteJid,
			fromMe: revokeProtocolMsg.key?.fromMe ?? revokeStanza.key.fromMe,
			participant: revokeProtocolMsg.key?.participant ?? revokeStanza.key.participant,
			id: revokeProtocolMsg.key?.id
		}
		ev.emit('messages.update', [
			{ key: targetKey, update: { message: null, messageStubType: WAMessageStubType.REVOKE, key: revokeStanza.key } }
		])

		if (messageStoreBackend && targetKey.id) {
			try {
				messageStoreBackend.recordRevoke({
					chatJid: jidNormalizedUser(targetKey.remoteJid ?? ''),
					fromMe: !!targetKey.fromMe,
					revokedKeyId: targetKey.id,
					revokeTimestamp: toNumber(revokeStanza.messageTimestamp ?? 0)
				})
			} catch (err) {
				logger?.warn({ err }, 'failed to record message_revoked row')
			}
		}
	}

	/** Decrypts + emits an event-response once the event-creation message is known
	 * — shared by the live path (encEventResponseMessage branch below) and orphan
	 * replay. `eventMsg` is the creation message's decrypted content (either fetched
	 * via getMessage on the live path, or — on replay — the just-arrived message's
	 * own `content`, since replay only runs once that message is being processed). */
	const decryptAndEmitEventResponse = async (
		responseStanza: WAMessage,
		encEventResponse: proto.Message.IEncEventResponseMessage,
		creationMsgKey: WAMessageKey,
		eventMsg: proto.IMessage
	): Promise<void> => {
		try {
			const meIdNormalised = jidNormalizedUser(meId)

			// all jids need to be PN
			const eventCreatorKey = creationMsgKey.participant || creationMsgKey.remoteJid!
			const eventCreatorPn = isLidUser(eventCreatorKey)
				? await signalRepository.lidMapping.getPNForLID(eventCreatorKey)
				: eventCreatorKey
			if (!eventCreatorPn) {
				logger?.warn(
					{ messageKey: responseStanza.key, eventCreatorKey },
					'processMessage: eventCreatorPn missing, skipping'
				)
				return
			}

			const eventCreatorJid = getKeyAuthor(
				{ remoteJid: jidNormalizedUser(eventCreatorPn), fromMe: meIdNormalised === eventCreatorPn },
				meIdNormalised
			)

			const responderJid = getKeyAuthor(responseStanza.key, meIdNormalised)
			const eventEncKey = eventMsg?.messageContextInfo?.messageSecret

			if (!eventEncKey) {
				logger?.warn({ creationMsgKey }, 'event response: missing messageSecret for decryption')
				return
			}

			const responseMsg = decryptEventResponse(encEventResponse, {
				eventEncKey,
				eventCreatorJid,
				eventMsgId: creationMsgKey.id!,
				responderJid
			})

			const eventResponse = {
				eventResponseMessageKey: responseStanza.key,
				senderTimestampMs: responseMsg.timestampMs!,
				response: responseMsg
			}

			// Normalize creationMsgKey JIDs for the emitted event
			const normalizedCreationKey = { ...creationMsgKey }
			await normalizeKeyLidToPn(normalizedCreationKey, signalRepository.lidMapping, logger)

			ev.emit('messages.update', [
				{
					key: normalizedCreationKey,
					update: {
						eventResponses: [eventResponse]
					}
				}
			])
		} catch (err) {
			logger?.warn({ err, creationMsgKey }, 'failed to decrypt event response')
		}
	}

	const content = normalizeMessageContent(message.message)

	// unarchive chat if it's a real message, or someone reacted to our message
	// and we've the unarchive chats setting on
	if ((isRealMsg || content?.reactionMessage?.key?.fromMe) && accountSettings?.unarchiveChats) {
		chat.archived = false
		chat.readOnly = false
	}

	// Mirrors real messages into msgstore.db's message/chat tables when
	// configured. Never allowed to affect message processing: best-effort
	// side channel, same rule as the other optional multi-db-sqlite mirrors
	// in this file. Also mirrors media metadata and poll-creation options
	// via the same messageRowId, since both hang off the message row.
	let canReplayOrphans = !messageStoreBackend
	if (messageStoreBackend && isRealMsg && message.key.id) {
		let messageRowId: number | undefined
		try {
			const senderJid = getKeyAuthor(message.key, meId)
			const androidMessageType = mapMessageToAndroidType(message.message)
			const isViewOnce = isUnavailableViewOnce || isAndroidViewOnceMessageType(androidMessageType)
			if (androidMessageType === null && !isUnavailableViewOnce) {
				logger?.warn(
					{
						messageId: message.key.id,
						chatJid: chat.id,
						fromMe: !!message.key.fromMe,
						contentKeys: Object.keys(content ?? message.message ?? {})
					},
					'multi-db-sqlite: real message has no confirmed Android message_type mapping'
				)
			}

			messageRowId = messageStoreBackend.recordMessage({
				chatJid: chat.id!,
				fromMe: !!message.key.fromMe,
				keyId: message.key.id,
				senderJid: message.key.fromMe ? null : jidNormalizedUser(senderJid),
				// Web ERROR=0 has no lossless Android status equivalent. Match
				// history-sync mirroring and preserve NULL instead of fabricating
				// Android PENDING=0 for a terminally failed message.
				status:
					message.status === proto.WebMessageInfo.Status.ERROR
						? null
						: (mapWebMessageStatusToAndroid(message.status) ?? 0),
				timestamp: toNumber(message.messageTimestamp ?? 0),
				receivedTimestamp: Date.now(),
				messageType: androidMessageType,
				textData: content?.extendedTextMessage?.text ?? content?.conversation ?? null,
				viewMode: isViewOnce ? 0 : null,
				viewOnceState: isViewOnce ? ANDROID_VIEW_ONCE_STATE.UNOPENED : null,
				authorDeviceJid: jidNormalizedUser(senderJid),
				messageSecret: content?.messageContextInfo?.messageSecret
					? Buffer.from(content.messageContextInfo.messageSecret)
					: null,
				album: content?.albumMessage
					? {
							expectedImageCount: content.albumMessage.expectedImageCount ?? 0,
							expectedVideoCount: content.albumMessage.expectedVideoCount ?? 0
						}
					: null,
				stickerPack: mapStickerPackToMirror(content?.stickerPackMessage),
				incrementUnread: shouldIncrementChatUnread(message)
			})
			canReplayOrphans = true
		} catch (err) {
			logger?.warn(
				{
					err,
					...classifyMessageMirrorFailure('message_record', err),
					operation: 'message_record',
					table: MESSAGE_MIRROR_TABLE.message_record,
					messageId: message.key.id,
					primary: 'multi_db_sqlite',
					fallback: 'legacy_message_proto'
				},
				'multi-db-sqlite: message mirror fallback'
			)
		}

		if (messageRowId !== undefined) {
			try {
				receiptBackend?.replayOrphaned(chat.id!, !!message.key.fromMe, message.key.id)
			} catch (err) {
				logger?.warn(
					{ err, messageId: message.key.id, table: 'receipt_orphaned', fallback: 'live_receipt_events' },
					'multi-db-sqlite: failed to replay orphaned receipts; message processing continues'
				)
			}

			// NOTE: message_send_count is intentionally NOT written here. The
			// real msgstore.db capture keeps it at 0 rows — the mobile client
			// uses send_count transiently during send retries and clears it on
			// success, so persisting a count at the (successful) echo would
			// DIVERGE from the device. `MessageStoreBackend.recordSendAttempt`
			// stays available for a consumer that tracks its own retries.

			/* eslint-disable max-depth -- nested optional proto fields are traversed without changing the interactive payload */
			if (mediaBackend) {
				const media =
					content?.imageMessage ||
					content?.videoMessage ||
					content?.audioMessage ||
					content?.documentMessage ||
					content?.stickerMessage
				if (media) {
					runOptionalMessageMirror(logger, 'media_record', message.key.id, () =>
						mediaBackend.recordMedia({
							messageRowId,
							mimeType: media.mimetype ?? null,
							fileLength: media.fileLength ? toNumber(media.fileLength) : null,
							mediaKey: media.mediaKey ? Buffer.from(media.mediaKey) : null,
							directPath: media.directPath ?? null,
							fileSha256: media.fileSha256 ? Buffer.from(media.fileSha256) : null,
							fileEncSha256: media.fileEncSha256 ? Buffer.from(media.fileEncSha256) : null,
							width: 'width' in media ? (media.width ?? null) : null,
							height: 'height' in media ? (media.height ?? null) : null,
							mediaDurationSeconds: 'seconds' in media ? (media.seconds ?? null) : null,
							caption: 'caption' in media ? (media.caption ?? null) : null,
							mediaName: 'fileName' in media ? (media.fileName ?? null) : null
						})
					)

					const thumbnail = content?.imageMessage?.jpegThumbnail || content?.videoMessage?.jpegThumbnail
					if (thumbnail) {
						runOptionalMessageMirror(logger, 'media_thumbnail', message.key.id, () =>
							mediaBackend.recordThumbnail({ messageRowId, thumbnail: Buffer.from(thumbnail) })
						)
					}

					// Pre-download thumbnail metadata (direct_path/mediaKey/hashes) —
					// only image/video carry the dedicated thumbnail fields.
					const thumbSource = content?.imageMessage || content?.videoMessage
					if (thumbSource?.thumbnailDirectPath || thumbnail) {
						runOptionalMessageMirror(logger, 'media_mms_thumbnail', message.key.id, () =>
							mediaBackend.recordMmsThumbnail({
								messageRowId,
								directPath: thumbSource?.thumbnailDirectPath ?? null,
								mediaKey: thumbSource?.mediaKey ? Buffer.from(thumbSource.mediaKey) : null,
								mediaKeyTimestamp: thumbSource?.mediaKeyTimestamp ? toNumber(thumbSource.mediaKeyTimestamp) : null,
								thumbSha256: thumbSource?.thumbnailSha256 ? Buffer.from(thumbSource.thumbnailSha256) : null,
								thumbEncSha256: thumbSource?.thumbnailEncSha256 ? Buffer.from(thumbSource.thumbnailEncSha256) : null,
								microThumbnail: thumbnail ? Buffer.from(thumbnail) : null,
								insertTimestamp: toNumber(message.messageTimestamp ?? 0)
							})
						)
					}

					if (content?.audioMessage?.waveform) {
						runOptionalMessageMirror(logger, 'media_audio_data', message.key.id, () =>
							mediaBackend.recordAudioData({ messageRowId, waveform: Buffer.from(content.audioMessage!.waveform!) })
						)
					}

					const streamingSidecar = content?.videoMessage?.streamingSidecar || content?.audioMessage?.streamingSidecar
					if (streamingSidecar) {
						runOptionalMessageMirror(logger, 'media_streaming_sidecar', message.key.id, () =>
							mediaBackend.recordStreamingSidecar({
								messageRowId,
								sidecar: Buffer.from(streamingSidecar),
								timestamp: toNumber(message.messageTimestamp ?? 0)
							})
						)
					}
				}
			}

			if (addOnBackend) {
				const poll = content?.pollCreationMessage || content?.pollCreationMessageV2 || content?.pollCreationMessageV3
				if (poll) {
					runOptionalMessageMirror(logger, 'poll_record', message.key.id, () =>
						addOnBackend.recordPoll({
							messageRowId,
							encKey: poll.encKey ? Buffer.from(poll.encKey) : null,
							selectableOptionsCount: poll.selectableOptionsCount ?? null
						})
					)
					for (const option of poll.options ?? []) {
						const optionName = option.optionName
						if (!optionName) continue
						runOptionalMessageMirror(logger, 'poll_option_record', message.key.id, () =>
							addOnBackend.recordPollOption({
								messageRowId,
								optionSha256: sha256(Buffer.from(optionName)).toString('base64'),
								optionName
							})
						)
					}
				}

				if (content?.contactMessage?.vcard) {
					runOptionalMessageMirror(logger, 'vcard_record', message.key.id, () =>
						addOnBackend.recordVcard({ messageRowId, vcard: content.contactMessage!.vcard! })
					)
				}

				// A contactsArrayMessage carries several vcards on one message —
				// each is recorded (and deduped) under the same message_row_id.
				for (const contact of content?.contactsArrayMessage?.contacts ?? []) {
					if (contact.vcard) {
						runOptionalMessageMirror(logger, 'vcard_record', message.key.id, () =>
							addOnBackend.recordVcard({ messageRowId, vcard: contact.vcard! })
						)
					}
				}
			}
			/* eslint-enable max-depth */

			// UI rendering data keeps its own failure boundary. The extractor and
			// interactive payload are unchanged, including carousel card order.
			const isInteractive =
				content?.buttonsMessage || content?.listMessage || content?.templateMessage || content?.interactiveMessage
			if (addOnBackend && isInteractive) {
				runOptionalMessageMirror(logger, 'ui_elements_replace', message.key.id, () =>
					addOnBackend.recordUiElements(messageRowId, extractUiElements(content))
				)
			}
		}
	}

	// Replay only after the parent message has had a chance to reach msgstore.db.
	// A queued revoke must never be consumed before recordRevoke can resolve its
	// target row; otherwise the queue entry is lost and the persisted message is
	// left unrevoked.
	if (isRealMsg && orphanQueue && canReplayOrphans) {
		const drained = orphanQueue.drain(message.key)
		for (const entry of drained) {
			const entryContent = normalizeMessageContent(entry.message.message)
			if (entry.kind === 'revoke' && entryContent?.protocolMessage) {
				emitRevokeUpdate(entry.message, entryContent.protocolMessage)
			} else if (entry.kind === 'event-response' && entryContent?.encEventResponseMessage) {
				const encEventResponse = entryContent.encEventResponseMessage
				const creationMsgKey = encEventResponse.eventCreationMessageKey
				if (creationMsgKey) {
					await decryptAndEmitEventResponse(entry.message, encEventResponse, creationMsgKey, content!)
				}
			}
		}
	}

	// Poll vote mirror (message_add_on_poll_vote + selected options). Decrypted
	// in-house using the poll creation message's own messageSecret — which we
	// already persisted (message_secret) — so no consumer getMessage is needed.
	// This ONLY populates the typed mirror; the decrypted vote is deliberately
	// NOT re-emitted as a messages.update (event delivery stays a consumer
	// responsibility, per the upstream decision). Best-effort, never throws.
	if (addOnBackend && messageStoreBackend && content?.pollUpdateMessage?.vote && message.key.id) {
		try {
			const pollKey = content.pollUpdateMessage.pollCreationMessageKey
			const chatJid = jidNormalizedUser(message.key.remoteJid ?? '')
			const pollRow = pollKey?.id ? messageStoreBackend.getMessageByKeyId(chatJid, !!pollKey.fromMe, pollKey.id) : null
			const pollEncKey = pollRow ? messageStoreBackend.getMessageSecret(pollRow._id) : null
			if (pollRow && pollEncKey && pollKey?.id) {
				const meIdNorm = jidNormalizedUser(meId)
				const addressingMode = message.key.addressingMode
				const voterJid = await resolvePollCryptoAuthor(
					message.key,
					addressingMode,
					meIdNorm,
					meUser.lid,
					signalRepository.lidMapping
				)
				const pollCreatorJid = await resolvePollCryptoAuthor(
					pollKey,
					addressingMode,
					meIdNorm,
					meUser.lid,
					signalRepository.lidMapping
				)
				const voteMsg = decryptPollVote(content.pollUpdateMessage.vote, {
					pollEncKey,
					pollCreatorJid,
					pollMsgId: pollKey.id,
					voterJid
				})

				const selectedOptionRowIds: number[] = []
				for (const opt of voteMsg.selectedOptions ?? []) {
					const optRowId = addOnBackend.resolvePollOptionRowId(pollRow._id, Buffer.from(opt).toString('base64'))
					if (optRowId !== null) selectedOptionRowIds.push(optRowId)
				}

				addOnBackend.recordPollVote({
					chatJid,
					fromMe: !!message.key.fromMe,
					keyId: message.key.id,
					senderJid: message.key.fromMe ? null : voterJid,
					parentMessageRowId: pollRow._id,
					timestamp: toNumber(message.messageTimestamp ?? 0),
					senderTimestamp: content.pollUpdateMessage.senderTimestampMs
						? toNumber(content.pollUpdateMessage.senderTimestampMs)
						: toNumber(message.messageTimestamp ?? 0),
					selectedOptionRowIds
				})
			}
		} catch (err) {
			const vote = content.pollUpdateMessage.vote
			logger?.warn(
				{
					err,
					addressingMode: message.key.addressingMode,
					pollMsgId: content.pollUpdateMessage.pollCreationMessageKey?.id,
					voteMsgId: message.key.id,
					encPayloadLength: vote.encPayload?.length ?? 0,
					encIvLength: vote.encIv?.length ?? 0
				},
				'failed to record poll vote mirror'
			)
		}
	}

	// Mirror static/live location into location.db when configured.
	// Never allowed to affect message processing: best-effort side channel,
	// same rule as the other optional multi-db-sqlite mirrors in this file.
	if (
		(locationBackend || addOnBackend) &&
		(content?.locationMessage || content?.liveLocationMessage || message.finalLiveLocation)
	) {
		try {
			const liveLocation = content?.liveLocationMessage
			const finalLiveLocation = message.finalLiveLocation
			const loc = content?.locationMessage || liveLocation || finalLiveLocation
			const senderJid = getKeyAuthor(message.key, meId)
			const rawTimestamp = toNumber(message.messageTimestamp ?? 0)
			const messageTimestampMs =
				rawTimestamp >= 1_000_000_000_000 ? rawTimestamp : rawTimestamp > 0 ? rawTimestamp * 1000 : Date.now()
			if (
				locationBackend &&
				loc?.degreesLatitude !== undefined &&
				loc?.degreesLatitude !== null &&
				loc?.degreesLongitude !== undefined &&
				loc?.degreesLongitude !== null
			) {
				locationBackend.upsertLocationCache({
					jid: jidNormalizedUser(senderJid),
					latitude: loc.degreesLatitude,
					longitude: loc.degreesLongitude,
					accuracy: loc.accuracyInMeters ?? 0,
					speed: loc.speedInMps ?? 0,
					bearing: loc.degreesClockwiseFromMagneticNorth ?? 0,
					locationTs:
						finalLiveLocation?.timeOffset !== undefined && finalLiveLocation.timeOffset !== null
							? messageTimestampMs + finalLiveLocation.timeOffset * 1000
							: messageTimestampMs
				})
			}

			if (locationBackend && liveLocation && message.key.id) {
				const durationSecs =
					typeof message.duration === 'number' && Number.isSafeInteger(message.duration) && message.duration >= 0
						? message.duration
						: 0
				const remoteJid = jidNormalizedUser(message.key.remoteJid ?? '')
				const fromMe = message.key.fromMe ? 1 : 0
				const remoteResource = jidNormalizedUser(
					message.key.fromMe
						? message.key.participant || (isJidGroup(remoteJid) ? '' : remoteJid)
						: message.key.participant || senderJid
				)
				const expires = durationSecs > 0 ? messageTimestampMs + durationSecs * 1000 : LOCATION_OPEN_ENDED_EXPIRES_MS

				if (remoteJid && remoteResource) {
					locationBackend.upsertLocationSharer({
						remoteJid,
						fromMe,
						remoteResource,
						expires,
						messageId: message.key.id
					})
				}
			}

			// Also mirrors the per-message location row (msgstore.db's
			// message_location — a different concern than location.db above:
			// this is the location DATA attached to this specific message,
			// not the jid-level live-share state).
			if (addOnBackend && messageStoreBackend && message.key.id && (content?.locationMessage || liveLocation)) {
				const row = messageStoreBackend.getMessageByKeyId(chat.id!, !!message.key.fromMe, message.key.id)
				if (
					row &&
					loc?.degreesLatitude !== undefined &&
					loc?.degreesLatitude !== null &&
					loc?.degreesLongitude !== undefined &&
					loc?.degreesLongitude !== null
				) {
					const finalTimestampMs =
						finalLiveLocation?.timeOffset !== undefined && finalLiveLocation.timeOffset !== null
							? messageTimestampMs + finalLiveLocation.timeOffset * 1000
							: finalLiveLocation
								? messageTimestampMs
								: null
					addOnBackend.recordLocation({
						messageRowId: row._id,
						chatJid: chat.id!,
						latitude: loc.degreesLatitude,
						longitude: loc.degreesLongitude,
						placeName: content?.locationMessage?.name ?? null,
						placeAddress: content?.locationMessage?.address ?? null,
						url: content?.locationMessage?.url ?? null,
						liveLocationShareDurationSecs: liveLocation ? (message.duration ?? 0) : null,
						liveLocationSequenceNumber: liveLocation?.sequenceNumber ? toNumber(liveLocation.sequenceNumber) : null,
						liveLocationFinalLatitude: finalLiveLocation?.degreesLatitude ?? null,
						liveLocationFinalLongitude: finalLiveLocation?.degreesLongitude ?? null,
						liveLocationFinalTimestampMs: finalTimestampMs,
						mapDownloadStatus: 0
					})
				}
			}

			if (finalLiveLocation && message.key.id) {
				if (addOnBackend && messageStoreBackend) {
					const row = messageStoreBackend.getMessageByKeyId(chat.id!, !!message.key.fromMe, message.key.id)
					if (
						row &&
						finalLiveLocation.degreesLatitude !== undefined &&
						finalLiveLocation.degreesLatitude !== null &&
						finalLiveLocation.degreesLongitude !== undefined &&
						finalLiveLocation.degreesLongitude !== null
					) {
						addOnBackend.recordFinalLiveLocation({
							messageRowId: row._id,
							latitude: finalLiveLocation.degreesLatitude,
							longitude: finalLiveLocation.degreesLongitude,
							timestampMs:
								finalLiveLocation.timeOffset !== undefined && finalLiveLocation.timeOffset !== null
									? messageTimestampMs + finalLiveLocation.timeOffset * 1000
									: messageTimestampMs
						})
					}
				}

				locationBackend?.endLocationSharersForMessage(
					jidNormalizedUser(message.key.remoteJid ?? ''),
					message.key.fromMe ? 1 : 0,
					message.key.id
				)
			}
		} catch (err) {
			logger?.warn({ err }, 'failed to record location.db row')
		}
	}

	// Mirror received status/story updates into status.db when
	// configured. Never allowed to affect message processing. `isRealMsg`
	// excludes protocolMessage/reactionMessage/pollUpdateMessage (see its
	// own doc) — without this guard, a REVOKE or reaction addressed to
	// status@broadcast was recorded as if it were new status content
	// (confirmed real bug).
	if (statusBackend && isRealMsg && isJidStatusBroadcast(message.key.remoteJid ?? '') && message.key.id) {
		try {
			const senderJid = getKeyAuthor(message.key, meId)
			statusBackend.recordReceivedStatus({
				senderUserJid: jidNormalizedUser(senderJid),
				uuid: message.key.id,
				timestamp: toNumber(message.messageTimestamp ?? 0),
				textData: content?.extendedTextMessage?.text ?? content?.conversation ?? null
			})
		} catch (err) {
			logger?.warn({ err }, 'failed to record status.db row')
		}
	}

	const protocolMsg = content?.protocolMessage
	if (protocolMsg) {
		// Self-only protocol messages legitimately arrive from OUR OWN account on any device — the
		// primary phone (no device suffix) routinely sends APP_STATE_SYNC_KEY_SHARE / HISTORY_SYNC
		// to its linked companions without `fromMe` being set, and may address us via PN or LID.
		// Compare by user (same WhatsApp account, any device) instead of strict fromMe — otherwise
		// we drop the keys the phone is trying to share and app state sync hangs on "missing key
		// from v0, parking after 2 attempts".
		const fromJid = message.key.participant || message.key.remoteJid || ''
		const isFromOwnAccount =
			message.key.fromMe ||
			areJidsSameUser(fromJid, meId) ||
			(meUser.lid ? areJidsSameUser(fromJid, meUser.lid) : false)
		if (
			protocolMsg.type !== null &&
			protocolMsg.type !== undefined &&
			SELF_ONLY_PROTOCOL_TYPES.has(protocolMsg.type) &&
			!isFromOwnAccount
		) {
			logger?.warn(
				{ msgId: message.key.id, type: protocolMsg.type, from: message.key.participant || message.key.remoteJid },
				'dropping spoofed self-only protocolMessage from non-self origin'
			)
			return
		}

		switch (protocolMsg.type) {
			case proto.Message.ProtocolMessage.Type.HISTORY_SYNC_NOTIFICATION:
				const histNotification = protocolMsg.historySyncNotification
				if (!histNotification) {
					break
				}

				const process = shouldProcessHistoryMsg
				const isLatest = !creds.processedHistoryMessages?.length

				logger?.info(
					{
						syncType: histNotification.syncType,
						chunkOrder: histNotification.chunkOrder,
						progress: histNotification.progress,
						fileLength: histNotification.fileLength ? toNumber(histNotification.fileLength) : 0,
						hasInlinePayload: Boolean(histNotification.initialHistBootstrapInlinePayload?.length),
						process,
						id: message.key.id,
						isLatest
					},
					'got history notification'
				)

				if (process) {
					if (historySyncCoordinator) {
						await historySyncCoordinator.enqueue(message.key, message.messageTimestamp, histNotification)
						logger?.debug(
							{ id: message.key.id, syncType: histNotification.syncType, chunkOrder: histNotification.chunkOrder },
							'history sync notification admitted to durable queue'
						)
					} else {
						// Compatibility path for custom AuthenticationState implementations
						// that do not expose the optional durable queue capability.
						const data = await downloadAndProcessHistorySyncNotification(histNotification, options, logger)
						await applyProcessedHistorySync(data, { signalRepository, logger, messageStoreBackend }, undefined, false)
						emitProcessedHistorySync(data, ev, {
							isLatest,
							chunkOrder: histNotification.chunkOrder,
							peerDataRequestSessionId: histNotification.peerDataRequestSessionId
						})
						if (histNotification.syncType !== proto.HistorySync.HistorySyncType.ON_DEMAND) {
							ev.emit('creds.update', {
								processedHistoryMessages: [
									...(creds.processedHistoryMessages || []),
									{ key: message.key, messageTimestamp: message.messageTimestamp }
								]
							})
						}

						onHistorySyncCommitted?.(histNotification)
					}
				}

				break
			case proto.Message.ProtocolMessage.Type.APP_STATE_SYNC_KEY_SHARE:
				const keys = protocolMsg.appStateSyncKeyShare?.keys
				if (keys?.length) {
					let newAppStateSyncKeyId = ''
					let isNewlyGeneratedKey = false
					await keyStore.transaction(async () => {
						const newKeys: string[] = []
						for (const { keyData, keyId } of keys) {
							const keyIdValue = keyId?.keyId
							if (!keyIdValue) {
								continue
							}

							const strKeyId = Buffer.from(keyIdValue).toString('base64')
							newKeys.push(strKeyId)

							if (keyData) {
								// "isNewlyGeneratedKey" — confirmed real field in
								// sync.db.peer_messages' JSON payload (live Frida capture), but
								// neither the server nor this protocolMessage transmit it as a
								// flag — it's a local determination. Inferred here as "was this
								// key ID absent from our store before this share", which matches
								// the field name's own meaning. A share can carry more than one
								// key, but only one peer_messages row is recorded for the whole
								// batch (below, after this loop) — OR the per-key results together
								// so the flag means "at least one key in this share was new"
								// instead of silently keeping only the last key's result.
								if (appStateBackend) {
									const existing = await keyStore.get('app-state-sync-key', [strKeyId])
									isNewlyGeneratedKey = isNewlyGeneratedKey || !existing[strKeyId]
								}

								await keyStore.set({ 'app-state-sync-key': { [strKeyId]: keyData } })
							}

							newAppStateSyncKeyId = strKeyId
						}

						logger?.info({ newAppStateSyncKeyId, newKeys }, 'injecting new app state sync keys')
					}, meId)

					if (appStateBackend && protocolMsg.appStateSyncKeyShare) {
						try {
							const peerMsgId = appStateBackend.recordPeerMessage({
								messageType: PEER_MESSAGE_TYPE_APP_STATE_SYNC_KEY_SHARE,
								keyRemoteJid: message.key.remoteJid ?? '',
								keyFromMe: message.key.fromMe ? 1 : 0,
								keyId: message.key.id ?? '',
								deviceId: meId,
								timestamp: toNumber(message.messageTimestamp ?? 0),
								data: JSON.stringify({
									appStateSyncKeyShareProtoString: Buffer.from(
										proto.Message.AppStateSyncKeyShare.encode(protocolMsg.appStateSyncKeyShare).finish()
									).toString('base64'),
									isNewlyGeneratedKey
								}),
								acked: 0
							})
							appStateBackend.ackPeerMessage(peerMsgId)
						} catch (err) {
							logger?.warn({ err }, 'failed to record peer_messages row for app-state-sync-key-share')
						}
					}

					ev.emit('creds.update', { myAppStateKeyId: newAppStateSyncKeyId })
				} else {
					logger?.info({ protocolMsg }, 'recv app state sync with 0 keys')
				}

				break
			case proto.Message.ProtocolMessage.Type.REVOKE: {
				if (!protocolMsg.key?.id) {
					logger?.debug({ protocolMsg }, 'processMessage: REVOKE with no target id, dropping')
					break
				}

				const targetKey: WAMessageKey = {
					...protocolMsg.key,
					remoteJid: protocolMsg.key.remoteJid ?? message.key.remoteJid,
					fromMe: protocolMsg.key.fromMe ?? message.key.fromMe,
					participant: protocolMsg.key.participant ?? message.key.participant,
					id: protocolMsg.key.id
				}

				let original: proto.IMessage | undefined
				try {
					original = await getMessage(targetKey)
				} catch (err) {
					logger?.warn(
						{ err, targetKey },
						'processMessage: consumer message lookup failed, continuing with store/orphan fallback'
					)
				}

				// The consumer's `getMessage` defaults to `() => undefined`, so a
				// caller that doesn't maintain its own message cache would never
				// record the revoke — even though the multi-db message store DOES
				// have the target. Treat the store as an independent "target known"
				// source: if either the consumer or our own store has the original,
				// process the revoke now instead of queueing it as an orphan.
				//
				// Wrapped in try/catch so a store read error (closed handle,
				// transient I/O) can NEVER reject REVOKE processing — the same
				// "the mirror must never affect message handling" invariant every
				// other multi-db write in this file follows. On failure we fall
				// back to `knownToStore = false` (relies on getMessage / orphan
				// queue), never breaking the delete-for-everyone core path.
				let knownToStore = false
				try {
					knownToStore =
						!!messageStoreBackend &&
						!!targetKey.id &&
						messageStoreBackend.getMessageByKeyId(
							jidNormalizedUser(targetKey.remoteJid ?? ''),
							!!targetKey.fromMe,
							targetKey.id
						) !== null
				} catch (err) {
					logger?.warn({ err, targetKey }, 'processMessage: REVOKE store lookup failed, treating target as unknown')
				}

				if (original || knownToStore) {
					emitRevokeUpdate(message, protocolMsg)
				} else if (orphanQueue) {
					// Out-of-order arrival (common during history sync / offline catch-up):
					// the revoke target isn't in the consumer's store yet. Queue it instead
					// of firing a "delete a message I don't have" no-op — replayed by the
					// drain block near the top of this function, on the future invocation
					// of processMessage() that handles the target message once it arrives.
					orphanQueue.enqueue(targetKey, 'revoke', message)
					logger?.debug({ targetKey }, 'processMessage: REVOKE target not found yet, queued as orphan')
				} else {
					logger?.debug({ targetKey }, 'processMessage: REVOKE target not found, dropping (no orphan queue configured)')
				}

				break
			}

			case proto.Message.ProtocolMessage.Type.EPHEMERAL_SETTING:
				Object.assign(chat, {
					ephemeralSettingTimestamp: toNumber(message.messageTimestamp),
					ephemeralExpiration: protocolMsg.ephemeralExpiration || null
				})
				break
			case proto.Message.ProtocolMessage.Type.PEER_DATA_OPERATION_REQUEST_RESPONSE_MESSAGE:
				const response = protocolMsg.peerDataOperationRequestResponseMessage
				if (response) {
					// Retrieve cached metadata BEFORE deletion
					// This preserves original message details that the phone might not send
					const cachedData = response.stanzaId
						? await placeholderResendCache?.get<PlaceholderMessageData | boolean>(response.stanzaId)
						: undefined

					// Clean up cache after retrieving data
					if (response.stanzaId) {
						await placeholderResendCache?.del(response.stanzaId)
					}

					// TODO: IMPLEMENT HISTORY SYNC ETC (sticker uploads etc.).
					const { peerDataOperationResult } = response
					if (!peerDataOperationResult) {
						break
					}

					let recoveredCount = 0
					for (const result of peerDataOperationResult) {
						const { placeholderMessageResendResponse: retryResponse } = result

						if (retryResponse) {
							if (!retryResponse.webMessageInfoBytes) {
								continue
							}

							const webMessageInfo = proto.WebMessageInfo.decode(retryResponse.webMessageInfoBytes)

							// Merge cached metadata with decoded message
							// This ensures we don't lose critical information like pushName and LID mappings

							if (cachedData && typeof cachedData === 'object') {
								// Preserve pushName if not present in PDO response
								// eslint-disable-next-line max-depth
								if (cachedData.pushName && !webMessageInfo.pushName) {
									webMessageInfo.pushName = cachedData.pushName
									logger?.debug({ msgId: webMessageInfo.key?.id }, 'CTWA: Restored pushName from cached metadata')
								}

								// Preserve participantAlt (LID) if not present in PDO response
								// This is critical for maintaining LID/PN mapping in groups
								// eslint-disable-next-line max-depth
								if (cachedData.participantAlt && webMessageInfo.key) {
									const msgKey = webMessageInfo.key as WAMessageKey
									// eslint-disable-next-line max-depth
									if (!msgKey.participantAlt) {
										msgKey.participantAlt = cachedData.participantAlt
										logger?.debug(
											{ msgId: webMessageInfo.key?.id, participantAlt: cachedData.participantAlt },
											'CTWA: Restored participantAlt (LID) from cached metadata'
										)
									}
								}

								// Preserve original participant if not in PDO response
								// eslint-disable-next-line max-depth
								if (cachedData.participant && webMessageInfo.key && !webMessageInfo.key.participant) {
									webMessageInfo.key.participant = cachedData.participant
									logger?.debug({ msgId: webMessageInfo.key?.id }, 'CTWA: Restored participant from cached metadata')
								}

								// Only use cached timestamp if PDO response doesn't have one
								// PDO response timestamp is more authoritative if present
								// eslint-disable-next-line max-depth
								if (!webMessageInfo.messageTimestamp && cachedData.messageTimestamp) {
									webMessageInfo.messageTimestamp = cachedData.messageTimestamp
								}
							}

							// Track CTWA message recovery success
							recoveredCount++
							logger?.info(
								{
									msgId: webMessageInfo.key?.id,
									remoteJid: webMessageInfo.key?.remoteJid,
									requestId: response.stanzaId,
									hasMetadata: !!cachedData && typeof cachedData === 'object'
								},
								'CTWA: Successfully recovered message via placeholder resend'
							)

							// Normalize LID→PN in PDO-recovered message key before emitting

							if (webMessageInfo.key && signalRepository) {
								await normalizeKeyLidToPn(webMessageInfo.key as WAMessageKey, signalRepository.lidMapping, logger)
							}

							// wait till another upsert event is available, don't want it to be part of the PDO response message
							// TODO: parse through proper message handling utilities (to add relevant key fields)
							ev.emit('messages.upsert', {
								messages: [webMessageInfo as WAMessage],
								type: 'notify',
								requestId: response.stanzaId!
							})
						}
					}

					// Update metrics for recovered messages
					if (recoveredCount > 0) {
						metrics.ctwaMessagesRecovered.inc(recoveredCount)
						metrics.ctwaRecoveryRequests.inc({ status: 'success' })
						logger?.debug(
							{ recoveredCount, requestId: response.stanzaId },
							'CTWA: Placeholder resend response processed'
						)
					}
				}

				break
			case proto.Message.ProtocolMessage.Type.MESSAGE_EDIT:
				ev.emit('messages.update', [
					{
						// flip the sender / fromMe properties because they're in the perspective of the sender
						key: { ...message.key, id: protocolMsg.key?.id },
						update: {
							message: {
								editedMessage: {
									message: protocolMsg.editedMessage
								}
							},
							messageTimestamp: protocolMsg.timestampMs
								? Math.floor(toNumber(protocolMsg.timestampMs) / 1000)
								: message.messageTimestamp
						}
					}
				])
				break
			case proto.Message.ProtocolMessage.Type.GROUP_MEMBER_LABEL_CHANGE:
				// Port of upstream WhiskeySockets/Baileys#2609 (`fix: emit member tag
				// removal updates`). Member-tag removal arrives as a `memberLabel`
				// patch with NO populated label, so the previous guard
				// `labelAssociationMsg?.label` silently swallowed the removal event.
				// Mirror WA Web's `WAWebHandleMemberLabelChange` which coerces a
				// missing label to "":
				//   `var f = (n = a.label) != null ? n : "";`
				// followed by `createOrUpdateMemberLabel({ ..., label: f })` —
				// i.e. an empty label IS a valid update, the removal channel.
				const labelAssociationMsg = protocolMsg.memberLabel
				if (labelAssociationMsg) {
					ev.emit('group.member-tag.update', {
						groupId: chat.id!,
						label: labelAssociationMsg.label || '',
						participant: message.key.participant!,
						participantAlt: message.key.participantAlt!,
						messageTimestamp: Number(message.messageTimestamp)
					})
				}

				break
			case proto.Message.ProtocolMessage.Type.LID_MIGRATION_MAPPING_SYNC:
				const encodedPayload = protocolMsg.lidMigrationMappingSyncMessage?.encodedMappingPayload
				if (!encodedPayload) {
					break
				}

				const { pnToLidMappings, chatDbMigrationTimestamp } =
					proto.LIDMigrationMappingSyncPayload.decode(encodedPayload)
				logger?.debug({ pnToLidMappings, chatDbMigrationTimestamp }, 'got lid mappings and chat db migration timestamp')
				const pairs = []
				for (const { pn, latestLid, assignedLid } of pnToLidMappings) {
					const lid = latestLid || assignedLid
					pairs.push({ lid: `${lid}@lid`, pn: `${pn}@s.whatsapp.net` })
				}

				await signalRepository.lidMapping.storeLIDPNMappings(pairs)
				if (pairs.length) {
					for (const { pn, lid } of pairs) {
						await signalRepository.migrateSession(pn, lid)
					}
				}
		}
	} else if (content?.reactionMessage) {
		const reactionKey = content.reactionMessage.key
		if (!reactionKey) {
			logger?.warn({ messageKey: message.key }, 'processMessage: reactionMessage.key missing, skipping')
			return
		}

		const reaction: proto.IReaction = {
			...content.reactionMessage,
			key: message.key
		}
		ev.emit('messages.reaction', [
			{
				reaction,
				key: reactionKey
			}
		])

		// Mirrors the reaction into msgstore.db's message_add_on(+_reaction)
		// tables when configured. No-ops (does not throw) when the reacted-to
		// message isn't locally known — same best-effort convention as
		// MessageStoreBackend.recordRevoke.
		if (addOnBackend && messageStoreBackend && message.key.id && reactionKey.remoteJid && reactionKey.id) {
			try {
				const parent = messageStoreBackend.getMessageByKeyId(
					jidNormalizedUser(reactionKey.remoteJid),
					!!reactionKey.fromMe,
					reactionKey.id
				)
				if (parent) {
					const senderJid = getKeyAuthor(message.key, meId)
					addOnBackend.recordReaction({
						chatJid: jidNormalizedUser(message.key.remoteJid ?? ''),
						fromMe: !!message.key.fromMe,
						keyId: message.key.id,
						senderJid: message.key.fromMe ? null : jidNormalizedUser(senderJid),
						parentMessageRowId: parent._id,
						timestamp: toNumber(message.messageTimestamp ?? 0),
						reaction: content.reactionMessage.text ?? '',
						senderTimestamp: toNumber(content.reactionMessage.senderTimestampMs ?? 0)
					})
				}
			} catch (err) {
				logger?.warn({ err }, 'failed to record message_add_on_reaction row')
			}
		}
	} else if (content?.encEventResponseMessage) {
		const encEventResponse = content.encEventResponseMessage
		const creationMsgKey = encEventResponse.eventCreationMessageKey
		if (!creationMsgKey) {
			logger?.warn({ messageKey: message.key }, 'processMessage: eventCreationMessageKey missing, skipping')
			return
		}

		// we need to fetch the event creation message to get the event enc key
		const eventMsg = await getMessage(creationMsgKey)
		if (eventMsg) {
			await decryptAndEmitEventResponse(message, encEventResponse, creationMsgKey, eventMsg)
		} else if (orphanQueue) {
			// Out-of-order arrival: the event-creation message isn't in the
			// consumer's store yet. Queue it instead of dropping the response —
			// replayed by the drain block near the top of this function, on the
			// future invocation of processMessage() that handles the creation
			// message once it arrives.
			orphanQueue.enqueue(creationMsgKey, 'event-response', message)
			logger?.debug({ creationMsgKey }, 'processMessage: event creation message not found yet, queued as orphan')
		} else {
			logger?.warn({ creationMsgKey }, 'event creation message not found, cannot decrypt response')
		}
	} else if (message.messageStubType) {
		const jid = message.key?.remoteJid!
		//let actor = whatsappID (message.participant)
		let participants: GroupParticipant[]
		const emitParticipantsUpdate = (action: ParticipantAction) =>
			ev.emit('group-participants.update', {
				id: jid,
				author: message.key.participant!,
				authorPn: message.key.participantAlt!,
				authorUsername: message.key.participantUsername!,
				participants,
				action
			})
		const emitGroupUpdate = (update: Partial<GroupMetadata>) => {
			ev.emit('groups.update', [
				{
					id: jid,
					...update,
					author: message.key.participant ?? undefined,
					authorPn: message.key.participantAlt,
					authorUsername: message.key.participantUsername
				}
			])
		}

		const emitGroupRequestJoin = (participant: LIDMapping, action: RequestJoinAction, method: RequestJoinMethod) => {
			ev.emit('group.join-request', {
				id: jid,
				author: message.key.participant!,
				authorPn: message.key.participantAlt!,
				authorUsername: message.key.participantUsername!,
				participant: participant.lid,
				participantPn: participant.pn,
				action,
				method: method!
			})
		}

		const participantsIncludesMe = () =>
			participants.find(p => areJidsSameUser(meId, p.id) || areJidsSameUser(meId, p.phoneNumber))

		switch (message.messageStubType) {
			case WAMessageStubType.GROUP_PARTICIPANT_CHANGE_NUMBER:
				participants = message.messageStubParameters.map((a: any) => JSON.parse(a as string)) || []
				emitParticipantsUpdate('modify')
				break
			case WAMessageStubType.GROUP_PARTICIPANT_LEAVE:
			case WAMessageStubType.GROUP_PARTICIPANT_REMOVE:
				participants = message.messageStubParameters.map((a: any) => JSON.parse(a as string)) || []
				emitParticipantsUpdate('remove')
				// mark the chat read only if you left the group
				if (participantsIncludesMe()) {
					chat.readOnly = true
				}

				break
			case WAMessageStubType.GROUP_PARTICIPANT_ADD:
			case WAMessageStubType.GROUP_PARTICIPANT_INVITE:
			case WAMessageStubType.GROUP_PARTICIPANT_ADD_REQUEST_JOIN:
				participants = message.messageStubParameters.map((a: any) => JSON.parse(a as string)) || []
				if (participantsIncludesMe()) {
					chat.readOnly = false
				}

				emitParticipantsUpdate('add')
				break
			case WAMessageStubType.GROUP_PARTICIPANT_DEMOTE:
				participants = message.messageStubParameters.map((a: any) => JSON.parse(a as string)) || []
				emitParticipantsUpdate('demote')
				break
			case WAMessageStubType.GROUP_PARTICIPANT_PROMOTE:
				participants = message.messageStubParameters.map((a: any) => JSON.parse(a as string)) || []
				emitParticipantsUpdate('promote')
				break
			case WAMessageStubType.GROUP_CHANGE_ANNOUNCE:
				const announceValue = message.messageStubParameters?.[0]
				emitGroupUpdate({ announce: announceValue === 'true' || announceValue === 'on' })
				break
			case WAMessageStubType.GROUP_CHANGE_RESTRICT:
				const restrictValue = message.messageStubParameters?.[0]
				emitGroupUpdate({ restrict: restrictValue === 'true' || restrictValue === 'on' })
				break
			case WAMessageStubType.GROUP_CHANGE_SUBJECT:
				const name = message.messageStubParameters?.[0]
				chat.name = name
				emitGroupUpdate({ subject: name })
				break
			case WAMessageStubType.GROUP_CHANGE_DESCRIPTION:
				const description = message.messageStubParameters?.[0]
				chat.description = description
				emitGroupUpdate({ desc: description })
				break
			case WAMessageStubType.GROUP_CHANGE_INVITE_LINK:
				const code = message.messageStubParameters?.[0]
				emitGroupUpdate({ inviteCode: code })
				break
			case WAMessageStubType.GROUP_MEMBER_ADD_MODE:
				const memberAddValue = message.messageStubParameters?.[0]
				emitGroupUpdate({ memberAddMode: memberAddValue === 'all_member_add' })
				break
			case WAMessageStubType.GROUP_MEMBERSHIP_JOIN_APPROVAL_MODE:
				const approvalMode = message.messageStubParameters?.[0]
				emitGroupUpdate({ joinApprovalMode: approvalMode === 'on' })
				break
			case WAMessageStubType.GROUP_MEMBERSHIP_JOIN_APPROVAL_REQUEST_NON_ADMIN_ADD: // TODO: Add other events
				const participant = JSON.parse(message.messageStubParameters?.[0]) as LIDMapping
				const action = message.messageStubParameters?.[1] as RequestJoinAction
				const method = message.messageStubParameters?.[2] as RequestJoinMethod
				emitGroupRequestJoin(participant, action, method)
				break
		}
	} /*  else if(content?.pollUpdateMessage) {
		const creationMsgKey = content.pollUpdateMessage.pollCreationMessageKey!
		// we need to fetch the poll creation message to get the poll enc key
		// TODO: make standalone, remove getMessage reference
		// TODO: Remove entirely
		const pollMsg = await getMessage(creationMsgKey)
		if(pollMsg) {
			const meIdNormalised = jidNormalizedUser(meId)
			const pollCreatorJid = getKeyAuthor(creationMsgKey, meIdNormalised)
			const voterJid = getKeyAuthor(message.key, meIdNormalised)
			const pollEncKey = pollMsg.messageContextInfo?.messageSecret!

			try {
				const voteMsg = decryptPollVote(
					content.pollUpdateMessage.vote!,
					{
						pollEncKey,
						pollCreatorJid,
						pollMsgId: creationMsgKey.id!,
						voterJid,
					}
				)
				ev.emit('messages.update', [
					{
						key: creationMsgKey,
						update: {
							pollUpdates: [
								{
									pollUpdateMessageKey: message.key,
									vote: voteMsg,
									senderTimestampMs: (content.pollUpdateMessage.senderTimestampMs! as Long).toNumber(),
								}
							]
						}
					}
				])
			} catch(err) {
				logger?.warn(
					{ err, creationMsgKey },
					'failed to decrypt poll vote'
				)
			}
		} else {
			logger?.warn(
				{ creationMsgKey },
				'poll creation message not found, cannot decrypt update'
			)
		}
		} */

	if (Object.keys(chat).length > 1) {
		ev.emit('chats.update', [chat])
	}
}

export default processMessage
