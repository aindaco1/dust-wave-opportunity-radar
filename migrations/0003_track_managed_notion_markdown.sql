ALTER TABLE opportunities ADD COLUMN managed_markdown TEXT;

INSERT INTO app_config(key, value) VALUES ('schema_version', '3')
ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP;
