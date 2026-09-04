PRAGMA defer_foreign_keys = ON;

CREATE TABLE messages_next (
  id TEXT PRIMARY KEY,
  source TEXT NOT NULL CHECK (source IN ('hey', 'zoho', 'creative_west', 'colossal', 'hyperallergic')),
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
    CHECK (status IN ('queued', 'processing', 'pending_notion', 'notion_review', 'notion', 'digest', 'ignored', 'failed')),
  classification_json TEXT,
  discovery_context_json TEXT,
  canonical_url TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(source, external_id)
);

INSERT INTO messages_next(
  id, source, external_id, mailbox, subject, sender_name, sender_email,
  received_at, raw_r2_key, parsed_r2_key, raw_size, status,
  classification_json, discovery_context_json, canonical_url, attempts, last_error, created_at, updated_at
)
SELECT
  id, source, external_id, mailbox, subject, sender_name, sender_email,
  received_at, raw_r2_key, parsed_r2_key, raw_size,
  status,
  classification_json, discovery_context_json, canonical_url, attempts, last_error, created_at, updated_at
FROM messages;

DROP TABLE messages;
ALTER TABLE messages_next RENAME TO messages;

CREATE INDEX idx_messages_status_received
  ON messages(status, received_at);

CREATE INDEX idx_messages_source_external
  ON messages(source, external_id);

INSERT INTO app_config(key, value) VALUES ('schema_version', '7')
ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP;
PRAGMA defer_foreign_keys = OFF;
