/**
 * Schema for `sync.db` — app-state sync persistence.
 *
 * Gateway scope:
 *   - `collection_versions` — per-collection version tracking
 *   - `syncd_mutations` — committed app-state mutations (ordered log)
 *   - `pending_mutations` — uncommitted mutations awaiting server ACK
 *
 * Target for phase 9.7 (replaces multi-file blob storage).
 */
export const SYNC_SCHEMA = `
CREATE TABLE IF NOT EXISTS collection_versions (
  collection_name TEXT PRIMARY KEY,
  version INTEGER NOT NULL,
  hash BLOB,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS syncd_mutations (
  _id INTEGER PRIMARY KEY AUTOINCREMENT,
  collection_name TEXT NOT NULL,
  version INTEGER NOT NULL,
  index_mac BLOB NOT NULL,
  value_mac BLOB NOT NULL,
  operation INTEGER NOT NULL DEFAULT 0,
  payload BLOB NOT NULL,
  committed_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS syncd_mutations_by_collection
  ON syncd_mutations (collection_name, version);

CREATE TABLE IF NOT EXISTS pending_mutations (
  _id INTEGER PRIMARY KEY AUTOINCREMENT,
  collection_name TEXT NOT NULL,
  index_mac BLOB NOT NULL,
  value_mac BLOB NOT NULL,
  operation INTEGER NOT NULL DEFAULT 0,
  payload BLOB NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS pending_mutations_by_collection
  ON pending_mutations (collection_name);
`
