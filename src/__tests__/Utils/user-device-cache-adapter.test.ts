/**
 * Phase 9.2 — `UserDeviceCacheSqliteAdapter` test.
 *
 * Confirms the NodeCache-compatible shape works as the existing
 * `userDevicesCache` plumbing expects: get/set/del/mget with TTL.
 */
import { mkdtemp, rm } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'

import { MultiDbSqliteStore, UserDeviceCacheSqliteAdapter } from '../../Utils/multi-db-sqlite'

describe('UserDeviceCacheSqliteAdapter', () => {
	let dir: string
	let store: MultiDbSqliteStore

	beforeEach(async () => {
		dir = await mkdtemp(join(tmpdir(), 'user-device-cache-test-'))
		store = new MultiDbSqliteStore({ sessionDir: dir })
		await store.open()
	})

	afterEach(async () => {
		store.close()
		await rm(dir, { recursive: true, force: true })
	})

	it('round-trips a JidWithDevice[] payload via get/set', () => {
		const adapter = new UserDeviceCacheSqliteAdapter(store.handle('msgstore.db'))
		const devices = [
			{ user: '5515991426667', agent: undefined, device: 0 },
			{ user: '5515991426667', agent: undefined, device: 1 }
		]
		adapter.set('5515991426667', devices)

		expect(adapter.get('5515991426667')).toEqual(devices)
		expect(adapter.get('unknown')).toBeUndefined()
	})

	it('honors TTL — entries expire after their ttl seconds', () => {
		const adapter = new UserDeviceCacheSqliteAdapter(store.handle('msgstore.db'), {
			defaultTtlSeconds: 5
		})
		adapter.set('abc', [{ x: 1 }], 1) // 1-second TTL
		expect(adapter.get('abc')).toEqual([{ x: 1 }])

		// Fast-forward by mocking Date.now to simulate expiry
		const realNow = Date.now
		try {
			Date.now = () => realNow() + 2_000 // +2 s
			expect(adapter.get('abc')).toBeUndefined()
		} finally {
			Date.now = realNow
		}
	})

	it('del removes one or many entries and reports count', () => {
		const adapter = new UserDeviceCacheSqliteAdapter(store.handle('msgstore.db'))
		adapter.set('a', [1])
		adapter.set('b', [2])
		adapter.set('c', [3])

		expect(adapter.del('a')).toBe(1)
		expect(adapter.get('a')).toBeUndefined()

		expect(adapter.del(['b', 'c', 'nonexistent'])).toBe(2)
		expect(adapter.get('b')).toBeUndefined()
		expect(adapter.get('c')).toBeUndefined()
	})

	it('mget returns a record of all present keys', () => {
		const adapter = new UserDeviceCacheSqliteAdapter(store.handle('msgstore.db'))
		adapter.set('u1', ['d1'])
		adapter.set('u2', ['d2'])
		adapter.set('u3', ['d3'])

		const got = adapter.mget(['u1', 'u2', 'u4'])
		expect(got).toEqual({ u1: ['d1'], u2: ['d2'] })
	})

	it('pruneExpired removes expired rows', () => {
		const adapter = new UserDeviceCacheSqliteAdapter(store.handle('msgstore.db'))
		adapter.set('fresh', ['ok'], 60) // 60 s
		adapter.set('stale', ['old'], 1) // 1 s

		const future = Date.now() + 5_000
		const removed = adapter.pruneExpired(future)
		expect(removed).toBe(1)
		expect(adapter.get('fresh')).toEqual(['ok'])
		expect(adapter.get('stale')).toBeUndefined()
	})
})
