/**
 * Schema for `payments.db` — payment state (contacts, methods, payouts,
 * receipts, transient transaction metadata).
 *
 * Holds per-country credential state for both consumer and merchant
 * payment flows. Column names match the canonical mobile schema verbatim.
 */
export const PAYMENTS_SCHEMA = `
CREATE TABLE IF NOT EXISTS android_metadata (locale TEXT);

CREATE TABLE IF NOT EXISTS contacts (
  jid TEXT NOT NULL DEFAULT '',
  country_data TEXT,
  merchant INTEGER,
  consumer_status INTEGER,
  default_payment_type INTEGER
);

CREATE UNIQUE INDEX IF NOT EXISTS payment_contacts_index ON contacts (jid);

CREATE TABLE IF NOT EXISTS methods (
  credential_id TEXT PRIMARY KEY NOT NULL,
  country TEXT,
  readable_name TEXT,
  issuer_name TEXT,
  type INTEGER NOT NULL DEFAULT 0,
  subtype INTEGER,
  creation_ts INTEGER,
  updated_ts INTEGER,
  debit_mode INTEGER NOT NULL DEFAULT 0,
  credit_mode INTEGER NOT NULL DEFAULT 0,
  balance_1000 INTEGER,
  balance_ts INTEGER,
  country_data TEXT,
  icon BLOB,
  p2m_debit_mode INTEGER NOT NULL DEFAULT 0,
  p2m_credit_mode INTEGER NOT NULL DEFAULT 0
);

CREATE UNIQUE INDEX IF NOT EXISTS payment_methods_index ON methods (credential_id);

CREATE TABLE IF NOT EXISTS payouts (
  credential_id TEXT PRIMARY KEY NOT NULL,
  merchant_credential_id TEXT,
  payout_verification_status INTEGER,
  country TEXT,
  readable_name TEXT,
  issuer_name TEXT,
  type INTEGER NOT NULL DEFAULT 0,
  subtype INTEGER,
  creation_ts INTEGER,
  updated_ts INTEGER,
  balance_1000 INTEGER,
  balance_ts INTEGER,
  credit_mode INTEGER,
  country_data TEXT,
  icon BLOB
);

CREATE INDEX IF NOT EXISTS merchant_credential_id_index ON payouts (merchant_credential_id);
CREATE UNIQUE INDEX IF NOT EXISTS payout_methods_index ON payouts (credential_id);

CREATE TABLE IF NOT EXISTS receipts (
  ref_id TEXT PRIMARY KEY NOT NULL,
  country TEXT,
  biller_id TEXT,
  status TEXT,
  data TEXT
);

CREATE UNIQUE INDEX IF NOT EXISTS payment_receipts_index ON receipts (ref_id);

CREATE TABLE IF NOT EXISTS tmp_transactions (
  tmp_id TEXT NOT NULL DEFAULT '',
  tmp_metadata TEXT,
  tmp_ts INTEGER
);

CREATE UNIQUE INDEX IF NOT EXISTS message_payment_transactions_index
  ON tmp_transactions (tmp_id);
`
