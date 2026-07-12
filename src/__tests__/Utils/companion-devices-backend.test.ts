/**
 * `CompanionDevicesBackend` smoke tests — the own-device registration row in
 * `companion_devices.db`. InfiniteAPI stores a single row (itself) mapped from
 * the DeviceProps it declares at pairing. Exercises upsert (booleans → 0/1),
 * ON CONFLICT(device_id) dedupe (proves the schema's UNIQUE jid index), read,
 * and clear.
 */
import { mkdtemp, rm } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { CompanionDevicesBackend, MultiDbSqliteStore } from '../../Utils/multi-db-sqlite'

const DEVICE_ID = '5515991426667.0:12@s.whatsapp.net'

describe('CompanionDevicesBackend', () => {
	let dir: string
	let store: MultiDbSqliteStore
	let backend: CompanionDevicesBackend

	const countRows = () =>
		(store.handle('companion_devices.db').prepare('SELECT COUNT(*) AS n FROM devices').get() as { n: number }).n

	beforeEach(async () => {
		dir = await mkdtemp(join(tmpdir(), 'companion-devices-test-'))
		store = new MultiDbSqliteStore({ sessionDir: dir })
		await store.open()
		backend = new CompanionDevicesBackend(store.handle('companion_devices.db'))
	})

	afterEach(async () => {
		store.close()
		await rm(dir, { recursive: true, force: true })
	})

	it('upserts the own-device row with booleans stored as 0/1 and metadata', () => {
		backend.upsertOwnDevice({
			deviceId: DEVICE_ID,
			deviceOs: 'Chrome',
			platformType: 1,
			loginTime: 1_700_000_000,
			advKeyIndex: 46,
			fullSyncRequired: true,
			storageQuotaMb: 10240,
			supportCallLogHistory: false,
			supportBotUserAgentChatHistory: true,
			supportGroupHistory: false,
			supportMessageAssociation: true
		})

		const row = backend.getByDeviceId(DEVICE_ID)
		expect(row).not.toBeNull()
		expect(row!.device_os).toBe('Chrome')
		expect(row!.platform_type).toBe(1)
		expect(row!.login_time).toBe(1_700_000_000)
		expect(row!.logout_time).toBe(0)
		expect(row!.adv_key_index).toBe(46)
		expect(row!.full_sync_required).toBe(1)
		expect(row!.storage_quota_mb).toBe(10240)
		expect(row!.support_call_log_history).toBe(0)
		expect(row!.support_bot_user_agent_chat_history).toBe(1)
		expect(row!.support_group_history).toBe(0)
		expect(row!.support_message_association).toBe(1)

		expect(backend.getByDeviceId('other@s.whatsapp.net')).toBeNull()
	})

	it('ON CONFLICT(device_id) upserts a single row (reconnect refreshes login_time)', () => {
		backend.upsertOwnDevice({ deviceId: DEVICE_ID, loginTime: 1_700_000_000, advKeyIndex: 0 })
		backend.upsertOwnDevice({ deviceId: DEVICE_ID, loginTime: 1_700_000_999, advKeyIndex: 46 })
		expect(countRows()).toBe(1)

		const row = backend.getByDeviceId(DEVICE_ID)!
		expect(row.login_time).toBe(1_700_000_999)
		expect(row.adv_key_index).toBe(46)
	})

	it('clear wipes the row (logout)', () => {
		backend.upsertOwnDevice({ deviceId: DEVICE_ID })
		expect(countRows()).toBe(1)
		backend.clear()
		expect(countRows()).toBe(0)
	})
})
