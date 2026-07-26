import { proto } from '../../../WAProto/index.js'
import type { AuthenticationCreds, AuthenticationState, SignalDataSet, SignalDataTypeMap } from '../../Types'
import { initAuthCreds } from '../auth-utils'
import { generateSignalPubKey } from '../crypto'
import { BufferJSON } from '../generics'
import type { ILogger } from '../logger'
import { makeMutex } from '../make-mutex'
import { hasPrekeyDirectDistributionIntent } from '../prekey-direct-distribution'
import { prepareInClause } from './in-statement-cache'
import { JidMapBackend } from './lid-mapping-backend'
import { SignalTypedBackend } from './signal-typed-backend'
import { isMirroredSignalType, mirrorSignalEntry } from './signal-typed-mirror'
import { SignalTypedSourceStore, type TypedSignalType } from './signal-typed-source'
import { MultiDbSqliteStore, type MultiDbSqliteStoreOptions } from './store'
import { type TrustedContactReplacement, TrustedContactsBackend } from './trusted-contacts-backend'

const CREDS_ROW_KEY = '__creds__'
const MAX_BUSY_ATTEMPTS = 5
const BUSY_RETRY_BASE_MS = 25
const AUTH_KEYS_ENUM_PAGE_SIZE = 256

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
	 * The same switch gates relational Trusted Contact-token authority: when
	 * disabled, `tctoken` also remains exclusively `signal_kv`-authoritative.
	 *
	 * Safe by construction for typed Signal keys (default mode):
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
	 *
	 * Trusted Contact tokens span `wa.db` and `axolotl.db`, so they cannot use
	 * one SQLite transaction. Their relational value commits first; a mutex,
	 * tombstones, compare-and-prune, and a durable clear marker make crashes and
	 * concurrent refreshes recoverable while `signal_kv` remains the backup.
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
 * `signal_kv` as an atomic compatibility fallback. This adapter also owns the
 * relational Trusted Contact-token capability; other database backends are
 * wired by the socket when `multiDbStore` is configured.
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
	// Global barrier shared by auth-key clear/recovery and every public key
	// operation. The marker now covers all key stores, not only tctoken.
	const authKeysClearMutex = makeMutex()
	let authKeysClearGeneration = 0

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
		// remains required by the other typed mirrors; identities themselves
		// use Android's numeric PN/LID recipient_id and do not reference jid._id.
		signalTypedBackend = new SignalTypedBackend(store.handle('axolotl.db'))
		signalMirrorJidMap = new JidMapBackend(store.handle('msgstore.db'))
		signalTypedSource = new SignalTypedSourceStore(signalTypedBackend, signalMirrorJidMap, opts.logger)
		rehydrateTypedIdentities(store, signalTypedSource, opts.logger)
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

	const mirrorOwnIdentity = (): void => {
		const current = credsRef.current
		if (!current?.signedIdentityKey || !signalTypedBackend) return
		try {
			signalTypedBackend.putOwnIdentity({
				registrationId: current.registrationId,
				publicKey: generateSignalPubKey(current.signedIdentityKey.public),
				privateKey: current.signedIdentityKey.private,
				nextPrekeyId: current.nextPreKeyId
			})
		} catch (err) {
			opts.logger?.debug?.({ err }, 'multi-db-sqlite: local identities row mirror failed (non-fatal)')
		}
	}

	const persistCreds = (): void => {
		credsStmts.upsert.run(CREDS_ROW_KEY, JSON.stringify(credsRef.current, BufferJSON.replacer), Date.now())
		mirrorSignedPrekey()
		mirrorOwnIdentity()
	}

	// Initial mirror on load — covers a session that reconnects but never
	// re-saves creds.
	mirrorSignedPrekey()
	mirrorOwnIdentity()

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
		mirrorSignalEntry(type, id, value as Uint8Array | { public: Uint8Array } | object | null | undefined, {
			signalTypedBackend,
			jidMapBackend: signalMirrorJidMap,
			logger: opts.logger
		})
	}

	const isTypedSignalValue = (type: TypedSignalType, value: unknown): boolean => {
		const isBytes = (candidate: unknown): boolean => Buffer.isBuffer(candidate) || candidate instanceof Uint8Array
		if (type === 'fast-ratchet-sender-key') {
			if (!value || typeof value !== 'object' || Array.isArray(value)) return false
			const state = value as {
				senderKeyId?: unknown
				iteration?: unknown
				chainKeys?: unknown
				signingPublic?: unknown
				signingPrivate?: unknown
			}
			return (
				Number.isSafeInteger(state.senderKeyId) &&
				Number.isSafeInteger(state.iteration) &&
				Array.isArray(state.chainKeys) &&
				state.chainKeys.length === 8 &&
				state.chainKeys.every(isBytes) &&
				isBytes(state.signingPublic) &&
				isBytes(state.signingPrivate)
			)
		}

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

	const finiteNumberOrZero = (value: unknown): number => {
		const parsed = Number(value ?? 0)
		return Number.isFinite(parsed) ? parsed : 0
	}

	const finiteNumberOrNull = (value: unknown): number | null => {
		if (value === null) return null
		return finiteNumberOrZero(value)
	}

	// Build both relational halves for replacement in one wa.db transaction. A fully deleted
	// value leaves an empty-token tombstone: relational reads can distinguish a
	// deliberate delete from a pre-migration miss and therefore never resurrect
	// the stale signal_kv fallback after a cross-file crash.
	const toTctokenRelationalReplacement = (
		value: SignalDataTypeMap['tctoken'] | null | undefined
	): TrustedContactReplacement => {
		if (value === null || value === undefined) {
			return {
				incoming: { token: Buffer.alloc(0), timestamp: 0 },
				sent: null
			}
		}

		const hasIncoming = value.token && value.token.length > 0
		const hasSent = value.senderTimestamp !== undefined
		return {
			incoming: hasIncoming
				? { token: value.token, timestamp: finiteNumberOrZero(value.timestamp) }
				: hasSent
					? null
					: { token: Buffer.alloc(0), timestamp: 0 },
			sent: hasSent
				? {
						sentTimestamp: finiteNumberOrZero(value.senderTimestamp),
						realIssueTimestamp: finiteNumberOrNull(value.realIssueTimestamp)
					}
				: null
		}
	}

	type TctokenRelationalRead =
		| { kind: 'value'; value: SignalDataTypeMap['tctoken'] }
		| { kind: 'tombstone' }
		| { kind: 'miss' }

	// A tombstone is a deliberate authoritative absence and must NOT fall back.
	const readTctokenRelational = (id: string): TctokenRelationalRead => {
		const inc = trustedContactsBackend.getIncoming(id)
		const snt = trustedContactsBackend.getSent(id)
		if (!inc && !snt) return { kind: 'miss' }
		if (inc?.token.length === 0 && !snt) return { kind: 'tombstone' }
		return {
			kind: 'value',
			value: {
				token: inc ? inc.token : Buffer.alloc(0),
				timestamp: inc ? String(inc.timestamp) : undefined,
				senderTimestamp: snt ? snt.sentTimestamp : undefined,
				realIssueTimestamp: snt ? snt.realIssueTimestamp : undefined
			}
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

	const msgstoreDb = store.handle('msgstore.db')
	const axolotlDb = store.handle('axolotl.db')
	const clearAxolotlTx = axolotlDb.transaction(() => {
		signalStmts.clear.run()
		axolotlDb.exec('DELETE FROM sessions; DELETE FROM prekeys; DELETE FROM sender_keys; DELETE FROM identities;')
	}).immediate

	// Every statement is idempotent. The durable marker lives in wa.db and is
	// removed only after all three remaining physical databases complete, so a
	// crash or SQLITE_BUSY at any boundary can safely replay the whole sequence.
	const clearRemainingAuthKeyStores = async (label: string): Promise<void> => {
		await runWithBusyRetry(label, () => {
			msgstoreDb.exec('DELETE FROM jid_map;')
			clearAxolotlTx()
			appStateSyncKeyStmts.clear.run()
		})
	}

	const finishAuthKeysClear = (label: string): Promise<void> =>
		runWithBusyRetry(label, () => trustedContactsBackend.finishClear())

	const recoverPendingAuthKeysClearUnlocked = async (trigger: 'startup' | 'before-access'): Promise<boolean> => {
		if (!trustedContactsBackend.hasPendingClear()) return false
		authKeysClearGeneration++
		try {
			await clearRemainingAuthKeyStores('recover interrupted auth keys clear')
			await finishAuthKeysClear('finish recovered auth keys clear')
			opts.logger?.warn?.(
				{
					reason: 'interrupted-auth-keys-clear',
					trigger,
					recoveredStores: ['wa.db', 'msgstore.db', 'axolotl.db', 'creds.db'],
					markerState: 'cleared'
				},
				'multi-db-sqlite: completed interrupted auth key clear across every participating database'
			)
			return true
		} catch (err) {
			opts.logger?.error?.(
				{
					err,
					reason: 'auth-keys-clear-recovery-failed',
					trigger,
					markerState: 'retained',
					recovery: 'retry-on-next-auth-state-open-or-key-access'
				},
				'multi-db-sqlite: auth key clear recovery failed; refusing partially-cleared state'
			)
			throw err
		}
	}

	const recoverPendingAuthKeysClear = (trigger: 'startup' | 'before-access'): Promise<boolean> =>
		authKeysClearMutex.mutex(() => recoverPendingAuthKeysClearUnlocked(trigger))

	const runSetWithBusyRetryUnlocked = async (data: SignalDataSet): Promise<void> => {
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

		// Commit the authoritative wa.db representation first. If the process dies
		// before signal_kv is updated, reads still see the new relational value. Each
		// bundled value replaces its incoming+sent halves in one wa.db transaction.
		if (sourceOfTruth && data.tctoken) {
			const bucket = data.tctoken
			await runWithBusyRetry('tctoken relational set', () => {
				const replacements: Array<readonly [string, TrustedContactReplacement]> = []
				for (const id in bucket) {
					if (isTctokenContactKey(id)) replacements.push([id, toTctokenRelationalReplacement(bucket[id])])
				}

				trustedContactsBackend.replaceMany(replacements)
			})
		}

		try {
			await runWithBusyRetry('signal_kv set', () => applySetTx.immediate(data))
		} catch (err) {
			if (sourceOfTruth && data.tctoken) {
				opts.logger?.error?.(
					{
						err,
						reason: 'signal-kv-fallback-write-failed',
						authoritativeStore: 'wa.db',
						fallbackStore: 'axolotl.db.signal_kv',
						fallbackState: 'stale-or-missing',
						recovery: 'retry-the-same-keys.set-batch'
					},
					'multi-db-sqlite: tctoken committed to wa.db but its signal_kv fallback failed; retry is required to restore the backup copy'
				)
			}

			throw err
		}

		// A null delete used a relational tombstone as the cross-file handoff.
		// Once signal_kv has durably committed the delete, the tombstone can be
		// removed; a crash before this cleanup is safe because reads recognize it
		// as authoritative absence and never fall back.
		if (sourceOfTruth && data.tctoken) {
			const bucket = data.tctoken
			await runWithBusyRetry('tctoken tombstone cleanup', () => {
				for (const id in bucket) {
					if (isTctokenContactKey(id) && (bucket[id] === null || bucket[id] === undefined)) {
						trustedContactsBackend.deleteIncoming(id)
					}
				}
			})
		}
	}

	const runSetWithBusyRetry = (data: SignalDataSet): Promise<void> =>
		authKeysClearMutex.mutex(async () => {
			await recoverPendingAuthKeysClearUnlocked('before-access')
			await runSetWithBusyRetryUnlocked(data)
		})
	const assertAuthKeyEnumerationGeneration = (expected: number): void => {
		if (expected === authKeysClearGeneration) return
		throw new Error(
			'multi-db-sqlite: auth-key enumeration invalidated by concurrent keys.clear; restart the enumeration'
		)
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
			prekeyUploads: sourceOfTruth
				? {
						authoritative: true,
						reserveUploadRange: (fromId, toId, timestampSec) =>
							signalTypedBackend.reservePrekeyUploadRange(fromId, toId, timestampSec),
						commitUpload: (fromId, toId, timestampSec) =>
							signalTypedBackend.commitPrekeyUpload(fromId, toId, timestampSec),
						countUnsent: () => signalTypedBackend.countUnsentPrekeys(),
						firstUnsentId: () => signalTypedBackend.firstUnsentPrekeyId(),
						nextGeneratedId: () => signalTypedBackend.nextGeneratedPrekeyId(),
						markDirectDistribution: (prekeyId, timestampSec) =>
							signalTypedBackend.markPrekeyDirectDistribution(prekeyId, timestampSec),
						isDirectDistribution: prekeyId => signalTypedBackend.isPrekeyDirectDistribution(prekeyId)
					}
				: undefined,
			trustedContactTokens: sourceOfTruth
				? {
						authoritative: true,
						listIncoming: () => trustedContactsBackend.listIncoming(),
						compareAndPrune: (jid, expectedTimestamp, expectedToken) =>
							authKeysClearMutex.mutex(async () => {
								await recoverPendingAuthKeysClearUnlocked('before-access')
								let current = readTctokenRelational(jid)
								if (current.kind === 'miss') {
									const row = signalStmts.select.get('tctoken', jid) as { value: string } | undefined
									if (!row) return false
									current = {
										kind: 'value',
										value: JSON.parse(row.value, BufferJSON.reviver) as SignalDataTypeMap['tctoken']
									}
								}

								if (
									current.kind !== 'value' ||
									Number(current.value.timestamp ?? 0) !== expectedTimestamp ||
									!Buffer.from(current.value.token).equals(Buffer.from(expectedToken))
								)
									return false
								// Cross-file safe ordering: remove the legacy fallback first,
								// then physically delete the authoritative incoming row. If the
								// process crashes between the two, wa.db still owns the token; the
								// inverse order could expose a stale signal_kv token after a miss.
								await runWithBusyRetry('tctoken prune signal_kv', () => {
									signalStmts.del.run('tctoken', jid)
								})
								await runWithBusyRetry('tctoken prune relational', () => {
									trustedContactsBackend.replace(jid, {
										incoming: null,
										sent:
											current.value.senderTimestamp !== undefined
												? {
														sentTimestamp: finiteNumberOrZero(current.value.senderTimestamp),
														realIssueTimestamp: finiteNumberOrNull(current.value.realIssueTimestamp)
													}
												: null
									})
								})
								return true
							})
					}
				: undefined,
			get: (type, ids) =>
				authKeysClearMutex.mutex(async () => {
					const out: { [_: string]: SignalDataTypeMap[typeof type] } = {}
					if (ids.length === 0) return out
					await recoverPendingAuthKeysClearUnlocked('before-access')

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

					if (!sourceOfTruth && type === 'tctoken') {
						const rows = signalGetIn.all([type], ids) as Array<{ id: string; value: string }>
						for (const row of rows) {
							out[row.id] = JSON.parse(row.value, BufferJSON.reviver) as SignalDataTypeMap[typeof type]
						}

						return out
					}

					// tctoken: read the authoritative PK-jid tables first; fall back to
					// signal_kv for metadata keys (`__index`/`__prune_ts`) and for contacts
					// not yet migrated. An authoritative read error fails closed: the backup
					// may be stale after a cross-file partial write, so only a genuine miss
					// is eligible for legacy fallback.
					if (sourceOfTruth && type === 'tctoken') {
						const missing: string[] = []
						for (const id of ids) {
							if (!isTctokenContactKey(id)) {
								missing.push(id)
								continue
							}

							try {
								const rel = readTctokenRelational(id)
								if (rel.kind === 'value') out[id] = rel.value as SignalDataTypeMap[typeof type]
								if (rel.kind === 'miss') missing.push(id)
								// Tombstone = deliberate absence; never fall back.
							} catch (err) {
								opts.logger?.error?.(
									{
										err,
										id,
										reason: 'authoritative-relational-read-failed',
										fallbackStore: 'signal_kv',
										fallbackUsed: false,
										action: 'tctoken-omitted-fail-closed'
									},
									'multi-db-sqlite: authoritative tctoken read failed; stale signal_kv fallback was rejected and this token was omitted'
								)
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
				}),
			set: async data => {
				await runSetWithBusyRetry(data)
			},
			clear: async () => {
				await authKeysClearMutex.mutex(async () => {
					await recoverPendingAuthKeysClearUnlocked('before-access')
					// wa.db owns the durable intent. Writing it and clearing both token
					// tables is one transaction; every remaining database is replayed
					// idempotently until all key-store surfaces have been cleared.
					trustedContactsBackend.beginClear()
					authKeysClearGeneration++
					// Only `jid_map` is cleared, NOT the shared `jid` table:
					// other msgstore tables (`user_device.user_jid_row_id`,
					// `user_device_info.user_jid_row_id`,
					// `message_orphaned_edit.chat_row_id`) hold row-id
					// references into `jid`. Deleting `jid` rows would orphan
					// them. `jid` rows are reused naturally by the next
					// `LIDMappingStore.storeMapping()` resolve on the same
					// raw_string.
					try {
						await clearRemainingAuthKeyStores('clear auth key stores')
						await finishAuthKeysClear('finish auth keys clear')
					} catch (err) {
						opts.logger?.error?.(
							{
								err,
								reason: 'auth-keys-clear-interrupted',
								markerState: 'retained',
								recovery: 'retry-on-next-auth-state-open-or-key-access'
							},
							'multi-db-sqlite: auth key clear interrupted; durable marker retained for full replay'
						)
						throw err
					}
				})
			},
			list: async function* <T extends keyof SignalDataTypeMap>(
				type: T
			): AsyncIterable<readonly [string, SignalDataTypeMap[T]]> {
				let afterId: string | undefined
				let enumerationGeneration: number | undefined
				while (true) {
					const rows = await authKeysClearMutex.mutex(async () => {
						await recoverPendingAuthKeysClearUnlocked('before-access')
						if (enumerationGeneration === undefined) enumerationGeneration = authKeysClearGeneration
						else assertAuthKeyEnumerationGeneration(enumerationGeneration)

						if (type === 'app-state-sync-key') {
							return (
								afterId === undefined
									? appStateSyncKeyStmts.listFirstPage.all(AUTH_KEYS_ENUM_PAGE_SIZE)
									: appStateSyncKeyStmts.listPageAfter.all(afterId, AUTH_KEYS_ENUM_PAGE_SIZE)
							) as Array<{
								id: string
								value: string
							}>
						}

						return (
							afterId === undefined
								? signalStmts.listFirstPage.all(type, AUTH_KEYS_ENUM_PAGE_SIZE)
								: signalStmts.listPageAfter.all(type, afterId, AUTH_KEYS_ENUM_PAGE_SIZE)
						) as Array<{
							id: string
							value: string
						}>
					})
					const pageGeneration = enumerationGeneration
					if (pageGeneration === undefined) throw new Error('auth-key enumeration generation was not initialized')
					if (rows.length === 0) return

					for (const row of rows) {
						assertAuthKeyEnumerationGeneration(pageGeneration)
						// eslint-disable-next-line @typescript-eslint/no-explicit-any
						let value: any = JSON.parse(row.value, BufferJSON.reviver)
						if (type === 'app-state-sync-key' && value) {
							value = proto.Message.AppStateSyncKeyData.fromObject(value)
						}

						yield [row.id, value as SignalDataTypeMap[T]] as const
					}

					afterId = rows[rows.length - 1]!.id
					if (rows.length < AUTH_KEYS_ENUM_PAGE_SIZE) return
				}
			},
			listIds: async function* <T extends keyof SignalDataTypeMap>(type: T): AsyncIterable<string> {
				let afterId: string | undefined
				let enumerationGeneration: number | undefined
				while (true) {
					const rows = await authKeysClearMutex.mutex(async () => {
						await recoverPendingAuthKeysClearUnlocked('before-access')
						if (enumerationGeneration === undefined) enumerationGeneration = authKeysClearGeneration
						else assertAuthKeyEnumerationGeneration(enumerationGeneration)

						if (type === 'app-state-sync-key') {
							return (
								afterId === undefined
									? appStateSyncKeyStmts.listIdsFirstPage.all(AUTH_KEYS_ENUM_PAGE_SIZE)
									: appStateSyncKeyStmts.listIdsPageAfter.all(afterId, AUTH_KEYS_ENUM_PAGE_SIZE)
							) as Array<{
								id: string
							}>
						}

						return (
							afterId === undefined
								? signalStmts.listIdsFirstPage.all(type, AUTH_KEYS_ENUM_PAGE_SIZE)
								: signalStmts.listIdsPageAfter.all(type, afterId, AUTH_KEYS_ENUM_PAGE_SIZE)
						) as Array<{
							id: string
						}>
					})
					const pageGeneration = enumerationGeneration
					if (pageGeneration === undefined) throw new Error('auth-key enumeration generation was not initialized')
					if (rows.length === 0) return

					for (const row of rows) {
						assertAuthKeyEnumerationGeneration(pageGeneration)
						yield row.id
					}

					afterId = rows[rows.length - 1]!.id
					if (rows.length < AUTH_KEYS_ENUM_PAGE_SIZE) return
				}
			}
		}
	}

	// Do not expose an auth-state whose previous clear completed in only some
	// physical databases. A retained marker makes startup replay every target;
	// persistent failure aborts opening and leaves the marker for the next try.
	try {
		await recoverPendingAuthKeysClear('startup')
	} catch (err) {
		if (ownsStore) store.close()
		throw err
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
		deleteType: db.prepare('DELETE FROM signal_kv WHERE type = ?'),
		listIdsFirstPage: db.prepare('SELECT id FROM signal_kv WHERE type = ? ORDER BY id LIMIT ?'),
		listIdsPageAfter: db.prepare('SELECT id FROM signal_kv WHERE type = ? AND id > ? ORDER BY id LIMIT ?'),
		listFirstPage: db.prepare('SELECT id, value FROM signal_kv WHERE type = ? ORDER BY id LIMIT ?'),
		listPageAfter: db.prepare('SELECT id, value FROM signal_kv WHERE type = ? AND id > ? ORDER BY id LIMIT ?'),
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
		listIdsFirstPage: db.prepare('SELECT key_id AS id FROM app_state_sync_keys ORDER BY key_id LIMIT ?'),
		listIdsPageAfter: db.prepare(
			'SELECT key_id AS id FROM app_state_sync_keys WHERE key_id > ? ORDER BY key_id LIMIT ?'
		),
		listFirstPage: db.prepare('SELECT key_id AS id, value FROM app_state_sync_keys ORDER BY key_id LIMIT ?'),
		listPageAfter: db.prepare(
			'SELECT key_id AS id, value FROM app_state_sync_keys WHERE key_id > ? ORDER BY key_id LIMIT ?'
		),
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

/**
 * Rebuilds corrected Android-shaped identity rows from signal_kv, which stays
 * the complete compatibility copy. This heals the pre-v3 format that keyed
 * recipient_id by msgstore.jid._id and stored BufferJSON text in public_key.
 */
function rehydrateTypedIdentities(
	store: MultiDbSqliteStore,
	typedSource: SignalTypedSourceStore,
	logger: ILogger | undefined
): void {
	const rows = store
		.handle('axolotl.db')
		.prepare("SELECT id, value FROM signal_kv WHERE type = 'identity-key' ORDER BY id")
		.all() as Array<{ id: string; value: string }>
	let repaired = 0
	for (const row of rows) {
		try {
			if (typedSource.get('identity-key', row.id) === row.value) continue
			typedSource.set('identity-key', row.id, row.value)
			repaired++
		} catch (err) {
			logger?.warn?.(
				{ err, id: row.id },
				'multi-db-sqlite: identity-key typed rehydrate failed, signal_kv remains available'
			)
		}
	}

	if (repaired > 0) {
		logger?.info?.(
			{ repaired, scanned: rows.length },
			'multi-db-sqlite: rebuilt Android-shaped identity rows from signal_kv'
		)
	}
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
