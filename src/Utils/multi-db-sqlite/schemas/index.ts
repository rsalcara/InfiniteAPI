export { AXOLOTL_SCHEMA } from './axolotl'
export { CHATSETTINGS_SCHEMA } from './chatsettings'
export { COMPANION_DEVICES_SCHEMA } from './companion-devices'
export { CREDS_SCHEMA } from './creds'
export { LOCATION_SCHEMA } from './location'
export { MEDIA_SCHEMA } from './media'
export { MSGSTORE_SCHEMA } from './msgstore'
export { PAYMENTS_SCHEMA } from './payments'
export { PROMETHEUS_SCHEMA } from './prometheus'
export { SMB_SCHEMA } from './smb'
export { STICKERS_SCHEMA } from './stickers'
export { SYNC_SCHEMA } from './sync'
export { WA_SCHEMA } from './wa'

import { AXOLOTL_SCHEMA } from './axolotl'
import { CHATSETTINGS_SCHEMA } from './chatsettings'
import { COMPANION_DEVICES_SCHEMA } from './companion-devices'
import { CREDS_SCHEMA } from './creds'
import { LOCATION_SCHEMA } from './location'
import { MEDIA_SCHEMA } from './media'
import { MSGSTORE_SCHEMA } from './msgstore'
import { PAYMENTS_SCHEMA } from './payments'
import { PROMETHEUS_SCHEMA } from './prometheus'
import { SMB_SCHEMA } from './smb'
import { STICKERS_SCHEMA } from './stickers'
import { SYNC_SCHEMA } from './sync'
import { WA_SCHEMA } from './wa'

/**
 * The 13 physical SQLite files we open in multi-DB mode, one per concern:
 *
 *   - `creds.db`             — auth credentials root + app-state sync keys
 *   - `axolotl.db`           — Signal Protocol (sessions, prekeys, identities,
 *                              sender_keys, stanza queues, base keys, kyber
 *                              prekeys, preacks)
 *   - `msgstore.db`          — JID routing, device cache, retry counters,
 *                              quarantine (subset of the canonical mobile
 *                              schema — gateway scope only)
 *   - `wa.db`                — contacts + Trusted Contact tokens
 *   - `sync.db`              — app-state sync mutations + collection versions
 *   - `media.db`             — media metadata + transfer state
 *   - `companion_devices.db` — Multi-Device companion registry
 *   - `chatsettings.db`      — per-chat preferences + notification state
 *   - `location.db`          — live location share state
 *   - `payments.db`          — payment state (consumer + merchant)
 *   - `stickers.db`          — sticker pack catalog and recent state
 *   - `smb.db`               — Small Business / Marketing Messages state
 *   - `prometheus.db`        — observability / metrics history (isolated so
 *                              high-frequency writes never contend with the
 *                              message-send hot path)
 */
export const MULTI_DB_FILES = [
	'creds.db',
	'axolotl.db',
	'msgstore.db',
	'wa.db',
	'sync.db',
	'media.db',
	'companion_devices.db',
	'chatsettings.db',
	'location.db',
	'payments.db',
	'stickers.db',
	'smb.db',
	'prometheus.db'
] as const

export type MultiDbFile = (typeof MULTI_DB_FILES)[number]

export const SCHEMAS: Record<MultiDbFile, string> = {
	'creds.db': CREDS_SCHEMA,
	'axolotl.db': AXOLOTL_SCHEMA,
	'msgstore.db': MSGSTORE_SCHEMA,
	'wa.db': WA_SCHEMA,
	'sync.db': SYNC_SCHEMA,
	'media.db': MEDIA_SCHEMA,
	'companion_devices.db': COMPANION_DEVICES_SCHEMA,
	'chatsettings.db': CHATSETTINGS_SCHEMA,
	'location.db': LOCATION_SCHEMA,
	'payments.db': PAYMENTS_SCHEMA,
	'stickers.db': STICKERS_SCHEMA,
	'smb.db': SMB_SCHEMA,
	'prometheus.db': PROMETHEUS_SCHEMA
}
