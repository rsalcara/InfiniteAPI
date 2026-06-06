/**
 * Schema for `status.db` — Status (24h feed) + channel-crosspost state.
 *
 * Mirrors the canonical mobile schema discovered on WA Business 2.26.21.75
 * via Frida (the verbatim mobile dump captured at the same time is preserved
 * outside the repo for future reference). The mobile DB has ~25 tables; we
 * ship the core subset that any Baileys status / channel-crosspost feature
 * would touch — `status` (the root feed), `status_attribution` (channel-
 * crosspost reference), `status_info` (per-chat aggregates), the read-receipt
 * + privacy + media-link companion tables, and the `status_crossposting_v3`
 * outbound queue. Remaining tables (reporting, orphan, interactions, add_on,
 * etc.) can be appended in future PRs as concrete callers land — the
 * bookkeeping schema-migrations helper lets new tables be introduced safely
 * against existing databases.
 *
 * State machine for `status.state` (empirical):
 *   0 → creating / uploading
 *   1 → sent locally (queued for server)
 *   3 → server-confirmed receipt
 *   6 → expired / deleted
 *
 * `status.type` observed values:
 *   4 → standard photo/text/crosspost (dominant)
 *   5 → variant (other senders, flags=32)
 *
 * `status_attribution.type` observed values:
 *   1 → newsletter / channel crosspost (proto ~43 bytes)
 *   3 → other variant (16–111 byte protos)
 *
 * Column names match the canonical mobile schema verbatim.
 */
export const STATUS_SCHEMA = `
CREATE TABLE IF NOT EXISTS android_metadata (locale TEXT);

CREATE TABLE IF NOT EXISTS status (
  row_id INTEGER PRIMARY KEY AUTOINCREMENT,
  sort_id INTEGER NOT NULL,
  uuid TEXT NOT NULL,
  sender_user_jid TEXT NOT NULL,
  status_info_row_id INTEGER NOT NULL,
  type INTEGER NOT NULL,
  timestamp INTEGER NOT NULL,
  server_receipt_timestamp INTEGER,
  text_data TEXT,
  state INTEGER NOT NULL,
  secret BLOB,
  content_proto BLOB,
  fp_proto BLOB,
  origin INTEGER NOT NULL,
  flags INTEGER NOT NULL,
  audience_type INTEGER NOT NULL DEFAULT 0,
  is_archived INTEGER NOT NULL,
  stanza_xml BLOB,
  received_timestamp INTEGER
);

CREATE INDEX IF NOT EXISTS status_is_archived_index ON status (is_archived);
CREATE UNIQUE INDEX IF NOT EXISTS status_info_sort_id_index
  ON status (status_info_row_id, sort_id);

CREATE TABLE IF NOT EXISTS status_attribution (
  row_id INTEGER PRIMARY KEY AUTOINCREMENT,
  status_row_id INTEGER NOT NULL,
  type INTEGER NOT NULL,
  content_proto BLOB
);

CREATE INDEX IF NOT EXISTS status_attribution_index
  ON status_attribution (status_row_id);

CREATE TABLE IF NOT EXISTS status_crossposting_v3 (
  row_id INTEGER PRIMARY KEY AUTOINCREMENT,
  status_row_id INTEGER,
  crossposting_session_id TEXT,
  crossposting_status_unique_id TEXT,
  state INTEGER,
  media_file_path TEXT,
  direct_url_path TEXT,
  destination INTEGER
);

CREATE UNIQUE INDEX IF NOT EXISTS status_crossposting_v3_index
  ON status_crossposting_v3 (status_row_id, destination);
CREATE INDEX IF NOT EXISTS status_crossposting_v3_state_index
  ON status_crossposting_v3 (state);

CREATE TABLE IF NOT EXISTS status_info (
  row_id INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_jid TEXT NOT NULL,
  total_count INTEGER NOT NULL,
  unread_count INTEGER NOT NULL,
  last_status_sort_id INTEGER,
  first_unread_sort_id INTEGER,
  is_muted INTEGER NOT NULL,
  last_status_timestamp INTEGER,
  pending_count INTEGER,
  failed_count INTEGER,
  type INTEGER NOT NULL DEFAULT 0,
  unread_count_close_friends INTEGER NOT NULL DEFAULT 0
);

CREATE UNIQUE INDEX IF NOT EXISTS status_info_chat_index ON status_info (chat_jid);
CREATE INDEX IF NOT EXISTS status_info_last_status_sort_id_index
  ON status_info (last_status_sort_id);
CREATE INDEX IF NOT EXISTS status_info_type_index ON status_info (type);

CREATE TABLE IF NOT EXISTS status_text (
  status_row_id INTEGER PRIMARY KEY,
  url TEXT,
  page_title TEXT,
  page_description TEXT,
  font_style INTEGER,
  text_color INTEGER,
  background_color INTEGER,
  preview_type INTEGER,
  invite_link_group_type INTEGER,
  thumbnail BLOB,
  text_content_proto BLOB
);

CREATE TABLE IF NOT EXISTS status_media_link (
  row_id INTEGER PRIMARY KEY AUTOINCREMENT,
  status_row_id INTEGER NOT NULL,
  media_content_row_id INTEGER NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS status_media_link_index
  ON status_media_link (status_row_id, media_content_row_id);
CREATE INDEX IF NOT EXISTS status_media_link_media_content_row_id_index
  ON status_media_link (media_content_row_id);

CREATE TABLE IF NOT EXISTS status_thumbnail (
  row_id INTEGER PRIMARY KEY AUTOINCREMENT,
  status_row_id INTEGER NOT NULL,
  media_content_row_id INTEGER,
  thumbnail BLOB,
  thumbnail_path TEXT,
  highres_thumbnail_path TEXT
);

CREATE INDEX IF NOT EXISTS status_thumbnail_status_row_id_index
  ON status_thumbnail (status_row_id);
CREATE INDEX IF NOT EXISTS status_thumbnail_media_content_row_id_index
  ON status_thumbnail (media_content_row_id);

CREATE TABLE IF NOT EXISTS status_seen_receipt (
  row_id INTEGER PRIMARY KEY AUTOINCREMENT,
  status_row_id INTEGER,
  receipt_user_jid TEXT NOT NULL,
  received_timestamp INTEGER,
  seen_timestamp INTEGER
);

CREATE UNIQUE INDEX IF NOT EXISTS status_seen_receipt_index
  ON status_seen_receipt (status_row_id, receipt_user_jid);

CREATE TABLE IF NOT EXISTS status_privacy_custom_list (
  row_id INTEGER PRIMARY KEY AUTOINCREMENT,
  list_id TEXT NOT NULL,
  name TEXT,
  emoji TEXT,
  is_selected INTEGER NOT NULL DEFAULT 0,
  member_jids TEXT,
  source_group_jids TEXT,
  allow_list_selected INTEGER
);

CREATE UNIQUE INDEX IF NOT EXISTS status_privacy_custom_list_list_id_index
  ON status_privacy_custom_list (list_id);

CREATE TABLE IF NOT EXISTS key_value_store (
  row_id INTEGER PRIMARY KEY AUTOINCREMENT,
  key TEXT NOT NULL UNIQUE,
  value TEXT
);

CREATE TABLE IF NOT EXISTS props (
  _id INTEGER PRIMARY KEY AUTOINCREMENT,
  prop_name TEXT UNIQUE,
  prop_value TEXT
);
`
