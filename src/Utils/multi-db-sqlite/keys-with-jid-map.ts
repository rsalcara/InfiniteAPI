/**
 * Phase 9.1 — `wrapKeysWithJidMap` plugs the typed {@link JidMapBackend}
 * into any `SignalKeyStoreWithTransaction`-shaped store by intercepting
 * the `'lid-mapping'` type.
 *
 * Behavior:
 *   - `get('lid-mapping', ids)` is answered from `jid_map` directly. IDs
 *     ending in `_reverse` are treated as LID-to-PN lookups; others as
 *     PN-to-LID lookups. Other types fall through to the inner store.
 *   - `set({ 'lid-mapping': { ... } })` pairs each `pnUser`/`lidUser_reverse`
 *     entry and writes a single `jid_map` row per pair. Other types fall
 *     through unchanged.
 *   - `clear`, `list`, `listIds`, `transaction`, `transactWith`, `destroy`,
 *     and `isInTransaction` delegate to the inner store unchanged.
 *
 * Why a wrapper and not a fork of `LIDMappingStore`?
 *   The existing `LIDMappingStore` carries InfiniteAPI-specific cache
 *   coalescing, retry logic, statistics, and metrics that we want to keep
 *   intact. Swapping persistence behind it via this wrapper preserves all
 *   of that and lets us introduce typed-table storage without altering
 *   message-routing code paths.
 */
import type { SignalDataSet, SignalDataTypeMap, SignalKeyStoreWithTransaction } from '../../Types'
import { JidMapBackend, REVERSE_SUFFIX, stripReverse } from './lid-mapping-backend'

/**
 * Returns a new store that proxies `inner`, intercepting only the
 * `'lid-mapping'` type.
 *
 * The returned object satisfies the same `SignalKeyStoreWithTransaction`
 * surface as `inner` so it can be used wherever the existing
 * {@link LIDMappingStore} expects a key store.
 */
export function wrapKeysWithJidMap(
	inner: SignalKeyStoreWithTransaction,
	jidMap: JidMapBackend
): SignalKeyStoreWithTransaction {
	return {
		isInTransaction: () => inner.isInTransaction(),
		transaction: (exec, key) => inner.transaction(exec, key),
		transactWith: inner.transactWith ? (scope, work) => inner.transactWith!(scope, work) : undefined,
		destroy: inner.destroy ? () => inner.destroy!() : undefined,
		clear: inner.clear ? () => inner.clear!() : undefined,
		list: inner.list ? inner.list.bind(inner) : undefined,
		listIds: inner.listIds ? inner.listIds.bind(inner) : undefined,

		async get<T extends keyof SignalDataTypeMap>(
			type: T,
			ids: string[]
		): Promise<{ [id: string]: SignalDataTypeMap[T] }> {
			if (type !== 'lid-mapping') {
				return inner.get(type, ids)
			}

			// Split the input batch into PN-direction (no suffix) and
			// LID-direction (`_reverse` suffix) lookups, then do ONE batched
			// SQL query per direction. `LIDMappingStore` defaults
			// batchSize=100 here, so without batching this was N point
			// selects per call — undoing the whole point of the batch read.
			const out: { [id: string]: SignalDataTypeMap[T] } = {}
			const forwardIds: string[] = []
			const reverseLids: string[] = []
			const reverseLookup = new Map<string, string>() // lidUser → original id
			for (const id of ids) {
				const { lidUser, isReverse } = stripReverse(id)
				if (isReverse) {
					reverseLids.push(lidUser)
					reverseLookup.set(lidUser, id)
				} else {
					forwardIds.push(id)
				}
			}

			if (forwardIds.length > 0) {
				const forwardHits = jidMap.batchGetLidForPn(forwardIds)
				for (const pn of forwardIds) {
					const lid = forwardHits[pn]
					if (lid !== undefined) out[pn] = lid as unknown as SignalDataTypeMap[T]
				}
			}

			if (reverseLids.length > 0) {
				const reverseHits = jidMap.batchGetPnForLid(reverseLids)
				for (const lid of reverseLids) {
					const pn = reverseHits[lid]
					if (pn === undefined) continue
					const originalId = reverseLookup.get(lid)
					if (originalId) out[originalId] = pn as unknown as SignalDataTypeMap[T]
				}
			}

			// Fall back to the inner store for any IDs that jid_map did not
			// resolve. This covers sessions migrated from a legacy key store
			// that still have lid-mapping entries under the inner store rather
			// than jid_map — without this, those mappings are invisible until
			// WhatsApp re-emits them.
			const allOriginalIds = [...forwardIds, ...reverseLids.map(lid => reverseLookup.get(lid)!)]
			const missedIds = allOriginalIds.filter(id => out[id] === undefined)
			if (missedIds.length > 0) {
				const legacyHits = await inner.get(type, missedIds)
				for (const id of missedIds) {
					if (legacyHits[id] !== undefined) out[id] = legacyHits[id]
				}
			}

			return out
		},

		async set(data: SignalDataSet): Promise<void> {
			// IMPORTANT — cross-DB transaction caveat (audit MDB-03):
			// `wrapKeysWithJidMap` writes to TWO physical .db files —
			// axolotl.db (signal_kv via `inner.set`) and msgstore.db (jid_map
			// via `jidMap.*`). SQLite does not support a single transaction
			// spanning multiple files; ATTACH could come close but breaks
			// busy-timeout semantics and is incompatible with the per-DB
			// `transaction()` helper better-sqlite3 already wraps each call
			// in. We therefore commit `inner.set` FIRST, then jid_map — the
			// same order documented in `use-multi-db-sqlite-auth-state.ts:clear`.
			// A crash between the two commits leaves jid_map STALE relative
			// to the newer Signal keys; on next session establishment the
			// missing jid_map row is naturally rebuilt by LIDMappingStore.
			// Promoting this to a real distributed-transaction needs a
			// write-ahead log on either side and is out of scope here.
			const lidMappingBucket = data['lid-mapping']
			if (!lidMappingBucket) {
				return inner.set(data)
			}

			// Pair forward + reverse entries by stripping the `_reverse`
			// suffix and matching against the unsuffixed entry. Anything
			// unpaired is stored as a single direction (forward implies
			// inserting only the PN→LID side; reverse implies the LID→PN
			// side without a confirmed forward pair).
			const pairs: Array<{ pnUser: string; lidUser: string }> = []
			const forwardOnly: Array<{ pnUser: string; lidUser: string }> = []
			const reverseOnly: Array<{ pnUser: string; lidUser: string }> = []
			// Deletes — `null`/`undefined` value is the Signal protocol's
			// delete sentinel. Previously these were silently `continue`d,
			// leaving stale `jid_map` rows that pointed at sessions that no
			// longer existed. (audit P1-SQDB-02)
			const deletes: string[] = []

			const seenReverse = new Set<string>()
			// Track which entries in the inner store ALSO need a delete request
			// — used below to propagate the null sentinel down so legacy entries
			// that landed in the inner store (pre-Phase-9) don't resurrect via
			// the `inner.get` fallback. (audit MDB-02)
			const innerDeleteForward: string[] = []
			const innerDeleteReverse: string[] = []
			for (const key of Object.keys(lidMappingBucket)) {
				if (key.endsWith(REVERSE_SUFFIX)) continue
				const pnUser = key
				const lidUser = lidMappingBucket[key] as unknown as string | null
				if (lidUser === null || lidUser === undefined) {
					// Forward delete request. WhatsApp can link multiple device-
					// LIDs to one PN over time, so `getLidForPn` returning the
					// most-recent isn't enough — N-1 historic LIDs would still
					// be visible via batchGetPnForLid. Wipe them all.
					// (audit MDB-01)
					const allLids = jidMap.getAllLidsForPn(pnUser)
					for (const l of allLids) {
						deletes.push(l)
						// Also propagate the corresponding `_reverse` delete to
						// the inner store — without this, a legacy reverse
						// mapping `${lid}_reverse → pnUser` left behind in the
						// inner store would re-surface (and point at the
						// just-deleted PN) on the next `getKey` fallback.
						// (audit thread 12)
						innerDeleteReverse.push(l + REVERSE_SUFFIX)
					}

					innerDeleteForward.push(pnUser)
					continue
				}

				const reverseKey = lidUser + REVERSE_SUFFIX
				const reverseVal = lidMappingBucket[reverseKey] as unknown as string | null
				if (reverseVal === pnUser) {
					pairs.push({ pnUser, lidUser })
					seenReverse.add(reverseKey)
				} else {
					forwardOnly.push({ pnUser, lidUser })
				}
			}

			for (const key of Object.keys(lidMappingBucket)) {
				if (!key.endsWith(REVERSE_SUFFIX) || seenReverse.has(key)) continue
				const lidUser = key.slice(0, -REVERSE_SUFFIX.length)
				const pnUser = lidMappingBucket[key] as unknown as string | null
				if (pnUser === null || pnUser === undefined) {
					// Reverse delete — keyed by LID directly.
					deletes.push(lidUser)
					innerDeleteReverse.push(key) // include the `_reverse` suffix
					continue
				}

				reverseOnly.push({ pnUser, lidUser })
			}

			// Cross-DB write ordering — see comment in
			// `use-multi-db-sqlite-auth-state.ts:clear` for why this matters.
			// Order chosen here:
			//   1. Forward the rest of `data` to the inner store (axolotl.db).
			//   2. Then write jid_map (msgstore.db).
			// A crash between 1 and 2 leaves jid_map STALE relative to the
			// newer Signal keys. On the next session establishment, the missing
			// `jid_map` row is rebuilt naturally by the LIDMappingStore — no
			// catastrophic loss. The reverse order would leave the Signal keys
			// missing while jid_map still resolves PN→LID, causing decryption
			// failures for those contacts until WhatsApp re-emits the mapping.
			// (audit P1-SQDB-03)
			const rest: SignalDataSet = {}
			let hasRest = false
			for (const t in data) {
				if (t === 'lid-mapping') continue
				;(rest as Record<string, unknown>)[t] = (data as Record<string, unknown>)[t]
				hasRest = true
			}

			// Propagate deletes to the inner store as well — covers legacy
			// lid-mapping entries that landed there before Phase 9 migrated
			// the typed jid_map backend in. Without this they resurrect via
			// `inner.get` fallback. (audit MDB-02)
			if (innerDeleteForward.length > 0 || innerDeleteReverse.length > 0) {
				const lidMappingDeletes: Record<string, null> = {}
				for (const pn of innerDeleteForward) lidMappingDeletes[pn] = null
				for (const reverseKey of innerDeleteReverse) lidMappingDeletes[reverseKey] = null
				;(rest as Record<string, unknown>)['lid-mapping'] = lidMappingDeletes
				hasRest = true
			}

			if (hasRest) await inner.set(rest)

			// Now persist jid_map changes. Wrapped in best-effort try/catch
			// so a transient SQLITE_BUSY on the reverse-only path doesn't
			// crash the caller — the missing mapping rebuilds on the next
			// observed event. (audit P2-SQDB-02)
			try {
				if (deletes.length > 0) {
					for (const lidUser of deletes) jidMap.deleteMapping(lidUser)
				}

				if (pairs.length > 0) jidMap.storeMappingsBatch(pairs)
				for (const m of forwardOnly) jidMap.storeMapping(m.pnUser, m.lidUser)
				for (const m of reverseOnly) jidMap.storeMapping(m.pnUser, m.lidUser)
			} catch (err) {
				// Re-raise SQLITE_BUSY so caller-level retry (e.g.
				// `runSetWithBusyRetry` in `use-multi-db-sqlite-auth-state`)
				// can drive a backoff. Anything else (constraint violation,
				// disk full) is a hard error — let it propagate. (P2-SQDB-01)
				throw err
			}
		}
	} as SignalKeyStoreWithTransaction
}
