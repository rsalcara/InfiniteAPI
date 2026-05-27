/**
 * Schema for `wa.db` — auxiliary store: contacts, Trusted Contact tokens,
 * business profile cache.
 *
 * Gateway scope:
 *   - `wa_contacts` — contact directory (target for phase 9.6 indirectly)
 *   - `wa_trusted_contacts` / `wa_trusted_contacts_send` — TC token
 *     persistence (incoming + outgoing per-recipient state) for the biz
 *     `quality_control` envelope (phase 9.6)
 *
 * Column names match the canonical mobile schema verbatim.
 */
export const WA_SCHEMA = `
CREATE TABLE IF NOT EXISTS android_metadata (locale TEXT);

CREATE TABLE IF NOT EXISTS wa_contacts (
  _id INTEGER PRIMARY KEY AUTOINCREMENT,
  jid TEXT NOT NULL,
  is_whatsapp_user BOOLEAN NOT NULL,
  status TEXT,
  status_timestamp INTEGER,
  number TEXT,
  raw_contact_id INTEGER,
  display_name TEXT,
  phone_type INTEGER,
  phone_label TEXT,
  photo_ts INTEGER,
  thumb_ts INTEGER,
  photo_id_timestamp INTEGER,
  given_name TEXT,
  family_name TEXT,
  wa_name TEXT,
  sort_name TEXT,
  nickname TEXT,
  company TEXT,
  title TEXT,
  status_autodownload_disabled INTEGER,
  keep_timestamp INTEGER,
  is_spam_reported INTEGER,
  is_sidelist_synced BOOLEAN DEFAULT 0,
  is_business_synced BOOLEAN DEFAULT 0,
  disappearing_mode_duration INTEGER,
  disappearing_mode_timestamp INTEGER,
  disappearing_mode_support_disabled INTEGER,
  is_starred BOOLEAN,
  is_wa_created_contact BOOLEAN,
  sync_policy INTEGER,
  status_emoji TEXT,
  is_contact_synced INTEGER,
  is_reachable INTEGER,
  external_user_state INTEGER
);

CREATE INDEX IF NOT EXISTS wa_contacts_jid_idx ON wa_contacts (jid);
CREATE INDEX IF NOT EXISTS wa_contacts_is_wa_idx ON wa_contacts (is_whatsapp_user);
CREATE INDEX IF NOT EXISTS wa_contacts_is_contact_synced_idx
  ON wa_contacts (is_contact_synced);

CREATE TABLE IF NOT EXISTS wa_trusted_contacts (
  jid TEXT PRIMARY KEY NOT NULL,
  incoming_tc_token BLOB NOT NULL,
  incoming_tc_token_timestamp INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS incoming_tc_token_timestamp_index
  ON wa_trusted_contacts (incoming_tc_token_timestamp);

CREATE TABLE IF NOT EXISTS wa_trusted_contacts_send (
  jid TEXT PRIMARY KEY NOT NULL,
  sent_tc_token_timestamp INTEGER NOT NULL,
  real_issue_timestamp INTEGER
);

CREATE INDEX IF NOT EXISTS sent_real_issue_timestamp_index
  ON wa_trusted_contacts_send (real_issue_timestamp);
CREATE INDEX IF NOT EXISTS sent_tc_token_timestamp_index
  ON wa_trusted_contacts_send (sent_tc_token_timestamp);
`
