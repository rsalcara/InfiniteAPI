/**
 * Factories that wire existing in-memory components onto the
 * multi-DB SQLite backend. Each factory preserves the component's public
 * API and InfiniteAPI customizations (cache coalescing, retry, metrics,
 * grace periods, etc.) — only the persistence layer is rerouted.
 *
 * Why factories and not constructor-level options? The existing components
 * (`LIDMappingStore`, `getDevices`, retry caches) ship today with a
 * `SignalKeyStoreWithTransaction`-shaped persistence dependency. Rather
 * than forking each component to add an alternative backend, the factory
 * wraps the inner store with a SQLite-aware proxy and hands the wrapped
 * store to the component unchanged. Zero churn in the component's hot
 * paths.
 */
import { type LIDMappingConfig, LIDMappingStore } from '../../Signal/lid-mapping'
import type { LIDMapping, SignalKeyStoreWithTransaction } from '../../Types'
import type { ILogger } from '../logger'
import { wrapKeysWithJidMap } from './keys-with-jid-map'
import { LidChatStateBackend } from './lid-chat-state-backend'
import { JidMapBackend } from './lid-mapping-backend'
import { MessageQuarantineBackend } from './quarantine-backend'
import type { MultiDbSqliteStore } from './store'

/**
 * Construct a {@link LIDMappingStore} whose persistence is backed by the
 * typed `msgstore.jid_map` table instead of opaque key-value rows.
 *
 * Behavior preserved 1:1 with the legacy constructor:
 *   - LRU cache + coalescing + retry + metrics + statistics all unchanged
 *   - configurable via the same `BAILEYS_LID_*` env vars
 *   - same `pnToLIDFunc` USync fallback
 *
 * Only difference: `keys.get('lid-mapping', ...)` and
 * `keys.set({ 'lid-mapping': ... })` go through the typed jid_map storage,
 * which queries / writes single rows in the canonical `jid` + `jid_map`
 * tables instead of two opaque rows per pair.
 */
export function createLIDMappingStoreWithSqlite(args: {
	innerKeys: SignalKeyStoreWithTransaction
	store: MultiDbSqliteStore
	logger: ILogger
	pnToLIDFunc?: (jids: string[]) => Promise<LIDMapping[] | undefined>
	configOverride?: Partial<LIDMappingConfig>
}): LIDMappingStore {
	const backend = new JidMapBackend(args.store.handle('msgstore.db'))
	// Mirror per-jid LID/PN coexistence state (lid_chat_state.is_pn_shared)
	// through the same wrapper — it sees every mapping-store write and marks the
	// LID whose PN just became known. Shares the jid table with `backend`.
	const lidChatState = new LidChatStateBackend(args.store.handle('msgstore.db'), backend)
	const wrapped = wrapKeysWithJidMap(args.innerKeys, backend, lidChatState)
	return new LIDMappingStore(wrapped, args.logger, args.pnToLIDFunc, args.configOverride)
}

/**
 * Record handed to the quarantine recorder when an inbound
 * stanza's decryption permanently fails (all retries exhausted). Mirrors
 * the canonical WhatsApp Android `msgstore.message_quarantine` columns
 * (`original_protobuf`, `serialized_stanza`) plus the natural key InfiniteAPI
 * uses to dedupe repeat quarantine attempts for the same message
 * (`key_id` + `from_me` + chat/sender JIDs, resolved to row ids below).
 */
export type QuarantineNodeRecord = {
	chatJid: string
	keyId: string
	fromMe: boolean
	senderJid?: string
	originalProtobuf?: Uint8Array
	serializedStanza?: Uint8Array
	failureReason?: string
}

/**
 * Construct the `SocketConfig.onMessageQuarantine` callback backed by the
 * multi-DB SQLite store. Kept as a plain function (not a class) so
 * `decode-wa-message.ts` / `SocketConfig` never need to import anything from
 * `multi-db-sqlite` — the only shape they see is `(record) => void`.
 *
 * Why a fresh `JidMapBackend` here instead of reusing the one
 * `createLIDMappingStoreWithSqlite` already built? That instance lives
 * inside the signal repository and isn't threaded out to the caller. A
 * second `JidMapBackend` against the same `msgstore.db` handle is cheap
 * (its own prepared statements, same underlying tables) and this path only
 * runs on a permanent decrypt failure — nowhere near the per-message hot
 * path.
 */
export function createMessageQuarantineRecorder(args: {
	store: MultiDbSqliteStore
}): (record: QuarantineNodeRecord) => void {
	const db = args.store.handle('msgstore.db')
	const jidBackend = new JidMapBackend(db)
	const quarantineBackend = new MessageQuarantineBackend(db)

	return (record: QuarantineNodeRecord): void => {
		const chatRowId = jidBackend.resolveJidRowId(record.chatJid)
		const senderJidRowId = record.senderJid ? jidBackend.resolveJidRowId(record.senderJid) : undefined

		quarantineBackend.quarantine({
			keyId: record.keyId,
			fromMe: record.fromMe,
			chatRowId,
			senderJidRowId,
			originalProtobuf: record.originalProtobuf,
			serializedStanza: record.serializedStanza,
			failureReason: record.failureReason
		})
	}
}
