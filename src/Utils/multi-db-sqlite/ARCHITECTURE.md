# Multi-DB SQLite Persistence — Architecture

InfiniteAPI's Phase 9 persistence layer splits the auth/signal/message-routing
state across multiple physical SQLite files, one per concern. This document
explains the design choices and the roadmap that follows the skeleton PR.

## Why multiple files instead of one consolidated DB?

Three operational wins under load:

1. **Lock isolation** — a heavy write burst on the routing tables (e.g. a sync
   flow inserting thousands of `jid_map` rows) does not block point reads on
   `signal_sessions`, which sit on the message-send hot path. With a single
   consolidated DB those would contend on the same WAL writer slot.
2. **Corruption blast radius** — WAL checkpoint corruption on the
   `msgstore.db` file leaves `creds.db` untouched. A gateway can recover its
   session credentials and restart even if message routing state is
   compromised.
3. **Concern-focused schemas** — each `.db` file holds a coherent group of
   tables (auth credentials, Signal Protocol, routing/device cache,
   contacts/biz state, app-state sync). This makes the schema diffable and
   navigable.

## The 13 files

```
sessionDir/
├── creds.db             (auth credentials root; `app_state_sync_keys`
│                         table reserved for a later phase — v1 keeps
│                         `app-state-sync-key` in axolotl.signal_kv)
├── axolotl.db           (Signal Protocol — sessions, prekeys, identities,
│                         sender_keys, stanza queues, base keys, kyber
│                         prekeys, preacks)
├── msgstore.db          (JID routing, device cache, quarantine, retry counters)
├── wa.db                (contacts + Trusted Contact tokens)
├── sync.db              (app-state sync mutations + collection versions
│                         + placeholder retries + peer messages)
├── media.db             (media metadata + transfer / Express Path state)
├── companion_devices.db (Multi-Device companion registry)
├── chatsettings.db      (per-chat preferences + notification state)
├── location.db          (live location share state)
├── payments.db          (payment state — consumer + merchant)
├── stickers.db          (sticker pack catalog and recent state)
├── smb.db               (Small Business / Marketing Messages state)
└── prometheus.db        (observability — metric samples with retention
                          policies; isolated so high-frequency writes never
                          contend with the message-send hot path)
```

Each file carries:

- `journal_mode = WAL` — concurrent readers alongside a single writer
- `synchronous = NORMAL` — fsync at checkpoint boundaries (sufficient for a
  gateway workload)
- `busy_timeout = 5000` — internal wait before SQLITE_BUSY
- Tables created via `CREATE TABLE IF NOT EXISTS` on every open

`extraPragmas` lets ops apply further tuning (e.g. `cache_size = -8000`,
`mmap_size = 268435456`) without forking the adapter.

## Phase roadmap

This directory ships the **skeleton** — files exist, schemas materialize, and
`useMultiDbSqliteAuthState` works as a drop-in replacement for
`useSqliteAuthState`. Component-level integrations follow:

### Phase 9.0 (this PR) — Skeleton

- `MultiDbSqliteStore` opens all 13 files
- `useMultiDbSqliteAuthState` routes:
  - auth creds → `creds.db` `creds(key, value, updated_at)` row
  - signal data → `axolotl.db` `signal_kv(type, id, value)` (opaque)
- Typed tables (`signal_sessions`, `jid_map`, etc.) created and indexed but
  **not yet populated** — they wait for the integrations below.

### Phase 9.1 — `LIDMappingStore` → `jid_map`

**Replaces:** the in-RAM `Map<lid, pn>` plus `Map<pn, lid>` pair.
**Schema target:** `jid_map(lid_row_id, jid_row_id, sort_id)` joined with
`jid(_id, user, server, agent, device, type, raw_string)`. Both addressing
forms become rows in `jid`, with `jid_map` as the lookup table.

### Phase 9.2 — `userDevicesCache` → `user_device(_info)`

**Replaces:** the in-RAM device list cache.
**Schema target:** `user_device(user_jid_row_id, device_jid_row_id, key_index)`

- `user_device_info(user_jid_row_id, raw_id, timestamp, expected_timestamp)`.
  The `expected_timestamp` column gives a native TTL — no application-level
  eviction loop needed.

### Phase 9.3 — `msgRetryCounterCache` → `message_orphaned_edit`

**Replaces:** the in-RAM retry counter.
**Schema target:** `message_orphaned_edit(message_row_id, key_id, from_me,
chat_id, sender_id, retry_count, last_attempt)` with `UNIQUE (key_id, from_me,
chat_id, sender_id)` matching the natural retry-dedup key.

### Phase 9.4 — Bad MAC quarantine → `message_quarantine`

**Replaces:** the in-RAM ring buffer.
**Schema target:** `message_quarantine(... original_protobuf BLOB,
serialized_stanza BLOB, failure_reason, quarantined_at)`. Critical property:
**survives restart** — quarantined stanzas captured for forensic replay or
out-of-order retry don't vanish on gateway crash.

### Phase 9.5 — `signal_kv` → typed Signal Protocol tables

**Migrates** the opaque `signal_kv(type, id, value)` row set into typed tables:

- `signal_sessions(recipient_id, device_id, recipient_account_type, record BLOB)`
- `signal_prekeys(prekey_id PK, record BLOB, consumed_at)`
- `signal_signed_prekeys(prekey_id PK, record BLOB, created_at)`
- `signal_kyber_prekeys(prekey_id PK, record BLOB, created_at, is_one_time)`
- `signal_identities(recipient_id, recipient_account_type, public_key BLOB, trust_level, first_seen)`
- `signal_sender_keys(group_id, sender_id, device_id, record BLOB)`

**Identity dual-storage:** each contact's identity is stored TWICE — once as
LID (`recipient_account_type=1`) and once as PN (`recipient_account_type=0`).
This lets identity lookups by either addressing form land in a single row
without a join.

**InfiniteAPI's PreKey 5-minute grace remains in effect** — the typed schema
preserves this gateway-specific behavior and does not force a change.

### Phase 9.6 — TC tokens → `wa_trusted_contacts(_send)`

**Replaces:** trusted-contact-token storage scattered across creds JSON.
**Schema target:** `wa_trusted_contacts(jid, incoming_tc_token BLOB,
incoming_tc_token_timestamp)` + `wa_trusted_contacts_send(jid,
sent_tc_token_timestamp, real_issue_timestamp)`.

### Phase 9.7 — App-state sync → `collection_versions` + `syncd_mutations`

**Replaces:** the multi-file blob storage for app-state sync.
**Schema target:** ordered mutation log + per-collection version tracking.

## Backwards compatibility

`useMultiDbSqliteAuthState` is **additive** — it does not replace
`useSqliteAuthState` or `useMultiFileAuthState`. Existing deployments stay on
their current backend until they choose to migrate via `migrateAuthState`
(Phase 9.8, after typed tables are populated by phases 9.1–9.7).

## Concurrency contract

- **point reads** via prepared statements — constant time, no transaction
- **`set()`** runs as a single `BEGIN IMMEDIATE` ... `COMMIT` on the affected
  DB file; the multi-type payload commits atomically or rolls back the whole
  call
- **SQLITE_BUSY** on the BEGIN IMMEDIATE retries up to `MAX_BUSY_ATTEMPTS` (5)
  with jittered exponential backoff (base 25 ms, factor 2)
- **`clear()`** is a single DELETE — serializes naturally under WAL
- **`list`/`listIds`** stream via `better-sqlite3`'s `.iterate()` so they do
  not block the single writer

## Lifecycle

- `useMultiDbSqliteAuthState({ sessionDir })` opens all 13 handles
- The returned `close()` closes every handle in order; safe to call twice
- After `close()`, the same `sessionDir` can be reopened to resume
- File locking: each `.db` carries its own WAL — independent locks across the
  13 files, hence the isolation properties stated above
