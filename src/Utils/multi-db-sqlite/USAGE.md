# multi-db-sqlite — Usage Guide

This guide walks through wiring the multi-DB SQLite layer into an
InfiniteAPI gateway. Every component is opt-in — passing nothing keeps
the legacy in-memory + multi-file behavior.

## Quick start

```typescript
import {
	MultiDbSqliteStore,
	useMultiDbSqliteAuthState,
	UserDeviceCacheSqliteAdapter,
	MsgRetryCounterSqliteAdapter,
	makeWASocket
} from 'baileys'

const sessionDir = '/var/lib/infiniteapi/sessions/main'

// 1) Open ONE MultiDbSqliteStore. All consumers below share these 13 handles —
//    do NOT open the store again inside `useMultiDbSqliteAuthState` or the
//    adapters, or you'll end up with duplicate connections (WAL contention,
//    2× FD usage).
const store = new MultiDbSqliteStore({ sessionDir })
await store.open()

// 2) Auth state — drop-in replacement for useMultiFileAuthState /
//    useSqliteAuthState. Pass the pre-opened `store` so the adapter reuses
//    the same handles instead of opening a second set.
const {
	state,
	saveCreds,
	close: closeAuth
} = await useMultiDbSqliteAuthState({
	sessionDir,
	store
})

// 3) Wire the SocketConfig. Passing `multiDbStore` activates phase 9.1
//    LID mapping persistence via msgstore.jid_map; the cache adapters
//    activate phases 9.2 + 9.3 (they reuse the same `store.handle(...)`).
const sock = makeWASocket({
	auth: state,
	multiDbStore: store,
	userDevicesCache: new UserDeviceCacheSqliteAdapter(store.handle('msgstore.db')),
	msgRetryCounterCache: new MsgRetryCounterSqliteAdapter(store.handle('msgstore.db'))
})

sock.ev.on('creds.update', saveCreds)

// 4) On shutdown: closeAuth() is a no-op because the auth-state does NOT
//    own the injected `store` — the caller does. Call store.close() yourself.
async function shutdown() {
	closeAuth() // no-op when `store` was injected
	store.close()
}
```

That's the supported "one-stop" path. Each component below is also usable
in isolation if you only want part of the multi-DB layer.

## Available components, by phase

### Phase 9.0 — physical layout

| Export                                     | Purpose                                                                                     |
| ------------------------------------------ | ------------------------------------------------------------------------------------------- |
| `MultiDbSqliteStore`                       | Opens / closes 13 `.db` handles with WAL + busy_timeout.                                    |
| `useMultiDbSqliteAuthState`                | `useSqliteAuthState` replacement; creds → `creds.db`, signal data → `axolotl.db.signal_kv`. |
| `MULTI_DB_FILES`, `SCHEMAS`, `MultiDbFile` | The 13 filenames, their schemas, and the union type for `store.handle(...)`.                |

### Phase 9.1 — LID mapping (wired)

| Export                            | Purpose                                                                                                                                    |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `JidMapBackend`                   | Typed `storeMapping` / `getLidForPn` / `getPnForLid` / `storeMappingsBatch`.                                                               |
| `wrapKeysWithJidMap`              | Wraps an inner `SignalKeyStoreWithTransaction` and intercepts `'lid-mapping'`.                                                             |
| `createLIDMappingStoreWithSqlite` | One-call factory that wires `LIDMappingStore` (preserving its LRU cache + coalescing + retry + metrics) onto a `wrapKeysWithJidMap` store. |

Wired automatically when `SocketConfig.multiDbStore` is supplied.

### Phase 9.2 — user devices

| Export                         | Purpose                                                                                     |
| ------------------------------ | ------------------------------------------------------------------------------------------- |
| `UserDeviceBackend`            | Typed `replaceDevices` / `listDevices` / `getInfo` / `isFresh` / `setPrimaryDeviceVersion`. |
| `UserDeviceCacheSqliteAdapter` | `NodeCache`-compat drop-in for `SocketConfig.userDevicesCache` (`get/set/del/mget`).        |

### Phase 9.3 — message retry counters

| Export                         | Purpose                                                                                                      |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------ |
| `MsgRetryCounterSqliteAdapter` | `NodeCache`-compat drop-in for `SocketConfig.msgRetryCounterCache`. Persists retry counters across restarts. |

### Phase 9.4 — Bad MAC quarantine

| Export                     | Purpose                                                                                                                                         |
| -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `MessageQuarantineBackend` | `quarantine` (upsert with retry_count increment on duplicate natural key), `findByKey`, `listByChat`, `listSince`, `dismiss`, `pruneOlderThan`. |

### Phase 9.5 — typed Signal Protocol tables

| Export               | Purpose                                                                                                                  |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `SignalTypedBackend` | Typed accessors for `sessions`, `prekeys`, `signed_prekeys`, `kyber_prekeys`, `identities` (dual LID+PN), `sender_keys`. |

Used by the in-progress libsignal-side integration (phase 9.5.1); the
opaque `axolotl.db.signal_kv` staging table remains primary until that
integration lands.

### Phase 9.6 — Trusted Contact tokens

| Export                   | Purpose                                                                                                     |
| ------------------------ | ----------------------------------------------------------------------------------------------------------- |
| `TrustedContactsBackend` | `setIncoming` / `getIncoming` / `setSent` / `getSent` / `stats`. Drives the biz `quality_control` envelope. |

### Phase 9.7 — app-state sync

| Export            | Purpose                                                                                                                          |
| ----------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `AppStateBackend` | `setCollectionVersion` / `getCollectionVersion` / `insertMutation` / `listMutations` / `listMutationsSince` / `clearCollection`. |

## Concurrency and recovery

- Every `.db` file uses `journal_mode = WAL` and `synchronous = NORMAL`.
  Readers never block the single writer.
- `busy_timeout = 5000` absorbs short cross-process contention bursts
  internally; the auth-state `set()` retries up to 5 times with jittered
  backoff if SQLITE_BUSY still escapes.
- Each `.db` has its own WAL — independent locks across concerns. A
  heavy write burst on `jid_map` does not block point reads on
  `signal_sessions`.
- WAL corruption on one file (e.g. `msgstore.db`) leaves the others
  intact. Auth credentials in `creds.db` survive even if message routing
  state is hosed — the gateway can restart and resume.

## Migration from the legacy backends

Backward compatibility is intentional — there is no breaking change. Two
migration paths:

1. **Side-by-side** (recommended for production):
   - Keep the existing session in `useMultiFileAuthState` or
     `useSqliteAuthState`.
   - For new sessions, pass `multiDbStore` + the cache adapters in their
     `SocketConfig`.
   - As old sessions roll over, they migrate naturally to the multi-DB
     layout.

2. **In-place** (lower-traffic deployments):
   - Stop the gateway.
   - Run `migrateAuthState` (phase 9.8 — to be wired) which reads the
     legacy on-disk state and writes it into the multi-DB layout in one
     transaction per `.db` file.
   - Restart with `multiDbStore` passed.

Both paths preserve every InfiniteAPI customization (carousel, biz
quality_control, prekey 5-minute grace, Bad MAC retry receipt flow, 463
retry handling, memory leak fix, H7 atomic write, null tombstone
semantics).

## Operational tuning

```typescript
const store = new MultiDbSqliteStore({
	sessionDir: '/var/lib/infiniteapi/sessions/main',
	extraPragmas: [
		'cache_size = -16000', // 16 MiB shared cache
		'mmap_size = 268435456', // 256 MiB mmap for hot reads
		'wal_autocheckpoint = 4000' // larger WAL batches
	],
	logger: pinoLogger // optional — visibility into open / pragma application
})
```

`extraPragmas` is applied to every `.db` handle after the defaults. Useful
for cache sizing, mmap, checkpoint intervals, and SQLite tracing.
