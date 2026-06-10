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
			for (const key of Object.keys(lidMappingBucket)) {
				if (key.endsWith(REVERSE_SUFFIX)) continue
				const pnUser = key
				const lidUser = lidMappingBucket[key] as unknown as string | null
				if (lidUser === null || lidUser === undefined) {
					// Forward delete request. We need a LID to identify the row;
					// look up the current mapping so the delete actually lands.
					const currentLid = jidMap.getLidForPn(pnUser)
					if (currentLid) deletes.push(currentLid)
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
