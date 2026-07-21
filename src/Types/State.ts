import { Boom } from '@hapi/boom'
import type { Contact } from './Contact'

export enum SyncState {
	/** The socket is connecting, but we haven't received pending notifications yet. */
	Connecting,
	/** Pending notifications received. Buffering events until we decide whether to sync or not. */
	AwaitingInitialSync,
	/** The initial app state sync (history, etc.) is in progress. Buffering continues. */
	Syncing,
	/** Initial sync is complete, or was skipped. The socket is fully operational and events are processed in real-time. */
	Online
}

export type WAConnectionState = 'open' | 'connecting' | 'close'

export type ConnectionState = {
	/** connection is now open, connecting or closed */
	connection: WAConnectionState

	/** the error that caused the connection to close */
	lastDisconnect?: {
		// TODO: refactor and gain independence from Boom
		error: Boom | Error | undefined
		date: Date
	}
	/** is this a new login */
	isNewLogin?: boolean
	/** the current QR code */
	qr?: string
	/** has the device received all pending notifications while it was offline */
	receivedPendingNotifications?: boolean
	/** legacy connection options */
	legacy?: {
		phoneConnected: boolean
		user?: Contact
	}
	/**
	 * if the client is shown as an active, online client.
	 * If this is false, the primary phone and other devices will receive notifs
	 * */
	isOnline?: boolean
	/**
	 * indicates the disconnect was caused by a session error (keys desynchronized).
	 * When true, the consumer should recreate the socket with makeWASocket()
	 * to establish a fresh session.
	 */
	isSessionError?: boolean

	/**
	 * When you are in this state, WhatsApp prevents outgoing messages and calls.
	 * Port de upstream `4dbbba2891` (PR #2442).
	 */
	reachoutTimeLock?: ReachoutTimelockState
}

export type ReachoutTimelockState = {
	isActive?: boolean
	timeEnforcementEnds?: Date
	enforcementType?: ReachoutTimelockEnforcementType
}

/**
 * Opt-in configuration for the experimental BIZ_QUALITY remediation flow.
 *
 * WhatsApp Android gates this flow with a remotely configured feature flag and
 * video URL. Neither value is available to a Web companion, so callers must
 * supply values captured from an eligible official-client session. Merely
 * enabling this object never changes message sending or removes a restriction.
 */
export type ReachoutTimelockRemediationConfig = {
	/** Master switch. The feature is disabled unless this is exactly `true`. */
	enabled?: boolean
	/** Whether Android remote feature flag 21412 was observed as enabled. */
	androidFeatureFlagEnabled?: boolean
	/** Official remediation video URL obtained from Android remote config key 24562. */
	officialVideoUrl?: string
}

export type ReachoutTimelockRemediationEligibilityReason =
	| 'eligible'
	| 'feature-disabled'
	| 'restriction-inactive'
	| 'wrong-enforcement-type'
	| 'android-feature-flag-not-confirmed'
	| 'official-video-url-missing-or-invalid'

export type ReachoutTimelockRemediationEligibility = {
	eligible: boolean
	reason: ReachoutTimelockRemediationEligibilityReason
	state: ReachoutTimelockState
	officialVideoUrl?: string
}

export type ReachoutTimelockRemediationRequest = {
	/** Explicit assertion made only after the user watched the configured official video. */
	videoWatched: true
	/** Prevents a generic boolean or accidental call from authorizing a server mutation. */
	confirmation: 'USER_WATCHED_OFFICIAL_VIDEO'
}

export type ReachoutTimelockRemediationResult = {
	removed: boolean
	status: 'removed' | 'server-rejected' | 'server-accepted-pending-verification'
	before: ReachoutTimelockState
	after?: ReachoutTimelockState
	serverSuccess: boolean
	serverError?: string
}

export enum ReachoutTimelockEnforcementType {
	BIZ_COMMERCE_VIOLATION_ALCOHOL = 'BIZ_COMMERCE_VIOLATION_ALCOHOL',
	BIZ_COMMERCE_VIOLATION_ADULT = 'BIZ_COMMERCE_VIOLATION_ADULT',
	BIZ_COMMERCE_VIOLATION_ANIMALS = 'BIZ_COMMERCE_VIOLATION_ANIMALS',
	BIZ_COMMERCE_VIOLATION_BODY_PARTS_FLUIDS = 'BIZ_COMMERCE_VIOLATION_BODY_PARTS_FLUIDS',
	BIZ_COMMERCE_VIOLATION_DATING = 'BIZ_COMMERCE_VIOLATION_DATING',
	BIZ_COMMERCE_VIOLATION_DIGITAL_SERVICES_PRODUCTS = 'BIZ_COMMERCE_VIOLATION_DIGITAL_SERVICES_PRODUCTS',
	BIZ_COMMERCE_VIOLATION_DRUGS = 'BIZ_COMMERCE_VIOLATION_DRUGS',
	BIZ_COMMERCE_VIOLATION_DRUGS_ONLY_OTC = 'BIZ_COMMERCE_VIOLATION_DRUGS_ONLY_OTC',
	BIZ_COMMERCE_VIOLATION_GAMBLING = 'BIZ_COMMERCE_VIOLATION_GAMBLING',
	BIZ_COMMERCE_VIOLATION_HEALTHCARE = 'BIZ_COMMERCE_VIOLATION_HEALTHCARE',
	BIZ_COMMERCE_VIOLATION_REAL_FAKE_CURRENCY = 'BIZ_COMMERCE_VIOLATION_REAL_FAKE_CURRENCY',
	BIZ_COMMERCE_VIOLATION_SUPPLEMENTS = 'BIZ_COMMERCE_VIOLATION_SUPPLEMENTS',
	BIZ_COMMERCE_VIOLATION_TOBACCO = 'BIZ_COMMERCE_VIOLATION_TOBACCO',
	BIZ_COMMERCE_VIOLATION_VIOLENT_CONTENT = 'BIZ_COMMERCE_VIOLATION_VIOLENT_CONTENT',
	BIZ_COMMERCE_VIOLATION_WEAPONS = 'BIZ_COMMERCE_VIOLATION_WEAPONS',
	BIZ_QUALITY = 'BIZ_QUALITY',
	BULK_MESSAGING = 'BULK_MESSAGING',
	/** The generic server category. `isActive`, not this value, determines whether a restriction exists. */
	DEFAULT = 'DEFAULT',
	RESTRICT_ALL_COMPANIONS = 'RESTRICT_ALL_COMPANIONS',
	SCAM = 'SCAM',
	WEB_COMPANION_ONLY = 'WEB_COMPANION_ONLY'
}

export enum NewChatMessageCappingStatusType {
	NONE = 'NONE',
	FIRST_WARNING = 'FIRST_WARNING',
	SECOND_WARNING = 'SECOND_WARNING',
	CAPPED = 'CAPPED'
}

export enum NewChatMessageCappingMVStatusType {
	NOT_ELIGIBLE = 'NOT_ELIGIBLE',
	NOT_ACTIVE = 'NOT_ACTIVE',
	ACTIVE = 'ACTIVE',
	ACTIVE_UPGRADE_AVAILABLE = 'ACTIVE_UPGRADE_AVAILABLE'
}

export enum NewChatMessageCappingOTEStatusType {
	NOT_ELIGIBLE = 'NOT_ELIGIBLE',
	ELIGIBLE = 'ELIGIBLE',
	ACTIVE_IN_CURRENT_CYCLE = 'ACTIVE_IN_CURRENT_CYCLE',
	EXHAUSTED = 'EXHAUSTED'
}

export type NewChatMessageCapInfo = {
	total_quota?: number
	used_quota?: number
	cycle_start_timestamp?: string
	cycle_end_timestamp?: string
	server_sent_timestamp?: string
	ote_status?: NewChatMessageCappingOTEStatusType
	mv_status?: NewChatMessageCappingMVStatusType
	capping_status?: NewChatMessageCappingStatusType
}
