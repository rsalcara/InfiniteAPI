/**
 * Schema for `stickers.db` — sticker pack catalog and recent/starred state.
 *
 * Tracks installed and downloadable sticker packs (including avatar and
 * lottie packs), per-pack ordering, recent + starred sticker history with
 * emoji-to-sticker reverse mapping, and 3rd-party sticker app integration
 * state. Column names match the canonical mobile schema verbatim.
 */
export const STICKERS_SCHEMA = `
CREATE TABLE IF NOT EXISTS android_metadata (locale TEXT);

CREATE TABLE IF NOT EXISTS avatar_sticker_search_dictionary (
  _id INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
  sticker_id TEXT NOT NULL DEFAULT '',
  tag TEXT NOT NULL DEFAULT '',
  weight INTEGER NOT NULL DEFAULT 0
);

CREATE UNIQUE INDEX IF NOT EXISTS avatar_sticker_search_index
  ON avatar_sticker_search_dictionary (tag, sticker_id);

CREATE TABLE IF NOT EXISTS downloadable_sticker_packs (
  id TEXT NOT NULL,
  name TEXT,
  publisher TEXT,
  description TEXT,
  size INTEGER NOT NULL DEFAULT 0,
  tray_image_id TEXT,
  tray_image_preview_id TEXT,
  preview_image_id_array TEXT,
  image_data_hash TEXT NOT NULL DEFAULT '',
  animated_pack INTEGER NOT NULL DEFAULT 0,
  lottie_pack INTEGER,
  premium_pack INTEGER,
  PRIMARY KEY(id)
);

CREATE TABLE IF NOT EXISTS installed_sticker_packs (
  installed_id TEXT NOT NULL,
  installed_name TEXT,
  installed_publisher TEXT,
  installed_description TEXT,
  installed_size INTEGER NOT NULL DEFAULT 0,
  installed_image_data_hash TEXT NOT NULL DEFAULT '',
  installed_tray_image_id TEXT NOT NULL DEFAULT '',
  installed_tray_image_preview_id TEXT,
  installed_animated_pack INTEGER NOT NULL DEFAULT 0,
  installed_is_avatar_pack INTEGER NOT NULL DEFAULT 0,
  installed_empty_favorites_avatar_template_id TEXT,
  installed_empty_recents_avatar_template_id TEXT,
  installed_lottie_pack INTEGER,
  installed_pack_type TEXT,
  is_created_by_me INTEGER,
  installed_premium_pack INTEGER,
  PRIMARY KEY(installed_id)
);

CREATE INDEX IF NOT EXISTS installed_sticker_packs_avatar_pack_index
  ON installed_sticker_packs (installed_is_avatar_pack);

CREATE TABLE IF NOT EXISTS new_sticker_packs (pack_id TEXT PRIMARY KEY NOT NULL);

CREATE TABLE IF NOT EXISTS recent_stickers (
  plaintext_hash TEXT NOT NULL,
  entry_weight REAL NOT NULL DEFAULT 0,
  hash_of_image_part TEXT,
  url TEXT,
  enc_hash TEXT,
  direct_path TEXT,
  mimetype TEXT,
  media_key TEXT,
  file_size INTEGER,
  width INTEGER,
  height INTEGER,
  emojis TEXT,
  is_first_party INTEGER,
  is_avocado INTEGER NOT NULL DEFAULT 0,
  last_sticker_sent_ts INTEGER NOT NULL DEFAULT 0,
  avatar_template_id TEXT,
  is_fun_sticker INTEGER,
  is_lottie INTEGER,
  accessibility_text TEXT,
  premium INTEGER DEFAULT 0,
  PRIMARY KEY(plaintext_hash)
);

CREATE INDEX IF NOT EXISTS recent_sticker_avatar_template_index
  ON recent_stickers (avatar_template_id);
CREATE INDEX IF NOT EXISTS recent_sticker_is_avocado_index
  ON recent_stickers (is_avocado);

CREATE TABLE IF NOT EXISTS starred_stickers (
  plaintext_hash TEXT NOT NULL,
  timestamp INTEGER,
  hash_of_image_part TEXT,
  url TEXT,
  enc_hash TEXT,
  direct_path TEXT,
  mimetype TEXT,
  media_key TEXT,
  file_size INTEGER,
  width INTEGER,
  height INTEGER,
  emojis TEXT,
  is_first_party INTEGER,
  is_avatar INTEGER NOT NULL DEFAULT 0,
  avatar_template_id TEXT,
  is_fun_sticker INTEGER,
  is_lottie INTEGER,
  accessibility_text TEXT,
  premium INTEGER DEFAULT 0,
  PRIMARY KEY(plaintext_hash)
);

CREATE INDEX IF NOT EXISTS starred_sticker_avatar_template_id_index
  ON starred_stickers (avatar_template_id);
CREATE INDEX IF NOT EXISTS starred_sticker_is_avatar_index
  ON starred_stickers (is_avatar);

CREATE TABLE IF NOT EXISTS sticker_pack_order (
  sticker_pack_id TEXT PRIMARY KEY NOT NULL,
  pack_order INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS stickers (
  plain_file_hash TEXT NOT NULL,
  encrypted_file_hash TEXT,
  media_key TEXT,
  mime_type TEXT,
  height INTEGER NOT NULL DEFAULT 0,
  width INTEGER NOT NULL DEFAULT 0,
  sticker_pack_id TEXT,
  file_path TEXT,
  url TEXT,
  file_size INTEGER,
  direct_path TEXT,
  emojis TEXT,
  hash_of_image_part TEXT,
  is_avatar INTEGER NOT NULL DEFAULT 0,
  avatar_template_id TEXT,
  is_fun_sticker INTEGER,
  is_lottie INTEGER,
  accessibility_text TEXT,
  order_in_pack INTEGER,
  premium INTEGER DEFAULT 0,
  PRIMARY KEY(plain_file_hash)
);

CREATE INDEX IF NOT EXISTS sticker_avatar_template_id_index
  ON stickers (avatar_template_id);
CREATE INDEX IF NOT EXISTS sticker_is_avatar_index
  ON stickers (is_avatar);
CREATE INDEX IF NOT EXISTS sticker_pack_id_index
  ON stickers (sticker_pack_id);

CREATE TABLE IF NOT EXISTS third_party_sticker_emoji_mapping (
  plaintext_hash TEXT NOT NULL,
  authority TEXT NOT NULL DEFAULT '',
  sticker_pack_id TEXT NOT NULL DEFAULT '',
  emojis TEXT,
  hash_of_image_part TEXT,
  PRIMARY KEY(plaintext_hash)
);

CREATE TABLE IF NOT EXISTS third_party_whitelist_packs (
  authority TEXT NOT NULL,
  sticker_pack_id TEXT NOT NULL,
  sticker_pack_name TEXT,
  sticker_pack_publisher TEXT,
  sticker_pack_image_data_hash TEXT,
  avoid_cache INTEGER,
  is_animated_pack INTEGER,
  PRIMARY KEY (authority, sticker_pack_id)
);

CREATE TABLE IF NOT EXISTS unseen_sticker_packs (pack_id TEXT PRIMARY KEY NOT NULL);
`
