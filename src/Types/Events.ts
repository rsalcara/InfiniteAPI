import type { Boom } from '@hapi/boom'
import { proto } from '../../WAProto/index.js'
import type { AuthenticationCreds, LIDMapping } from './Auth'
import type { WACallEvent } from './Call'
import type { Chat, ChatUpdate, PresenceData } from './Chat'
import type { Contact } from './Contact'
import type {
	GroupMetadata,
	GroupParticipant,
	ParticipantAction,
	RequestJoinAction,
	RequestJoinMethod
} from './GroupMetadata'
import type { Label } from './Label'
import type { LabelAssociation } from './LabelAssociation'
import type { MessageUpsertType, MessageUserReceiptUpdate, WAMessage, WAMessageKey, WAMessageUpdate } from './Message'
import type { ConnectionState, NewChatMessageCapInfo } from './State'

export type MessageDeliveryState = 'accepted' | 'server_ack' | 'delivered' | 'failed'

export type MessageDeliveryStateUpdate = {
	key: WAMessageKey
	state: MessageDeliveryState
	/** Epoch milliseconds when this state was observed locally. */
	timestamp: number
	/** Server receipt time, when the stanza supplied one. */
	serverTimestamp?: number
	/** JID supplied by the consumer, when it differs from the wire identity. */
	requestedJid?: string
	/** Canonical PN/LID used for routing or policy evaluation. */
	canonicalJid?: string
	serverCode?: string
	category?: string
	reason?: string
	action?: 'none' | 'blocked-no-retry' | 'retry-suppressed'
}

// TODO: refactor this mess
export type BaileysEventMap = {
	/** connection state has been updated -- WS closed, opened, connecting etc. */
	'connection.update': Partial<ConnectionState>
	/** credentials updated -- some metadata, keys or something */
	'creds.update': Partial<AuthenticationCreds>
	/** set chats (history sync), everything is reverse chronologically sorted */
	'messaging-history.set': {
		chats: Chat[]
		contacts: Contact[]
		messages: WAMessage[]
		isLatest?: boolean
		progress?: number | null
		syncType?: proto.HistorySync.HistorySyncType | null
		pastParticipants?: proto.IPastParticipants[] | null
		chunkOrder?: number | null
		peerDataRequestSessionId?: string | null
	}
	/** signals history sync milestones (completion or stall) per sync type */
	'messaging-history.status': {
		/** which sync phase this status refers to */
		syncType: proto.HistorySync.HistorySyncType
		/** the status of this sync phase */
		status: 'complete' | 'paused'
		/**
		 * progress === 100 was received from the server.
		 * when false, completion was inferred via timeout (no more chunks arriving).
		 */
		explicit: boolean
	}
	/** upsert chats */
	'chats.upsert': Chat[]
	/** update the given chats */
	'chats.update': ChatUpdate[]
	'lid-mapping.update': LIDMapping[]
	/** delete chats with given ID */
	'chats.delete': string[]
	/** presence of contact in a chat updated */
	'presence.update': { id: string; presences: { [participant: string]: PresenceData } }

	'contacts.upsert': Contact[]
	'contacts.update': Partial<Contact>[]

	'messages.delete': { keys: WAMessageKey[] } | { jid: string; all: true }
	'messages.update': WAMessageUpdate[]
	/** Distinguishes local acceptance, server ACK and peer delivery. */
	'message.delivery-state': MessageDeliveryStateUpdate
	'messages.media-update': { key: WAMessageKey; media?: { ciphertext: Uint8Array; iv: Uint8Array }; error?: Boom }[]
	/**
	 * add/update the given messages. If they were received while the connection was online,
	 * the update will have type: "notify"
	 * if requestId is provided, then the messages was received from the phone due to it being unavailable
	 *  */
	'messages.upsert': { messages: WAMessage[]; type: MessageUpsertType; requestId?: string }
	/** message was reacted to. If reaction was removed -- then "reaction.text" will be falsey */
	'messages.reaction': { key: WAMessageKey; reaction: proto.IReaction }[]

	'message-receipt.update': MessageUserReceiptUpdate[]

	'groups.upsert': GroupMetadata[]
	'groups.update': Partial<GroupMetadata>[]
	/** apply an action to participants in a group */
	'group-participants.update': {
		id: string
		author: string
		authorPn?: string
		authorUsername?: string
		participants: GroupParticipant[]
		action: ParticipantAction
	}
	'group.join-request': {
		id: string
		author: string
		authorPn?: string
		authorUsername?: string
		participant: string
		participantPn?: string
		action: RequestJoinAction
		method: RequestJoinMethod
	}
	/*	update the labels assigned to a group participant */
	'group.member-tag.update': {
		groupId: string
		participant: string
		participantAlt?: string
		label: string
		messageTimestamp?: number
	}

	/**
	 * Fired when an outgoing message into an "admins only" (announce) group /
	 * locked community is blocked because this account is a non-admin member
	 * (see `enforceAnnounceAdmin`). Lets the operator detect, log and alert on
	 * attempts to post where the account is not allowed to — e.g. someone using
	 * the API to push spam into a locked community.
	 */
	'security.announce-violation': {
		/** the announce group / community the send was attempted into */
		jid: string
		/** the identity that attempted the send (PN or LID of this account) */
		by: string
		/** machine-readable reason, currently always 'announce-non-admin' */
		reason: 'announce-non-admin'
		/** id of the message that was blocked, if one was assigned */
		messageId?: string
		/** group subject, when available from metadata */
		groupSubject?: string
		/** epoch milliseconds when the attempt was blocked */
		timestamp: number
	}

	/**
	 * Fired when the "promote → blast → demote/leave" abuse pattern is detected:
	 * an account was promoted to admin and then demoted/removed within the
	 * configured window (see `detectAdminPromoteDemoteAbuse`). Identifies BOTH
	 * the promoted account that (likely) sent the blast and the admin who
	 * promoted it — i.e. who is responsible.
	 */
	'security.admin-abuse-suspected': {
		/** the group / community where it happened */
		jid: string
		/** group subject, when available */
		groupSubject?: string
		/** the account that was promoted then demoted/removed (the spammer) */
		participant: string
		/** the admin who granted admin to `participant` (colluding/compromised) */
		promotedBy: string
		/** who demoted/removed `participant` to close the window, if known */
		removedBy?: string
		/** how the window closed */
		closedBy: 'demote' | 'remove'
		/** epoch ms of the promotion */
		promotedAt: number
		/** epoch ms of the demote/remove that closed the window */
		closedAt: number
		/** elapsed ms between promotion and demote/remove */
		windowMs: number
		/** number of messages `participant` sent while it was admin */
		messagesDuringWindow: number
	}

	'blocklist.set': { blocklist: string[] }
	'blocklist.update': { blocklist: string[]; type: 'add' | 'remove' }

	/** Receive an update on a call, including when the call was received, rejected, accepted */
	call: WACallEvent[]
	'labels.edit': Label
	'labels.association': { association: LabelAssociation; type: 'add' | 'remove' }

	/** Newsletter-related events */
	'newsletter.reaction': {
		id: string
		server_id: string
		reaction: { code?: string; count?: number; removed?: boolean }
	}
	'newsletter.view': { id: string; server_id: string; count: number }
	'newsletter-participants.update': { id: string; author: string; user: string; new_role: string; action: string }
	'newsletter-settings.update': { id: string; update: any }

	/** Server-side notification de novo limite de chats — port de upstream `c89d97b13b` (PR #2445). */
	'message-capping.update': NewChatMessageCapInfo
	/**
	 * An opaque side-subscription hash announced that one or more contacts may
	 * have changed their text status/about. The official Android client resolves
	 * this hash through its private side-list index before refreshing contacts.
	 */
	'text-status-side-sub.update': { from?: string; hash: string }
	/** Full text-status/about update for a specific contact. */
	'text-status.update': {
		from?: string
		jid: string
		lastUpdateTime: string
		text: string
		emoji: string | null
		ephemeralDurationSec: number
	}

	/** Settings and actions sync events */
	'chats.lock': { id: string; locked: boolean }
	/** A sticker was starred/unstarred (app-state `stickerAction`). `plaintextHash`
	 * is the sticker's plaintext SHA-256 (base64). Mirrored into stickers.db. */
	'stickers.update': { plaintextHash: string; isFavorite: boolean }
	/**
	 * Emitted when a new WhatsApp Web version is detected.
	 * The new version will be used on the next reconnection (soft update).
	 */
	'version.update': {
		/** Previous version */
		currentVersion: [number, number, number]
		/** New version detected */
		newVersion: [number, number, number]
		/** Whether the update is critical (major version change) */
		isCritical: boolean
	}
	'settings.update':
		| { setting: 'unarchiveChats'; value: boolean }
		| { setting: 'locale'; value: string }
		| { setting: 'disableLinkPreviews'; value: proto.SyncActionValue.IPrivacySettingDisableLinkPreviewsAction }
		| { setting: 'timeFormat'; value: proto.SyncActionValue.ITimeFormatAction }
		| { setting: 'privacySettingRelayAllCalls'; value: proto.SyncActionValue.IPrivacySettingRelayAllCalls }
		| { setting: 'statusPrivacy'; value: proto.SyncActionValue.IStatusPrivacyAction }
		| {
				setting: 'notificationActivitySetting'
				value: proto.SyncActionValue.NotificationActivitySettingAction.NotificationActivitySetting
		  }
		| {
				setting: 'channelsPersonalisedRecommendation'
				value: proto.SyncActionValue.IPrivacySettingChannelsPersonalisedRecommendationAction
		  }

	/**
	 * Emitted when a contact's Signal identity key changes.
	 * This typically indicates the contact reinstalled WhatsApp or switched devices.
	 * Applications can use this to notify users about the security code change,
	 * similar to the "Security code changed" notification in the official WhatsApp client.
	 */
	'identity.changed': {
		/** JID of the contact whose identity key changed */
		jid: string
		/** SHA-256 fingerprint of the previous identity key (hex string) */
		previousKeyFingerprint: string | null
		/** SHA-256 fingerprint of the new identity key (hex string) */
		newKeyFingerprint: string
		/** Timestamp when the change was detected */
		timestamp: number
		/** Whether this is a new contact (true) or an existing contact with changed key (false) */
		isNewContact: boolean
	}

	/**
	 * Emitted when the session TTL (Time-To-Live) expires after 7 days.
	 * Applications can listen to this event to perform graceful cleanup,
	 * flush pending operations, or rotate credentials before the socket closes.
	 */
	'session.ttl-expired': {
		/** Timestamp when the session started (Date.now()) */
		startTime: number | undefined
		/** Duration of the session in milliseconds */
		duration: number
	}
}

export type BufferedEventData = {
	historySets: {
		chats: { [jid: string]: Chat }
		contacts: { [jid: string]: Contact }
		messages: { [uqId: string]: WAMessage }
		empty: boolean
		isLatest: boolean
		progress?: number | null
		syncType?: proto.HistorySync.HistorySyncType
		pastParticipants?: proto.IPastParticipants[]
		chunkOrder?: number | null
		peerDataRequestSessionId?: string
	}
	chatUpserts: { [jid: string]: Chat }
	chatUpdates: { [jid: string]: ChatUpdate }
	chatDeletes: Set<string>
	contactUpserts: { [jid: string]: Contact }
	contactUpdates: { [jid: string]: Partial<Contact> }
	messageUpserts: { [key: string]: { type: MessageUpsertType; message: WAMessage } }
	messageUpdates: { [key: string]: WAMessageUpdate }
	messageDeletes: { [key: string]: WAMessageKey }
	messageReactions: { [key: string]: { key: WAMessageKey; reactions: proto.IReaction[] } }
	messageReceipts: { [key: string]: { key: WAMessageKey; userReceipt: proto.IUserReceipt[] } }
	groupUpdates: { [jid: string]: Partial<GroupMetadata> }
	lidMappings: { [key: string]: LIDMapping }
}

export type BaileysEvent = keyof BaileysEventMap

export interface BaileysEventEmitter {
	on<T extends keyof BaileysEventMap>(event: T, listener: (arg: BaileysEventMap[T]) => void): void
	off<T extends keyof BaileysEventMap>(event: T, listener: (arg: BaileysEventMap[T]) => void): void
	removeAllListeners<T extends keyof BaileysEventMap>(event: T): void
	emit<T extends keyof BaileysEventMap>(event: T, arg: BaileysEventMap[T]): boolean
}
