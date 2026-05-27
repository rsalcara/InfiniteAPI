/**
 * Phase 9.2 — `UserDeviceBackend` test.
 *
 * Verifies device list replacement (atomic delete-insert-upsert), TTL
 * staleness check via `expected_timestamp`, and the
 * `primary_device_version` short-circuit cache.
 */
import { mkdtemp, rm } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { MultiDbSqliteStore, UserDeviceBackend } from '../../Utils/multi-db-sqlite'

describe('UserDeviceBackend', () => {
	let dir: string
	let store: MultiDbSqliteStore

	beforeEach(async () => {
		dir = await mkdtemp(join(tmpdir(), 'user-device-test-'))
		store = new MultiDbSqliteStore({ sessionDir: dir })
		await store.open()
	})

	afterEach(async () => {
		store.close()
		await rm(dir, { recursive: true, force: true })
	})

	it('replaces device set atomically and lists them back', () => {
		const backend = new UserDeviceBackend(store.handle('msgstore.db'))
		backend.replaceDevices(
			42,
			[{ deviceJidRowId: 100, keyIndex: 1 }, { deviceJidRowId: 101, keyIndex: 2 }, { deviceJidRowId: 102 }],
			{ rawId: 7, timestamp: 1_000, expectedTimestamp: 5_000 }
		)

		const devices = backend.listDevices(42)
		expect(devices).toHaveLength(3)
		expect(devices.map(d => d.deviceJidRowId).sort()).toEqual([100, 101, 102])
		expect(devices.find(d => d.deviceJidRowId === 102)?.keyIndex).toBe(0)
	})

	it('isFresh respects expected_timestamp', () => {
		const backend = new UserDeviceBackend(store.handle('msgstore.db'))
		backend.replaceDevices(77, [{ deviceJidRowId: 999, keyIndex: 0 }], {
			rawId: 1,
			timestamp: 1_000,
			expectedTimestamp: 5_000
		})

		expect(backend.isFresh(77, 4_999)).toBe(true)
		expect(backend.isFresh(77, 5_000)).toBe(true) // boundary: inclusive
		expect(backend.isFresh(77, 5_001)).toBe(false)
		expect(backend.isFresh(999_999)).toBe(false) // unknown user
	})

	it('round-trips primary_device_version', () => {
		const backend = new UserDeviceBackend(store.handle('msgstore.db'))
		expect(backend.getPrimaryDeviceVersion(123)).toBeNull()

		backend.setPrimaryDeviceVersion(123, 7)
		expect(backend.getPrimaryDeviceVersion(123)).toBe(7)

		backend.setPrimaryDeviceVersion(123, 8)
		expect(backend.getPrimaryDeviceVersion(123)).toBe(8)
	})

	it('replaceDevices wipes old devices before inserting new', () => {
		const backend = new UserDeviceBackend(store.handle('msgstore.db'))
		backend.replaceDevices(55, [{ deviceJidRowId: 1 }, { deviceJidRowId: 2 }, { deviceJidRowId: 3 }], {
			rawId: 1,
			timestamp: 100,
			expectedTimestamp: 200
		})
		backend.replaceDevices(55, [{ deviceJidRowId: 99 }], { rawId: 2, timestamp: 300, expectedTimestamp: 400 })

		const devices = backend.listDevices(55)
		expect(devices).toHaveLength(1)
		expect(devices[0]?.deviceJidRowId).toBe(99)
	})
})
