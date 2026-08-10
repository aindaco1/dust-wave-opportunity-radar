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
  markPendingNotionError,
  saveClassification,
  saveParsedKey,
  setCheckpoint,
  upsertDigestItem,
  upsertMessage,
  upsertOpportunity
} from "../src/storage/database";
import { classification, messageRecord } from "./support/fixtures";
import { createTestDatabase, type TestDatabase } from "./support/d1";

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
    expect(sqlite.prepare("SELECT value FROM app_config WHERE key = 'schema_version'").get()).toEqual({ value: "4" });
    expect(sqlite.prepare("SELECT value FROM app_config WHERE key = 'notion_publish_enabled'").get()).toEqual({ value: "false" });
    expect(sqlite.prepare("SELECT value FROM app_config WHERE key = 'creative_west_sync_enabled'").get()).toEqual({ value: "false" });
    expect(sqlite.prepare("PRAGMA table_info(opportunities)").all()).toContainEqual(expect.objectContaining({ name: "managed_markdown" }));
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

    expect((await listQueuedMessages(db, false)).map((row) => row.id)).toEqual(["message-1"]);
    expect((await listQueuedMessages(db, true)).map((row) => row.id)).toEqual(["message-1", "message-2"]);
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
      { messageId: "4", status: "failed" }
    ], 4);
    expect(sqlite.prepare("SELECT status, queued_count, notion_count, digest_count, ignored_count, failed_count FROM runs").get()).toEqual({
      status: "completed", queued_count: 4, notion_count: 1, digest_count: 1, ignored_count: 1, failed_count: 1
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
