/**
 * Schema for `sync.db` — app-state sync persistence.
 *
 * Gateway scope:
 *   - `collection_versions` — per-collection version tracking with
 *     `lt_hash` (LT-Hash collection digest) + `dirty_version` marker
 *   - `syncd_mutations` — committed app-state mutations (ordered log)
 *   - `pending_mutations` — uncommitted mutations awaiting server ACK
 *   - `placeholder_retry_message` — placeholder pending re-resolution
 *   - `peer_messages` — peer-to-peer message queue (DSM, app-state acks)
 *
 * Target for phase 9.7 (replaces multi-file blob storage). Column names
 * match the canonical mobile schema verbatim.
 */
export const SYNC_SCHEMA = `
CREATE TABLE IF NOT EXISTS android_metadata (locale TEXT);

CREATE TABLE IF NOT EXISTS collection_versions (
  collection_name TEXT PRIMARY KEY,
  version INTEGER NOT NULL DEFAULT 0,
  lt_hash BLOB,
  dirty_version INTEGER NOT NULL DEFAULT -1
);

CREATE TABLE IF NOT EXISTS crypto_info (
  device_id INTEGER NOT NULL DEFAULT 0,
  epoch INTEGER NOT NULL DEFAULT 0,
  key_data BLOB NOT NULL DEFAULT X'',
  timestamp INTEGER NOT NULL DEFAULT 0,
  fingerprint BLOB NOT NULL DEFAULT X'',
  stale_timestamp INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (device_id, epoch)
);

CREATE TABLE IF NOT EXISTS missing_keys (
  device_id INTEGER NOT NULL DEFAULT 0,
  epoch INTEGER NOT NULL DEFAULT 0,
  collection_name TEXT NOT NULL DEFAULT '',
  PRIMARY KEY (device_id, epoch, collection_name)
);

CREATE TABLE IF NOT EXISTS syncd_mutations (
  _id INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL DEFAULT 0,
  mutation_index TEXT NOT NULL UNIQUE DEFAULT '',
  mutation_value BLOB,
  mutation_version INTEGER NOT NULL DEFAULT 0,
  collection_name TEXT NOT NULL DEFAULT '',
  are_dependencies_missing INTEGER NOT NULL DEFAULT 0,
  mutation_mac BLOB,
  device_id INTEGER NOT NULL DEFAULT 0,
  epoch INTEGER NOT NULL DEFAULT 0,
  chat_jid TEXT,
  mutation_name TEXT
);

CREATE INDEX IF NOT EXISTS syncd_mutations_active_mutations_index
  ON syncd_mutations (are_dependencies_missing);
CREATE INDEX IF NOT EXISTS syncd_mutations_active_mutations_chat_jid_index
  ON syncd_mutations (chat_jid, are_dependencies_missing);
/* InfiniteAPI addition: the most common app-state scan is "give me all
   ready mutations for collection X" — covered by this composite index. The
   two indexes above do not cover this access pattern (their leftmost column
   is are_dependencies_missing or chat_jid, never collection_name). Additive
   index; does not change row semantics, so fidelity to the mobile schema is
   preserved at the data layer. */
CREATE INDEX IF NOT EXISTS syncd_mutations_collection_deps_index
  ON syncd_mutations (collection_name, are_dependencies_missing);

CREATE TABLE IF NOT EXISTS pending_mutations (
  _id INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL DEFAULT 0,
  mutation_index TEXT NOT NULL UNIQUE DEFAULT '',
  mutation_value BLOB,
  mutation_version INTEGER NOT NULL DEFAULT 0,
  operation BLOB NOT NULL DEFAULT X'',
  is_ready_to_sync INTEGER NOT NULL DEFAULT 1,
  collection_name TEXT,
  device_id INTEGER,
  epoch INTEGER,
  are_dependencies_missing INTEGER NOT NULL DEFAULT 0,
  mutation_name TEXT NOT NULL DEFAULT '',
  chat_jid TEXT
);

CREATE TABLE IF NOT EXISTS placeholder_retry_message (
  message_row_id INTEGER PRIMARY KEY NOT NULL DEFAULT 0,
  peer_message_row_id INTEGER NOT NULL DEFAULT 0,
  timestamp INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS placeholder_retry_peer_msg_index
  ON placeholder_retry_message (peer_message_row_id);
CREATE INDEX IF NOT EXISTS placeholder_retry_timestamp_index
  ON placeholder_retry_message (timestamp);

CREATE TABLE IF NOT EXISTS peer_messages (
  _id INTEGER PRIMARY KEY AUTOINCREMENT,
  message_type INTEGER NOT NULL DEFAULT 0,
  key_remote_jid TEXT NOT NULL DEFAULT '',
  key_from_me INTEGER,
  key_id TEXT NOT NULL DEFAULT '',
  device_id TEXT,
  timestamp INTEGER,
  data TEXT,
  acked INTEGER
);
`
