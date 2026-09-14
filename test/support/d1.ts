import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { createD1TestAdapter } from "@dustwave/test-core/sqlite-d1";

export interface TestDatabase {
  db: D1Database;
  sqlite: DatabaseSync;
  close(): void;
}

export const testMigrationFiles = [
  "0001_initial.sql",
  "0002_seed_config.sql",
  "0003_track_managed_notion_markdown.sql",
  "0004_add_creative_west_source.sql",
  "0005_track_notion_review.sql",
  "0006_add_colossal_source.sql",
  "0007_add_hyperallergic_source.sql",
  "0008_add_artwork_archive_source.sql"
] as const;

export function applyTestMigrations(sqlite: DatabaseSync, migrations: readonly string[] = testMigrationFiles): void {
  for (const migration of migrations) {
    sqlite.exec("BEGIN");
    try {
      sqlite.exec(readFileSync(join(process.cwd(), "migrations", migration), "utf8"));
      sqlite.exec("COMMIT");
    } catch (error) {
      sqlite.exec("ROLLBACK");
      throw error;
    }
  }
}

export function createTestDatabase(options: { migrate?: boolean } = {}): TestDatabase {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec("PRAGMA foreign_keys = ON");
  if (options.migrate !== false) {
    applyTestMigrations(sqlite);
  }

  const db = createD1TestAdapter(sqlite) as unknown as D1Database;

  return { db, sqlite, close: () => sqlite.close() };
}
