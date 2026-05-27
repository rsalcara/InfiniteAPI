/**
 * Schema for `chatsettings.db` — per-chat preference and notification state.
 *
 * Mute state, notification routing, pin order, wallpaper selection,
 * disappearing media policy, transcription locale, snooze, and theme
 * binding live here. Column names match the canonical mobile schema
 * verbatim.
 */
export const CHATSETTINGS_SCHEMA = `
CREATE TABLE IF NOT EXISTS android_metadata (locale TEXT);

CREATE TABLE IF NOT EXISTS props (
  _id INTEGER PRIMARY KEY AUTOINCREMENT,
  prop_name TEXT UNIQUE,
  prop_value TEXT
);

CREATE TABLE IF NOT EXISTS settings (
  _id INTEGER PRIMARY KEY AUTOINCREMENT,
  jid TEXT,
  deleted INTEGER,
  mute_end INTEGER,
  muted_notifications BOOLEAN,
  use_custom_notifications BOOLEAN,
  message_tone TEXT,
  message_vibrate INTEGER,
  message_popup INTEGER,
  message_light INTEGER,
  call_tone TEXT,
  call_vibrate INTEGER,
  status_muted INTEGER,
  pinned BOOLEAN,
  pinned_time INTEGER,
  low_pri_notifications BOOLEAN,
  media_visibility INTEGER,
  mute_reactions INTEGER,
  wallpaper_light_type TEXT,
  wallpaper_light_value TEXT,
  wallpaper_dark_type TEXT,
  wallpaper_dark_value TEXT,
  wallpaper_dark_opacity INTEGER,
  notifications_auto_muted INTEGER NOT NULL DEFAULT 0,
  push_recording_button_mode INTEGER,
  call_mute_end_time INTEGER,
  auto_delete_media INTEGER,
  transcription_locale INTEGER,
  enable_auto_message_translations INTEGER NOT NULL DEFAULT 0,
  source_lang TEXT,
  target_lang TEXT,
  snooze_end_time INTEGER,
  theme_id TEXT,
  notification_activity_level INTEGER,
  notification_activity_banner_state INTEGER,
  last_chat_entry_timestamp_millis INTEGER,
  theme_bundle_id TEXT,
  mention_everyone_mute_end_time INTEGER
);

CREATE UNIQUE INDEX IF NOT EXISTS chatsettings_jid_index ON settings (jid);
CREATE INDEX IF NOT EXISTS settings_snooze_index ON settings (snooze_end_time);
`
