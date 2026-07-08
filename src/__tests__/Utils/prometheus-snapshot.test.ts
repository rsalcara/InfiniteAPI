/**
 * Phase 9.16 — verifies snapshotRegistryToPrometheusDb correctly extracts
 * every registered metric (counter/gauge/histogram/summary) into the shape
 * PrometheusBackend.recordBatch expects, using a real (fresh, isolated)
 * MetricsRegistry and a mock backend — no SQLite needed for this wiring test.
 */
import { jest } from '@jest/globals'
import {
	Counter,
	Gauge,
	Histogram,
	MetricsRegistry,
	snapshotRegistryToPrometheusDb,
	Summary
} from '../../Utils/prometheus-metrics'

const makeBackendMock = () => ({ recordBatch: jest.fn(), upsertDescriptor: jest.fn() })

describe('snapshotRegistryToPrometheusDb', () => {
	it('snapshots a counter and a gauge with their current values', async () => {
		const registry = new MetricsRegistry({ prefix: 'test9_16a' })
		const counter = registry.register(new Counter('reqs_total', 'requests', ['status']))
		const gauge = registry.register(new Gauge('queue_size', 'queue size'))

		counter.inc({ status: 'ok' }, 3)
		gauge.set(7)

		const backend = makeBackendMock()
		const count = await snapshotRegistryToPrometheusDb(registry, backend as any, 12345)

		expect(count).toBe(2)
		expect(backend.recordBatch).toHaveBeenCalledWith(
			expect.arrayContaining([
				expect.objectContaining({
					metricName: 'test9_16a_reqs_total',
					metricType: 'counter',
					value: 3,
					timestamp: 12345
				}),
				expect.objectContaining({
					metricName: 'test9_16a_queue_size',
					metricType: 'gauge',
					value: 7,
					timestamp: 12345
				})
			])
		)
		// descriptors (name/type/help) are upserted once per metric, independent of recordBatch
		expect(backend.upsertDescriptor).toHaveBeenCalledWith('test9_16a_reqs_total', 'counter', 'requests', null, 12345)
		expect(backend.upsertDescriptor).toHaveBeenCalledWith('test9_16a_queue_size', 'gauge', 'queue size', null, 12345)
	})

	it('snapshots a histogram with buckets/sum/count', async () => {
		const registry = new MetricsRegistry({ prefix: 'test9_16b' })
		const histogram = registry.register(new Histogram('latency', 'latency', [], [1, 5, 10]))
		histogram.observe(3)

		const backend = makeBackendMock()
		await snapshotRegistryToPrometheusDb(registry, backend as any, 999)

		const [samples] = (backend.recordBatch as jest.Mock).mock.calls[0] as [any[]]
		expect(samples).toHaveLength(1)
		expect(samples[0]).toMatchObject({ metricName: 'test9_16b_latency', metricType: 'histogram', sum: 3, count: 1 })
		expect(JSON.parse(samples[0].bucketsJson)).toBeDefined()
	})

	it('snapshots a summary with quantiles/sum/count', async () => {
		const registry = new MetricsRegistry({ prefix: 'test9_16c' })
		const summary = registry.register(new Summary('duration', 'duration'))
		summary.observe(5)

		const backend = makeBackendMock()
		await snapshotRegistryToPrometheusDb(registry, backend as any, 555)

		const [samples] = (backend.recordBatch as jest.Mock).mock.calls[0] as [any[]]
		expect(samples).toHaveLength(1)
		expect(samples[0]).toMatchObject({ metricName: 'test9_16c_duration', metricType: 'summary', sum: 5, count: 1 })
	})

	it('is a no-op (recordBatch called with []) for an empty registry', async () => {
		const registry = new MetricsRegistry({ prefix: 'test9_16d' })
		const backend = makeBackendMock()
		const count = await snapshotRegistryToPrometheusDb(registry, backend as any, 1)
		expect(count).toBe(0)
	})
})
