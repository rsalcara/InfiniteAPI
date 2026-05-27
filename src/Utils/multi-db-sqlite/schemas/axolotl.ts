/**
 * Schema for `axolotl.db` — Signal Protocol store.
 *
 * Mirrors WhatsApp's mobile schema exactly: every column name and type
 * matches their canonical layout, so introspection tools, migration logic,
 * and forensic dumps line up 1:1 without renames.
 *
 * Identity dual-storage: each contact's identity is stored TWICE — once
 * with `recipient_type = 1` (LID) and once with `recipient_type = 0` (PN).
 * The store resolves identity lookups by either addressing form without a
 * separate mapping table.
 */
export const AXOLOTL_SCHEMA = `
CREATE TABLE IF NOT EXISTS android_metadata (locale TEXT);

CREATE TABLE IF NOT EXISTS sessions (
  _id INTEGER PRIMARY KEY AUTOINCREMENT,
  device_id INTEGER,
  record BLOB,
  timestamp INTEGER,
  recipient_account_id TEXT,
  recipient_account_type INTEGER,
  session_type INTEGER NOT NULL DEFAULT 0,
  session_scope INTEGER NOT NULL DEFAULT 0
);

CREATE UNIQUE INDEX IF NOT EXISTS sessions_idx_v33
  ON sessions (device_id, recipient_account_id, recipient_account_type, session_type, session_scope);
CREATE INDEX IF NOT EXISTS sessions_account_idx
  ON sessions (recipient_account_id, recipient_account_type, device_id);

CREATE TABLE IF NOT EXISTS prekeys (
  _id INTEGER PRIMARY KEY AUTOINCREMENT,
  prekey_id INTEGER UNIQUE,
  sent_to_server BOOLEAN,
  record BLOB,
  direct_distribution BOOLEAN,
  upload_timestamp INTEGER,
  key_type INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS signed_prekeys (
  _id INTEGER PRIMARY KEY AUTOINCREMENT,
  prekey_id INTEGER UNIQUE,
  timestamp INTEGER,
  record BLOB,
  key_type INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS kyber_prekeys (
  _id INTEGER PRIMARY KEY AUTOINCREMENT,
  prekey_id INTEGER NOT NULL UNIQUE,
  sent_to_server BOOLEAN,
  record BLOB NOT NULL,
  direct_distribution BOOLEAN,
  upload_timestamp INTEGER,
  last_resort_key BOOLEAN NOT NULL DEFAULT FALSE
);

CREATE INDEX IF NOT EXISTS kyber_prekeys_last_resort_key_idx
  ON kyber_prekeys (last_resort_key);

CREATE TABLE IF NOT EXISTS identities (
  _id INTEGER PRIMARY KEY AUTOINCREMENT,
  recipient_id INTEGER,
  recipient_type INTEGER NOT NULL DEFAULT 0,
  device_id INTEGER,
  registration_id INTEGER,
  public_key BLOB,
  private_key BLOB,
  next_prekey_id INTEGER,
  next_kyber_prekey_id INTEGER,
  timestamp INTEGER
);

CREATE UNIQUE INDEX IF NOT EXISTS identities_idx
  ON identities (recipient_id, recipient_type, device_id);

CREATE TABLE IF NOT EXISTS sender_keys (
  _id INTEGER PRIMARY KEY AUTOINCREMENT,
  group_id TEXT NOT NULL,
  device_id INTEGER NOT NULL DEFAULT 0,
  record BLOB NOT NULL,
  timestamp INTEGER,
  sender_account_id TEXT,
  sender_account_type INTEGER
);

CREATE INDEX IF NOT EXISTS sender_keys_account_idx
  ON sender_keys (group_id, sender_account_id, sender_account_type, device_id);
CREATE UNIQUE INDEX IF NOT EXISTS sender_keys_idx_v26
  ON sender_keys (group_id, device_id, sender_account_id, sender_account_type);

CREATE TABLE IF NOT EXISTS fast_ratchet_sender_keys (
  _id INTEGER PRIMARY KEY AUTOINCREMENT,
  group_id TEXT NOT NULL,
  sender_id INTEGER NOT NULL,
  sender_type INTEGER NOT NULL DEFAULT 0,
  device_id INTEGER NOT NULL DEFAULT 0,
  record BLOB NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS fast_ratchet_sender_keys_idx
  ON fast_ratchet_sender_keys (group_id, sender_id, sender_type, device_id);

CREATE TABLE IF NOT EXISTS message_base_key (
  _id INTEGER PRIMARY KEY AUTOINCREMENT,
  msg_key_remote_jid TEXT NOT NULL,
  msg_key_from_me BOOLEAN NOT NULL,
  msg_key_id TEXT NOT NULL,
  recipient_id INTEGER,
  recipient_type INTEGER NOT NULL DEFAULT 0,
  device_id INTEGER NOT NULL DEFAULT 0,
  last_alice_base_key BLOB NOT NULL,
  timestamp INTEGER
);

CREATE UNIQUE INDEX IF NOT EXISTS message_base_key_idx
  ON message_base_key (msg_key_remote_jid, msg_key_from_me, msg_key_id, recipient_id, recipient_type, device_id);

CREATE TABLE IF NOT EXISTS preacks (
  _id INTEGER PRIMARY KEY AUTOINCREMENT,
  ptn BLOB NOT NULL
);

CREATE TABLE IF NOT EXISTS prekey_uploads (
  _id INTEGER PRIMARY KEY AUTOINCREMENT,
  upload_timestamp INTEGER,
  key_type INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS chat_stanza_queue (
  _id INTEGER PRIMARY KEY AUTOINCREMENT,
  stanza_id TEXT NOT NULL,
  stanza_key BLOB NOT NULL UNIQUE,
  stanza_class INTEGER NOT NULL,
  chat_type INTEGER,
  chat_jid TEXT,
  sender_jid TEXT,
  stanza_payload BLOB NOT NULL,
  stanza_type INTEGER NOT NULL,
  protobuf BLOB,
  decrypt_metadata BLOB,
  generated BOOLEAN NOT NULL,
  time_sec INTEGER NOT NULL,
  create_time_ms INTEGER NOT NULL,
  sort_id INTEGER NOT NULL,
  process_count INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS chat_queue_chat_jid_index ON chat_stanza_queue (chat_jid);
CREATE INDEX IF NOT EXISTS chat_sender_jid_index ON chat_stanza_queue (sender_jid);
CREATE INDEX IF NOT EXISTS chat_stanza_class_index ON chat_stanza_queue (stanza_class);

CREATE TABLE IF NOT EXISTS e2ee_stanza_queue (
  _id INTEGER PRIMARY KEY AUTOINCREMENT,
  stanza_id TEXT NOT NULL,
  stanza_key BLOB NOT NULL UNIQUE,
  stanza_class INTEGER NOT NULL,
  chat_type INTEGER,
  chat_jid TEXT,
  sender_jid TEXT,
  stanza_payload BLOB NOT NULL,
  offline_count INTEGER,
  e2ee_retry_count INTEGER NOT NULL,
  has_pkmsg BOOLEAN NOT NULL,
  has_skmsg BOOLEAN NOT NULL,
  time_sec INTEGER NOT NULL,
  create_time_ms INTEGER NOT NULL,
  sort_id INTEGER NOT NULL,
  process_count INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS e2ee_chat_jid_index ON e2ee_stanza_queue (chat_jid);
CREATE INDEX IF NOT EXISTS e2ee_sender_jid_index ON e2ee_stanza_queue (sender_jid);
CREATE INDEX IF NOT EXISTS e2ee_stanza_class_index ON e2ee_stanza_queue (stanza_class);

CREATE TABLE IF NOT EXISTS unordered_stanza_queue (
  _id INTEGER PRIMARY KEY AUTOINCREMENT,
  stanza_id TEXT NOT NULL,
  stanza_key BLOB NOT NULL UNIQUE,
  stanza_class INTEGER NOT NULL,
  stanza_type INTEGER NOT NULL,
  stanza_payload BLOB NOT NULL,
  protobuf BLOB,
  decrypt_metadata BLOB,
  chat_type INTEGER,
  chat_jid TEXT,
  sender_jid TEXT,
  time_sec INTEGER NOT NULL,
  create_time_ms INTEGER NOT NULL,
  process_count INTEGER
);

CREATE INDEX IF NOT EXISTS unordered_chat_jid_index ON unordered_stanza_queue (chat_jid);
CREATE INDEX IF NOT EXISTS unordered_stanza_class_index ON unordered_stanza_queue (stanza_class);

CREATE TABLE IF NOT EXISTS signal_kv (
  type TEXT NOT NULL,
  id TEXT NOT NULL,
  value TEXT NOT NULL,
  PRIMARY KEY (type, id)
);

CREATE INDEX IF NOT EXISTS signal_kv_by_type ON signal_kv(type);
`
