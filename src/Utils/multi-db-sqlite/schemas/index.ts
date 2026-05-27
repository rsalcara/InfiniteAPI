export { AXOLOTL_SCHEMA } from './axolotl'
export { CREDS_SCHEMA } from './creds'
export { MSGSTORE_SCHEMA } from './msgstore'
export { SYNC_SCHEMA } from './sync'
export { WA_SCHEMA } from './wa'

import { AXOLOTL_SCHEMA } from './axolotl'
import { CREDS_SCHEMA } from './creds'
import { MSGSTORE_SCHEMA } from './msgstore'
import { SYNC_SCHEMA } from './sync'
import { WA_SCHEMA } from './wa'

/**
 * The five physical SQLite files we open in multi-DB mode, one per concern
 * (auth credentials, Signal Protocol, message routing, contacts/biz state,
 * app-state sync).
 */
export const MULTI_DB_FILES = ['creds.db', 'axolotl.db', 'msgstore.db', 'wa.db', 'sync.db'] as const

export type MultiDbFile = (typeof MULTI_DB_FILES)[number]

export const SCHEMAS: Record<MultiDbFile, string> = {
	'creds.db': CREDS_SCHEMA,
	'axolotl.db': AXOLOTL_SCHEMA,
	'msgstore.db': MSGSTORE_SCHEMA,
	'wa.db': WA_SCHEMA,
	'sync.db': SYNC_SCHEMA
}
