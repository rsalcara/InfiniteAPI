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

describe('UserDeviceCacheSqliteAdapter — source of truth (typed tables)', () => {
	let dir: string
	let store: MultiDbSqliteStore

	beforeEach(async () => {
		dir = await mkdtemp(join(tmpdir(), 'user-device-sot-test-'))
		store = new MultiDbSqliteStore({ sessionDir: dir })
		await store.open()
	})

	afterEach(async () => {
		store.close()
		await rm(dir, { recursive: true, force: true })
	})

	// Server-bearing FullJid[] (the real gateway shape) — this is what makes
	// the typed path engage. `device 0` encodes to no `:device` suffix; the
	// typed read normalizes it back to `0` (not `undefined`) so it stays
	// value-identical to the JSON mirror.
	const devices = [
		{ user: '5515991426667', server: 's.whatsapp.net', device: 0 },
		{ user: '5515991426667', server: 's.whatsapp.net', device: 2 }
	]
	const normalize = (d: { user: string; server: string; device?: number }) => ({
		user: d.user,
		server: d.server,
		device: d.device || 0
	})

	it('writes the typed tables on set (dual-write with the JSON mirror)', () => {
		const adapter = new UserDeviceCacheSqliteAdapter(store.handle('msgstore.db'), { sourceOfTruth: true })
		adapter.set('5515991426667', devices)

		const db = store.handle('msgstore.db')
		const deviceCount = db.prepare('SELECT COUNT(*) AS n FROM user_device').get() as { n: number }
		const infoCount = db.prepare('SELECT COUNT(*) AS n FROM user_device_info').get() as { n: number }
		const jsonCount = db.prepare('SELECT COUNT(*) AS n FROM user_device_cache_json').get() as { n: number }
		const versionRow = db
			.prepare(
				'SELECT version FROM primary_device_version WHERE user_jid_row_id = (SELECT MIN(user_jid_row_id) FROM user_device_info)'
			)
			.get() as { version: number } | undefined
		expect(deviceCount.n).toBe(2)
		expect(infoCount.n).toBe(1)
		expect(jsonCount.n).toBe(1) // JSON mirror written too
		expect(versionRow?.version).toBe(1) // primary_device_version populated (matches real-device value)
	})

	it('typed read is value-identical to the JSON mirror (device 0 + domainType, no divergence)', () => {
		const adapter = new UserDeviceCacheSqliteAdapter(store.handle('msgstore.db'), { sourceOfTruth: true })
		// The real gateway shape carries user + device + domainType + server.
		const full = [
			{ user: '5515991426667', device: 0, domainType: 0, server: 's.whatsapp.net' },
			{ user: '5515991426667', device: 2, domainType: 0, server: 's.whatsapp.net' }
		]
		adapter.set('5515991426667', full)

		const db = store.handle('msgstore.db')
		const jsonValue = JSON.parse(
			(
				db.prepare('SELECT devices_json FROM user_device_cache_json WHERE user_jid = ?').get('5515991426667') as {
					devices_json: string
				}
			).devices_json
		)
		// Wipe the JSON mirror so the read must be served by the typed tables.
		db.prepare('DELETE FROM user_device_cache_json').run()

		// Byte-identical: primary device stays `0` (not undefined) and domainType
		// is preserved — the invariant the dual-write relies on.
		expect(adapter.get('5515991426667')).toEqual(jsonValue)
	})

	it('a non-device set clears the stale typed row (no shadowing)', () => {
		const adapter = new UserDeviceCacheSqliteAdapter(store.handle('msgstore.db'), { sourceOfTruth: true })
		adapter.set('5515991426667', devices) // writes the typed tables
		// Overwrite with an empty list (asDeviceList → null): the typed row MUST
		// be cleared, or the typed-first read would shadow this fresh value.
		adapter.set('5515991426667', [])

		const db = store.handle('msgstore.db')
		expect((db.prepare('SELECT COUNT(*) AS n FROM user_device').get() as { n: number }).n).toBe(0)
		expect(adapter.get('5515991426667')).toEqual([]) // fresh value, not the stale devices
	})

	it('reads back from the typed tables even when the JSON mirror is gone', () => {
		const adapter = new UserDeviceCacheSqliteAdapter(store.handle('msgstore.db'), { sourceOfTruth: true })
		adapter.set('5515991426667', devices)

		// Corruption test (mirrors the signal source-of-truth proof): destroy the
		// JSON fallback, keep the typed tables intact — a read must still succeed,
		// proving it comes from the typed tables, not the JSON mirror.
		store.handle('msgstore.db').prepare('DELETE FROM user_device_cache_json').run()

		const got = adapter.get<typeof devices>('5515991426667')!
		expect(got.map(normalize)).toEqual(devices.map(normalize))
		expect(adapter.fallbackStats.total).toBe(0) // served by typed, no fallback
	})

	it('del removes the typed rows too (no resurrection on next read)', () => {
		const adapter = new UserDeviceCacheSqliteAdapter(store.handle('msgstore.db'), { sourceOfTruth: true })
		adapter.set('5515991426667', devices)
		adapter.del('5515991426667')

		const db = store.handle('msgstore.db')
		expect((db.prepare('SELECT COUNT(*) AS n FROM user_device').get() as { n: number }).n).toBe(0)
		expect((db.prepare('SELECT COUNT(*) AS n FROM user_device_info').get() as { n: number }).n).toBe(0)
		expect(adapter.get('5515991426667')).toBeUndefined()
	})

	it('falls back to the JSON mirror for a pre-typed entry and counts it', () => {
		const adapter = new UserDeviceCacheSqliteAdapter(store.handle('msgstore.db'), { sourceOfTruth: true })
		// A JSON-only row (as written before the typed split) with no typed row.
		store
			.handle('msgstore.db')
			.prepare('INSERT INTO user_device_cache_json (user_jid, devices_json, expires_at) VALUES (?, ?, ?)')
			.run('legacyuser', JSON.stringify(devices), Date.now() + 60_000)

		expect(adapter.get('legacyuser')).toEqual(devices)
		expect(adapter.fallbackStats.total).toBe(1)
	})

	it('treats a stale typed entry as a miss (expected_timestamp elapsed)', () => {
		const adapter = new UserDeviceCacheSqliteAdapter(store.handle('msgstore.db'), {
			sourceOfTruth: true,
			defaultTtlSeconds: 1
		})
		adapter.set('5515991426667', devices, 1) // 1s TTL → expected_timestamp ~now+1s
		// Force the typed info row stale without waiting on a real timer.
		store
			.handle('msgstore.db')
			.prepare('UPDATE user_device_info SET expected_timestamp = ?')
			.run(Date.now() - 1000)
		// JSON mirror also stale → overall miss (caller refetches via USync).
		store
			.handle('msgstore.db')
			.prepare('UPDATE user_device_cache_json SET expires_at = ?')
			.run(Date.now() - 1000)

		expect(adapter.get('5515991426667')).toBeUndefined()
	})

	it('kill switch (sourceOfTruth:false) writes JSON only', () => {
		const adapter = new UserDeviceCacheSqliteAdapter(store.handle('msgstore.db'), { sourceOfTruth: false })
		adapter.set('5515991426667', devices)

		const db = store.handle('msgstore.db')
		expect((db.prepare('SELECT COUNT(*) AS n FROM user_device').get() as { n: number }).n).toBe(0)
		expect((db.prepare('SELECT COUNT(*) AS n FROM user_device_cache_json').get() as { n: number }).n).toBe(1)
		expect(adapter.get('5515991426667')).toEqual(devices)
	})
})
