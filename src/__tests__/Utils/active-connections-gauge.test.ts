/**
 * Regression tests for the `active_connections` gauge drift fix.
 *
 * The old `incrementActiveConnections`/`decrementActiveConnections` pair
 * drifted: `inc` fired only on a real open (`CB:success`), but `dec`
 * fired from the central `end()` teardown on EVERY disconnect — including
 * the ~13 paths that reach `end()` without ever opening (QR timeout, 515
 * before success, auth failure, ws close mid-handshake). Each such path
 * produced an orphan `dec` with no matching `inc`, permanently corrupting
 * the gauge (observed drift from 17 real connections down to 4).
 *
 * The fix backs the gauge with a Set of per-socket ids and SETs the gauge
 * to the Set's size. These tests pin the properties that make it
 * drift-proof, driving the gauge's `set` via a captured mock so we assert
 * the exact value the gauge is set to after each transition.
 */
import { jest } from '@jest/globals'

// Capture the value the gauge is set to. We mock the metric registry the
// helpers read (`metrics.activeConnections`) so no real prom-client
// registry is needed and each `set` call is observable.
const setCalls: number[] = []
const gaugeMock = {
	set: (_labels: Record<string, string>, value: number) => {
		setCalls.push(value)
	},
	inc: () => {},
	dec: () => {}
}

// The helpers live in prometheus-metrics.ts and read a module-level
// `metrics` object. Rather than mock the whole heavy module, we import
// the real helpers and inject our gauge by monkey-patching the exported
// `metrics` map after import.
let markConnectionActive: (id: string) => void
let markConnectionInactive: (id: string) => void

beforeAll(async () => {
	const mod: any = await import('../../Utils/prometheus-metrics')
	// Point the module's gauge at our capture mock. `metrics` is exported
	// for exactly this kind of test/introspection.
	if (mod.metrics) {
		mod.metrics.activeConnections = gaugeMock
	}
	markConnectionActive = mod.markConnectionActive
	markConnectionInactive = mod.markConnectionInactive
})

beforeEach(() => {
	setCalls.length = 0
})

const lastSet = (): number => {
	const v = setCalls[setCalls.length - 1]
	if (v === undefined) throw new Error('gauge.set was never called')
	return v
}

describe('active_connections gauge (Set-backed, drift-proof)', () => {
	it('open → close of one socket ends at the same baseline (no leak, no drift)', () => {
		const before = (() => {
			markConnectionActive('probe-baseline')
			const v = lastSet()
			markConnectionInactive('probe-baseline')
			return v - 1 // baseline before the probe
		})()

		markConnectionActive('sock-A')
		expect(lastSet()).toBe(before + 1)
		markConnectionInactive('sock-A')
		expect(lastSet()).toBe(before)
	})

	it('ORPHAN teardown (close without open) is a no-op — the core drift fix', () => {
		markConnectionActive('sock-open')
		const openValue = lastSet()

		// A socket that reached end() WITHOUT ever opening: markInactive for
		// an id that was never added. Old code did a raw dec() here → -1
		// orphan. New code: delete() of a missing id → no change.
		markConnectionInactive('sock-never-opened')
		expect(lastSet()).toBe(openValue) // UNCHANGED — no drift

		markConnectionInactive('sock-open')
		expect(lastSet()).toBe(openValue - 1)
	})

	it('repeated orphan teardowns cannot push the gauge below the real count', () => {
		markConnectionActive('real-1')
		markConnectionActive('real-2')
		const realTwo = lastSet()

		// Simulate the 515-churn: many closes of sockets that never opened.
		for (let i = 0; i < 50; i++) {
			markConnectionInactive(`ghost-${i}`)
		}
		expect(lastSet()).toBe(realTwo) // still exactly the 2 real ones
	})

	it('idempotent open: double markActive on the same id counts once', () => {
		markConnectionActive('dup')
		const first = lastSet()
		markConnectionActive('dup')
		expect(lastSet()).toBe(first) // Set.add of existing id → no change
		markConnectionInactive('dup')
		expect(lastSet()).toBe(first - 1)
	})

	it('overlapping reconnect: two sockets for the SAME number count as 2, old teardown does not evict the new one', () => {
		// This is the exact scenario that caused the original drift AND that a
		// naive me.id-keyed fix would re-break: old socket and new socket share
		// the phone number but MUST have distinct per-instance ids.
		markConnectionActive('sock-old') // old socket open
		const oneUp = lastSet()
		markConnectionActive('sock-new') // new socket (reconnect) opens
		expect(lastSet()).toBe(oneUp + 1) // both counted → 2 above baseline

		markConnectionInactive('sock-old') // old socket tears down
		expect(lastSet()).toBe(oneUp) // new socket STILL counted (not evicted)

		markConnectionInactive('sock-new')
		expect(lastSet()).toBe(oneUp - 1)
	})
})
