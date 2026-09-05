import { afterEach, describe, expect, it, vi } from "vitest";
import { ingestForwardedHeyEmail, ingestImportedHeyEmail } from "../src/ingest/email-worker";
import { getMessage } from "../src/storage/database";
import { extractHeySearchTopicIds } from "../scripts/hey-cli-fidelity.mjs";
import { env as baseEnv } from "./support/fixtures";
import { createTestDatabase, type TestDatabase } from "./support/d1";
import "./support/fixed-length-stream";

const open: TestDatabase[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  while (open.length) open.pop()?.close();
});

function setup() {
  const testDb = createTestDatabase();
  open.push(testDb);
  const objects = new Map<string, Uint8Array>();
  const bucket = {
    put: vi.fn(async (key: string, value: Uint8Array | ReadableStream<Uint8Array>) => {
      const bytes = value instanceof Uint8Array
        ? value
        : new Uint8Array(await new Response(value).arrayBuffer());
      objects.set(key, bytes);
      return null;
    }),
    delete: vi.fn(async (key: string) => { objects.delete(key); })
  };
  const env = baseEnv({ DB: testDb.db, MAIL_BUCKET: bucket });
  return { testDb, bucket, objects, env };
}

describe("HEY backfill ingestion", () => {
  const historicalInput = {
    externalId: "mcp-hey:9001",
    mailbox: "Feed",
    subject: "Synthetic historical call",
    senderEmail: "calls@example.org",
    receivedAt: "2026-08-05T12:00:00Z",
    rawBase64: btoa("Message-ID: <original@example.org>\r\nSubject: Synthetic historical call\r\n\r\nApply")
  };

  it("reuses the legacy topic key across CLI postings and mailbox moves", async () => {
    const { env, testDb, objects } = setup();
    const original = await ingestImportedHeyEmail(historicalInput, env);
    testDb.sqlite.prepare("UPDATE messages SET status = 'notion', attempts = 2, classification_json = ? WHERE id = ?")
      .run('{"title":"Synthetic call"}', original.id);
    const [topicId] = extractHeySearchTopicIds({ ok: true, data: [{ id: 1001, topic_id: 9001 }] });
    const repeated = await ingestImportedHeyEmail({
      ...historicalInput, externalId: `mcp-hey:${topicId}`, mailbox: "Paper Trail"
    }, env);

    expect(repeated.id).toBe(original.id);
    expect(testDb.sqlite.prepare("SELECT COUNT(*) AS count FROM messages").get()).toEqual({ count: 1 });
    expect(await getMessage(env.DB, original.id)).toMatchObject({
      status: "notion", attempts: 2, classification_json: '{"title":"Synthetic call"}', mailbox: "Paper Trail"
    });
    expect(objects.size).toBe(1);
  });

  it("restores an expired failed payload under the same historical identity", async () => {
    const { env, testDb, objects } = setup();
    const original = await ingestImportedHeyEmail(historicalInput, env);
    const before = await getMessage(env.DB, original.id);
    objects.delete(before!.raw_r2_key);
    testDb.sqlite.prepare("UPDATE messages SET status = 'failed', attempts = 4, raw_r2_key = '', last_error = 'expired' WHERE id = ?")
      .run(original.id);

    expect(await ingestImportedHeyEmail(historicalInput, env)).toEqual(original);
    expect(await getMessage(env.DB, original.id)).toMatchObject({
      status: "queued", attempts: 0, last_error: null, raw_r2_key: before!.raw_r2_key
    });
    expect(testDb.sqlite.prepare("SELECT COUNT(*) AS count FROM messages").get()).toEqual({ count: 1 });
    expect(objects.size).toBe(1);
  });

  it("does not silently reset failed rows that still retain their payload", async () => {
    const { env, testDb } = setup();
    const original = await ingestImportedHeyEmail(historicalInput, env);
    testDb.sqlite.prepare("UPDATE messages SET status = 'failed', attempts = 4, last_error = 'parse_failed' WHERE id = ?")
      .run(original.id);
    await ingestImportedHeyEmail(historicalInput, env);
    expect(await getMessage(env.DB, original.id)).toMatchObject({ status: "failed", attempts: 4, last_error: "parse_failed" });
  });

  it("keeps a forwarded RFC Message-ID distinct from a historical topic snapshot", async () => {
    const { env, testDb } = setup();
    const raw = atob(historicalInput.rawBase64);
    await ingestForwardedHeyEmail({
      rawSize: raw.length,
      raw: new Response(raw).body,
      from: historicalInput.senderEmail,
      headers: new Headers({
        "message-id": "<original@example.org>", subject: historicalInput.subject,
        from: historicalInput.senderEmail, date: historicalInput.receivedAt
      }),
      setReject: vi.fn()
    } as unknown as ForwardableEmailMessage, env);
    await ingestImportedHeyEmail(historicalInput, env);
    // Identical MIME and metadata cannot justify treating a whole topic as one RFC message.
    expect(testDb.sqlite.prepare("SELECT external_id FROM messages ORDER BY external_id").all())
      .toEqual([{ external_id: "<original@example.org>" }, { external_id: "mcp-hey:9001" }]);
  });

  it("does not turn a terminal topic snapshot into a new-reply watcher", async () => {
    const { env, testDb } = setup();
    const original = await ingestImportedHeyEmail(historicalInput, env);
    testDb.sqlite.prepare("UPDATE messages SET status = 'digest' WHERE id = ?").run(original.id);
    await ingestImportedHeyEmail({ ...historicalInput, rawBase64: btoa("Synthetic new reply in the same topic") }, env);
    expect(await getMessage(env.DB, original.id)).toMatchObject({ status: "digest" });
    expect(testDb.sqlite.prepare("SELECT COUNT(*) AS count FROM messages").get()).toEqual({ count: 1 });
  });

  it("stores deterministic MIME and queue metadata", async () => {
    const { env, bucket, objects } = setup();
    const result = await ingestImportedHeyEmail({
      externalId: "hey-123",
      mailbox: "Feed",
      subject: "  Film call\r\n ",
      senderName: "Arts Group",
      senderEmail: "calls@example.org",
      receivedAt: "2026-08-05T12:00:00Z",
      rawBase64: btoa("Subject: Film call\r\n\r\nApply now")
    }, env);

    expect(result.id).toMatch(/^[0-9a-f]{64}$/);
    const record = await getMessage(env.DB, result.id);
    expect(record).toMatchObject({ source: "hey", external_id: "hey-123", mailbox: "Feed", subject: "Film call", status: "queued" });
    expect(bucket.put).toHaveBeenCalledWith(
      expect.stringMatching(/^raw\/hey\/2026-08-05\/[0-9a-f]{64}\.eml$/),
      expect.any(Uint8Array),
      expect.objectContaining({ customMetadata: expect.objectContaining({ import: "mcp-hey" }) })
    );
    expect(objects.size).toBe(1);
  });

  it.each([
    [{ externalId: "", mailbox: "Feed", subject: "Call", receivedAt: "2026-08-05", rawBase64: "YQ==" }, "externalId"],
    [{ externalId: "1", mailbox: "", subject: "Call", receivedAt: "2026-08-05", rawBase64: "YQ==" }, "mailbox"],
    [{ externalId: "1", mailbox: "Feed", subject: "", receivedAt: "2026-08-05", rawBase64: "YQ==" }, "subject"],
    [{ externalId: "1", mailbox: "Feed", subject: "Call", receivedAt: "not-a-date", rawBase64: "YQ==" }, "receivedAt"],
    [{ externalId: "1", mailbox: "Feed", subject: "Call", receivedAt: "2026-08-05", rawBase64: "" }, "rawBase64"],
    [{ externalId: "1", mailbox: "Feed", subject: "Call", receivedAt: "2026-08-05", rawBase64: "%%%" }, "base64"]
  ])("rejects invalid imported metadata (%s)", async (input, expected) => {
    const { env, bucket } = setup();
    await expect(ingestImportedHeyEmail(input, env)).rejects.toThrow(expected);
    expect(bucket.put).not.toHaveBeenCalled();
  });

  it("deletes the object when the D1 write fails", async () => {
    const { env, bucket, objects } = setup();
    const failingEnv = baseEnv({
      ...env,
      DB: { prepare: () => { throw new Error("D1 unavailable"); } },
      MAIL_BUCKET: bucket
    });
    await expect(ingestImportedHeyEmail({
      externalId: "hey-123",
      mailbox: "Feed",
      subject: "Film call",
      receivedAt: "2026-08-05T12:00:00Z",
      rawBase64: btoa("MIME")
    }, failingEnv)).rejects.toThrow("D1 unavailable");
    expect(bucket.delete).toHaveBeenCalledOnce();
    expect(objects.size).toBe(0);
  });
});

describe("forwarded HEY ingestion", () => {
  it("rejects messages over the 25 MiB edge limit", async () => {
    const { env, bucket } = setup();
    const setReject = vi.fn();
    const message = { rawSize: 26_214_401, setReject } as unknown as ForwardableEmailMessage;
    await ingestForwardedHeyEmail(message, env);
    expect(setReject).toHaveBeenCalledWith("Message exceeds the 25 MiB ingestion limit");
    expect(bucket.put).not.toHaveBeenCalled();
  });

  it.each([Number.NaN, -1, 0, 1.5])("rejects an invalid platform raw size (%s)", async (rawSize) => {
    const { env, bucket } = setup();
    const setReject = vi.fn();
    const message = { rawSize, setReject } as unknown as ForwardableEmailMessage;
    await ingestForwardedHeyEmail(message, env);
    expect(setReject).toHaveBeenCalledWith("Message has an invalid size");
    expect(bucket.put).not.toHaveBeenCalled();
  });

  it("queues a valid forwarded MIME stream and sanitizes headers", async () => {
    const { env } = setup();
    const raw = "Message-ID: <forwarded-1@example.org>\r\nSubject: Open call\r\n\r\nApply";
    const message = {
      rawSize: raw.length,
      raw: new Response(raw).body,
      from: "sender@example.org",
      to: "hey@ingest.dustwave.xyz",
      headers: {
        get(name: string) {
          return ({
            "message-id": "<forwarded-1@example.org>",
            subject: "Film\r\n call",
            from: "Sender <sender@example.org>",
            date: "Wed, 05 Aug 2026 12:00:00 GMT"
          } as Record<string, string>)[name.toLowerCase()] ?? null;
        }
      } as Headers,
      setReject: vi.fn(),
      forward: vi.fn(),
      reply: vi.fn()
    } as unknown as ForwardableEmailMessage;
    await ingestForwardedHeyEmail(message, env);
    const row = env.DB.prepare("SELECT * FROM messages").first<Record<string, unknown>>();
    await expect(row).resolves.toMatchObject({
      source: "hey",
      external_id: "<forwarded-1@example.org>",
      mailbox: "Forwarded non-spam",
      subject: "Film  call"
    });
  });

  it("rejects a raw stream whose bytes do not match the declared size", async () => {
    const { env, bucket, objects } = setup();
    const raw = "Subject: Short\r\n\r\nBody";
    const message = {
      rawSize: raw.length + 1,
      raw: new Response(raw).body,
      from: "sender@example.org",
      headers: new Headers({ "message-id": "<short@example.org>" }),
      setReject: vi.fn()
    } as unknown as ForwardableEmailMessage;

    await expect(ingestForwardedHeyEmail(message, env)).rejects.toThrow("too few bytes");
    expect(bucket.delete).toHaveBeenCalledOnce();
    expect(objects.size).toBe(0);
    await expect(env.DB.prepare("SELECT COUNT(*) AS count FROM messages").first<{ count: number }>())
      .resolves.toEqual({ count: 0 });
  });
});
