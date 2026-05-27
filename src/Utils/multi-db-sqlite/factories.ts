/**
 * Phase 9.1+ — factories that wire existing in-memory components onto the
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
import { JidMapBackend } from './lid-mapping-backend'
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
	const wrapped = wrapKeysWithJidMap(args.innerKeys, backend)
	return new LIDMappingStore(wrapped, args.logger, args.pnToLIDFunc, args.configOverride)
}
