/**
 * Schema for `location.db` — live location share state.
 *
 * Caches the latest reported position per contact, tracks key-distribution
 * acknowledgement state for the group-key rotation, and records active
 * sharer expiry per chat. Column names match the canonical mobile schema
 * verbatim.
 */
export const LOCATION_SCHEMA = `
CREATE TABLE IF NOT EXISTS android_metadata (locale TEXT);

CREATE TABLE IF NOT EXISTS location_cache (
  _id INTEGER PRIMARY KEY AUTOINCREMENT,
  jid TEXT NOT NULL DEFAULT '',
  latitude REAL NOT NULL DEFAULT 0.0,
  longitude REAL NOT NULL DEFAULT 0.0,
  accuracy INTEGER NOT NULL DEFAULT 0,
  speed REAL NOT NULL DEFAULT 0.0,
  bearing INTEGER NOT NULL DEFAULT 0,
  location_ts INTEGER NOT NULL DEFAULT 0
);

CREATE UNIQUE INDEX IF NOT EXISTS user_location_index ON location_cache (jid);

CREATE TABLE IF NOT EXISTS location_key_distribution (
  _id INTEGER PRIMARY KEY AUTOINCREMENT,
  jid TEXT NOT NULL DEFAULT '',
  sent_to_server BOOLEAN NOT NULL DEFAULT 0
);

CREATE UNIQUE INDEX IF NOT EXISTS location_key_distribution_index
  ON location_key_distribution (jid);

CREATE TABLE IF NOT EXISTS location_sharer (
  _id INTEGER PRIMARY KEY AUTOINCREMENT,
  remote_jid TEXT NOT NULL DEFAULT '',
  from_me BOOLEAN NOT NULL DEFAULT 0,
  remote_resource TEXT NOT NULL DEFAULT '',
  expires INTEGER NOT NULL DEFAULT 0,
  message_id TEXT NOT NULL DEFAULT ''
);

CREATE UNIQUE INDEX IF NOT EXISTS location_sharer_index
  ON location_sharer (remote_jid, from_me, remote_resource, message_id);

CREATE TABLE IF NOT EXISTS props (
  _id INTEGER PRIMARY KEY AUTOINCREMENT,
  prop_name TEXT UNIQUE,
  prop_value TEXT
);
`
