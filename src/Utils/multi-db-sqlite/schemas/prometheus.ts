/**
 * Schema for `prometheus.db` — observability / metrics history.
 *
 * Stores Prometheus-style metrics (counters, gauges, histograms, summaries)
 * for both real-time scraping and historical analysis. Kept in its own
 * physical SQLite file so high-frequency metric writes do not contend with
 * the message-send hot path (`axolotl.db` session storage) or the JID
 * routing tables (`msgstore.db`).
 *
 * Design choices:
 *   - One row per metric sample with `metric_name`, `labels_json`,
 *     `value`, `timestamp`. Querying by name + label set + time range is
 *     covered by composite indexes.
 *   - Sparse `quantiles_json` / `buckets_json` columns hold histogram and
 *     summary distributions without forcing extra tables — easier to scan,
 *     trivial to backfill.
 *   - `retention_seconds` policy is enforced by `prune_old_metrics`
 *     (called by a background ticker, NOT by triggers — triggers fire on
 *     every INSERT and would blow up the write path).
 *
 * Concurrency model:
 *   - `journal_mode = WAL`: readers (scrapers, dashboards) never block the
 *     single writer (metric collector).
 *   - Each instance opens its own connection on `prometheus.db`; better-
 *     sqlite3 serializes writes within a process. Across processes (e.g.
 *     sidecar exporter), `busy_timeout = 5000` absorbs short contention.
 *   - Writes are batched (`BEGIN IMMEDIATE` + N inserts + `COMMIT`) by the
 *     `recordBatch` helper to keep per-sample overhead negligible.
 */
export const PROMETHEUS_SCHEMA = `
CREATE TABLE IF NOT EXISTS metric_samples (
  _id INTEGER PRIMARY KEY AUTOINCREMENT,
  metric_name TEXT NOT NULL,
  metric_type TEXT NOT NULL,
  labels_json TEXT NOT NULL DEFAULT '{}',
  value REAL NOT NULL,
  timestamp INTEGER NOT NULL,
  buckets_json TEXT,
  quantiles_json TEXT,
  sum REAL,
  count INTEGER
);

CREATE INDEX IF NOT EXISTS metric_samples_by_name_ts
  ON metric_samples (metric_name, timestamp DESC);
CREATE INDEX IF NOT EXISTS metric_samples_by_ts
  ON metric_samples (timestamp DESC);
CREATE INDEX IF NOT EXISTS metric_samples_by_name_labels_ts
  ON metric_samples (metric_name, labels_json, timestamp DESC);

CREATE TABLE IF NOT EXISTS metric_descriptors (
  metric_name TEXT PRIMARY KEY,
  metric_type TEXT NOT NULL,
  help TEXT,
  unit TEXT,
  first_seen INTEGER NOT NULL,
  last_updated INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS retention_policies (
  metric_name TEXT PRIMARY KEY,
  retention_seconds INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS pruning_log (
  _id INTEGER PRIMARY KEY AUTOINCREMENT,
  pruned_at INTEGER NOT NULL,
  metric_name TEXT,
  rows_pruned INTEGER NOT NULL,
  oldest_kept_ts INTEGER
);
`
