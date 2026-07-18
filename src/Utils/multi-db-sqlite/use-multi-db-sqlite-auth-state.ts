import { proto } from '../../../WAProto/index.js'
import type { AuthenticationCreds, AuthenticationState, SignalDataSet, SignalDataTypeMap } from '../../Types'
import { initAuthCreds } from '../auth-utils'
import { BufferJSON } from '../generics'
import type { ILogger } from '../logger'
import { hasPrekeyDirectDistributionIntent } from '../prekey-direct-distribution'
import { prepareInClause } from './in-statement-cache'
import { JidMapBackend } from './lid-mapping-backend'
import { SignalTypedBackend } from './signal-typed-backend'
import { isMirroredSignalType, mirrorSignalEntry } from './signal-typed-mirror'
import { SignalTypedSourceStore, type TypedSignalType } from './signal-typed-source'
import { MultiDbSqliteStore, type MultiDbSqliteStoreOptions } from './store'
import { TrustedContactsBackend } from './trusted-contacts-backend'

const CREDS_ROW_KEY = '__creds__'
const MAX_BUSY_ATTEMPTS = 5
const BUSY_RETRY_BASE_MS = 25

function sleep(ms: number): Promise<void> {
	return new Promise(resolve => setTimeout(resolve, ms))
}

export type UseMultiDbSqliteAuthStateOptions = MultiDbSqliteStoreOptions & {
	/**
	 * Optional pre-opened {@link MultiDbSqliteStore}. When supplied, the
	 * auth-state adapter reuses this handle set instead of opening a fresh
	 * one against the same `sessionDir`, which avoids duplicate connections
	 * (WAL contention + 2× FD usage) when the caller also passes the same
	 * store to `SocketConfig.multiDbStore` or to a cache adapter.
	 *
	 * Typed as `unknown` to keep the public type free of `better-sqlite3`
	 * references for consumers that don't use SQLite.
	 *
	 * Ownership: when `store` is supplied, the returned `close()` does
	 * NOT close the injected store — the caller retains ownership and is
	 * expected to call `store.close()` itself on shutdown. When `store`
	 * is omitted and the adapter opens its own store, `close()` closes
	 * everything as before.
	 */
	store?: unknown
	/**
	 * Controls whether the typed `axolotl.db` tables (`sessions`/`prekeys`/
	 * `sender_keys`/`identities`) are the PRIMARY read/write surface for the
	 * Signal key store — read on every `keys.get`, written atomically
	 * alongside `signal_kv` on every `keys.set` — the way WhatsApp Android
	 * uses those structured tables instead of an opaque blob.
	 *
	 * **Default `true`** (typed tables authoritative). This is the normal
	 * mode. `signalSourceOfTruth: false` is a KILL SWITCH: it reverts to the
	 * legacy behavior (opaque `signal_kv` authoritative + a best-effort typed
	 * mirror) with no redeploy — kept as an instant escape hatch until the
	 * typed path is proven and `signal_kv` is eventually retired.
	 *
	 * Safe by construction (default mode):
	 *   - `signal_kv` is ALWAYS written in the SAME transaction (both tables
	 *     live in axolotl.db, so the dual-write commits or rolls back as a
	 *     unit — no partial write). It stays the complete superset and the
	 *     guaranteed fallback + rollback target. The typed table may
	 *     legitimately lack a row (an id whose structured key can't be parsed
	 *     is written to signal_kv only), which the read-time fallback covers —
	 *     never a data-losing divergence.
	 *   - `keys.get` reads the typed table first and falls back to `signal_kv`
	 *     on any miss (or an unparseable legacy mirror row), logging the
	 *     fallback for analysis (see the `logger.debug` in `keys.get`). Rows
	 *     written before the typed path existed keep resolving and heal to the
	 *     authoritative format on their next write; the cumulative fallback
	 *     counter should trend to ~0 once a session has fully migrated.
	 *   - `keys.list`/`listIds` operate on `signal_kv` (kept complete by the
	 *     dual-write); `clear()` wipes the typed tables too, so a reset can't
	 *     leave stale key material the typed read would find.
	 */
	signalSourceOfTruth?: boolean
}

/**
 * Multi-DB authentication state for Baileys.
 *
 * Same API as `useMultiFileAuthState` / `useSqliteAuthState`, but the
 * underlying persistence is split across 11 physical SQLite files, one per
 * concern (creds, axolotl, msgstore, wa, sync, media, companion_devices,
 * chatsettings, location, payments, stickers, smb, status):
 *
 *   sessionDir/
 *     creds.db        — auth credentials + `app_state_sync_keys` (the
 *                       decoded app-state-sync-key material routes here,
 *                       not to axolotl.signal_kv — see the migration note
 *                       below)
 *     axolotl.db      — Signal Protocol typed tables for mirrored key types,
 *                       with `signal_kv` retained as compatibility fallback
 *     msgstore.db     — JID routing, device cache, quarantine, retry counters
 *     wa.db           — contacts + TC tokens
 *     sync.db         — app-state sync
 *     status.db       — status feed/viewer mirror + channel-crosspost state
 *
 * **Compatibility contract:** `app-state-sync-key` routes to the typed
 * `creds.db.app_state_sync_keys` table instead of the opaque
 * `axolotl.db.signal_kv` — same JSON-via-BufferJSON encoding as before,
 * just a dedicated table instead of a shared opaque one, since this key
 * material has no analog in WhatsApp Android's own schema to mirror (it's
 * a companion-only concept: the primary phone never needs to persist keys
 * it hands out, so there's nothing to be schema-faithful to here — this is
 * InfiniteAPI's own bookkeeping). Existing rows already sitting in
 * `axolotl.signal_kv` from a prior version are migrated automatically on
 * first `open()` (idempotent — safe to run every startup). Mirrored Signal
 * types use their typed tables as the primary surface when enabled and retain
 * `signal_kv` as an atomic compatibility fallback. The remaining database
 * backends are wired by the socket when `multiDbStore` is configured.
 *
 * Why open all 11 files up front instead of lazily? Disk allocation + WAL
 * checkpointing both have one-time costs; doing them at startup means the
 * first message flow doesn't pay them. The cost is ~195 KB per session
 * for empty WAL files (11 files × ~15 KB each) — negligible.
 */
export async function useMultiDbSqliteAuthState(opts: UseMultiDbSqliteAuthStateOptions): Promise<{
	state: AuthenticationState
	saveCreds: () => Promise<void>
	close: () => void
	/** Exposed for advanced consumers and optional integrations. */
	store: MultiDbSqliteStore
}> {
	// Reuse an injected store when supplied; otherwise open our own. The
	// injected-store path lets a single MultiDbSqliteStore be shared with
	// `SocketConfig.multiDbStore` and with cache adapters, eliminating the
	// duplicate 14-handle open the quick-start docs previously showed.
	const ownsStore = !opts.store
	const store = ownsStore ? new MultiDbSqliteStore(opts) : (opts.store as MultiDbSqliteStore)

	// Default ON: typed tables authoritative. `signalSourceOfTruth: false` is
	// the kill switch back to legacy signal_kv-authoritative mode.
	const sourceOfTruth = opts.signalSourceOfTruth !== false

	// Observability for the typed→signal_kv fallback. `total` counts reads the
	// typed table couldn't serve but signal_kv could (real fallbacks, not
	// plain "key not found"); `legacyUnparseable` is the subset where a typed
	// row existed but wasn't the authoritative BufferJSON format (a pre-typed
	// mirror row). Right after enabling, these climb as existing sessions
	// migrate, then should plateau near 0 — a sustained climb is the signal
	// that something on the typed path is actually failing.
	const signalFallbackStats = { total: 0, legacyUnparseable: 0 }

	let creds: AuthenticationCreds
	let credsStmts: ReturnType<typeof prepareCredsStatements>
	let signalStmts: ReturnType<typeof prepareSignalStatements>
	let appStateSyncKeyStmts: ReturnType<typeof prepareAppStateSyncKeyStatements>
	let signalTypedBackend: SignalTypedBackend
	let signalMirrorJidMap: JidMapBackend
	let signalTypedSource: SignalTypedSourceStore
	// Authoritative (PK-jid) store for TC / "privacy" tokens, in wa.db. When
	// `sourceOfTruth` is on, `'tctoken'` reads/writes route here (signal_kv stays
	// the superset fallback); replaces the signal_kv `__index` enumeration race.
	let trustedContactsBackend: TrustedContactsBackend

	try {
		// store.open() now lives INSIDE the try/catch so any open-time error
		// (mkdir permission denial, bad extraPragma, schema exec failure) still
		// triggers the close() cleanup below — the store's own runOpen()
		// catches partial init internally, but a thrown error past .open()
		// would previously leave the caller with no close() to call.
		//
		// For an injected store the caller has already opened it; calling
		// open() again is a safe no-op (`openInFlight` / `opened` short-
		// circuit), so we still call it to handle the case where the caller
		// passes a fresh-but-unopened store.
		await store.open()
		credsStmts = prepareCredsStatements(store)
		signalStmts = prepareSignalStatements(store)
		appStateSyncKeyStmts = prepareAppStateSyncKeyStatements(store)
		migrateLegacyAppStateSyncKeys(store, opts.logger)
		creds = loadCreds(credsStmts, opts.logger)
		// Typed-table backend for session/pre-key/sender-key/identity-key.
		// In default mode it's the write target for the best-effort mirror
		// (signal-typed-mirror.ts); when `signalSourceOfTruth` is on it backs
		// the authoritative SignalTypedSourceStore below. `signalMirrorJidMap`
		// resolves identity-key jids to `msgstore.db.jid` row ids either way.
		signalTypedBackend = new SignalTypedBackend(store.handle('axolotl.db'))
		signalMirrorJidMap = new JidMapBackend(store.handle('msgstore.db'))
		signalTypedSource = new SignalTypedSourceStore(signalTypedBackend, signalMirrorJidMap, opts.logger)
		trustedContactsBackend = new TrustedContactsBackend(store.handle('wa.db'))
	} catch (err) {
		// Only close the store if WE opened it — injected stores belong to
		// the caller.
		if (ownsStore) store.close()
		throw err
	}

	// Wrap `creds` in a ref so a caller that REASSIGNS `state.creds = newObj`
	// (instead of mutating in place) gets that change persisted by
	// `saveCreds()`. Without this indirection, `persistCreds(creds)` would
	// always serialize the originally-loaded credentials object.
	const credsRef: { current: AuthenticationCreds } = { current: creds }

	// Best-effort mirror of the current signed pre-key into the typed
	// `signed_prekeys` table. WhatsApp Android keeps it there (1 row, the
	// current rotation); the authoritative copy stays in `creds.db`
	// (`creds.signedPreKey`, which the Signal handshake reads directly), so
	// this is introspection parity only — a failure never affects auth
	// persistence. `record` is the same BufferJSON encoding the signal_kv
	// values use, round-trippable. Baileys keeps `keyId` stable (no rotation),
	// so the upsert stays a single row, matching the mobile client.
	const mirrorSignedPrekey = (): void => {
		const sp = credsRef.current?.signedPreKey
		if (!sp || !signalTypedBackend) return
		try {
			const record = Buffer.from(JSON.stringify(sp, BufferJSON.replacer))
			signalTypedBackend.putSignedPrekey(sp.keyId, record, sp.timestampS ? sp.timestampS * 1000 : Date.now())
		} catch (err) {
			opts.logger?.debug?.({ err }, 'multi-db-sqlite: signed_prekeys mirror failed (non-fatal)')
		}
	}

	const persistCreds = (): void => {
		credsStmts.upsert.run(CREDS_ROW_KEY, JSON.stringify(credsRef.current, BufferJSON.replacer), Date.now())
		mirrorSignedPrekey()
	}

	// Initial mirror on load — covers a session that reconnects but never
	// re-saves creds.
	mirrorSignedPrekey()

	// Cached batched `IN (…)` SELECT — see use-sqlite-auth-state.ts for
	// rationale (one round-trip per batched get instead of N).
	const signalGetIn = prepareInClause(
		store.handle('axolotl.db'),
		'SELECT id, value FROM signal_kv WHERE type = ? AND id IN (',
		')'
	)

	// `app-state-sync-key` has its own dedicated table (see the class doc
	// above), so its batched get has no `type =` prefix to bind — hence the
	// separate query/leadingParams shape from `signalGetIn`.
	const appStateSyncKeyGetIn = prepareInClause(
		store.handle('creds.db'),
		'SELECT key_id AS id, value FROM app_state_sync_keys WHERE key_id IN (',
		')'
	)

	// Handles the typed-table side of one `session`/`pre-key`/`sender-key`/
	// `identity-key` write, inside the applySetTx transaction. Extracted from
	// the loop body to keep nesting shallow. `serialized` is null iff delete.
	const writeTypedSignal = (
		type: TypedSignalType,
		id: string,
		value: SignalDataTypeMap[keyof SignalDataTypeMap] | null | undefined,
		serialized: string | null
	): void => {
		// A retry-receipt prekey must be inserted and flagged in the SAME
		// axolotl.db transaction as signal_kv. The KeyPair carries a private
		// WeakSet intent (never serialized) from messages-recv through the auth
		// transaction cache. In authoritative mode, doing both statements here
		// closes the post-commit window where upload self-heal could observe dd=0.
		// Kill-switch mode deliberately falls through to its best-effort mirror;
		// the receipt path verifies/marks that row after commit and omits the key
		// without breaking signal_kv when the mirror is unavailable.
		if (sourceOfTruth && type === 'pre-key' && serialized !== null && hasPrekeyDirectDistributionIntent(value)) {
			signalTypedSource.set(type, id, serialized)
			const prekeyId = Number(id)
			if (!Number.isSafeInteger(prekeyId) || prekeyId < 0) {
				throw new Error(`multi-db-sqlite: invalid direct-distribution prekey id: ${id}`)
			}

			if (!signalTypedBackend.markPrekeyDirectDistribution(prekeyId)) {
				throw new Error(`multi-db-sqlite: direct-distribution prekey row was not persisted: ${id}`)
			}

			return
		}

		if (sourceOfTruth) {
			// Authoritative typed write — same transaction as the signal_kv
			// write, so they can never diverge. On delete, remove the typed row
			// too: reads hit the typed table first, so a surviving row would
			// shadow the delete and resurrect stale key material.
			if (serialized === null) {
				signalTypedSource.del(type, id)
			} else {
				signalTypedSource.set(type, id, serialized)
			}

			return
		}

		// Best-effort introspection mirror — signal_kv stays the authoritative
		// read source; mirrorSignalEntry swallows its own errors and never
		// affects the signal_kv write.
		mirrorSignalEntry(type, id, value as Uint8Array | { public: Uint8Array } | null | undefined, {
			signalTypedBackend,
			jidMapBackend: signalMirrorJidMap,
			logger: opts.logger
		})
	}

	const isTypedSignalValue = (type: TypedSignalType, value: unknown): boolean => {
		const isBytes = (candidate: unknown): boolean => Buffer.isBuffer(candidate) || candidate instanceof Uint8Array
		if (type === 'pre-key') {
			if (!value || typeof value !== 'object' || Array.isArray(value)) return false
			const pair = value as { public?: unknown; private?: unknown }
			return isBytes(pair.public) && isBytes(pair.private)
		}

		return isBytes(value)
	}

	// tctoken values bundle the incoming (token/timestamp) and sent
	// (senderTimestamp/realIssueTimestamp) sides into one KV entry; the relational
	// model splits them across wa_trusted_contacts / wa_trusted_contacts_send
	// (both PK jid). Metadata keys (`__index`, `__prune_ts`) are NOT contact rows
	// — they have no `@` and stay in signal_kv.
	const isTctokenContactKey = (id: string): boolean => id.includes('@')

	// Mirror a bundled tctoken value into the two relational tables. Matches the
	// KV "replace whole value" semantics: a side absent from the new value is
	// cleared, so the tables never keep a stale incoming/sent half.
	const writeTctokenRelational = (id: string, value: SignalDataTypeMap['tctoken'] | null | undefined): void => {
		if (value === null || value === undefined) {
			trustedContactsBackend.deleteIncoming(id)
			trustedContactsBackend.deleteSent(id)
			return
		}

		if (value.token && value.token.length > 0) {
			trustedContactsBackend.setIncoming(id, value.token, value.timestamp ? Number(value.timestamp) : 0)
		} else {
			trustedContactsBackend.deleteIncoming(id)
		}

		if (value.senderTimestamp !== undefined) {
			trustedContactsBackend.setSent(id, value.senderTimestamp, value.realIssueTimestamp ?? 0)
		} else {
			trustedContactsBackend.deleteSent(id)
		}
	}

	// Merge the two relational rows back into the bundled KV shape, or undefined
	// when the contact has neither side (a real miss → signal_kv fallback).
	const readTctokenRelational = (id: string): SignalDataTypeMap['tctoken'] | undefined => {
		const inc = trustedContactsBackend.getIncoming(id)
		const snt = trustedContactsBackend.getSent(id)
		if (!inc && !snt) return undefined
		return {
			token: inc ? inc.token : Buffer.alloc(0),
			timestamp: inc ? String(inc.timestamp) : undefined,
			senderTimestamp: snt ? snt.sentTimestamp : undefined,
			realIssueTimestamp: snt ? snt.realIssueTimestamp : undefined
		}
	}

	const applySetTx = store.handle('axolotl.db').transaction((data: SignalDataSet) => {
		for (const category in data) {
			const type = category as keyof SignalDataTypeMap
			const bucket = data[type]
			if (!bucket) continue
			for (const id in bucket) {
				const value = bucket[id]
				if (type === 'app-state-sync-key') {
					// Routed to creds.db, a DIFFERENT physical file/connection
					// than the axolotl.db transaction this callback runs inside
					// — so this write is not part of that transaction's
					// atomicity and autocommits on its own. Same non-atomic-
					// across-files trade-off already accepted by clear() below;
					// harmless at the write volume app-state-sync-key sees.
					if (value === null || value === undefined) {
						appStateSyncKeyStmts.del.run(id)
					} else {
						appStateSyncKeyStmts.upsert.run(id, JSON.stringify(value, BufferJSON.replacer), Date.now())
					}

					continue
				}

				const isDelete = value === null || value === undefined
				const serialized = isDelete ? null : JSON.stringify(value, BufferJSON.replacer)

				// signal_kv is written in EVERY mode: authoritative by default,
				// and (when sourceOfTruth is on) the atomic fallback/rollback
				// copy alongside the typed write below. Both writes hit the same
				// axolotl.db transaction, so they can never diverge.
				if (isDelete) {
					signalStmts.del.run(type, id)
				} else {
					signalStmts.upsert.run(type, id, serialized!)
				}

				if (isMirroredSignalType(type)) {
					writeTypedSignal(type, id, value, serialized)
				}

				// Authoritative tctoken write to wa.db (PK-jid tables). signal_kv is
				// still written above as the superset fallback. Metadata keys
				// (`__index`/`__prune_ts`) are NOT contacts → signal_kv only. Like the
				// app-state-sync-key write, this hits a DIFFERENT physical file than
				// the axolotl.db transaction, so it autocommits on its own — the same
				// non-atomic-across-files trade-off already accepted here.
				if (sourceOfTruth && type === 'tctoken' && isTctokenContactKey(id)) {
					writeTctokenRelational(id, value as SignalDataTypeMap['tctoken'] | null)
				}
			}
		}
	})

	// Generic SQLITE_BUSY retry helper. Was previously inlined in
	// `runSetWithBusyRetry` only; extracted so `clear()` can use the same
	// jittered-exponential-backoff against the `DELETE FROM jid_map` exec
	// (which previously had no busy retry and would surface SQLITE_BUSY
	// directly to the caller after the 5 s busy_timeout expired).
	const runWithBusyRetry = async (label: string, work: () => void): Promise<void> => {
		let lastError: unknown
		for (let attempt = 0; attempt < MAX_BUSY_ATTEMPTS; attempt++) {
			try {
				work()
				return
			} catch (err) {
				const code = (err as { code?: string } | null)?.code
				if (code !== 'SQLITE_BUSY' && code !== 'SQLITE_BUSY_SNAPSHOT') throw err
				lastError = err
				const jitter = 0.5 + Math.random()
				const delay = Math.floor(BUSY_RETRY_BASE_MS * Math.pow(2, attempt) * jitter)
				opts.logger?.warn?.({ label, attempt: attempt + 1, delay, code }, 'multi-db-sqlite: SQLITE_BUSY, retrying')
				await sleep(delay)
			}
		}

		throw lastError ?? new Error(`runWithBusyRetry(${label}): no attempts were made (MAX_BUSY_ATTEMPTS=0?)`)
	}

	const runSetWithBusyRetry = (data: SignalDataSet): Promise<void> => {
		const nonEmptyTypes = Object.keys(data).filter(type => {
			const bucket = data[type as keyof SignalDataTypeMap]
			return bucket && Object.keys(bucket).length > 0
		})
		if (nonEmptyTypes.includes('app-state-sync-key') && nonEmptyTypes.length > 1) {
			throw new Error(
				`multi-db-sqlite: one keys.set batch cannot mix app-state-sync-key (creds.db) with ${nonEmptyTypes
					.filter(type => type !== 'app-state-sync-key')
					.join(', ')} (axolotl.db); split the batch so each physical database commits independently`
			)
		}

		return runWithBusyRetry('signal_kv set', () => applySetTx.immediate(data))
	}

	const state: AuthenticationState = {
		// Getter/setter pair so `state.creds = newObj` mutations are
		// observed by `saveCreds()` via the shared `credsRef`. Callers that
		// only mutate fields in place (`state.creds.advSecretKey = …`)
		// continue to work too — both paths land on `credsRef.current`.
		get creds() {
			return credsRef.current
		},
		set creds(value: AuthenticationCreds) {
			credsRef.current = value
		},
		keys: {
			get: async (type, ids) => {
				const out: { [_: string]: SignalDataTypeMap[typeof type] } = {}
				if (ids.length === 0) return out

				// `app-state-sync-key` lives in its own creds.db table and needs
				// the AppStateSyncKeyData proto rehydration — kept separate.
				if (type === 'app-state-sync-key') {
					const rows = appStateSyncKeyGetIn.all([], ids) as Array<{ id: string; value: string }>
					for (const row of rows) {
						const parsed = JSON.parse(row.value, BufferJSON.reviver)
						out[row.id] = (
							parsed ? proto.Message.AppStateSyncKeyData.fromObject(parsed) : parsed
						) as SignalDataTypeMap[typeof type]
					}

					return out
				}

				// tctoken: read the authoritative PK-jid tables first; fall back to
				// signal_kv for metadata keys (`__index`/`__prune_ts`) and for contacts
				// not yet migrated. A backend read error also degrades to signal_kv —
				// never throws to the caller.
				if (sourceOfTruth && type === 'tctoken') {
					const missing: string[] = []
					for (const id of ids) {
						if (!isTctokenContactKey(id)) {
							missing.push(id)
							continue
						}

						let rel: SignalDataTypeMap['tctoken'] | undefined
						try {
							rel = readTctokenRelational(id)
						} catch {
							rel = undefined
						}

						if (rel !== undefined) {
							out[id] = rel as SignalDataTypeMap[typeof type]
						} else {
							missing.push(id)
						}
					}

					if (missing.length > 0) {
						const rows = signalGetIn.all([type], missing) as Array<{ id: string; value: string }>
						for (const row of rows) {
							out[row.id] = JSON.parse(row.value, BufferJSON.reviver) as SignalDataTypeMap[typeof type]
						}
					}

					return out
				}

				// Source-of-truth: read the typed table first, fall back to
				// signal_kv for any id it doesn't have yet (rows written before
				// the flag was enabled). Both stores hold the identical
				// serialized value, so a typed hit and a signal_kv hit are
				// interchangeable — the fallback only covers pre-migration rows.
				//
				// `getMany` batches the typed read into cached, parameter-bounded
				// row-value IN queries (was one point-query per id). Semantics are identical
				// to looping `get` per id — an id absent from the batch result is
				// a miss and resolves via the signal_kv fallback below. (#618/#619)
				if (sourceOfTruth && isMirroredSignalType(type)) {
					const missing: string[] = []
					const unparseableIds = new Set<string>()
					const serializedById = signalTypedSource.getMany(type, ids)
					for (const id of ids) {
						if (!Object.prototype.hasOwnProperty.call(serializedById, id)) {
							missing.push(id)
							continue
						}

						const serialized = serializedById[id]!

						try {
							const parsed = JSON.parse(serialized, BufferJSON.reviver) as unknown
							if (!isTypedSignalValue(type, parsed)) throw new Error('typed row has an invalid runtime shape')
							out[id] = parsed as SignalDataTypeMap[typeof type]
						} catch {
							// A typed row left by the pre-typed best-effort mirror is
							// raw session/sender-key bytes or a public-only pre-key —
							// NOT the BufferJSON string this path expects. Treat the
							// unparseable row as a miss and resolve via signal_kv,
							// which still holds the valid value; the row heals to the
							// authoritative format on its next write.
							unparseableIds.add(id)
							missing.push(id)
						}
					}

					if (missing.length > 0) {
						const rows = signalGetIn.all([type], missing) as Array<{ id: string; value: string }>
						for (const row of rows) {
							out[row.id] = JSON.parse(row.value, BufferJSON.reviver) as SignalDataTypeMap[typeof type]
						}

						// Only rows signal_kv actually served count as a real
						// fallback (the typed table lacked a value the legacy store
						// had). An id absent from BOTH is just "not found", not a
						// fallback — don't inflate the counter with it. `legacyServed`
						// is the subset of served fallbacks whose typed row existed
						// but was unparseable, so it's always ≤ servedByLegacy.
						if (rows.length > 0) {
							const legacyServed = rows.reduce((n, row) => (unparseableIds.has(row.id) ? n + 1 : n), 0)
							signalFallbackStats.total += rows.length
							signalFallbackStats.legacyUnparseable += legacyServed
							opts.logger?.debug?.(
								{
									type,
									servedByLegacy: rows.length,
									legacyUnparseable: legacyServed,
									cumulativeFallbacks: signalFallbackStats.total,
									cumulativeLegacyUnparseable: signalFallbackStats.legacyUnparseable
								},
								'multi-db-sqlite: typed signal read fell back to signal_kv'
							)
						}
					}

					return out
				}

				const rows = signalGetIn.all([type], ids) as Array<{ id: string; value: string }>
				for (const row of rows) {
					out[row.id] = JSON.parse(row.value, BufferJSON.reviver) as SignalDataTypeMap[typeof type]
				}

				return out
			},
			set: async data => {
				await runSetWithBusyRetry(data)
			},
			clear: async () => {
				// Order matters here because cross-file transactions are NOT
				// ACID in SQLite — `clear()` writes to two physical .db files
				// (axolotl.db.signal_kv + msgstore.db.jid_map). If the
				// process crashes between the two DELETEs, the partially-
				// completed state must be RECOVERABLE on the next startup.
				//
				// We clear `jid_map` FIRST. If we crash now:
				//   - msgstore.jid_map is empty (no stale LID mappings)
				//   - axolotl.signal_kv still has Signal keys
				//   - on next start, `initAuthCreds()` only runs when creds.db
				//     is empty, so existing creds are loaded; the leftover
				//     Signal keys in signal_kv will be naturally overwritten
				//     by the next session establishment. NOT catastrophic.
				//
				// If we cleared `signal_kv` first and crashed:
				//   - axolotl.signal_kv is empty (Signal session lost)
				//   - msgstore.jid_map STILL has LID mappings pointing at the
				//     old session — `LIDMappingStore` would resolve contacts
				//     to LIDs whose sessions no longer exist, breaking
				//     encryption for those contacts until a fresh
				//     `storeMapping()` overwrites them.
				//
				// Only `jid_map` is cleared, NOT the shared `jid` table:
				// other msgstore tables (`user_device.user_jid_row_id`,
				// `user_device_info.user_jid_row_id`,
				// `message_orphaned_edit.chat_row_id`) hold row-id
				// references into `jid`. Deleting `jid` rows would orphan
				// them. `jid` rows are reused naturally by the next
				// `LIDMappingStore.storeMapping()` resolve on the same
				// raw_string.
				const msgstoreDb = store.handle('msgstore.db')
				// Wrap both DELETEs in the same busy-retry helper as
				// `runSetWithBusyRetry`. Without it, `exec('DELETE FROM
				// jid_map')` raised SQLITE_BUSY directly to the caller after
				// the 5 s busy_timeout expired — under contention pressure
				// (e.g. cleanup raced with a hot LIDMappingStore write) the
				// session reset would abort and the caller usually doesn't
				// handle the error. The two DELETEs are still issued in the
				// documented order so the partial-crash recovery semantics
				// above hold.
				await runWithBusyRetry('clear', () => {
					msgstoreDb.exec('DELETE FROM jid_map;')
					signalStmts.clear.run()
					appStateSyncKeyStmts.clear.run()
					// The typed Signal tables must be wiped too. In
					// `signalSourceOfTruth` mode `keys.get` reads them BEFORE
					// signal_kv, so a surviving row would resurrect key material
					// this clear() was meant to erase. Cleared unconditionally
					// (harmless when the flag is off — the mirror also populates
					// these tables, and a leftover mirror row after a reset is
					// equally undesirable). All four live in axolotl.db.
					const axolotlDb = store.handle('axolotl.db')
					axolotlDb.exec('DELETE FROM sessions; DELETE FROM prekeys; DELETE FROM sender_keys; DELETE FROM identities;')
					// tctoken authoritative tables live in wa.db — wipe them too so a
					// reset can't resurrect trusted-contact tokens via the tctoken read
					// path (which hits these before the signal_kv fallback).
					store.handle('wa.db').exec('DELETE FROM wa_trusted_contacts; DELETE FROM wa_trusted_contacts_send;')
				})
			},
			list: async function* <T extends keyof SignalDataTypeMap>(
				type: T
			): AsyncIterable<readonly [string, SignalDataTypeMap[T]]> {
				const rows =
					type === 'app-state-sync-key'
						? (appStateSyncKeyStmts.list.iterate() as Iterable<{ id: string; value: string }>)
						: (signalStmts.list.iterate(type) as Iterable<{ id: string; value: string }>)
				for (const row of rows) {
					// eslint-disable-next-line @typescript-eslint/no-explicit-any
					let value: any = JSON.parse(row.value, BufferJSON.reviver)
					if (type === 'app-state-sync-key' && value) {
						value = proto.Message.AppStateSyncKeyData.fromObject(value)
					}

					yield [row.id, value as SignalDataTypeMap[T]] as const
				}
			},
			listIds: async function* <T extends keyof SignalDataTypeMap>(type: T): AsyncIterable<string> {
				const rows =
					type === 'app-state-sync-key'
						? (appStateSyncKeyStmts.listIds.iterate() as Iterable<{ id: string }>)
						: (signalStmts.listIds.iterate(type) as Iterable<{ id: string }>)
				for (const row of rows) {
					yield row.id
				}
			}
		}
	}

	return {
		state,
		saveCreds: async () => {
			// Without busy retry, a concurrent write on creds.db (e.g. another
			// connection rotating Noise/prekey state) used to surface
			// SQLITE_BUSY straight up to the caller after the 5 s busy_timeout
			// — and the caller almost never handles it, so rotated credentials
			// were silently lost. (audit P1-SQDB-01)
			await runWithBusyRetry('saveCreds', () => persistCreds())
		},
		close: () => {
			// Injected stores belong to the caller — they call .close()
			// themselves on shutdown. Our close() is a no-op in that case so
			// the caller can keep using the store after the auth-state is
			// torn down (e.g. for cache adapters that share the same store).
			if (ownsStore) store.close()
		},
		store
	}
}

function prepareCredsStatements(store: MultiDbSqliteStore) {
	const db = store.handle('creds.db')
	return {
		select: db.prepare('SELECT value FROM creds WHERE key = ?'),
		upsert: db.prepare(
			'INSERT INTO creds (key, value, updated_at) VALUES (?, ?, ?) ' +
				'ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at'
		)
	}
}

function prepareSignalStatements(store: MultiDbSqliteStore) {
	const db = store.handle('axolotl.db')
	return {
		select: db.prepare('SELECT value FROM signal_kv WHERE type = ? AND id = ?'),
		upsert: db.prepare(
			'INSERT INTO signal_kv (type, id, value) VALUES (?, ?, ?) ' +
				'ON CONFLICT(type, id) DO UPDATE SET value = excluded.value'
		),
		del: db.prepare('DELETE FROM signal_kv WHERE type = ? AND id = ?'),
		listIds: db.prepare('SELECT id FROM signal_kv WHERE type = ?'),
		list: db.prepare('SELECT id, value FROM signal_kv WHERE type = ?'),
		clear: db.prepare('DELETE FROM signal_kv')
	}
}

/**
 * Typed operations on `creds.db.app_state_sync_keys` — the dedicated table
 * `app-state-sync-key` data routes to instead of the opaque
 * `axolotl.db.signal_kv`. Same `key_id`-only shape signal_kv's `(type, id)`
 * key would have had with `type` fixed to `'app-state-sync-key'`, since
 * this table only ever holds that one data type.
 */
function prepareAppStateSyncKeyStatements(store: MultiDbSqliteStore) {
	const db = store.handle('creds.db')
	return {
		select: db.prepare('SELECT value FROM app_state_sync_keys WHERE key_id = ?'),
		upsert: db.prepare(
			'INSERT INTO app_state_sync_keys (key_id, value, created_at) VALUES (?, ?, ?) ' +
				'ON CONFLICT(key_id) DO UPDATE SET value = excluded.value, created_at = excluded.created_at'
		),
		del: db.prepare('DELETE FROM app_state_sync_keys WHERE key_id = ?'),
		listIds: db.prepare('SELECT key_id AS id FROM app_state_sync_keys'),
		list: db.prepare('SELECT key_id AS id, value FROM app_state_sync_keys'),
		clear: db.prepare('DELETE FROM app_state_sync_keys')
	}
}

/**
 * One-time (per open()) migration of `app-state-sync-key` rows a prior
 * version of this adapter left in the opaque `axolotl.db.signal_kv` table
 * into the dedicated `creds.db.app_state_sync_keys` table. Idempotent: a
 * session with nothing left to migrate does one cheap SELECT and returns.
 *
 * Insert-then-delete ordering matters for crash safety, same reasoning as
 * `clear()`'s jid_map/signal_kv ordering below: if the process dies between
 * the two steps, the legacy rows are still in signal_kv (nothing lost) and
 * this function simply runs again — and does nothing extra — on the next
 * open() because the upsert is idempotent.
 */
function migrateLegacyAppStateSyncKeys(store: MultiDbSqliteStore, logger: ILogger | undefined): void {
	const axolotlDb = store.handle('axolotl.db')
	const legacyRows = axolotlDb
		.prepare("SELECT id, value FROM signal_kv WHERE type = 'app-state-sync-key'")
		.all() as Array<{ id: string; value: string }>
	if (legacyRows.length === 0) return

	const credsDb = store.handle('creds.db')
	const upsert = credsDb.prepare(
		'INSERT INTO app_state_sync_keys (key_id, value, created_at) VALUES (?, ?, ?) ' +
			'ON CONFLICT(key_id) DO UPDATE SET value = excluded.value, created_at = excluded.created_at'
	)
	const now = Date.now()
	for (const row of legacyRows) upsert.run(row.id, row.value, now)

	axolotlDb.prepare("DELETE FROM signal_kv WHERE type = 'app-state-sync-key'").run()
	logger?.info?.(
		{ count: legacyRows.length },
		'multi-db-sqlite: migrated app-state-sync-key rows from axolotl.signal_kv to creds.app_state_sync_keys'
	)
}

function loadCreds(stmts: ReturnType<typeof prepareCredsStatements>, logger: ILogger | undefined): AuthenticationCreds {
	const row = stmts.select.get(CREDS_ROW_KEY) as { value: string } | undefined
	if (!row) {
		logger?.info?.('multi-db-sqlite: creds.db empty, initializing fresh credentials')
		return initAuthCreds()
	}

	try {
		return JSON.parse(row.value, BufferJSON.reviver) as AuthenticationCreds
	} catch (cause) {
		const error = new Error(`multi-db-sqlite creds row is corrupt (key=${CREDS_ROW_KEY})`)
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		;(error as any).cause = cause
		throw error
	}
}
