CREATE TABLE newsletter_editions (
  day TEXT PRIMARY KEY,
  payload_json TEXT,
  state TEXT NOT NULL CHECK(state IN ('prepared','empty','attempting','accepted','ambiguous')),
  created_at TEXT NOT NULL,
  attempted_at TEXT,
  message_id TEXT
);
CREATE TABLE newsletter_summaries (
  page_id TEXT PRIMARY KEY,
  content_hash TEXT NOT NULL,
  summary_json TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
