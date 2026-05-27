/**
 * Schema for `media.db` — media metadata + transfer state.
 *
 * Stores media job state (uploads/downloads with reupload retry tracking),
 * Express Path download cache, draft voice notes, recent searches, and
 * cross-session shared media identifiers. Column names match the canonical
 * mobile schema verbatim.
 */
export const MEDIA_SCHEMA = `
CREATE TABLE IF NOT EXISTS android_metadata (locale TEXT);

CREATE TABLE IF NOT EXISTS draft_voice_note_metadata (
  chat_jid TEXT PRIMARY KEY NOT NULL,
  page_number INTEGER
);

CREATE TABLE IF NOT EXISTS express_path_download_data (
  enc_file_hash TEXT PRIMARY KEY NOT NULL,
  ep_saved_time_ms INTEGER,
  ep_saved_bytes INTEGER,
  download_state INTEGER,
  last_update_time INTEGER,
  enc_file_restored INTEGER DEFAULT 0
);

CREATE INDEX IF NOT EXISTS enc_file_hash_index
  ON express_path_download_data (enc_file_hash);

CREATE TABLE IF NOT EXISTS media_job (
  _id INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
  uuid TEXT NOT NULL DEFAULT '',
  job_type INTEGER,
  create_time INTEGER,
  transfer_start_time INTEGER,
  last_update_time INTEGER,
  user_initiated_attempt_count INTEGER,
  overall_cumulative_time INTEGER,
  overall_cumulative_user_visible_time INTEGER,
  streaming_playback_count INTEGER,
  media_key_reuse_type INTEGER,
  doodle_id TEXT,
  transferred_bytes INTEGER,
  reupload_attempt_count INTEGER,
  last_reupload_attempt_timestamp INTEGER,
  last_reupload_success_timestamp INTEGER
);

CREATE TABLE IF NOT EXISTS recent_searches (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  search_query TEXT NOT NULL DEFAULT '',
  search_entry_point TEXT NOT NULL DEFAULT '',
  timestamp INTEGER NOT NULL DEFAULT 0,
  UNIQUE(search_query, search_entry_point)
);

CREATE INDEX IF NOT EXISTS idx_recent_searches_search_entry_point
  ON recent_searches (search_entry_point);
CREATE INDEX IF NOT EXISTS idx_recent_searches_timestamp
  ON recent_searches (timestamp DESC);

CREATE TABLE IF NOT EXISTS shared_media_ids (
  item_uuid TEXT PRIMARY KEY NOT NULL,
  file_name TEXT NOT NULL DEFAULT '',
  mime_type TEXT NOT NULL DEFAULT '',
  display_name TEXT,
  expiration_timestamp INTEGER NOT NULL DEFAULT 0
);
`
