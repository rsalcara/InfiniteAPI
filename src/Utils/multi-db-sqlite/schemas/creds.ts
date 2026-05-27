/**
 * Schema for `creds.db` — root DB holding auth credentials.
 *
 * The single row is JSON-encoded (mirrors the legacy `creds.json` from
 * `useMultiFileAuthState`). Kept in its own file so corruption on any
 * other concern's `.db` does not take down the entire session — the
 * gateway can recover its credentials and restart.
 */
export const CREDS_SCHEMA = `
CREATE TABLE IF NOT EXISTS creds (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS app_state_sync_keys (
  key_id TEXT PRIMARY KEY,
  value BLOB NOT NULL,
  created_at INTEGER NOT NULL
);
`
