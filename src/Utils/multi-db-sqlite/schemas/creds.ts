/**
 * Schema for `creds.db` — root DB holding auth credentials.
 *
 * The single creds row is JSON-encoded (mirrors the legacy `creds.json`
 * from `useMultiFileAuthState`). Kept in its own file so corruption on
 * any other concern's `.db` does not take down the entire session — the
 * gateway can recover its credentials and restart.
 *
 * The `app_state_sync_keys` table is RESERVED for a later phase that will
 * route `app-state-sync-key` signal data here directly. In phase 9.0 the
 * adapter still persists those into `axolotl.db.signal_kv` (under the
 * opaque `type='app-state-sync-key'` rows) along with the other Signal
 * data types. Phase 9.5/9.7 will split the typed targets out.
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
