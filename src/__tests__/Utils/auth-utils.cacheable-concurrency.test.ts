/**
 * Concurrency regression suite for `makeCacheableSignalKeyStore` after the
 * removal of the global `cacheMutex` from `get()` and `set()` (port of
 * upstream PR #2593).
 *
 * The tests model the contract each scenario in this file exists to verify:
 *
 *   1. Concurrent GETs for the same MISSING id may both hit `store.get` (no
 *      coalescing was claimed by the upstream PR), but both callers must
 *      observe the same value, the cache must end up populated, and a
 *      subsequent `get` for the same id must be a pure cache hit (zero new
 *      store.get calls).
 *
 *   2. Concurrent SETs for DIFFERENT keys must each land in both the cache
 *      and the durable store. Without the global mutex they are no longer
 *      serialized.
 *
 *   3. Concurrent SETs for the SAME key must each commit to the durable
 *      store. The cache must converge with the store on a subsequent read
 *      WITHOUT any clear() in between — this is the "cache eventually
 *      reflects the store" contract upstream relies on.
 *
 *   4. H6 closure preserved without the mutex: if `store.set` throws, the
 *      cache must stay untouched and a subsequent `get` must NOT serve the
 *      uncommitted value.
 *
 *   5. Stage 5 null tombstone behavior preserved without the mutex: a
 *      `set({type: {id: null}})` must evict the cache entry AND not
 *      reappear as a cache hit on the next `get`.
 *
 *   6. The mutex on `clear()` serializes `clear()` against ANOTHER `clear()`
 *      ONLY. It does NOT exclude concurrent `set()` calls — the upstream
 *      race between `set()` and the `flushAll` + `store.clear?.()` pair is
 *      ACCEPTED. The covering test only proves clear-vs-clear interleaving
 *      doesn't crash and that the post-state stays cache↔store consistent.
 *
 * The mock store inserts a microtask yield (`await Promise.resolve()`) at
 * the top of `get`/`set`/`clear` so that `Promise.all([a, b])` actually
 * interleaves rather than running each operation atomically end-to-end.
 * Without the yield, JS's single-threaded event loop runs each async body
 * to its first real await without giving the other promise a chance — the
 * "concurrent" tests would degenerate into sequential ones.
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

interface MemoryStoreHandle {
	store: SignalKeyStore & { clear?: () => void | Promise<void> }
	persisted: Persisted
	getCalls: { type: string; ids: string[] }[]
	setCalls: () => number
}

const makeMemoryStore = (): MemoryStoreHandle => {
	const persisted: Persisted = {}
	const getCalls: { type: string; ids: string[] }[] = []
	let setCallCount = 0
	const store: SignalKeyStore & { clear?: () => void | Promise<void> } = {
		async get(type, ids) {
			// Force a microtask yield so a sibling promise inside Promise.all
			// can actually interleave instead of running this body atomically.
			await Promise.resolve()
			getCalls.push({ type, ids: [...ids] })
			const bucket = persisted[type] ?? {}
			const out: Record<string, unknown> = {}
			for (const id of ids) {
				if (id in bucket) out[id] = bucket[id]
			}

			return out as any
		},
		async set(data: SignalDataSet) {
			await Promise.resolve() // yield to peers — see file header comment
			setCallCount++
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
			await Promise.resolve()
			for (const type in persisted) delete persisted[type]
		}
	}

	return { store, persisted, getCalls, setCalls: () => setCallCount }
}

describe('makeCacheableSignalKeyStore — concurrency after global-mutex removal (#2593)', () => {
	it('concurrent GETs of the same missing id end up populating the cache; next read is a pure cache hit', async () => {
		const handle = makeMemoryStore()
		const { store, persisted, getCalls } = handle
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

		// Subsequent read is a pure cache hit — no new `store.get` invocation.
		// Use the recorded call list, NOT `store.get.length` (which returns
		// the arity of the get method and never changes — would be tautology).
		const callsBefore = getCalls.length
		await cacheable.get('session', ['aaa:0'])
		expect(getCalls.length).toBe(callsBefore)
	})

	it('concurrent SETs for DIFFERENT keys both land in store + cache', async () => {
		const { store, persisted, getCalls } = makeMemoryStore()
		const cacheable = makeCacheableSignalKeyStore(store, silentLogger())

		await Promise.all([
			cacheable.set({ session: { 'aaa:0': Buffer.from([0x01]) as any } }),
			cacheable.set({ session: { 'bbb:0': Buffer.from([0x02]) as any } })
		])

		expect(persisted.session!['aaa:0']).toEqual(Buffer.from([0x01]))
		expect(persisted.session!['bbb:0']).toEqual(Buffer.from([0x02]))

		// Both values must now serve from the cache (no extra store.get).
		const callsBefore = getCalls.length
		const got = await cacheable.get('session', ['aaa:0', 'bbb:0'])
		expect(got['aaa:0']).toEqual(Buffer.from([0x01]))
		expect(got['bbb:0']).toEqual(Buffer.from([0x02]))
		expect(getCalls.length).toBe(callsBefore)
	})

	it('concurrent SETs for the SAME key both commit; cache converges with the store on the next read (no clear() needed)', async () => {
		const { store, persisted } = makeMemoryStore()
		const cacheable = makeCacheableSignalKeyStore(store, silentLogger())

		await Promise.all([
			cacheable.set({ session: { 'aaa:0': Buffer.from([0xa1]) as any } }),
			cacheable.set({ session: { 'aaa:0': Buffer.from([0xa2]) as any } })
		])

		// The store has the value from whichever set() committed last.
		const finalStored = persisted.session!['aaa:0'] as Buffer
		const validFinal =
			finalStored.equals(Buffer.from([0xa1])) || finalStored.equals(Buffer.from([0xa2]))
		expect(validFinal).toBe(true)

		// Convergence: the next read returns the SAME value the durable store
		// is holding. We do NOT clear() here — that would make both store
		// AND cache empty trivially and prove nothing.
		const got = await cacheable.get('session', ['aaa:0'])
		expect((got['aaa:0'] as Buffer).equals(finalStored)).toBe(true)
	})

	it('H6 preserved without the mutex: failed store.set leaves cache untouched', async () => {
		let shouldThrow = true
		const persisted: Persisted = {}
		const flaky: SignalKeyStore = {
			async get(type, ids) {
				await Promise.resolve()
				const bucket = persisted[type] ?? {}
				const out: Record<string, unknown> = {}
				for (const id of ids) {
					if (id in bucket) out[id] = bucket[id]
				}

				return out as any
			},
			async set(data: SignalDataSet) {
				await Promise.resolve()
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

		await expect(cacheable.set({ session: { 'aaa:0': Buffer.from([0xee]) as any } })).rejects.toThrow(
			/simulated transient/
		)

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

	it('clear() serializes against another clear() only; concurrent set() is NOT excluded — post-state stays cache↔store consistent', async () => {
		// What this test really proves:
		//   - Two concurrent clear() calls don't crash and leave the store
		//     in the cleared state.
		//   - A concurrent set() that races against a clear() is NOT
		//     excluded by the mutex. The outcome depends on interleaving;
		//     this test checks that the cache and store agree at the end
		//     (so we don't observe a "cache has the value, store doesn't"
		//     half-state).
		// It does NOT prove atomicity of clear() vs set() — that race is
		// inherited from upstream PR #2593 and is accepted in our adaptation.
		const { store, persisted } = makeMemoryStore()
		const cacheable = makeCacheableSignalKeyStore(store, silentLogger())

		// Pre-populate
		await cacheable.set({ session: { 'aaa:0': Buffer.from([0x01]) as any } })
		expect(persisted.session!['aaa:0']).toEqual(Buffer.from([0x01]))

		// Concurrently: a set() + TWO clear()s. The two clear() calls
		// exercise the mutex (clear-vs-clear); the set() is the unprotected
		// racer.
		await Promise.all([
			cacheable.set({ session: { 'bbb:0': Buffer.from([0x02]) as any } }),
			cacheable.clear!(),
			cacheable.clear!()
		])

		// The end state depends on whether set() landed before or after the
		// clear() pair. EITHER way, the cache must AGREE with the durable
		// store on a fresh read — no "value in cache but absent from store"
		// (or vice versa) is allowed.
		const got = await cacheable.get('session', ['aaa:0', 'bbb:0'])
		expect(got['aaa:0']).toEqual(persisted.session?.['aaa:0'] ?? undefined)
		expect(got['bbb:0']).toEqual(persisted.session?.['bbb:0'] ?? undefined)
	})
})
