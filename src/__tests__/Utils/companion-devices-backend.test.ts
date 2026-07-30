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
import { proto } from '../../../WAProto/index.js'
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
		const historySyncConfig = proto.DeviceProps.HistorySyncConfig.fromObject({
			fullSyncDaysLimit: 365,
			onDemandReady: true,
			completeOnDemandReady: true,
			thumbnailSyncDaysLimit: 60,
			supportManusHistory: true,
			supportHatchHistory: true,
			supportedBotChannelFbids: []
		})
		backend.upsertOwnDevice({
			deviceId: DEVICE_ID,
			deviceOs: 'Windows',
			platformType: proto.DeviceProps.PlatformType.UWP,
			loginTime: 1_700_000_000,
			advKeyIndex: 46,
			fullSyncRequired: true,
			fullSyncDaysLimit: 365,
			supportCallLogHistory: true,
			supportBotUserAgentChatHistory: true,
			supportGroupHistory: true,
			supportMessageAssociation: true,
			onDemandReady: true,
			historySyncConfigProtobuf: proto.DeviceProps.HistorySyncConfig.encode(historySyncConfig).finish(),
			supportManusHistory: true,
			supportHatchHistory: true,
			supportedBotChannelFbids: []
		})

		const row = backend.getByDeviceId(DEVICE_ID)
		expect(row).not.toBeNull()
		expect(row!.device_os).toBe('Windows')
		expect(row!.platform_type).toBe(proto.DeviceProps.PlatformType.UWP)
		expect(row!.login_time).toBe(1_700_000_000)
		expect(row!.logout_time).toBe(0)
		expect(row!.adv_key_index).toBe(46)
		expect(row!.full_sync_required).toBe(1)
		expect(row!.full_sync_days_limit).toBe(365)
		expect(row!.storage_quota_mb).toBeNull()
		expect(row!.support_call_log_history).toBe(1)
		expect(row!.support_bot_user_agent_chat_history).toBe(1)
		expect(row!.support_group_history).toBe(1)
		expect(row!.support_message_association).toBe(1)
		expect(row!.on_demand_ready).toBe(1)
		expect(row!.support_manus_history).toBe(1)
		expect(row!.support_hatch_history).toBe(1)
		expect(row!.supported_bot_channel_fbids).toBe('[]')

		const mirroredConfig = proto.DeviceProps.HistorySyncConfig.decode(row!.history_sync_config_protobuf as Uint8Array)
		expect(mirroredConfig).toMatchObject({
			fullSyncDaysLimit: 365,
			onDemandReady: true,
			completeOnDemandReady: true,
			thumbnailSyncDaysLimit: 60,
			supportManusHistory: true,
			supportHatchHistory: true,
			supportedBotChannelFbids: []
		})

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
