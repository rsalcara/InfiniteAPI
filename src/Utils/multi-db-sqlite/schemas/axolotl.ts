/**
 * Schema for `axolotl.db` — Signal Protocol store split into typed tables.
 *
 * Identity dual-storage: every contact's identity is stored TWICE — once with
 * `recipient_account_type = 1` (LID) and once with `recipient_account_type = 0`
 * (PN). This lets identity lookups by either addressing form resolve to a
 * single row without a separate join.
 *
 * `signal_kv` is an opaque key-value bucket used by the auth-state adapter
 * for v1. The typed tables above wait for the phase 9.5 split, which will
 * migrate the opaque rows into their concrete typed targets.
 */
export const AXOLOTL_SCHEMA = `
CREATE TABLE IF NOT EXISTS signal_sessions (
  recipient_id TEXT NOT NULL,
  device_id INTEGER NOT NULL,
  recipient_account_type INTEGER NOT NULL DEFAULT 0,
  record BLOB NOT NULL,
  PRIMARY KEY (recipient_id, device_id, recipient_account_type)
);

CREATE TABLE IF NOT EXISTS signal_prekeys (
  prekey_id INTEGER PRIMARY KEY,
  record BLOB NOT NULL,
  consumed_at INTEGER
);

CREATE TABLE IF NOT EXISTS signal_signed_prekeys (
  prekey_id INTEGER PRIMARY KEY,
  record BLOB NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS signal_kyber_prekeys (
  prekey_id INTEGER PRIMARY KEY,
  record BLOB NOT NULL,
  created_at INTEGER NOT NULL,
  is_one_time INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS signal_identities (
  recipient_id TEXT NOT NULL,
  recipient_account_type INTEGER NOT NULL DEFAULT 0,
  public_key BLOB NOT NULL,
  trust_level INTEGER NOT NULL DEFAULT 0,
  first_seen INTEGER,
  PRIMARY KEY (recipient_id, recipient_account_type)
);

CREATE TABLE IF NOT EXISTS signal_sender_keys (
  group_id TEXT NOT NULL,
  sender_id TEXT NOT NULL,
  device_id INTEGER NOT NULL,
  record BLOB NOT NULL,
  PRIMARY KEY (group_id, sender_id, device_id)
);

CREATE INDEX IF NOT EXISTS signal_identities_by_recipient
  ON signal_identities (recipient_id);

CREATE INDEX IF NOT EXISTS signal_sessions_by_recipient
  ON signal_sessions (recipient_id);

CREATE INDEX IF NOT EXISTS signal_sender_keys_by_group
  ON signal_sender_keys (group_id);

CREATE TABLE IF NOT EXISTS e2ee_stanza_queue (
  message_id TEXT PRIMARY KEY,
  recipient_id TEXT NOT NULL,
  e2ee_retry_count INTEGER NOT NULL DEFAULT 0,
  has_pkmsg INTEGER NOT NULL DEFAULT 0,
  has_skmsg INTEGER NOT NULL DEFAULT 0,
  serialized_stanza BLOB,
  inserted_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS e2ee_stanza_queue_by_recipient
  ON e2ee_stanza_queue (recipient_id);

CREATE TABLE IF NOT EXISTS signal_kv (
  type TEXT NOT NULL,
  id TEXT NOT NULL,
  value TEXT NOT NULL,
  PRIMARY KEY (type, id)
);

CREATE INDEX IF NOT EXISTS signal_kv_by_type ON signal_kv(type);
`
