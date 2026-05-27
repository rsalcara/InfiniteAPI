/**
 * Schema for `smb.db` — Small Business / Marketing Messages state.
 *
 * Subset of the canonical mobile schema covering the core business-only
 * tables: marketing message lifecycle (template, pricing, draft, sent),
 * audience/broadcast targeting, premium messages, customer data, and
 * coex call permission state. Auxiliary FTS/diagnostics tables omitted —
 * they're internal-only and not relevant for a gateway scope.
 */
export const SMB_SCHEMA = `
CREATE TABLE IF NOT EXISTS android_metadata (locale TEXT);

CREATE TABLE IF NOT EXISTS ad_creation_multiple_drafts (
  uuid TEXT PRIMARY KEY NOT NULL,
  last_updated_timestamp INTEGER NOT NULL,
  created_at_timestamp INTEGER NOT NULL,
  json_payload TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS audience (
  _id INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
  audience_id TEXT NOT NULL,
  audience_expression_json TEXT NOT NULL,
  semantic_key TEXT,
  name TEXT,
  created_timestamp INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS biz_app_insights_events (
  _id INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
  created_timestamp INTEGER NOT NULL,
  name TEXT NOT NULL,
  chat_jid TEXT,
  entrypoint TEXT
);

CREATE TABLE IF NOT EXISTS broadcast_audience (
  _id INTEGER PRIMARY KEY AUTOINCREMENT,
  broadcast_jid TEXT NOT NULL,
  audience_id TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS business_broadcast_catalog (
  _id INTEGER PRIMARY KEY AUTOINCREMENT,
  premium_message_id TEXT NOT NULL,
  product_id TEXT
);

CREATE TABLE IF NOT EXISTS business_broadcast_document (
  _id INTEGER PRIMARY KEY AUTOINCREMENT,
  premium_message_id TEXT NOT NULL,
  document_name TEXT,
  mime_type TEXT,
  file_size INTEGER,
  page_count INTEGER,
  document_uri TEXT
);

CREATE TABLE IF NOT EXISTS coex_call_permission_state (
  jid TEXT PRIMARY KEY NOT NULL,
  timestamp_ms INTEGER NOT NULL,
  permission_state INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS customer_data (
  chat_jid TEXT PRIMARY KEY NOT NULL,
  contact_type INTEGER NOT NULL DEFAULT 0,
  email TEXT NOT NULL DEFAULT '',
  alt_phone_numbers TEXT NOT NULL DEFAULT '',
  birthday INTEGER,
  address TEXT NOT NULL DEFAULT '',
  acquisition_source INTEGER,
  lead_stage INTEGER,
  last_order INTEGER,
  created_at INTEGER NOT NULL,
  modified_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS data_sharing_3pd_lid (
  _id INTEGER PRIMARY KEY AUTOINCREMENT,
  lid_raw_string TEXT NOT NULL UNIQUE,
  data_sharing_3pd_enabled INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS marketing_message_api_response (
  premium_message_id TEXT PRIMARY KEY NOT NULL,
  ad_id TEXT NOT NULL,
  ad_group_id TEXT NOT NULL,
  ad_campaign_id TEXT NOT NULL,
  ad_creative_id TEXT NOT NULL,
  ad_campaign_group_id TEXT NOT NULL,
  status TEXT NOT NULL,
  last_updated_timestamp INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS marketing_message_offer (
  offer_id TEXT PRIMARY KEY NOT NULL,
  discount DOUBLE NOT NULL,
  expiration_timestamp INTEGER NOT NULL,
  premium_message_id TEXT NOT NULL,
  was_offer_claimed BOOLEAN DEFAULT 0
);

CREATE TABLE IF NOT EXISTS marketing_message_pending_payment (
  premium_message_id TEXT PRIMARY KEY NOT NULL,
  message_cost TEXT NOT NULL,
  last_updated_timestamp INTEGER NOT NULL,
  cost_before_tax DOUBLE,
  currency_code TEXT
);

CREATE TABLE IF NOT EXISTS marketing_message_pricing_map_table (
  country TEXT PRIMARY KEY NOT NULL,
  message_cost REAL NOT NULL
);

CREATE TABLE IF NOT EXISTS marketing_message_promo_template_table (
  _id INTEGER PRIMARY KEY AUTOINCREMENT,
  promo_type TEXT NOT NULL,
  content TEXT NOT NULL,
  cta_type TEXT,
  cta_content TEXT,
  title TEXT,
  subtitle TEXT
);

CREATE TABLE IF NOT EXISTS marketing_messages_background_send (
  premium_message_id TEXT PRIMARY KEY NOT NULL,
  creation_timestamp INTEGER NOT NULL,
  scheduled_timestamp INTEGER NOT NULL,
  retry_count INTEGER NOT NULL,
  error_code INTEGER NOT NULL,
  processing_state INTEGER NOT NULL,
  last_handled_timestamp INTEGER NOT NULL,
  campaign_id TEXT,
  smart_list_option TEXT NOT NULL,
  smart_list_selection TEXT NOT NULL,
  entry_point TEXT,
  broadcast_raw_jid TEXT,
  free_reserved_messages_count INTEGER NOT NULL DEFAULT 0,
  failed_message_id TEXT,
  analytics_session_json TEXT
);

CREATE TABLE IF NOT EXISTS marketing_messages_recent_audience_smart_list (
  id TEXT PRIMARY KEY NOT NULL,
  name TEXT NOT NULL,
  timestamp INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS premium_message (
  premium_message_id TEXT PRIMARY KEY NOT NULL,
  name TEXT NOT NULL,
  text TEXT NOT NULL,
  media_uri TEXT,
  media_type INTEGER,
  created_from_premium_message_id TEXT,
  last_sent_timestamp INTEGER,
  promotion_template_name TEXT,
  creation_source TEXT,
  is_premium_broadcast BOOLEAN DEFAULT 0,
  broadcast_raw_jid TEXT,
  message_type INTEGER,
  device_id INTEGER DEFAULT 0
);
`
