PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  source TEXT NOT NULL CHECK (source IN ('hey', 'zoho')),
  external_id TEXT NOT NULL,
  mailbox TEXT NOT NULL,
  subject TEXT NOT NULL DEFAULT '',
  sender_name TEXT,
  sender_email TEXT,
  received_at TEXT NOT NULL,
  raw_r2_key TEXT NOT NULL,
  parsed_r2_key TEXT,
  raw_size INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued', 'processing', 'pending_notion', 'notion', 'digest', 'ignored', 'failed')),
  classification_json TEXT,
  canonical_url TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(source, external_id)
);

CREATE INDEX IF NOT EXISTS idx_messages_status_received
  ON messages(status, received_at);

CREATE INDEX IF NOT EXISTS idx_messages_source_external
  ON messages(source, external_id);

CREATE TABLE IF NOT EXISTS opportunities (
  automation_key TEXT PRIMARY KEY,
  canonical_url TEXT,
  title TEXT NOT NULL,
  organization TEXT,
  notion_page_id TEXT,
  latest_message_id TEXT NOT NULL,
  first_seen_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  last_published_at TEXT,
  FOREIGN KEY(latest_message_id) REFERENCES messages(id)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_opportunities_canonical_url
  ON opportunities(canonical_url)
  WHERE canonical_url IS NOT NULL;

CREATE TABLE IF NOT EXISTS digest_items (
  message_id TEXT PRIMARY KEY,
  category TEXT NOT NULL,
  title TEXT NOT NULL,
  summary TEXT NOT NULL,
  url TEXT,
  deadline TEXT,
  sender TEXT,
  received_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  sent_at TEXT,
  run_id TEXT,
  FOREIGN KEY(message_id) REFERENCES messages(id)
);

CREATE INDEX IF NOT EXISTS idx_digest_items_unsent
  ON digest_items(sent_at, created_at);

CREATE TABLE IF NOT EXISTS runs (
  id TEXT PRIMARY KEY,
  scheduled_for TEXT NOT NULL,
  started_at TEXT NOT NULL,
  completed_at TEXT,
  status TEXT NOT NULL CHECK (status IN ('running', 'completed', 'failed', 'skipped')),
  queued_count INTEGER NOT NULL DEFAULT 0,
  notion_count INTEGER NOT NULL DEFAULT 0,
  digest_count INTEGER NOT NULL DEFAULT 0,
  ignored_count INTEGER NOT NULL DEFAULT 0,
  failed_count INTEGER NOT NULL DEFAULT 0,
  error TEXT
);

CREATE TABLE IF NOT EXISTS source_checkpoints (
  source TEXT NOT NULL,
  mailbox TEXT NOT NULL,
  last_received_at TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY(source, mailbox)
);

CREATE TABLE IF NOT EXISTS app_config (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
