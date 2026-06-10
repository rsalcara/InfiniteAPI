import { proto } from '../../WAProto/index.js'
import { makeLibSignalRepository } from '../Signal/libsignal'
import type { AuthenticationState, SocketConfig, WAVersion } from '../Types'
import { Browsers } from '../Utils/browser-utils'
import logger from '../Utils/logger'
// Single source of truth for WhatsApp Web version - imported from JSON
import baileysVersionData from './baileys-version.json' with { type: 'json' }

const version = baileysVersionData.version

export const UNAUTHORIZED_CODES = [401, 403, 419]

export const DEFAULT_ORIGIN = 'https://web.whatsapp.com'
export const CALL_VIDEO_PREFIX = 'https://call.whatsapp.com/video/'
export const CALL_AUDIO_PREFIX = 'https://call.whatsapp.com/voice/'
export const DEF_CALLBACK_PREFIX = 'CB:'
export const DEF_TAG_PREFIX = 'TAG:'
export const PHONE_CONNECTION_CB = 'CB:Pong'

export const WA_ADV_ACCOUNT_SIG_PREFIX = Buffer.from([6, 0])
export const WA_ADV_DEVICE_SIG_PREFIX = Buffer.from([6, 1])
export const WA_ADV_HOSTED_ACCOUNT_SIG_PREFIX = Buffer.from([6, 5])
export const WA_ADV_HOSTED_DEVICE_SIG_PREFIX = Buffer.from([6, 6])

export const WA_DEFAULT_EPHEMERAL = 7 * 24 * 60 * 60

/** Status messages older than 24 hours are considered expired */
export const STATUS_EXPIRY_SECONDS = 24 * 60 * 60

/** CTWA placeholder messages older than 7 days won't be requested from phone */
export const PLACEHOLDER_MAX_AGE_SECONDS = 7 * 24 * 60 * 60

export const NOISE_MODE = 'Noise_XX_25519_AESGCM_SHA256\0\0\0\0'
export const DICT_VERSION = 3
export const KEY_BUNDLE_TYPE = Buffer.from([5])
export const NOISE_WA_HEADER = Buffer.from([87, 65, 6, DICT_VERSION]) // last is "DICT_VERSION"
/** from: https://stackoverflow.com/questions/3809401/what-is-a-good-regular-expression-to-match-a-url */
export const URL_REGEX = /https:\/\/(?![^:@\/\s]+:[^:@\/\s]+@)[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}(:\d+)?(\/[^\s]*)?/g

export const WA_CERT_DETAILS = {
	SERIAL: 0,
	ISSUER: 'WhatsAppLongTerm1',
	PUBLIC_KEY: Buffer.from('142375574d0a587166aae71ebe516437c4a28b73e3695c6ce1f7f9545da8ee6b', 'hex')
}

export const PROCESSABLE_HISTORY_TYPES = [
	proto.HistorySync.HistorySyncType.INITIAL_BOOTSTRAP,
	proto.HistorySync.HistorySyncType.PUSH_NAME,
	proto.HistorySync.HistorySyncType.RECENT,
	proto.HistorySync.HistorySyncType.FULL,
	proto.HistorySync.HistorySyncType.ON_DEMAND,
	proto.HistorySync.HistorySyncType.NON_BLOCKING_DATA,
	proto.HistorySync.HistorySyncType.INITIAL_STATUS_V3
]

// 6 hours in milliseconds
const SIX_HOURS_MS = 6 * 60 * 60 * 1000

/**
 * Resolves the default browser tuple from the BAILEYS_BROWSER env var.
 * Default: Android companion (SMB_ANDROID) — matches upstream PR #2201.
 * Pair code auto-detects Android and falls back to Chrome in socket.ts.
 *
 *   unset / 'android'    → Browsers.android('14')
 *   'android:15'         → Browsers.android('15')
 *   'chrome' / 'macos'   → Browsers.macOS('Chrome')
 */
const resolveDefaultBrowser = (): [string, string, string] => {
	const env = process.env.BAILEYS_BROWSER?.trim().toLowerCase()
	if (env === 'chrome' || env === 'macos') {
		return Browsers.macOS('Chrome')
	}

	if (env?.startsWith('android:')) {
		const apiLevel = env.split(':')[1] || '14'
		return Browsers.android(apiLevel)
	}

	return Browsers.android('14')
}

export const DEFAULT_CONNECTION_CONFIG: SocketConfig = {
	version: version as WAVersion,
	versionCheckIntervalMs: SIX_HOURS_MS,
	browser: resolveDefaultBrowser(),
	waWebSocketUrl: 'wss://web.whatsapp.com/ws/chat',
	connectTimeoutMs: 20_000,
	keepAliveIntervalMs: 15_000,
	logger: logger.child({ class: 'baileys' }),
	emitOwnEvents: true,
	defaultQueryTimeoutMs: 30_000,
	customUploadHosts: [],
	retryRequestDelayMs: 150,
	maxMsgRetryCount: 5,
	fireInitQueries: true,
	auth: undefined as unknown as AuthenticationState,
	markOnlineOnConnect: true,
	// Set to false if you don't need full message history (reduces bandwidth/storage)
	syncFullHistory: true,
	patchMessageBeforeSending: msg => msg,
	shouldSyncHistoryMessage: () => true,
	shouldIgnoreJid: () => false,
	linkPreviewImageThumbnailWidth: 192,
	// When sending plain text + URL to a newsletter (channel), upgrade the
	// message to imageMessage + caption using the URL's og:image so it
	// renders full-width and crisp like news channels do (verified on g1,
	// 6.4M followers: message_type=1, 1547×864 JPEG, text_data carries the
	// caption with the URL). Without this, the channel UI shows raw text
	// because the official mobile client never auto-generates a preview
	// for links posted in channels. Disable with explicit `false`.
	autoImageFromLinkInNewsletter: true,
	transactionOpts: { maxCommitRetries: 10, delayBetweenTriesMs: 1000 },
	generateHighQualityLinkPreview: false,
	enableAutoSessionRecreation: true,
	enableRecentMessageCache: true,
	// Enable automatic recovery of Click-to-WhatsApp ads messages
	// These arrive as "placeholder messages" and need to be requested from the phone
	enableCTWARecovery: true,
	// Enable interactive messages (buttons, lists, templates, carousel)
	enableInteractiveMessages: true,
	// Clear stale routingInfo on every socket creation so the WhatsApp load balancer
	// assigns a fresh, healthy edge server after any restart (pm2, server reboot, deploy).
	// The server always sends a new routingInfo during the connection handshake, so the
	// old value is never needed. Keeping it can cause slow or unstable sessions when the
	// previous edge server is overloaded or has stale state.
	clearRoutingInfoOnStart: true,
	options: {},
	appStateMacVerification: {
		patch: false,
		snapshot: false
	},
	countryCode: 'US',
	getMessage: async () => undefined,
	cachedGroupMetadata: async () => undefined,
	makeSignalRepository: makeLibSignalRepository,
	// Listener limits (memory leak prevention)
	// WebSocket: 8 core events (open, close, error, message, ping, pong, upgrade, unexpected-response)
	//          + 10 dynamic listeners (reconnect handlers, custom events)
	//          + 2 buffer slots for temporary listeners = 20 total
	maxWebSocketListeners: 20,
	// SocketClient: 20 core events (connection, messaging, presence, groups, calls, etc.)
	//             + 20 dynamic listeners (user handlers, plugins)
	//             + 10 buffer slots for high-load scenarios = 50 total
	maxSocketClientListeners: 50,
	// Unified session telemetry (reduces detection of unofficial clients)
	// NOTE: undefined means "check env var first, then default to true"
	// This allows BAILEYS_UNIFIED_SESSION_ENABLED env var to have precedence
	enableUnifiedSession: undefined
}

/**
 * Path prefixes for non-newsletter (1:1 / group) media uploads.
 *
 * Confirmed empirically against WhatsApp Web 2.3000.x source code on
 * 2026-06-05 (via CDP `Runtime.evaluate` enumerating `'/mms/*'` string
 * literals across 50 loaded chunks). See
 * `WABA-ANDROID-RE/captures/wa-web-cdp-20260605-021821.log` for the run.
 *
 * Previous values for `sticker` and `thumbnail-link` were `/mms/image`,
 * which works because the CDN's content-typing is permissive — but it
 * tags uploads as image and breaks newsletter / channel routing on the
 * server side. The strings here match the WA Web source 1:1.
 */
export const MEDIA_PATH_MAP: { [T in MediaType]?: string } = {
	image: '/mms/image',
	video: '/mms/video',
	document: '/mms/document',
	audio: '/mms/audio',
	gif: '/mms/gif',
	ptt: '/mms/ptt',
	sticker: '/mms/sticker',
	'thumbnail-image': '/mms/thumbnail-image',
	'thumbnail-video': '/mms/thumbnail-video',
	'thumbnail-document': '/mms/thumbnail-document',
	'thumbnail-link': '/mms/thumbnail-link',
	'product-catalog-image': '/product/image',
	'md-app-state': '',
	'md-msg-hist': '/mms/md-app-state',
	'biz-cover-photo': '/pps/biz-cover-photo',
	'sticker-pack': '/mms/sticker-pack',
	'thumbnail-sticker-pack': '/mms/thumbnail-sticker-pack'
}

/**
 * Path prefixes for media uploaded to newsletter (channel) chats.
 *
 * Confirmed empirically against WhatsApp Web 2.3000.x source code on
 * 2026-06-05 (via CDP `Runtime.evaluate` enumerating `'/newsletter/*'`
 * string literals across 50 loaded chunks). 5 of the 10 paths were
 * additionally observed live in network captures (image, video, gif,
 * ptt, sticker uploads sent from a real channel via WhatsApp Desktop).
 *
 * This matches PR #2434 (WhiskeySockets/Baileys) with the corrections
 * requested by reviewer @vinikjkkj (sticker and thumbnail-link were
 * incorrectly pointed to `-image` in the original PR; gif/ptt/ptv/
 * sticker-pack were missing entirely). Both bugs are fixed here.
 *
 * Note: `audio` exists on the server side but the WhatsApp client
 * always uploads audio to a channel as `ptt` (push-to-talk), even when
 * the source file is an arbitrary mp3. The mapping is preserved for
 * completeness in case a caller dispatches by raw mediaType.
 */
export const NEWSLETTER_MEDIA_PATH_MAP: { [T in MediaType]?: string } = {
	image: '/newsletter/newsletter-image',
	video: '/newsletter/newsletter-video',
	audio: '/newsletter/newsletter-audio',
	document: '/newsletter/newsletter-document',
	sticker: '/newsletter/newsletter-sticker',
	'sticker-pack': '/newsletter/newsletter-sticker-pack',
	gif: '/newsletter/newsletter-gif',
	ptt: '/newsletter/newsletter-ptt',
	ptv: '/newsletter/newsletter-ptv',
	'thumbnail-link': '/newsletter/newsletter-thumbnail-link'
}

export const MEDIA_HKDF_KEY_MAPPING = {
	audio: 'Audio',
	document: 'Document',
	gif: 'Video',
	image: 'Image',
	ppic: '',
	product: 'Image',
	ptt: 'Audio',
	sticker: 'Image',
	video: 'Video',
	'thumbnail-document': 'Document Thumbnail',
	'thumbnail-image': 'Image Thumbnail',
	'thumbnail-video': 'Video Thumbnail',
	'thumbnail-link': 'Link Thumbnail',
	'md-msg-hist': 'History',
	'md-app-state': 'App State',
	'product-catalog-image': '',
	'payment-bg-image': 'Payment Background',
	ptv: 'Video',
	'biz-cover-photo': 'Image',
	'sticker-pack': 'Sticker Pack',
	'thumbnail-sticker-pack': 'Sticker Pack Thumbnail'
}

export type MediaType = keyof typeof MEDIA_HKDF_KEY_MAPPING

export const MEDIA_KEYS = Object.keys(MEDIA_PATH_MAP) as MediaType[]

/** 120s timeout for history sync stall detection, same as WA Web's handleChunkProgress / restartPausedTimer (g = 120) */
export const HISTORY_SYNC_PAUSED_TIMEOUT_MS = 120_000

export const MIN_PREKEY_COUNT = 5

// Moderate prekey count (upstream uses 812, reduced to balance rate limiting and availability)
export const INITIAL_PREKEY_COUNT = 200

export const UPLOAD_TIMEOUT = 30000 // 30 seconds
// Moderate upload interval to balance rate limiting and responsiveness (was 5000)
export const MIN_UPLOAD_INTERVAL = 10_000 // 10 seconds minimum between uploads

/**
 * Cache TTL configuration (in seconds)
 */
export const DEFAULT_CACHE_TTLS = {
	SIGNAL_STORE: 5 * 60, // 5 minutes
	MSG_RETRY: 60 * 60, // 1 hour
	CALL_OFFER: 5 * 60, // 5 minutes
	USER_DEVICES: 5 * 60, // 5 minutes
	// Meta AI / FBID bot message-secret cache. Streaming responses (first/inner/last edit chain)
	// reference the same target_id over ~600ms, so an hour is comfortably long. Cache is
	// also cleared on socket disconnect (mimics WA Web's BackendEventBus.onLogout).
	MSMSG_SECRET: 60 * 60 // 1 hour
}

/**
 * Maximum cache keys per store type - prevents memory leaks
 * Based on RSocket's battle-tested configuration
 *
 * Usage: Use these limits when initializing LRU caches to prevent unbounded growth
 * Example:
 *   import { DEFAULT_CACHE_MAX_KEYS } from './Defaults'
 *   const cache = new LRUCache({ max: DEFAULT_CACHE_MAX_KEYS.SIGNAL_STORE })
 */
export const DEFAULT_CACHE_MAX_KEYS = {
	SIGNAL_STORE: 10_000,
	MSG_RETRY: 10_000,
	CALL_OFFER: 500,
	USER_DEVICES: 5_000,
	PLACEHOLDER_RESEND: 5_000,
	LID_PER_SOCKET: 2_000,
	LID_GLOBAL: 10_000,
	// Per-socket Meta AI / FBID bot message-secret cache. One key per outgoing
	// bot-conversation message — 500 covers heavy users without unbounded growth.
	// Upstream PR #2592 uses an unbounded module-global Map (cubic P1, coderabbit Major).
	MSMSG_SECRET: 500
}

/**
 * Session cleanup configuration - removes inactive/orphaned Signal sessions
 * Prevents unbounded database growth while maintaining security
 *
 * Environment variables:
 * - BAILEYS_SESSION_CLEANUP_ENABLED: Enable/disable cleanup (default: true)
 * - BAILEYS_SESSION_CLEANUP_INTERVAL: Cleanup interval in ms (default: 24h)
 * - BAILEYS_SESSION_CLEANUP_HOUR: Hour to run cleanup (default: 3 = 3am)
 * - BAILEYS_SESSION_SECONDARY_INACTIVE_DAYS: Days before cleaning secondary devices (default: 7)
 * - BAILEYS_SESSION_PRIMARY_INACTIVE_DAYS: Days before cleaning primary device (default: 30)
 * - BAILEYS_SESSION_LID_ORPHAN_HOURS: Hours before cleaning orphaned LID sessions (default: 24)
 * - BAILEYS_SESSION_CLEANUP_ON_STARTUP: Run cleanup immediately on startup (default: true)
 * - BAILEYS_SESSION_AUTO_CLEAN_CORRUPTED: Auto-delete corrupted sessions (Bad MAC) (default: true)
 */
/**
 * Parse an integer env var with a fallback if the value is missing, empty
 * or non-numeric. Bare `parseInt(envVar || 'N', 10)` returns `NaN` when
 * the var is set to something non-numeric (e.g. "24h", "true") because
 * `'24h' || 'N'` is truthy — and downstream `setInterval(NaN)` is clamped
 * by Node to 1 ms, producing a runaway cleanup loop that pegs the event
 * loop. (audit P1-DEF-01)
 */
// `min` defaults to 1 so that zero is rejected for intervals/days (which
// would produce the same runaway loop as NaN). Pass min=0 for `cleanupHour`
// where midnight (0) is a valid, intentional value.
const intFromEnv = (raw: string | undefined, fallback: number, min = 1): number => {
	if (!raw) return fallback
	// Use Number() instead of parseInt() so values like "24h" yield NaN
	// instead of 24. parseInt("24h", 10) === 24 would silently accept
	// malformed input and schedule cleanup every 24ms. (audit P2-DEF-03)
	const n = Number(raw.trim())
	return Number.isInteger(n) && n >= min ? n : fallback
}

export const DEFAULT_SESSION_CLEANUP_CONFIG = {
	enabled: process.env.BAILEYS_SESSION_CLEANUP_ENABLED !== 'false',
	intervalMs: intFromEnv(process.env.BAILEYS_SESSION_CLEANUP_INTERVAL, 86_400_000), // 24h
	cleanupHour: intFromEnv(process.env.BAILEYS_SESSION_CLEANUP_HOUR, 3, 0), // 3am; 0 = midnight
	secondaryDeviceInactiveDays: intFromEnv(process.env.BAILEYS_SESSION_SECONDARY_INACTIVE_DAYS, 7),
	primaryDeviceInactiveDays: intFromEnv(process.env.BAILEYS_SESSION_PRIMARY_INACTIVE_DAYS, 30),
	lidOrphanHours: intFromEnv(process.env.BAILEYS_SESSION_LID_ORPHAN_HOURS, 24),
	cleanupOnStartup: process.env.BAILEYS_SESSION_CLEANUP_ON_STARTUP !== 'false',
	autoCleanCorrupted: process.env.BAILEYS_SESSION_AUTO_CLEAN_CORRUPTED !== 'false'
}

// Re-export retry constants for backwards compatibility
// Actual definitions are in retry-utils.ts to avoid ESM initialization order issues
export { RETRY_BACKOFF_DELAYS, RETRY_JITTER_FACTOR } from '../Utils/retry-utils'

// ============================================
// Time Constants
// ============================================

/**
 * Time constants in milliseconds for various timing calculations.
 * Used by unified session, rate limiting, and other time-based features.
 *
 * @example
 * ```typescript
 * import { TimeMs } from './Defaults'
 *
 * // Calculate 3 days in milliseconds
 * const threeDays = 3 * TimeMs.Day
 *
 * // Check if 1 week has passed
 * if (Date.now() - lastUpdate > TimeMs.Week) {
 *   // do something
 * }
 * ```
 */
export const TimeMs = {
	/** One second in milliseconds (1,000) */
	Second: 1_000,
	/** One minute in milliseconds (60,000) */
	Minute: 60_000,
	/** One hour in milliseconds (3,600,000) */
	Hour: 3_600_000,
	/** One day in milliseconds (86,400,000) */
	Day: 86_400_000,
	/** One week in milliseconds (604,800,000) */
	Week: 604_800_000
} as const

export type TimeMsKey = keyof typeof TimeMs
