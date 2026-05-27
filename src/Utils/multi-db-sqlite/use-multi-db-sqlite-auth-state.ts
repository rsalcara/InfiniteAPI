import { proto } from '../../../WAProto/index.js'
import type { AuthenticationCreds, AuthenticationState, SignalDataSet, SignalDataTypeMap } from '../../Types'
import { initAuthCreds } from '../auth-utils'
import { BufferJSON } from '../generics'
import type { ILogger } from '../logger'
import { MultiDbSqliteStore, type MultiDbSqliteStoreOptions } from './store'

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
}

/**
 * Multi-DB authentication state for Baileys.
 *
 * Same API as `useMultiFileAuthState` / `useSqliteAuthState`, but the
 * underlying persistence is split across 13 physical SQLite files, one per
 * concern (creds, axolotl, msgstore, wa, sync, media, companion_devices,
 * chatsettings, location, payments, stickers, smb, prometheus):
 *
 *   sessionDir/
 *     creds.db        — auth credentials (the `app_state_sync_keys` table
 *                       is reserved for a later phase; v1 still routes
 *                       `app-state-sync-key` to axolotl.signal_kv)
 *     axolotl.db      — Signal Protocol (opaque `signal_kv` in v1; typed
 *                       tables reserved for phase 9.5 integration)
 *     msgstore.db     — JID routing, device cache, quarantine, retry counters
 *                       (schemas reserved for phases 9.1–9.4)
 *     wa.db           — contacts + TC tokens (schemas reserved for phase 9.6)
 *     sync.db         — app-state sync (schemas reserved for phase 9.7)
 *     prometheus.db   — metrics history; isolated so high-frequency writes
 *                       never contend with the message-send hot path
 *
 * **v1 contract:** behaves exactly like `useSqliteAuthState` — auth creds
 * in `creds.db`, signal data in `axolotl.db.signal_kv` (opaque, JSON-encoded
 * via BufferJSON). The msgstore/wa/sync DB files are created with their
 * schemas but their typed tables remain empty until the corresponding
 * follow-up phases route the respective components to them.
 *
 * Why open all 13 files up front instead of lazily? Disk allocation + WAL
 * checkpointing both have one-time costs; doing them at startup means the
 * first message flow doesn't pay them. The cost is ~200 KB per session
 * for empty WAL files (13 files × ~15 KB each) — negligible.
 */
export async function useMultiDbSqliteAuthState(opts: UseMultiDbSqliteAuthStateOptions): Promise<{
	state: AuthenticationState
	saveCreds: () => Promise<void>
	close: () => void
	/** Exposed for advanced consumers and the upcoming phase 9.1+ integrations. */
	store: MultiDbSqliteStore
}> {
	// Reuse an injected store when supplied; otherwise open our own. The
	// injected-store path lets a single MultiDbSqliteStore be shared with
	// `SocketConfig.multiDbStore` and with cache adapters, eliminating the
	// duplicate 13-handle open the quick-start docs previously showed.
	const ownsStore = !opts.store
	const store = ownsStore ? new MultiDbSqliteStore(opts) : (opts.store as MultiDbSqliteStore)

	let creds: AuthenticationCreds
	let credsStmts: ReturnType<typeof prepareCredsStatements>
	let signalStmts: ReturnType<typeof prepareSignalStatements>

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
		creds = loadCreds(credsStmts, opts.logger)
	} catch (err) {
		// Only close the store if WE opened it — injected stores belong to
		// the caller.
		if (ownsStore) store.close()
		throw err
	}

	const persistCreds = (): void => {
		credsStmts.upsert.run(CREDS_ROW_KEY, JSON.stringify(creds, BufferJSON.replacer), Date.now())
	}

	const applySetTx = store.handle('axolotl.db').transaction((data: SignalDataSet) => {
		for (const category in data) {
			const type = category as keyof SignalDataTypeMap
			const bucket = data[type]
			if (!bucket) continue
			for (const id in bucket) {
				const value = bucket[id]
				if (value === null || value === undefined) {
					signalStmts.del.run(type, id)
				} else {
					signalStmts.upsert.run(type, id, JSON.stringify(value, BufferJSON.replacer))
				}
			}
		}
	})

	const runSetWithBusyRetry = async (data: SignalDataSet): Promise<void> => {
		let lastError: unknown
		for (let attempt = 0; attempt < MAX_BUSY_ATTEMPTS; attempt++) {
			try {
				applySetTx.immediate(data)
				return
			} catch (err) {
				const code = (err as { code?: string } | null)?.code
				if (code !== 'SQLITE_BUSY' && code !== 'SQLITE_BUSY_SNAPSHOT') throw err
				lastError = err
				const jitter = 0.5 + Math.random()
				const delay = Math.floor(BUSY_RETRY_BASE_MS * Math.pow(2, attempt) * jitter)
				opts.logger?.warn?.({ attempt: attempt + 1, delay, code }, 'multi-db-sqlite: SQLITE_BUSY, retrying')
				await sleep(delay)
			}
		}

		throw lastError
	}

	const state: AuthenticationState = {
		creds,
		keys: {
			get: async (type, ids) => {
				const out: { [_: string]: SignalDataTypeMap[typeof type] } = {}
				for (const id of ids) {
					const row = signalStmts.select.get(type, id) as { value: string } | undefined
					if (!row) continue
					let parsed = JSON.parse(row.value, BufferJSON.reviver)
					if (type === 'app-state-sync-key' && parsed) {
						parsed = proto.Message.AppStateSyncKeyData.fromObject(parsed)
					}

					out[id] = parsed as SignalDataTypeMap[typeof type]
				}

				return out
			},
			set: async data => {
				await runSetWithBusyRetry(data)
			},
			clear: async () => {
				signalStmts.clear.run()
				// LID mappings now live in msgstore.db.jid_map (phase 9.1),
				// not in signal_kv. A reset/wipe that only nukes signal_kv
				// would leave the LID↔PN mappings behind, which can cause
				// the LIDMappingStore (in-RAM LRU + retry) to surface
				// stale resolutions for previously-known contacts after a
				// "clear all keys" event.
				//
				// Only `jid_map` is cleared here — NOT the shared `jid` table.
				// Other msgstore tables (`user_device.user_jid_row_id`,
				// `user_device_info.user_jid_row_id`, `message_orphaned_edit.
				// chat_row_id`, etc.) hold row-id references into `jid`, and
				// deleting `jid` rows would orphan them into an inconsistent
				// state. The `jid` rows are cheap to keep — they're only
				// addresses, not session material — and are reused naturally
				// by the next `LIDMappingStore.storeMapping()` call that
				// resolves to the same raw_string.
				const msgstoreDb = store.handle('msgstore.db')
				msgstoreDb.exec('DELETE FROM jid_map;')
			},
			list: async function* <T extends keyof SignalDataTypeMap>(
				type: T
			): AsyncIterable<readonly [string, SignalDataTypeMap[T]]> {
				for (const row of signalStmts.list.iterate(type) as Iterable<{ id: string; value: string }>) {
					// eslint-disable-next-line @typescript-eslint/no-explicit-any
					let value: any = JSON.parse(row.value, BufferJSON.reviver)
					if (type === 'app-state-sync-key' && value) {
						value = proto.Message.AppStateSyncKeyData.fromObject(value)
					}

					yield [row.id, value as SignalDataTypeMap[T]] as const
				}
			},
			listIds: async function* <T extends keyof SignalDataTypeMap>(type: T): AsyncIterable<string> {
				for (const row of signalStmts.listIds.iterate(type) as Iterable<{ id: string }>) {
					yield row.id
				}
			}
		}
	}

	return {
		state,
		saveCreds: async () => {
			persistCreds()
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
