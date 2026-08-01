/**
 * Typed backend for `devices` in `companion_devices.db`.
 *
 * On the mobile PRIMARY this table lists every linked companion with its
 * pairing metadata (platform, ADV key index, history-sync capability flags,
 * quotas). InfiniteAPI IS a companion, not the primary, so it does not own
 * other companions' registrations — but it DOES know its OWN, exactly: the
 * `DeviceProps` it declares during pairing (`buildCompanionDeviceProps`) plus
 * its device jid and ADV key index. So this backend stores a single row: this
 * client's own registration, with full, accurate metadata.
 *
 * Best-effort mirror with fallback: the write is wrapped at the call site (a
 * failure never affects pairing/connection) and the read returns null on miss
 * so the caller falls back to the live `DeviceProps` source. The row is keyed
 * by `device_id` (the schema's UNIQUE `companion_device_jid_index`), so a
 * reconnect upserts rather than duplicating.
 */
import type { SqliteDbLike, SqliteStatementLike } from './types'

/** The own-device registration mapped from `DeviceProps` + creds. Booleans are stored as 0/1. */
export type OwnDeviceRow = {
	deviceId: string
	deviceOs?: string | null
	platformType?: number | null
	loginTime?: number | null
	advKeyIndex?: number
	fullSyncRequired?: boolean
	fullSyncDaysLimit?: number | null
	fullSyncSizeMbLimit?: number | null
	storageQuotaMb?: number | null
	inlineInitialHistSyncPayloadEnabled?: boolean | null
	recentSyncDaysLimit?: number | null
	supportCallLogHistory?: boolean | null
	supportBotUserAgentChatHistory?: boolean
	supportCagReactionsAndPollsHistory?: boolean
	supportRecentSyncChunkMessageTuning?: boolean
	supportHostedGroupMsg?: boolean
	supportFbidBotChatHistory?: boolean
	supportBizHostedMsg?: boolean | null
	supportAddOnHistorySyncMigration?: boolean
	supportMessageAssociation?: boolean
	supportGroupHistory?: boolean
	supportGuestChat?: boolean | null
	onDemandReady?: boolean
	historySyncConfigProtobuf?: Uint8Array | null
	supportManusHistory?: boolean
	supportHatchHistory?: boolean
	supportedBotChannelFbids?: string[] | null
}

export type StoredCompanionDeviceRow = Record<string, unknown> & { device_id: string }

const b = (v: boolean | null | undefined): number | null => (v === null || v === undefined ? null : v ? 1 : 0)

export class CompanionDevicesBackend {
	private readonly stmts: {
		upsert: SqliteStatementLike
		select: SqliteStatementLike
		clear: SqliteStatementLike
	}

	private readonly db: SqliteDbLike

	constructor(db: SqliteDbLike) {
		this.db = db
		this.stmts = {
			// Keyed by device_id (schema's UNIQUE companion_device_jid_index).
			// logout_time is forced to 0 on our own live registration.
			upsert: this.db.prepare(
				'INSERT INTO devices (device_id, device_os, platform_type, login_time, logout_time, adv_key_index, ' +
					'full_sync_required, full_sync_days_limit, full_sync_size_mb_limit, storage_quota_mb, ' +
					'inline_initial_hist_sync_payload_enabled, recent_sync_days_limit, ' +
					'support_call_log_history, support_bot_user_agent_chat_history, support_cag_reactions_and_polls_history, ' +
					'support_recent_sync_chunk_message_tuning, support_hosted_group_msg, support_fbid_bot_chat_history, ' +
					'support_biz_hosted_msg, support_add_on_history_sync_migration, support_message_association, ' +
					'support_group_history, support_guest_chat, on_demand_ready, history_sync_config_protobuf, ' +
					'support_manus_history, support_hatch_history, supported_bot_channel_fbids) ' +
					'VALUES (?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ' +
					'ON CONFLICT(device_id) DO UPDATE SET ' +
					'  device_os = excluded.device_os, platform_type = excluded.platform_type, ' +
					'  login_time = excluded.login_time, logout_time = 0, adv_key_index = excluded.adv_key_index, ' +
					'  full_sync_required = excluded.full_sync_required, ' +
					'  full_sync_days_limit = excluded.full_sync_days_limit, ' +
					'  full_sync_size_mb_limit = excluded.full_sync_size_mb_limit, ' +
					'  storage_quota_mb = excluded.storage_quota_mb, ' +
					'  inline_initial_hist_sync_payload_enabled = excluded.inline_initial_hist_sync_payload_enabled, ' +
					'  recent_sync_days_limit = excluded.recent_sync_days_limit, ' +
					'  support_call_log_history = excluded.support_call_log_history, ' +
					'  support_bot_user_agent_chat_history = excluded.support_bot_user_agent_chat_history, ' +
					'  support_cag_reactions_and_polls_history = excluded.support_cag_reactions_and_polls_history, ' +
					'  support_recent_sync_chunk_message_tuning = excluded.support_recent_sync_chunk_message_tuning, ' +
					'  support_hosted_group_msg = excluded.support_hosted_group_msg, ' +
					'  support_fbid_bot_chat_history = excluded.support_fbid_bot_chat_history, ' +
					'  support_biz_hosted_msg = excluded.support_biz_hosted_msg, ' +
					'  support_add_on_history_sync_migration = excluded.support_add_on_history_sync_migration, ' +
					'  support_message_association = excluded.support_message_association, ' +
					'  support_group_history = excluded.support_group_history, ' +
					'  support_guest_chat = excluded.support_guest_chat, ' +
					'  on_demand_ready = excluded.on_demand_ready, ' +
					'  history_sync_config_protobuf = excluded.history_sync_config_protobuf, ' +
					'  support_manus_history = excluded.support_manus_history, ' +
					'  support_hatch_history = excluded.support_hatch_history, ' +
					'  supported_bot_channel_fbids = excluded.supported_bot_channel_fbids'
			),
			select: this.db.prepare('SELECT * FROM devices WHERE device_id = ?'),
			clear: this.db.prepare('DELETE FROM devices')
		}
	}

	/** Upsert this client's own device registration (single row). */
	upsertOwnDevice(row: OwnDeviceRow): void {
		this.stmts.upsert.run(
			row.deviceId,
			row.deviceOs ?? null,
			row.platformType ?? null,
			row.loginTime ?? null,
			row.advKeyIndex ?? 0,
			b(row.fullSyncRequired) ?? 0,
			row.fullSyncDaysLimit ?? null,
			row.fullSyncSizeMbLimit ?? null,
			row.storageQuotaMb ?? null,
			b(row.inlineInitialHistSyncPayloadEnabled),
			row.recentSyncDaysLimit ?? null,
			b(row.supportCallLogHistory),
			b(row.supportBotUserAgentChatHistory) ?? 0,
			b(row.supportCagReactionsAndPollsHistory) ?? 0,
			b(row.supportRecentSyncChunkMessageTuning) ?? 0,
			b(row.supportHostedGroupMsg) ?? 0,
			b(row.supportFbidBotChatHistory) ?? 0,
			b(row.supportBizHostedMsg),
			b(row.supportAddOnHistorySyncMigration) ?? 0,
			b(row.supportMessageAssociation) ?? 0,
			b(row.supportGroupHistory) ?? 0,
			b(row.supportGuestChat) ?? 0,
			b(row.onDemandReady) ?? 0,
			row.historySyncConfigProtobuf ?? null,
			b(row.supportManusHistory) ?? 0,
			b(row.supportHatchHistory) ?? 0,
			row.supportedBotChannelFbids === null || row.supportedBotChannelFbids === undefined
				? null
				: JSON.stringify(row.supportedBotChannelFbids)
		)
	}

	/** Reads a device row by device_id. Returns null on miss (→ fallback to live DeviceProps). */
	getByDeviceId(deviceId: string): StoredCompanionDeviceRow | null {
		return (this.stmts.select.get(deviceId) as StoredCompanionDeviceRow | undefined) ?? null
	}

	/** Wipes every row (e.g. logout). */
	clear(): void {
		this.stmts.clear.run()
	}
}
