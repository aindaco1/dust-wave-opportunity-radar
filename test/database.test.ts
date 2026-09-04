import { afterEach, describe, expect, it } from "vitest";
import {
  claimMessageProcessing,
  clearExpiredR2Keys,
  completeRun,
  createRun,
  failRun,
  getCheckpoint,
  getMessage,
  listExpiredR2Keys,
  listQueuedMessages,
  listUnsentDigestItems,
  markDigestItemsSent,
  markMessageFailed,
  markNotionReviewRequired,
  markPendingNotionError,
  saveClassification,
  saveParsedKey,
  setCheckpoint,
  upsertDigestItem,
  upsertMessage,
  upsertOpportunity
} from "../src/storage/database";
import { classification, messageRecord } from "./support/fixtures";
import { applyTestMigrations, createTestDatabase, testMigrationFiles, type TestDatabase } from "./support/d1";

const open: TestDatabase[] = [];

afterEach(() => {
  while (open.length) open.pop()?.close();
});

function database(): TestDatabase {
  const testDb = createTestDatabase();
  open.push(testDb);
  return testDb;
}

async function seedMessage(db: D1Database, overrides: Partial<Parameters<typeof upsertMessage>[1]> = {}) {
  await upsertMessage(db, {
    id: "message-1",
    source: "zoho",
    externalId: "external-1",
    mailbox: "Dust Wave",
    subject: "Open call",
    senderName: "Example Foundation",
    senderEmail: "calls@example.org",
    receivedAt: "2026-08-05T12:00:00.000Z",
    rawR2Key: "raw/message-1.eml",
    rawSize: 100,
    ...overrides
  });
}

describe("D1 migrations", () => {
  it("applies every migration and seeds safe feature flags", () => {
    const { sqlite } = database();
    expect(sqlite.prepare("SELECT value FROM app_config WHERE key = 'schema_version'").get()).toEqual({ value: "7" });
    expect(sqlite.prepare("SELECT value FROM app_config WHERE key = 'notion_publish_enabled'").get()).toEqual({ value: "false" });
    expect(sqlite.prepare("SELECT value FROM app_config WHERE key = 'creative_west_sync_enabled'").get()).toEqual({ value: "false" });
    expect(sqlite.prepare("PRAGMA table_info(opportunities)").all()).toContainEqual(expect.objectContaining({ name: "managed_markdown" }));
    expect(sqlite.prepare("PRAGMA table_info(opportunities)").all()).toContainEqual(expect.objectContaining({ name: "body_management" }));
    expect(sqlite.prepare("PRAGMA table_info(runs)").all()).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "pending_notion_count" }),
      expect.objectContaining({ name: "notion_review_count" })
    ]));
  });

  it("migrates permanent Notion body conflicts out of the retry queue", () => {
    const testDb = createTestDatabase({ migrate: false });
    open.push(testDb);
    applyTestMigrations(testDb.sqlite, testMigrationFiles.slice(0, 4));
    testDb.sqlite.exec(`
      INSERT INTO messages(id, source, external_id, mailbox, received_at, raw_r2_key, status, last_error)
      VALUES ('message-1', 'zoho', 'external-1', 'Inbox', '2026-08-05T00:00:00Z', '', 'pending_notion',
        'Cannot safely update Notion page 11111111-1111-1111-1111-111111111111 because its managed opportunity text was edited');
    `);
    applyTestMigrations(testDb.sqlite, testMigrationFiles.slice(4));
    expect(testDb.sqlite.prepare("SELECT status FROM messages WHERE id = 'message-1'").get())
      .toEqual({ status: "notion_review" });
    expect(testDb.sqlite.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  });

  it("accepts Creative West messages while retaining foreign-key enforcement", async () => {
    const { db, sqlite } = database();
    await seedMessage(db, {
      id: "creative-west-message",
      source: "creative_west",
      externalId: "CAFE:123:snapshot",
      rawR2Key: "raw/creative-west/creative-west-message.eml"
    });
    expect(sqlite.prepare("SELECT source FROM messages WHERE id = 'creative-west-message'").get())
      .toEqual({ source: "creative_west" });
    expect(sqlite.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  });
});

describe("Colossal migration", () => {
  it("preserves pre-existing message references and manual body ownership", async () => {
    const testDb = createTestDatabase({ migrate: false }); open.push(testDb);
    applyTestMigrations(testDb.sqlite, testMigrationFiles.slice(0, 5));
    testDb.sqlite.exec(`
      INSERT INTO messages(id, source, external_id, mailbox, received_at, raw_r2_key, status)
        VALUES ('before', 'zoho', 'before', 'Inbox', '2026-08-05', '', 'notion_review');
      INSERT INTO opportunities(automation_key, title, latest_message_id, first_seen_at, last_seen_at, body_management)
        VALUES ('before', 'Manual title', 'before', '2026-08-05', '2026-08-05', 'manual');
      INSERT INTO digest_items(message_id, category, title, summary, received_at)
        VALUES ('before', 'Other Useful Finds', 'Manual title', 'Synthetic summary', '2026-08-05');
    `);
    applyTestMigrations(testDb.sqlite, testMigrationFiles.slice(5));
    expect(testDb.sqlite.prepare("SELECT status FROM messages WHERE id = 'before'").get()).toEqual({ status: "notion_review" });
    expect(testDb.sqlite.prepare("SELECT body_management FROM opportunities WHERE automation_key = 'before'").get()).toEqual({ body_management: "manual" });
    await seedMessage(testDb.db, { source: "colossal", discoveryContext: {
      sourceUrl: "https://example.org/roundup", officialUrls: ["https://example.org/apply"], ambiguousUrls: [], requiresReview: false
    } });
    expect((await getMessage(testDb.db, "message-1"))?.discovery_context_json).toContain("officialUrls");
    expect(testDb.sqlite.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  });
});

describe("Hyperallergic migration", () => {
  it("preserves existing discovery context, source links, digest references, and manual ownership", async () => {
    const testDb = createTestDatabase({ migrate: false }); open.push(testDb);
    applyTestMigrations(testDb.sqlite, testMigrationFiles.slice(0, 6));
    const context = JSON.stringify({ sourceUrl: "https://example.org/roundup", officialUrls: ["https://example.org/apply"], ambiguousUrls: [], requiresReview: false });
    testDb.sqlite.prepare(`INSERT INTO messages(id, source, external_id, mailbox, received_at, raw_r2_key, status, discovery_context_json)
      VALUES ('before', 'colossal', 'before', 'Opportunities', '2026-08-05', '', 'notion_review', ?)`).run(context);
    testDb.sqlite.exec(`
      INSERT INTO opportunities(automation_key, title, latest_message_id, first_seen_at, last_seen_at, body_management, managed_markdown)
        VALUES ('before', 'Manual title', 'before', '2026-08-05', '2026-08-05', 'manual', 'Preserved manual notes');
      INSERT INTO digest_items(message_id, category, title, summary, received_at)
        VALUES ('before', 'Other Useful Finds', 'Manual title', 'Synthetic summary', '2026-08-05');
      INSERT INTO source_documents(id, source, url, roundup_month, published_at, next_entry, pending)
        VALUES ('doc', 'colossal', 'https://example.org/roundup', '2026-08', '', 17, 1);
      INSERT INTO source_document_messages(document_id, message_id) VALUES ('doc', 'before');
      INSERT INTO source_http_cache(source, etag) VALUES ('colossal', 'synthetic-validator');
    `);
    applyTestMigrations(testDb.sqlite, testMigrationFiles.slice(6));
    expect(testDb.sqlite.prepare("SELECT status, discovery_context_json FROM messages WHERE id = 'before'").get())
      .toEqual({ status: "notion_review", discovery_context_json: context });
    expect(testDb.sqlite.prepare("SELECT body_management, managed_markdown FROM opportunities").get())
      .toEqual({ body_management: "manual", managed_markdown: "Preserved manual notes" });
    expect(testDb.sqlite.prepare("SELECT next_entry, pending FROM source_documents").get()).toEqual({ next_entry: 17, pending: 1 });
    expect(testDb.sqlite.prepare("SELECT message_id FROM source_document_messages").get()).toEqual({ message_id: "before" });
    expect(testDb.sqlite.prepare("SELECT message_id FROM digest_items").get()).toEqual({ message_id: "before" });
    expect(testDb.sqlite.prepare("SELECT etag FROM source_http_cache").get()).toEqual({ etag: "synthetic-validator" });
    await seedMessage(testDb.db, { source: "hyperallergic" });
    expect(testDb.sqlite.prepare("SELECT source FROM messages WHERE id = 'message-1'").get()).toEqual({ source: "hyperallergic" });
    expect(testDb.sqlite.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  });
});

describe("message queue persistence", () => {
  it("deduplicates a source/external ID without replacing terminal state", async () => {
    const { db, sqlite } = database();
    await seedMessage(db);
    sqlite.prepare("UPDATE messages SET status = 'notion', attempts = 2 WHERE id = 'message-1'").run();
    await seedMessage(db, { id: "different-id", subject: "Updated subject", rawR2Key: "raw/new.eml" });

    const rows = sqlite.prepare("SELECT id, subject, status, attempts, raw_r2_key FROM messages").all();
    expect(rows).toEqual([{ id: "message-1", subject: "Updated subject", status: "notion", attempts: 2, raw_r2_key: "raw/new.eml" }]);
  });

  it("requeues a failed record whose retained MIME has expired", async () => {
    const { db, sqlite } = database();
    await seedMessage(db);
    sqlite.prepare("UPDATE messages SET status = 'failed', attempts = 4, raw_r2_key = '', last_error = 'expired' WHERE id = 'message-1'").run();
    await seedMessage(db, { rawR2Key: "raw/restored.eml" });

    expect(await getMessage(db, "message-1")).toMatchObject({ status: "queued", attempts: 0, last_error: null });
  });

  it("selects eligible work and honors the Notion retry switch", async () => {
    const { db, sqlite } = database();
    await seedMessage(db);
    await seedMessage(db, { id: "message-2", externalId: "external-2", receivedAt: "2026-08-05T13:00:00.000Z" });
    sqlite.prepare("UPDATE messages SET status = 'pending_notion' WHERE id = 'message-2'").run();
    await seedMessage(db, { id: "message-3", externalId: "external-3", receivedAt: "2026-08-05T14:00:00.000Z" });
    await markNotionReviewRequired(db, "message-3", "managed_content_changed");

    expect((await listQueuedMessages(db, false)).map((row) => row.id)).toEqual(["message-1"]);
    expect((await listQueuedMessages(db, true)).map((row) => row.id)).toEqual(["message-1", "message-2"]);
    expect(await getMessage(db, "message-3")).toMatchObject({
      status: "notion_review",
      last_error: "managed_content_changed"
    });
  });

  it("reclaims stale processing work but not a fresh claim", async () => {
    const { db, sqlite } = database();
    await seedMessage(db);
    sqlite.prepare("UPDATE messages SET status = 'processing', updated_at = datetime('now', '-16 minutes') WHERE id = 'message-1'").run();
    expect(await listQueuedMessages(db, false)).toHaveLength(1);
    expect(await claimMessageProcessing(db, "message-1")).toBe(true);
    expect(await claimMessageProcessing(db, "message-1")).toBe(false);
    expect(await getMessage(db, "message-1")).toMatchObject({ status: "processing", attempts: 1 });
  });

  it("stores parsed data, classification, and bounded failure details", async () => {
    const { db } = database();
    await seedMessage(db);
    await saveParsedKey(db, "message-1", "parsed/message-1.json");
    await saveClassification(db, "message-1", classification(), "notion", "https://example.org/grant");
    expect(await getMessage(db, "message-1")).toMatchObject({
      parsed_r2_key: "parsed/message-1.json",
      status: "notion",
      canonical_url: "https://example.org/grant",
      last_error: null
    });

    await markMessageFailed(db, "message-1", new Error("x".repeat(2_500)));
    expect((await getMessage(db, "message-1"))?.last_error).toHaveLength(2_000);
    await markPendingNotionError(db, "message-1", "Notion unavailable");
    expect(await getMessage(db, "message-1")).toMatchObject({ status: "pending_notion", last_error: "Notion unavailable" });
  });
});

describe("digest and opportunity persistence", () => {
  it("upserts one rolling digest item and marks it sent idempotently", async () => {
    const { db } = database();
    await seedMessage(db);
    const message = messageRecord();
    await upsertDigestItem(db, message, classification({ decision: "digest", digestCategory: "Events & Conferences" }));
    await upsertDigestItem(db, message, classification({ decision: "digest", title: "Updated title", digestCategory: "Industry News" }));
    expect(await listUnsentDigestItems(db)).toEqual([expect.objectContaining({ message_id: "message-1", title: "Updated title", category: "Industry News" })]);
    await markDigestItemsSent(db, ["message-1"], "run-1");
    await markDigestItemsSent(db, [], "run-1");
    expect(await listUnsentDigestItems(db)).toEqual([]);
  });

  it("updates an automation key and repoints a shared Notion page safely", async () => {
    const { db, sqlite } = database();
    await seedMessage(db);
    await seedMessage(db, { id: "message-2", externalId: "external-2" });
    await upsertOpportunity(db, "old-key", "message-1", classification(), "page-1", "old markdown");
    await upsertOpportunity(db, "new-key", "message-2", classification({ title: "Renamed grant" }), "page-1", "new markdown");
    expect(sqlite.prepare("SELECT automation_key, title, latest_message_id, managed_markdown FROM opportunities").all()).toEqual([
      { automation_key: "new-key", title: "Renamed grant", latest_message_id: "message-2", managed_markdown: "new markdown" }
    ]);
  });
});

describe("run, checkpoint, and retention state", () => {
  it("records run counts and rejects a duplicate run ID", async () => {
    const { db, sqlite } = database();
    expect(await createRun(db, "run-1", "2026-08-05T13:00:00.000Z")).toBe(true);
    expect(await createRun(db, "run-1", "2026-08-05T13:00:00.000Z")).toBe(false);
    await completeRun(db, "run-1", [
      { messageId: "1", status: "notion" },
      { messageId: "2", status: "digest" },
      { messageId: "3", status: "ignored" },
      { messageId: "4", status: "failed" },
      { messageId: "5", status: "pending_notion" },
      { messageId: "6", status: "notion_review" }
    ], 6);
    expect(sqlite.prepare(
      "SELECT status, queued_count, notion_count, pending_notion_count, notion_review_count, digest_count, ignored_count, failed_count FROM runs"
    ).get()).toEqual({
      status: "completed",
      queued_count: 6,
      notion_count: 1,
      pending_notion_count: 1,
      notion_review_count: 1,
      digest_count: 1,
      ignored_count: 1,
      failed_count: 1
    });
  });

  it("bounds a failed run error", async () => {
    const { db, sqlite } = database();
    await createRun(db, "run-1", "2026-08-05T13:00:00.000Z");
    await failRun(db, "run-1", new Error("x".repeat(2_500)));
    expect((sqlite.prepare("SELECT error FROM runs").get() as { error: string }).error).toHaveLength(2_000);
  });

  it("creates and updates source checkpoints", async () => {
    const { db } = database();
    expect(await getCheckpoint(db, "zoho", "Inbox")).toBeNull();
    await setCheckpoint(db, "zoho", "Inbox", "2026-08-01T00:00:00.000Z");
    await setCheckpoint(db, "zoho", "Inbox", "2026-08-05T00:00:00.000Z");
    expect(await getCheckpoint(db, "zoho", "Inbox")).toBe("2026-08-05T00:00:00.000Z");
  });

  it("lists and clears only expired R2 object references", async () => {
    const { db, sqlite } = database();
    await seedMessage(db);
    sqlite.prepare("UPDATE messages SET parsed_r2_key = 'parsed/message-1.json', created_at = '2026-08-01 00:00:00'").run();
    expect(await listExpiredR2Keys(db, "2026-08-02T00:00:00.000Z")).toEqual(["raw/message-1.eml", "parsed/message-1.json"]);
    await clearExpiredR2Keys(db, "2026-08-02T00:00:00.000Z");
    expect(await getMessage(db, "message-1")).toMatchObject({ raw_r2_key: "", parsed_r2_key: null });
  });
});
