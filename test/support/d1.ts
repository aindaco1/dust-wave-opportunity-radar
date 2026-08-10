import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync, type SQLInputValue, type StatementSync } from "node:sqlite";

class TestD1Statement {
  private values: SQLInputValue[] = [];

  constructor(private readonly statement: StatementSync) {}

  bind(...values: unknown[]): D1PreparedStatement {
    this.values = values as SQLInputValue[];
    return this as unknown as D1PreparedStatement;
  }

  async run<T = unknown>(): Promise<D1Result<T>> {
    return this.runSync<T>();
  }

  async all<T = Record<string, unknown>>(): Promise<D1Result<T>> {
    return this.allSync<T>();
  }

  async first<T = Record<string, unknown>>(columnName?: string): Promise<T | null> {
    const row = this.statement.get(...this.values) as Record<string, unknown> | undefined;
    if (!row) return null;
    return (columnName ? row[columnName] : row) as T;
  }

  async raw<T = unknown[]>(): Promise<T[]> {
    this.statement.setReturnArrays(true);
    try {
      return this.statement.all(...this.values) as T[];
    } finally {
      this.statement.setReturnArrays(false);
    }
  }

  runSync<T = unknown>(): D1Result<T> {
    const result = this.statement.run(...this.values);
    return {
      success: true,
      results: [],
      meta: {
        changes: Number(result.changes),
        last_row_id: Number(result.lastInsertRowid),
        duration: 0,
        rows_read: 0,
        rows_written: Number(result.changes),
        changed_db: result.changes > 0,
        size_after: 0
      }
    } as D1Result<T>;
  }

  allSync<T = Record<string, unknown>>(): D1Result<T> {
    const results = this.statement.all(...this.values) as T[];
    return {
      success: true,
      results,
      meta: {
        changes: 0,
        duration: 0,
        rows_read: results.length,
        rows_written: 0,
        changed_db: false,
        size_after: 0
      }
    } as D1Result<T>;
  }
}

export interface TestDatabase {
  db: D1Database;
  sqlite: DatabaseSync;
  close(): void;
}

export function createTestDatabase(options: { migrate?: boolean } = {}): TestDatabase {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec("PRAGMA foreign_keys = ON");
  if (options.migrate !== false) {
    for (const migration of [
      "0001_initial.sql",
      "0002_seed_config.sql",
      "0003_track_managed_notion_markdown.sql",
      "0004_add_creative_west_source.sql"
    ]) {
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

  const db = {
    prepare(query: string): D1PreparedStatement {
      return new TestD1Statement(sqlite.prepare(query)) as unknown as D1PreparedStatement;
    },
    async batch<T = unknown>(statements: D1PreparedStatement[]): Promise<D1Result<T>[]> {
      sqlite.exec("BEGIN");
      try {
        const results = statements.map((statement) =>
          (statement as unknown as TestD1Statement).runSync<T>()
        );
        sqlite.exec("COMMIT");
        return results;
      } catch (error) {
        sqlite.exec("ROLLBACK");
        throw error;
      }
    },
    async exec(query: string): Promise<D1ExecResult> {
      sqlite.exec(query);
      return { count: 0, duration: 0 };
    },
    withSession(): D1DatabaseSession {
      throw new Error("D1 sessions are not implemented by the unit-test adapter");
    },
    dump(): Promise<ArrayBuffer> {
      throw new Error("D1 dump is not implemented by the unit-test adapter");
    }
  } as unknown as D1Database;

  return { db, sqlite, close: () => sqlite.close() };
}
