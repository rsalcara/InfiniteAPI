/**
 * Schema for `wa.db` — auxiliary store: contacts, Trusted Contact tokens,
 * business profile cache.
 *
 * Gateway scope:
 *   - `wa_trusted_contacts` / `wa_trusted_contacts_send` — TC token
 *     persistence (incoming + outgoing per-recipient state) for the biz
 *     quality_control envelope (phase 9.6)
 *   - `wa_contacts` — minimal contact directory (wa_name, push_name) used
 *     by gateway features that need a human-readable handle
 */
export const WA_SCHEMA = `
CREATE TABLE IF NOT EXISTS wa_contacts (
  jid TEXT PRIMARY KEY,
  wa_name TEXT,
  push_name TEXT,
  verified_name TEXT,
  status TEXT,
  status_timestamp INTEGER,
  is_business INTEGER NOT NULL DEFAULT 0,
  is_user INTEGER NOT NULL DEFAULT 1,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS wa_contacts_by_push_name
  ON wa_contacts (push_name);

CREATE TABLE IF NOT EXISTS wa_trusted_contacts (
  jid TEXT PRIMARY KEY,
  incoming_tc_token BLOB NOT NULL,
  incoming_tc_token_timestamp INTEGER NOT NULL,
  FOREIGN KEY (jid) REFERENCES wa_contacts(jid) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS wa_trusted_contacts_send (
  jid TEXT PRIMARY KEY,
  sent_tc_token_timestamp INTEGER NOT NULL,
  real_issue_timestamp INTEGER NOT NULL,
  FOREIGN KEY (jid) REFERENCES wa_contacts(jid) ON DELETE CASCADE
);
`
