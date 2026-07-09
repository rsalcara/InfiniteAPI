/**
 * Schema for `creds.db` — root DB holding auth credentials.
 *
 * The single creds row is JSON-encoded (mirrors the legacy `creds.json`
 * from `useMultiFileAuthState`). Kept in its own file so corruption on
 * any other concern's `.db` does not take down the entire session — the
 * gateway can recover its credentials and restart.
 *
 * `app_state_sync_keys` holds the decoded `app-state-sync-key` signal data
 * (`use-multi-db-sqlite-auth-state.ts` routes it here instead of the
 * opaque `axolotl.db.signal_kv`, migrating any legacy rows on open()).
 * This table has no WhatsApp Android equivalent to mirror — the primary
 * phone hands these keys out to companions but never needs to persist
 * them itself, so `key_id`/`value`/`created_at` is InfiniteAPI's own
 * bookkeeping shape, not a ported mobile schema.
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
