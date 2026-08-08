import { afterEach, describe, expect, it, vi } from "vitest";
import { ingestForwardedHeyEmail, ingestImportedHeyEmail } from "../src/ingest/email-worker";
import { getMessage } from "../src/storage/database";
import { env as baseEnv } from "./support/fixtures";
import { createTestDatabase, type TestDatabase } from "./support/d1";

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
});
