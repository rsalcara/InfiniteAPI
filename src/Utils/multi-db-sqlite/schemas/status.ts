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

-- AFTER DELETE triggers on \`status\` — ported VERBATIM from the canonical mobile
-- schema (WA Business 2.26.21.75). They keep \`status_info\`'s aggregate columns
-- consistent when a status row is deleted (e.g. by the 24h expiry prune), exactly
-- like the real app does — so a bulk \`DELETE FROM status WHERE timestamp < ?\`
-- self-maintains total_count/unread_count/last_status_*/first_unread_sort_id
-- instead of leaving them stale. We port only the DELETE-side triggers: the
-- INSERT counting is done manually by StatusBackend.recordReceivedStatus (adding
-- the mobile's AFTER INSERT triggers too would double-count). \`CREATE TRIGGER IF
-- NOT EXISTS\` is idempotent — the base schema is re-exec'd on every open, so
-- existing status.db files pick these up on upgrade.
CREATE TRIGGER IF NOT EXISTS status_ad_for_status_info_total_count_trigger
  AFTER DELETE ON status
  WHEN old.type <> 8 AND old.type <> 2 AND old.is_archived = 0
  BEGIN
    UPDATE status_info SET total_count = total_count - 1
      WHERE row_id = old.status_info_row_id AND total_count > 0;
  END;

CREATE TRIGGER IF NOT EXISTS status_ad_for_status_info_unread_count_trigger
  AFTER DELETE ON status
  WHEN old.type <> 8 AND old.type <> 2 AND old.is_archived = 0 AND old.state <= 4
  BEGIN
    UPDATE status_info
      SET unread_count = unread_count - 1,
      unread_count_close_friends = CASE
        WHEN (old.audience_type = 1 OR old.audience_type = 2) AND unread_count_close_friends > 0
          THEN unread_count_close_friends - 1
        ELSE unread_count_close_friends
      END
      WHERE row_id = old.status_info_row_id AND unread_count > 0;
  END;

CREATE TRIGGER IF NOT EXISTS status_ad_for_status_info_last_status_sort_id_trigger
  AFTER DELETE ON status
  BEGIN
    UPDATE status_info
      SET last_status_sort_id = (SELECT MAX(sort_id) FROM status
        WHERE status_info_row_id = old.status_info_row_id
        AND type <> 8 AND type <> 2 AND is_archived = 0)
      WHERE row_id = old.status_info_row_id AND last_status_sort_id = old.sort_id;
  END;

CREATE TRIGGER IF NOT EXISTS status_ad_for_status_info_last_status_timestamp_trigger
  AFTER DELETE ON status
  BEGIN
    UPDATE status_info
      SET last_status_timestamp = (SELECT
        CASE WHEN COALESCE(server_receipt_timestamp, 0) > 0 THEN server_receipt_timestamp ELSE timestamp END
        FROM status
        WHERE status_info_row_id = old.status_info_row_id
        AND type <> 8 AND type <> 2 AND is_archived = 0
        ORDER BY sort_id DESC LIMIT 1)
      WHERE row_id = old.status_info_row_id AND last_status_sort_id = old.sort_id;
  END;

CREATE TRIGGER IF NOT EXISTS status_ad_for_status_info_first_unread_sort_id_trigger
  AFTER DELETE ON status
  BEGIN
    UPDATE status_info
      SET first_unread_sort_id = (SELECT MIN(sort_id) FROM status
        WHERE status_info_row_id = old.status_info_row_id
        AND type <> 8 AND type <> 2 AND is_archived = 0
        AND (state <> 5 AND state <> 6))
      WHERE row_id = old.status_info_row_id AND first_unread_sort_id = old.sort_id;
  END;

-- BEFORE DELETE cascade to the child table we populate (verbatim from mobile).
CREATE TRIGGER IF NOT EXISTS status_bd_for_status_seen_receipt_trigger
  BEFORE DELETE ON status
  BEGIN
    DELETE FROM status_seen_receipt WHERE status_row_id = old.row_id;
  END;
`
