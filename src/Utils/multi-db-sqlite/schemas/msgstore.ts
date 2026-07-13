/**
 * Schema for `msgstore.db` — JID routing, device cache, retry counters,
 * quarantine storage, and the real message store.
 *
 * Gateway scope (only tables that solve operational pain points; this is a
 * deliberate subset of the full mobile schema, which has ~292 tables):
 *
 *   - `jid` + `jid_map` — LID↔PN bidirectional mapping (target for phase
 *     9.1 `LIDMappingStore` migration)
 *   - `user_device` + `user_device_info` — companion device list with
 *     native TTL via `expected_timestamp` (target for phase 9.2)
 *   - `primary_device_version` — short-circuits device list refetch
 *   - `message_orphaned_edit` — `msgRetryCounterCache` persistence target
 *     (phase 9.3)
 *   - `message_quarantine` — quarantined stanzas survive restart for
 *     forensic replay or out-of-order retry (phase 9.4)
 *
 * Message store mirror — confirmed via live Frida capture on a real
 * Android primary device (2026-07-09, WhatsApp 2.26.22.8), cross-checked
 * against the canonical DDL dump in
 * `WABA-ANDROID-RE/analysis/wa-android-schemas/msgstore_db.sql`:
 *
 *   - `message` — the message store itself (1 row per message, keyed by
 *     `(chat_row_id, from_me, key_id, sender_jid_row_id)`)
 *   - `chat` — per-chat aggregate counters (unread count, last message,
 *     sort timestamp)
 *   - `message_details` — author device (multi-device attribution)
 *   - `message_secret` — 32-byte per-message key used to derive
 *     reaction/poll-vote/edit HMAC keys
 *   - `message_revoked` — "delete for everyone" — live capture confirms
 *     WA DELETEs the original row, re-INSERTs a tombstone at the SAME
 *     `_id` (message_type=15, text_data=null), then links it here via
 *     `revoked_key_id` (the ORIGINAL message's key_id)
 *   - `message_send_count` — outbound retry counter
 *   - `receipt_user` / `receipt_device` — delivery/read/played receipts,
 *     per-user (JID) and per-device
 *   - `receipt_orphaned` — receipt that arrived before its target message
 *     row existed (same holding-pen pattern as `message_orphaned_edit`)
 *   - `message_media` — media metadata (file path, mime type, dimensions,
 *     media key) for image/video/audio/document messages
 *   - `message_thumbnail` — media preview blob
 *   - `message_add_on` — parent row for reactions/poll-votes (satellite
 *     rows keyed by `message_add_on_row_id`)
 *   - `message_add_on_reaction` / `message_add_on_poll_vote` /
 *     `message_add_on_poll_vote_selected_option` /
 *     `message_add_on_receipt_device` — add-on satellites
 *   - `message_poll` / `message_poll_option` — poll creation + its options
 *   - `message_location` — static/live location messages
 *   - `message_vcard` / `message_vcard_jid` — contact-card messages
 *   - `lid_chat_state` — per-jid LID/PN sharing state
 *   - `audio_data` — voice-note waveform + transcription metadata
 *   - `media_refs` — ref-counted media file paths (dedup across messages)
 *   - `message_streaming_sidecar` — streamable-media (video) sidecar
 *   - `mms_thumbnail_metadata` — pre-download thumbnail (arrives before
 *     the full media)
 *   - `composition` — outbound-compose draft state (typing/recording)
 *   - `message_ui_elements` — parsed interactive-message UI (buttons,
 *     templates) for rendering
 *   - `message_ui_element_context` — gateway-only native-flow action metadata
 *     plus carousel card/button ordering, attached 1:1 to a UI-element row
 *
 * Explicitly NOT ported (same rationale as the original scoping note):
 * `message_ftsv2`/`wa_contacts_fts` (FTS virtual tables, no direct value
 * without a search feature), `reporting_info`/`reporting_info_content`
 * (Meta integrity tokens, privacy-sensitive), `backup_changes` (Google
 * Drive backup CDC log), `message_edit_info` (Baileys doesn't decode
 * message edits today, so there is no data to populate it with).
 *
 * Column names match the canonical mobile schema verbatim.
 */
export const MSGSTORE_SCHEMA = `
CREATE TABLE IF NOT EXISTS android_metadata (locale TEXT);

CREATE TABLE IF NOT EXISTS jid (
  _id INTEGER PRIMARY KEY AUTOINCREMENT,
  user TEXT NOT NULL,
  server TEXT NOT NULL,
  agent INTEGER,
  device INTEGER,
  type INTEGER,
  /* NOT NULL prevents two distinct failure modes —
     (1) SQLite treats NULL as DISTINCT inside a UNIQUE index, so any
         malformed insert path that produced NULL would silently create
         duplicate rows that the jid_raw_string_idx was supposed to
         prevent;
     (2) selectJidIdByRaw filters by WHERE raw_string = ?, and SQL
         NULL = NULL evaluates to UNKNOWN, so the row is never returned
         — rowIdFor would then throw "failed to materialize jid row"
         for every subsequent access.
     CREATE TABLE IF NOT EXISTS is a no-op when the table exists, so
     legacy databases keep the nullable column; new databases get the
     constraint enforced. */
  raw_string TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS jid_raw_string_idx ON jid (raw_string);
CREATE INDEX IF NOT EXISTS jid_user_server_idx ON jid (user, server);

CREATE TABLE IF NOT EXISTS jid_map (
  lid_row_id INTEGER PRIMARY KEY NOT NULL,
  jid_row_id INTEGER NOT NULL,
  /* NOT NULL DEFAULT 0 so a row inserted without an explicit sort_id
     can never end up as NULL. ORDER BY sort_id DESC ranks NULLs LAST
     in SQLite which would silently demote a freshly-inserted-but-NULL
     row below older ones — the opposite of the "last write wins"
     intent. upsertMap always provides a real epoch-ms tick so the
     default is just defensive against any future code path that
     bypasses upsertMap. */
  sort_id INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS jid_map_jid_row_id_idx ON jid_map (jid_row_id);

CREATE TABLE IF NOT EXISTS user_device (
  _id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_jid_row_id INTEGER,
  device_jid_row_id INTEGER,
  key_index INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS user_device_user_jid_row_id_idx
  ON user_device (user_jid_row_id);

CREATE TABLE IF NOT EXISTS user_device_info (
  user_jid_row_id INTEGER PRIMARY KEY,
  raw_id INTEGER NOT NULL,
  timestamp INTEGER NOT NULL,
  expected_timestamp INTEGER,
  expected_ts_last_device_job_ts INTEGER,
  expected_timestamp_update_ts INTEGER,
  account_encryption_type INTEGER
);

CREATE TABLE IF NOT EXISTS primary_device_version (
  user_jid_row_id INTEGER PRIMARY KEY,
  version INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS message_orphaned_edit (
  _id INTEGER PRIMARY KEY,
  key_id TEXT NOT NULL,
  from_me INTEGER NOT NULL,
  chat_row_id INTEGER NOT NULL,
  sender_jid_row_id INTEGER NOT NULL DEFAULT 0,
  timestamp INTEGER,
  message_type INTEGER NOT NULL,
  revoked_key_id TEXT,
  retry_count INTEGER,
  admin_jid_row_id INTEGER,
  orphan_message_data BLOB,
  reporting_token BLOB,
  reporting_tag BLOB,
  reporting_version INTEGER
);

CREATE INDEX IF NOT EXISTS message_orphaned_edit_chat_row_id_idx
  ON message_orphaned_edit (chat_row_id);

/* InfiniteAPI extension: quarantine storage for stanzas that failed to
   decrypt (e.g. Bad MAC), so they survive a restart and can be replayed
   forensically. The mobile schema does not carry a direct equivalent —
   this is a gateway-specific table colocated with the related routing
   tables for lock locality. */
CREATE TABLE IF NOT EXISTS message_quarantine (
  _id INTEGER PRIMARY KEY AUTOINCREMENT,
  key_id TEXT NOT NULL,
  from_me INTEGER NOT NULL DEFAULT 0,
  chat_row_id INTEGER NOT NULL,
  /* sender_jid_row_id is NOT NULL DEFAULT 0 so the UNIQUE constraint
     treats unknown-sender rows consistently; SQLite considers two NULLs
     distinct under UNIQUE, so a nullable column would let duplicate
     (key_id, from_me, chat_row_id, NULL) rows in. The 0 sentinel mirrors
     message_orphaned_edit. */
  sender_jid_row_id INTEGER NOT NULL DEFAULT 0,
  original_protobuf BLOB,
  serialized_stanza BLOB,
  failure_reason TEXT,
  quarantined_at INTEGER NOT NULL,
  retry_count INTEGER NOT NULL DEFAULT 0,
  UNIQUE(key_id, from_me, chat_row_id, sender_jid_row_id)
);

CREATE INDEX IF NOT EXISTS message_quarantine_chat_row_id_idx
  ON message_quarantine (chat_row_id);

/* InfiniteAPI extension: auxiliary cache tables for the NodeCache-shaped
   adapters (MsgRetryCounterSqliteAdapter, UserDeviceCacheSqliteAdapter).
   They are colocated on msgstore.db (instead of axolotl.db) because they
   are addressed by the same single-string key that messages-recv.ts /
   messages-send.ts already use, and live next to the routing tables
   (jid, jid_map, user_device) they cache. Owned by this schema file so
   runMigrations can ALTER them in a future phase without a special-case
   for "table created in adapter constructor". */
CREATE TABLE IF NOT EXISTS msg_retry_counter (
  key_id TEXT PRIMARY KEY,
  retry_count INTEGER NOT NULL DEFAULT 0,
  last_attempt INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS msg_retry_counter_expires_idx
  ON msg_retry_counter (expires_at);

CREATE TABLE IF NOT EXISTS user_device_cache_json (
  user_jid TEXT PRIMARY KEY,
  devices_json TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS user_device_cache_json_expires_idx
  ON user_device_cache_json (expires_at);

-- ============================================================
-- Message store mirror (see header comment above)
-- ============================================================

CREATE TABLE IF NOT EXISTS message (
  _id INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_row_id INTEGER NOT NULL,
  from_me INTEGER NOT NULL,
  key_id TEXT NOT NULL,
  sender_jid_row_id INTEGER,
  status INTEGER,
  broadcast INTEGER,
  recipient_count INTEGER,
  participant_hash TEXT,
  origination_flags INTEGER,
  origin INTEGER,
  timestamp INTEGER,
  received_timestamp INTEGER,
  receipt_server_timestamp INTEGER,
  message_type INTEGER,
  text_data TEXT,
  starred INTEGER,
  lookup_tables INTEGER,
  message_add_on_flags INTEGER,
  view_mode INTEGER,
  sort_id INTEGER NOT NULL DEFAULT 0,
  translated_text TEXT,
  view_replies_thread_id INTEGER,
  server_sts INTEGER
);

CREATE UNIQUE INDEX IF NOT EXISTS message_natural_key_idx
  ON message (chat_row_id, from_me, key_id, sender_jid_row_id);
CREATE INDEX IF NOT EXISTS message_chat_row_id_idx ON message (chat_row_id);
CREATE INDEX IF NOT EXISTS message_key_id_idx ON message (key_id);

CREATE TABLE IF NOT EXISTS chat (
  _id INTEGER PRIMARY KEY AUTOINCREMENT,
  jid_row_id INTEGER UNIQUE,
  hidden INTEGER,
  subject TEXT,
  created_timestamp INTEGER,
  display_message_row_id INTEGER,
  last_message_row_id INTEGER,
  last_read_message_row_id INTEGER,
  last_read_receipt_sent_message_row_id INTEGER,
  last_important_message_row_id INTEGER,
  archived INTEGER,
  sort_timestamp INTEGER,
  mod_tag INTEGER,
  gen REAL,
  spam_detection INTEGER,
  unseen_earliest_message_received_time INTEGER,
  unseen_message_count INTEGER,
  unseen_missed_calls_count INTEGER,
  unseen_row_count INTEGER,
  plaintext_disabled INTEGER,
  vcard_ui_dismissed INTEGER,
  change_number_notified_message_row_id INTEGER,
  show_group_description INTEGER,
  ephemeral_expiration INTEGER,
  ephemeral_setting_timestamp INTEGER,
  ephemeral_displayed_exemptions INTEGER,
  ephemeral_disappearing_messages_initiator INTEGER,
  unseen_important_message_count INTEGER NOT NULL DEFAULT 0,
  group_type INTEGER NOT NULL DEFAULT 0,
  last_message_reaction_row_id INTEGER,
  last_seen_message_reaction_row_id INTEGER,
  unseen_message_reaction_count INTEGER,
  unseen_comment_message_count INTEGER,
  growth_lock_level INTEGER,
  growth_lock_expiration_ts INTEGER,
  last_read_message_sort_id INTEGER,
  display_message_sort_id INTEGER,
  last_message_sort_id INTEGER,
  last_read_receipt_sent_message_sort_id INTEGER,
  has_new_community_admin_dialog_been_acknowledged INTEGER NOT NULL DEFAULT 0,
  history_sync_progress INTEGER,
  chat_lock INTEGER,
  chat_origin TEXT,
  participation_status INTEGER,
  account_jid_row_id INTEGER,
  chat_encryption_state INTEGER,
  group_member_count INTEGER,
  limited_sharing INTEGER,
  limited_sharing_setting_timestamp INTEGER,
  is_contact INTEGER,
  ephemeral_after_read_duration INTEGER,
  business_chat_state INTEGER
);

CREATE TABLE IF NOT EXISTS message_details (
  message_row_id INTEGER PRIMARY KEY,
  author_device_jid INTEGER
);

CREATE TABLE IF NOT EXISTS message_secret (
  message_row_id INTEGER PRIMARY KEY,
  message_secret BLOB
);

CREATE TABLE IF NOT EXISTS message_revoked (
  message_row_id INTEGER PRIMARY KEY,
  revoked_key_id TEXT NOT NULL,
  admin_jid_row_id INTEGER,
  revoke_timestamp INTEGER
);

CREATE INDEX IF NOT EXISTS message_revoked_revoked_key_id_idx
  ON message_revoked (revoked_key_id);

CREATE TABLE IF NOT EXISTS message_send_count (
  message_row_id INTEGER PRIMARY KEY,
  send_count INTEGER
);

CREATE TABLE IF NOT EXISTS receipt_user (
  _id INTEGER PRIMARY KEY AUTOINCREMENT,
  message_row_id INTEGER NOT NULL,
  receipt_user_jid_row_id INTEGER NOT NULL,
  receipt_timestamp INTEGER,
  read_timestamp INTEGER,
  played_timestamp INTEGER
);

CREATE UNIQUE INDEX IF NOT EXISTS receipt_user_natural_key_idx
  ON receipt_user (message_row_id, receipt_user_jid_row_id);

CREATE TABLE IF NOT EXISTS receipt_device (
  _id INTEGER PRIMARY KEY AUTOINCREMENT,
  message_row_id INTEGER NOT NULL,
  receipt_device_jid_row_id INTEGER NOT NULL,
  receipt_device_timestamp INTEGER,
  primary_device_version INTEGER
);

CREATE UNIQUE INDEX IF NOT EXISTS receipt_device_natural_key_idx
  ON receipt_device (message_row_id, receipt_device_jid_row_id);

CREATE TABLE IF NOT EXISTS receipt_orphaned (
  _id INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_row_id INTEGER NOT NULL,
  from_me INTEGER NOT NULL,
  key_id TEXT NOT NULL,
  receipt_device_jid_row_id INTEGER NOT NULL,
  receipt_recipient_jid_row_id INTEGER,
  status INTEGER,
  timestamp INTEGER
);

CREATE INDEX IF NOT EXISTS receipt_orphaned_key_id_idx ON receipt_orphaned (key_id);

CREATE TABLE IF NOT EXISTS message_media (
  message_row_id INTEGER PRIMARY KEY,
  chat_row_id INTEGER,
  autotransfer_retry_enabled INTEGER,
  transferred INTEGER,
  face_x INTEGER,
  face_y INTEGER,
  has_streaming_sidecar INTEGER,
  page_count INTEGER,
  thumbnail_height_width_ratio REAL,
  first_scan_sidecar BLOB,
  first_scan_length INTEGER,
  message_url TEXT,
  media_upload_handle TEXT,
  sticker_flags INTEGER,
  raw_transcription_text TEXT,
  first_viewed_timestamp INTEGER,
  is_animated_sticker INTEGER,
  premium_message INTEGER,
  media_caption TEXT,
  metadata_url TEXT,
  motion_photo_presentation_offset_ms INTEGER,
  qr_url TEXT,
  media_key_domain INTEGER,
  e2ee_media_key BLOB,
  emoji_tags TEXT,
  multicast_id TEXT,
  media_job_uuid TEXT,
  transcoded INTEGER,
  file_path TEXT,
  file_size INTEGER,
  suspicious_content INTEGER,
  trim_from INTEGER,
  trim_to INTEGER,
  media_key BLOB,
  media_key_timestamp INTEGER,
  width INTEGER,
  height INTEGER,
  gif_attribution INTEGER,
  direct_path TEXT,
  mime_type TEXT,
  file_length INTEGER,
  media_name TEXT,
  file_hash TEXT,
  media_duration INTEGER,
  enc_file_hash TEXT,
  partial_media_hash TEXT,
  partial_media_enc_hash TEXT,
  original_file_hash TEXT,
  mute_video INTEGER DEFAULT 0,
  doodle_id TEXT,
  media_source_type INTEGER,
  accessibility_label TEXT,
  media_transcode_quality INTEGER DEFAULT 0
);

CREATE TABLE IF NOT EXISTS message_thumbnail (
  message_row_id INTEGER PRIMARY KEY,
  thumbnail BLOB
);

CREATE TABLE IF NOT EXISTS message_add_on (
  _id INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_row_id INTEGER,
  from_me INTEGER,
  key_id TEXT NOT NULL,
  sender_jid_row_id INTEGER,
  parent_message_row_id INTEGER,
  timestamp INTEGER,
  status INTEGER,
  message_add_on_type INTEGER,
  received_timestamp INTEGER,
  expiry_duration_in_secs INTEGER,
  server_timestamp INTEGER,
  expiry_timestamp INTEGER,
  expiry_type INTEGER
);

CREATE INDEX IF NOT EXISTS message_add_on_parent_message_row_id_idx
  ON message_add_on (parent_message_row_id);
CREATE UNIQUE INDEX IF NOT EXISTS message_add_on_natural_key_idx
  ON message_add_on (chat_row_id, from_me, key_id, sender_jid_row_id);

CREATE TABLE IF NOT EXISTS message_add_on_reaction (
  message_add_on_row_id INTEGER PRIMARY KEY,
  reaction TEXT,
  sender_timestamp INTEGER
);

CREATE TABLE IF NOT EXISTS message_add_on_poll_vote (
  message_add_on_row_id INTEGER PRIMARY KEY,
  sender_timestamp INTEGER
);

CREATE TABLE IF NOT EXISTS message_add_on_poll_vote_selected_option (
  _id INTEGER PRIMARY KEY AUTOINCREMENT,
  message_add_on_row_id INTEGER,
  message_poll_option_id INTEGER
);

CREATE INDEX IF NOT EXISTS message_add_on_poll_vote_selected_option_row_id_idx
  ON message_add_on_poll_vote_selected_option (message_add_on_row_id);

CREATE TABLE IF NOT EXISTS message_add_on_receipt_device (
  receipt_device_id INTEGER PRIMARY KEY AUTOINCREMENT,
  message_add_on_row_id INTEGER,
  receipt_device_jid_row_id INTEGER,
  receipt_device_timestamp INTEGER,
  primary_device_version INTEGER
);

CREATE UNIQUE INDEX IF NOT EXISTS message_add_on_receipt_device_unique_idx
  ON message_add_on_receipt_device (message_add_on_row_id, receipt_device_jid_row_id);

CREATE TABLE IF NOT EXISTS message_poll (
  message_row_id INTEGER PRIMARY KEY,
  enc_key BLOB,
  selectable_options_count INTEGER,
  invalid_state INTEGER NOT NULL DEFAULT 0,
  poll_logging_id INTEGER NOT NULL DEFAULT 0,
  poll_type INTEGER,
  correct_option_id INTEGER,
  content_type INTEGER,
  hide_participant_names INTEGER,
  end_time INTEGER,
  allow_add_option INTEGER
);

CREATE TABLE IF NOT EXISTS message_poll_option (
  _id INTEGER PRIMARY KEY AUTOINCREMENT,
  message_row_id INTEGER,
  option_sha256 TEXT,
  option_name TEXT,
  vote_total INTEGER,
  option_hash TEXT
);

CREATE INDEX IF NOT EXISTS message_poll_option_message_row_id_idx
  ON message_poll_option (message_row_id);

CREATE TABLE IF NOT EXISTS message_location (
  message_row_id INTEGER PRIMARY KEY,
  chat_row_id INTEGER,
  latitude REAL,
  longitude REAL,
  place_name TEXT,
  place_address TEXT,
  url TEXT,
  live_location_share_duration INTEGER,
  live_location_sequence_number INTEGER,
  live_location_final_latitude REAL,
  live_location_final_longitude REAL,
  live_location_final_timestamp INTEGER,
  map_download_status INTEGER
);

CREATE TABLE IF NOT EXISTS message_vcard (
  _id INTEGER PRIMARY KEY AUTOINCREMENT,
  message_row_id INTEGER,
  vcard TEXT
);

CREATE INDEX IF NOT EXISTS message_vcard_message_row_id_idx
  ON message_vcard (message_row_id);

CREATE TABLE IF NOT EXISTS message_vcard_jid (
  _id INTEGER PRIMARY KEY AUTOINCREMENT,
  vcard_jid_row_id INTEGER,
  vcard_row_id INTEGER,
  message_row_id INTEGER
);

CREATE TABLE IF NOT EXISTS lid_chat_state (
  jid_row_id INTEGER PRIMARY KEY NOT NULL,
  is_pn_shared INTEGER NOT NULL DEFAULT 0,
  pn_requested_ts INTEGER NOT NULL DEFAULT 0,
  pnh_duplicate_lid_thread INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS audio_data (
  message_row_id INTEGER PRIMARY KEY,
  waveform BLOB,
  background_color INTEGER NOT NULL DEFAULT 0,
  background_color_changed INTEGER DEFAULT 0,
  transcription_status INTEGER,
  transcription_locale INTEGER,
  transcription_confidence_threshold INTEGER,
  transcription_request_locale INTEGER,
  transcription_feedback_submitted INTEGER,
  transcription_id TEXT
);

CREATE TABLE IF NOT EXISTS transcription_segment (
  _id INTEGER PRIMARY KEY AUTOINCREMENT,
  message_row_id INTEGER NOT NULL,
  substring_start INTEGER NOT NULL,
  substring_length INTEGER NOT NULL,
  timestamp INTEGER,
  duration INTEGER,
  confidence INTEGER
);

CREATE INDEX IF NOT EXISTS transcription_segment_message_row_id_idx
  ON transcription_segment (message_row_id);

CREATE TABLE IF NOT EXISTS media_refs (
  _id INTEGER PRIMARY KEY AUTOINCREMENT,
  path TEXT UNIQUE,
  ref_count INTEGER
);

CREATE TABLE IF NOT EXISTS message_streaming_sidecar (
  message_row_id INTEGER PRIMARY KEY,
  sidecar BLOB,
  chunk_lengths BLOB,
  timestamp INTEGER
);

CREATE TABLE IF NOT EXISTS mms_thumbnail_metadata (
  message_row_id INTEGER PRIMARY KEY,
  direct_path TEXT,
  media_key BLOB,
  media_key_timestamp INTEGER,
  enc_thumb_hash TEXT,
  thumb_hash TEXT,
  thumb_width INTEGER,
  thumb_height INTEGER,
  transferred INTEGER,
  micro_thumbnail BLOB,
  insert_timestamp INTEGER,
  handle TEXT
);

CREATE TABLE IF NOT EXISTS composition (
  _id INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_row_id INTEGER NOT NULL,
  quoted_message_row_id INTEGER,
  timestamp INTEGER NOT NULL,
  message_type INTEGER NOT NULL,
  composition_type INTEGER NOT NULL,
  text TEXT,
  lookup_tables INTEGER NOT NULL DEFAULT 0,
  last_seen_timestamp INTEGER
);

CREATE TABLE IF NOT EXISTS message_ui_elements (
  _id INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
  message_row_id INTEGER NOT NULL,
  element_type INTEGER,
  element_content TEXT,
  description TEXT,
  template_id TEXT,
  hsm_tag TEXT,
  footer_text TEXT,
  button_text TEXT,
  message_type INTEGER
);

CREATE INDEX IF NOT EXISTS message_ui_elements_message_row_id_idx
  ON message_ui_elements (message_row_id);

-- Gateway-only context for native-flow buttons (the action key, plus card and
-- button order for carousels). Kept separate from message_ui_elements so the
-- mobile-compatible row shape and every existing consumer remain unchanged.
CREATE TABLE IF NOT EXISTS message_ui_element_context (
  ui_element_row_id INTEGER PRIMARY KEY NOT NULL,
  container_type TEXT CHECK (container_type = 'carousel'),
  card_index INTEGER CHECK (card_index >= 0),
  button_index INTEGER CHECK (button_index >= 0),
  native_flow_name TEXT,
  CHECK (
    (container_type IS NULL AND card_index IS NULL AND button_index IS NULL)
    OR (container_type = 'carousel' AND card_index IS NOT NULL AND button_index IS NOT NULL)
  ),
  CHECK (container_type IS NOT NULL OR native_flow_name IS NOT NULL),
  FOREIGN KEY (ui_element_row_id) REFERENCES message_ui_elements (_id) ON DELETE CASCADE
);
`
