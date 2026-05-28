/**
 * Schema for `msgstore.db` — JID routing, device cache, retry counters,
 * and quarantine storage.
 *
 * Gateway scope (only tables that solve operational pain points; this is a
 * deliberate subset of the full mobile schema):
 *
 *   - `jid` + `jid_map` — LID↔PN bidirectional mapping (target for phase
 *     9.1 `LIDMappingStore` migration)
 *   - `user_device` + `user_device_info` — companion device list with
 *     native TTL via `expected_timestamp` (target for phase 9.2)
 *   - `primary_device_version` — short-circuits device list refetch
 *   - `message_orphaned_edit` — `msgRetryCounterCache` persistence target
 *     (phase 9.3)
 *   - `message_quarantine` — quarantined stanzas survive restart for
 *     forensic replay or out-of-order retry (phase 9.4)
 *
 * Column names match the canonical mobile schema verbatim.
 */
export const MSGSTORE_SCHEMA = `
CREATE TABLE IF NOT EXISTS android_metadata (locale TEXT);

CREATE TABLE IF NOT EXISTS jid (
  _id INTEGER PRIMARY KEY AUTOINCREMENT,
  user TEXT NOT NULL,
  server TEXT NOT NULL,
  agent INTEGER,
  device INTEGER,
  type INTEGER,
  raw_string TEXT
);

CREATE UNIQUE INDEX IF NOT EXISTS jid_raw_string_idx ON jid (raw_string);
CREATE INDEX IF NOT EXISTS jid_user_server_idx ON jid (user, server);

CREATE TABLE IF NOT EXISTS jid_map (
  lid_row_id INTEGER PRIMARY KEY NOT NULL,
  jid_row_id INTEGER NOT NULL,
  sort_id INTEGER
);

CREATE INDEX IF NOT EXISTS jid_map_jid_row_id_idx ON jid_map (jid_row_id);

CREATE TABLE IF NOT EXISTS user_device (
  _id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_jid_row_id INTEGER,
  device_jid_row_id INTEGER,
  key_index INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS user_device_user_jid_row_id_idx
  ON user_device (user_jid_row_id);

CREATE TABLE IF NOT EXISTS user_device_info (
  user_jid_row_id INTEGER PRIMARY KEY,
  raw_id INTEGER NOT NULL,
  timestamp INTEGER NOT NULL,
  expected_timestamp INTEGER,
  expected_ts_last_device_job_ts INTEGER,
  expected_timestamp_update_ts INTEGER,
  account_encryption_type INTEGER
);

CREATE TABLE IF NOT EXISTS primary_device_version (
  user_jid_row_id INTEGER PRIMARY KEY,
  version INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS message_orphaned_edit (
  _id INTEGER PRIMARY KEY,
  key_id TEXT NOT NULL,
  from_me INTEGER NOT NULL,
  chat_row_id INTEGER NOT NULL,
  sender_jid_row_id INTEGER NOT NULL DEFAULT 0,
  timestamp INTEGER,
  message_type INTEGER NOT NULL,
  revoked_key_id TEXT,
  retry_count INTEGER,
  admin_jid_row_id INTEGER,
  orphan_message_data BLOB,
  reporting_token BLOB,
  reporting_tag BLOB,
  reporting_version INTEGER
);

CREATE INDEX IF NOT EXISTS message_orphaned_edit_chat_row_id_idx
  ON message_orphaned_edit (chat_row_id);

/* InfiniteAPI extension: quarantine storage for stanzas that failed to
   decrypt (e.g. Bad MAC), so they survive a restart and can be replayed
   forensically. The mobile schema does not carry a direct equivalent —
   this is a gateway-specific table colocated with the related routing
   tables for lock locality. */
CREATE TABLE IF NOT EXISTS message_quarantine (
  _id INTEGER PRIMARY KEY AUTOINCREMENT,
  key_id TEXT NOT NULL,
  from_me INTEGER NOT NULL DEFAULT 0,
  chat_row_id INTEGER NOT NULL,
  /* sender_jid_row_id is NOT NULL DEFAULT 0 so the UNIQUE constraint
     treats unknown-sender rows consistently; SQLite considers two NULLs
     distinct under UNIQUE, so a nullable column would let duplicate
     (key_id, from_me, chat_row_id, NULL) rows in. The 0 sentinel mirrors
     message_orphaned_edit. */
  sender_jid_row_id INTEGER NOT NULL DEFAULT 0,
  original_protobuf BLOB,
  serialized_stanza BLOB,
  failure_reason TEXT,
  quarantined_at INTEGER NOT NULL,
  retry_count INTEGER NOT NULL DEFAULT 0,
  UNIQUE(key_id, from_me, chat_row_id, sender_jid_row_id)
);

CREATE INDEX IF NOT EXISTS message_quarantine_chat_row_id_idx
  ON message_quarantine (chat_row_id);

/* InfiniteAPI extension: auxiliary cache tables for the NodeCache-shaped
   adapters (MsgRetryCounterSqliteAdapter, UserDeviceCacheSqliteAdapter).
   They are colocated on msgstore.db (instead of axolotl.db) because they
   are addressed by the same single-string key that messages-recv.ts /
   messages-send.ts already use, and live next to the routing tables
   (jid, jid_map, user_device) they cache. Owned by this schema file so
   runMigrations can ALTER them in a future phase without a special-case
   for "table created in adapter constructor". */
CREATE TABLE IF NOT EXISTS msg_retry_counter (
  key_id TEXT PRIMARY KEY,
  retry_count INTEGER NOT NULL DEFAULT 0,
  last_attempt INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS msg_retry_counter_expires_idx
  ON msg_retry_counter (expires_at);

CREATE TABLE IF NOT EXISTS user_device_cache_json (
  user_jid TEXT PRIMARY KEY,
  devices_json TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS user_device_cache_json_expires_idx
  ON user_device_cache_json (expires_at);
`
