/**
 * Phase 9.16 — typed metrics-history storage backed by `prometheus.db`.
 *
 * Unlike every other Phase 9 component, this table has no WhatsApp Android
 * counterpart at all — it's InfiniteAPI's own observability layer, kept in
 * its own physical file so high-frequency metric writes never contend with
 * message/session storage (see schemas/prometheus.ts's header). Lowest
 * priority of the roadmap for exactly that reason: it's not about matching
 * WhatsApp's behavior, it's ops tooling.
 *
 * Deliberately NOT auto-wired to a ticker inside socket/chats.ts: this
 * codebase has a documented prior incident (an uncleared
 * `cacheMetricsInterval` pinning a stale libsignal repository across
 * reconnects — see memory: memory_leak_investigation.md) from exactly this
 * class of bug — a periodic timer tied to socket lifecycle that outlives
 * its socket. Adding a new interval here, this late, without the ability to
 * verify its teardown against a live reconnect storm, would risk repeating
 * that incident. `snapshotRegistryToPrometheusDb` (prometheus-metrics.ts)
 * is exposed as a plain callable instead — the caller decides the cadence
 * and owns the interval's lifecycle.
 */
import type { SqliteDbLike, SqliteStatementLike } from './types'

export type MetricSampleInput = {
	metricName: string
	metricType: string
	labelsJson: string
	value: number
	timestamp: number
	bucketsJson?: string | null
	quantilesJson?: string | null
	sum?: number | null
	count?: number | null
}

export class PrometheusBackend {
	private readonly stmts: {
		insertSample: SqliteStatementLike
		upsertDescriptor: SqliteStatementLike
		setRetentionPolicy: SqliteStatementLike
		getRetentionPolicy: SqliteStatementLike
		pruneOlderThan: SqliteStatementLike
		logPruning: SqliteStatementLike
	}

	private readonly db: SqliteDbLike

	constructor(db: SqliteDbLike) {
		this.db = db
		this.stmts = {
			insertSample: this.db.prepare(
				'INSERT INTO metric_samples (metric_name, metric_type, labels_json, value, timestamp, ' +
					'buckets_json, quantiles_json, sum, count) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
			),
			upsertDescriptor: this.db.prepare(
				'INSERT INTO metric_descriptors (metric_name, metric_type, help, unit, first_seen, last_updated) ' +
					'VALUES (?, ?, ?, ?, ?, ?) ' +
					'ON CONFLICT(metric_name) DO UPDATE SET metric_type = excluded.metric_type, help = excluded.help, ' +
					'  unit = excluded.unit, last_updated = excluded.last_updated'
			),
			setRetentionPolicy: this.db.prepare(
				'INSERT INTO retention_policies (metric_name, retention_seconds, updated_at) VALUES (?, ?, ?) ' +
					'ON CONFLICT(metric_name) DO UPDATE SET retention_seconds = excluded.retention_seconds, updated_at = excluded.updated_at'
			),
			getRetentionPolicy: this.db.prepare('SELECT retention_seconds FROM retention_policies WHERE metric_name = ?'),
			pruneOlderThan: this.db.prepare('DELETE FROM metric_samples WHERE metric_name = ? AND timestamp < ?'),
			logPruning: this.db.prepare(
				'INSERT INTO pruning_log (pruned_at, metric_name, rows_pruned, oldest_kept_ts) VALUES (?, ?, ?, ?)'
			)
		}
	}

	/** Batched insert — one transaction for the whole snapshot, per the schema's own design note. */
	recordBatch(samples: MetricSampleInput[]): void {
		if (!samples.length) return
		const insertMany = this.db.transaction(() => {
			for (const s of samples) {
				this.stmts.insertSample.run(
					s.metricName,
					s.metricType,
					s.labelsJson,
					s.value,
					s.timestamp,
					s.bucketsJson ?? null,
					s.quantilesJson ?? null,
					s.sum ?? null,
					s.count ?? null
				)
			}
		})
		insertMany()
	}

	upsertDescriptor(metricName: string, metricType: string, help: string | null, unit: string | null, now: number): void {
		this.stmts.upsertDescriptor.run(metricName, metricType, help, unit, now, now)
	}

	setRetentionPolicy(metricName: string, retentionSeconds: number, now: number): void {
		this.stmts.setRetentionPolicy.run(metricName, retentionSeconds, now)
	}

	getRetentionSeconds(metricName: string): number | null {
		const r = this.stmts.getRetentionPolicy.get(metricName) as { retention_seconds: number } | undefined
		return r?.retention_seconds ?? null
	}

	/** Prunes samples for `metricName` older than its configured retention policy, if any. Returns rows pruned. */
	pruneOldMetrics(metricName: string, now: number): number {
		const retentionSeconds = this.getRetentionSeconds(metricName)
		if (retentionSeconds == null) return 0

		const cutoff = now - retentionSeconds * 1000
		const result = this.stmts.pruneOlderThan.run(metricName, cutoff)
		if (result.changes > 0) {
			this.stmts.logPruning.run(now, metricName, result.changes, cutoff)
		}

		return result.changes
	}
}
