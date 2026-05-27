/**
 * Schema for `companion_devices.db` — Multi-Device companion registry.
 *
 * Tracks each linked device with platform type, ADV key index, support
 * flags for history-sync features, and storage / sync quotas negotiated
 * during pairing. Column names match the canonical mobile schema verbatim.
 */
export const COMPANION_DEVICES_SCHEMA = `
CREATE TABLE IF NOT EXISTS android_metadata (locale TEXT);

CREATE TABLE IF NOT EXISTS devices (
  _id INTEGER PRIMARY KEY AUTOINCREMENT,
  device_id TEXT,
  device_os TEXT,
  platform_type INTEGER,
  last_active INTEGER,
  login_time INTEGER,
  logout_time INTEGER NOT NULL DEFAULT 0,
  adv_key_index INTEGER NOT NULL DEFAULT 0,
  full_sync_required INTEGER NOT NULL DEFAULT 0,
  place_name TEXT,
  nickname TEXT,
  support_bot_user_agent_chat_history INTEGER NOT NULL DEFAULT 0,
  support_cag_reactions_and_polls_history INTEGER NOT NULL DEFAULT 0,
  support_recent_sync_chunk_message_tuning INTEGER NOT NULL DEFAULT 0,
  support_hosted_group_msg INTEGER NOT NULL DEFAULT 0,
  support_fbid_bot_chat_history INTEGER NOT NULL DEFAULT 0,
  support_biz_hosted_msg INTEGER,
  support_call_log_history INTEGER,
  inline_initial_hist_sync_payload_enabled INTEGER,
  full_sync_days_limit INTEGER,
  full_sync_size_mb_limit INTEGER,
  storage_quota_mb INTEGER,
  recent_sync_days_limit INTEGER,
  companion_meta_nonce TEXT,
  support_add_on_history_sync_migration INTEGER NOT NULL DEFAULT 0,
  support_message_association INTEGER NOT NULL DEFAULT 0,
  support_group_history INTEGER NOT NULL DEFAULT 0,
  instrumentation_device_id TEXT,
  support_guest_chat INTEGER NOT NULL DEFAULT 0,
  on_demand_ready INTEGER NOT NULL DEFAULT 0,
  history_sync_config_protobuf BLOB,
  history_sync_access_type INTEGER NOT NULL DEFAULT 0,
  support_manus_history INTEGER NOT NULL DEFAULT 0,
  support_hatch_history INTEGER NOT NULL DEFAULT 0,
  supported_bot_channel_fbids TEXT
);

CREATE UNIQUE INDEX IF NOT EXISTS companion_device_jid_index ON devices (device_id);
`
