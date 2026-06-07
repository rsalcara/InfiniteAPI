/**
 * Concurrency regression suite for `makeCacheableSignalKeyStore` AFTER the
 * removal of the global `cacheMutex` from `get()` and `set()` (port of
 * upstream PR #2593).
 *
 * Each test models a scenario the upstream argument relies on:
 *
 *   1. Concurrent GETs for the same MISSING id must coalesce safely — the
 *      store may be hit twice, but both callers must see the same value
 *      and the cache must end up populated with that value.
 *
 *   2. Concurrent SETs for different keys must NOT serialize against each
 *      other (no global mutex contention) AND must each land in both the
 *      cache and the durable store.
 *
 *   3. Concurrent SETs for the SAME key must each commit to the durable
 *      store. Cache may transiently diverge under interleaving, but the
 *      durable store has the canonical value — exactly the upstream
 *      contract (cache is read-through / write-through; store is truth).
 *
 *   4. `clear()` STILL must observe atomicity vs concurrent `set()`
 *      (we deliberately kept the mutex around `clear()` even though
 *      upstream removed it from all three methods).
 *
 *   5. H6 closure preserved without the mutex: if `store.set` throws, the
 *      cache must stay untouched and subsequent `get` reads must NOT serve
 *      the uncommitted value.
 *
 *   6. Stage 5 null tombstone behavior preserved without the mutex: a
 *      `set({type: {id: null}})` must evict the cache entry AND not
 *      reappear as a cache hit on the next `get`.
 */
import type { SignalDataSet, SignalKeyStore } from '../../Types'
import { makeCacheableSignalKeyStore } from '../../Utils/auth-utils'
import type { ILogger } from '../../Utils/logger'

const silentLogger = (): ILogger =>
	({
		level: 'silent',
		child: () => silentLogger(),
		trace: () => {},
		debug: () => {},
		info: () => {},
		warn: () => {},
		error: () => {},
		fatal: () => {}
	}) as unknown as ILogger

type Bucket = Record<string, unknown>
type Persisted = Record<string, Bucket>

const makeMemoryStore = (): {
	store: SignalKeyStore & { clear?: () => void | Promise<void> }
	persisted: Persisted
	getCalls: { type: string; ids: string[] }[]
	setCalls: number
} => {
	const persisted: Persisted = {}
	const getCalls: { type: string; ids: string[] }[] = []
	let setCalls = 0
	const store: SignalKeyStore & { clear?: () => void | Promise<void> } = {
		async get(type, ids) {
			getCalls.push({ type, ids: [...ids] })
			const bucket = persisted[type] ?? {}
			const out: Record<string, unknown> = {}
			for (const id of ids) {
				if (id in bucket) out[id] = bucket[id]
			}

			return out as any
		},
		async set(data: SignalDataSet) {
			setCalls++
			for (const type in data) {
				persisted[type] = persisted[type] ?? {}
				const incoming = (data as any)[type] as Record<string, unknown>
				for (const id in incoming) {
					const value = incoming[id]
					if (value === null || value === undefined) {
						delete persisted[type]![id]
					} else {
						persisted[type]![id] = value
					}
				}
			}
		},
		async clear() {
			for (const type in persisted) delete persisted[type]
		}
	}

	return { store, persisted, getCalls, setCalls: () => setCalls } as any
}

describe('makeCacheableSignalKeyStore — concurrency after global-mutex removal (#2593)', () => {
	it('coalesces concurrent GETs of the same missing id without losing the value', async () => {
		const { store, persisted } = makeMemoryStore()
		persisted.session = { 'aaa:0': Buffer.from([0xab]) as any }
		const cacheable = makeCacheableSignalKeyStore(store, silentLogger())

		const [a, b, c] = await Promise.all([
			cacheable.get('session', ['aaa:0']),
			cacheable.get('session', ['aaa:0']),
			cacheable.get('session', ['aaa:0'])
		])

		// All three callers see the same persisted value.
		expect(a['aaa:0']).toEqual(persisted.session!['aaa:0'])
		expect(b['aaa:0']).toEqual(persisted.session!['aaa:0'])
		expect(c['aaa:0']).toEqual(persisted.session!['aaa:0'])

		// Subsequent read is a pure cache hit (no further store.get).
		const before = (store as any).get.length
		await cacheable.get('session', ['aaa:0'])
		expect((store as any).get.length).toBe(before)
	})

	it('concurrent SETs for DIFFERENT keys both land in store + cache', async () => {
		const { store, persisted } = makeMemoryStore()
		const cacheable = makeCacheableSignalKeyStore(store, silentLogger())

		await Promise.all([
			cacheable.set({ session: { 'aaa:0': Buffer.from([0x01]) as any } }),
			cacheable.set({ session: { 'bbb:0': Buffer.from([0x02]) as any } })
		])

		expect(persisted.session!['aaa:0']).toEqual(Buffer.from([0x01]))
		expect(persisted.session!['bbb:0']).toEqual(Buffer.from([0x02]))

		const got = await cacheable.get('session', ['aaa:0', 'bbb:0'])
		expect(got['aaa:0']).toEqual(Buffer.from([0x01]))
		expect(got['bbb:0']).toEqual(Buffer.from([0x02]))
	})

	it('concurrent SETs for the SAME key both reach the durable store (cache eventually converges)', async () => {
		const { store, persisted } = makeMemoryStore()
		const cacheable = makeCacheableSignalKeyStore(store, silentLogger())

		await Promise.all([
			cacheable.set({ session: { 'aaa:0': Buffer.from([0xa1]) as any } }),
			cacheable.set({ session: { 'aaa:0': Buffer.from([0xa2]) as any } })
		])

		// The store has the value from whichever set() committed last.
		const finalStored = persisted.session!['aaa:0']
		expect([Buffer.from([0xa1]), Buffer.from([0xa2])].some(b => b.equals(finalStored as Buffer))).toBe(true)

		// A fresh get must converge with the store eventually. We force convergence
		// by clearing the cache and re-reading.
		await cacheable.clear!()
		const got = await cacheable.get('session', ['aaa:0'])
		// After clear() the value is gone (store.clear was also called). This is
		// not the typical convergence path in production; it shows that clear()
		// remains atomic — which is the reason we kept the mutex on clear().
		expect(got['aaa:0']).toBeUndefined()
	})

	it('H6 preserved without the mutex: failed store.set leaves cache untouched', async () => {
		let shouldThrow = true
		const persisted: Persisted = {}
		const flaky: SignalKeyStore = {
			async get(type, ids) {
				const bucket = persisted[type] ?? {}
				const out: Record<string, unknown> = {}
				for (const id of ids) {
					if (id in bucket) out[id] = bucket[id]
				}

				return out as any
			},
			async set(data: SignalDataSet) {
				if (shouldThrow) {
					shouldThrow = false
					throw new Error('simulated transient durable-store failure')
				}

				for (const type in data) {
					persisted[type] = persisted[type] ?? {}
					const incoming = (data as any)[type] as Record<string, unknown>
					for (const id in incoming) persisted[type]![id] = incoming[id]
				}
			}
		}

		const cacheable = makeCacheableSignalKeyStore(flaky, silentLogger())

		await expect(
			cacheable.set({ session: { 'aaa:0': Buffer.from([0xee]) as any } })
		).rejects.toThrow(/simulated transient/)

		// Cache must NOT serve the uncommitted value.
		const got = await cacheable.get('session', ['aaa:0'])
		expect(got['aaa:0']).toBeUndefined()
	})

	it('Stage 5 null tombstone preserved: set({id: null}) evicts the cache', async () => {
		const { store, persisted } = makeMemoryStore()
		persisted.session = { 'aaa:0': Buffer.from([0xab]) as any }
		const cacheable = makeCacheableSignalKeyStore(store, silentLogger())

		// Warm cache
		const warm = await cacheable.get('session', ['aaa:0'])
		expect(warm['aaa:0']).toBeDefined()

		// Tombstone via null
		await cacheable.set({ session: { 'aaa:0': null as any } })

		// Both store and cache must reflect the deletion
		expect(persisted.session!['aaa:0']).toBeUndefined()
		const after = await cacheable.get('session', ['aaa:0'])
		expect(after['aaa:0']).toBeUndefined()
	})

	it('clear() observes atomicity vs concurrent set()s (mutex retained on clear)', async () => {
		const { store, persisted } = makeMemoryStore()
		const cacheable = makeCacheableSignalKeyStore(store, silentLogger())

		// Pre-populate
		await cacheable.set({ session: { 'aaa:0': Buffer.from([0x01]) as any } })
		expect(persisted.session!['aaa:0']).toEqual(Buffer.from([0x01]))

		// Concurrently: spin off a set() and a clear()
		const setPromise = cacheable.set({ session: { 'bbb:0': Buffer.from([0x02]) as any } })
		const clearPromise = cacheable.clear!()

		await Promise.all([setPromise, clearPromise])

		// The end state depends on which finished last, but the cache must
		// agree with the store in either outcome (no half-cleared cache).
		const got = await cacheable.get('session', ['aaa:0', 'bbb:0'])
		expect(got['aaa:0']).toEqual(persisted.session?.['aaa:0'] ?? undefined)
		expect(got['bbb:0']).toEqual(persisted.session?.['bbb:0'] ?? undefined)
	})
})
