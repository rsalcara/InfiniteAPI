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
		// Use realistic FullJid-shaped objects WITHOUT `agent: undefined`
		// fields — `JSON.stringify` drops undefined properties, so the
		// round-trip equality below would never hit if we included them
		// (the actual gateway addressed JID shape omits `agent` entirely
		// for the common no-agent case).
		const devices = [
			{ user: '5515991426667', device: 0 },
			{ user: '5515991426667', device: 1 }
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

	it('mget returns a record of all present keys', async () => {
		const adapter = new UserDeviceCacheSqliteAdapter(store.handle('msgstore.db'))
		adapter.set('u1', ['d1'])
		adapter.set('u2', ['d2'])
		adapter.set('u3', ['d3'])

		const got = await adapter.mget(['u1', 'u2', 'u4'])
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

	it('flushAll wipes every entry', () => {
		const adapter = new UserDeviceCacheSqliteAdapter(store.handle('msgstore.db'))
		adapter.set('a', [1])
		adapter.set('b', [2])
		adapter.set('c', [3])

		adapter.flushAll()
		expect(adapter.get('a')).toBeUndefined()
		expect(adapter.get('b')).toBeUndefined()
		expect(adapter.get('c')).toBeUndefined()
	})

	it('get returns undefined and drops the row when JSON is corrupted', () => {
		const adapter = new UserDeviceCacheSqliteAdapter(store.handle('msgstore.db'))
		const db = store.handle('msgstore.db')
		// Bypass the adapter to write a tampered devices_json row directly,
		// simulating a corruption / external write. NodeCache returns
		// undefined on a missing entry, and the adapter must mirror that.
		db.prepare('INSERT INTO user_device_cache_json (user_jid, devices_json, expires_at) VALUES (?, ?, ?)').run(
			'bad',
			'{not valid json',
			Date.now() + 60_000
		)

		expect(adapter.get('bad')).toBeUndefined()
		// The bad row is removed so it does not poison subsequent reads.
		const remaining = db.prepare('SELECT COUNT(*) AS n FROM user_device_cache_json WHERE user_jid = ?').get('bad') as {
			n: number
		}
		expect(remaining.n).toBe(0)
	})
})
