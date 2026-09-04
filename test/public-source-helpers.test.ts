import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchPublicText } from "../src/ingest/public-fetch";
import { ingestPublicSnapshot } from "../src/ingest/public-snapshot";
import { createTestDatabase, type TestDatabase } from "./support/d1";
import { env as baseEnv } from "./support/fixtures";

const databases: TestDatabase[] = [];
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  databases.splice(0).forEach((db) => db.close());
});
function setup() {
  const database = createTestDatabase(); databases.push(database);
  const bucket = { put: vi.fn(async () => null), delete: vi.fn(async () => undefined) };
  return { database, bucket, env: baseEnv({ DB: database.db, MAIL_BUCKET: bucket }) };
}
const snapshot = {
  source: "creative_west" as const, externalId: "stable:snapshot", namespace: "creative-west",
  mailbox: "Test", subject: "Fictional opportunity", receivedAt: "2026-09-04T13:00:00.000Z",
  mime: () => "Subject: Fictional opportunity\r\n\r\nApply at https://example.org/call"
};

describe("public snapshot persistence", () => {
  it("keeps stable identity and terminal state, but restores expired failed snapshots", async () => {
    const { database, bucket, env } = setup();
    const first = await ingestPublicSnapshot(env, snapshot);
    database.sqlite.prepare("UPDATE messages SET status = 'notion', raw_r2_key = ''").run();
    expect(await ingestPublicSnapshot(env, snapshot)).toEqual({ id: first.id, ingested: false });
    expect(bucket.put).toHaveBeenCalledTimes(1);
    database.sqlite.prepare("UPDATE messages SET status = 'failed', attempts = 4, last_error = 'synthetic'").run();
    expect(await ingestPublicSnapshot(env, snapshot)).toEqual(first);
    expect(database.sqlite.prepare("SELECT status, attempts, last_error FROM messages").get())
      .toEqual({ status: "queued", attempts: 0, last_error: null });
    expect(bucket.put).toHaveBeenCalledTimes(2);
  });
  it("removes the just-written object when D1 persistence fails", async () => {
    const { database, bucket, env } = setup();
    database.sqlite.exec("CREATE TRIGGER fail_insert BEFORE INSERT ON messages BEGIN SELECT RAISE(FAIL, 'synthetic'); END");
    await expect(ingestPublicSnapshot(env, snapshot)).rejects.toThrow("synthetic");
    expect(bucket.delete).toHaveBeenCalledWith(expect.stringMatching(/^raw\/creative-west\/2026-09-04\/[a-f0-9]{64}\.eml$/));
  });
  it("bounds encoded MIME before writing", async () => {
    const { bucket, env } = setup();
    await expect(ingestPublicSnapshot(env, { ...snapshot, mime: () => "é".repeat(500_001) }))
      .rejects.toThrow("public_snapshot_size_limit");
    expect(bucket.put).not.toHaveBeenCalled();
  });
});

function response(body: string | null, status = 200, type = "application/rss+xml") {
  const value = new Response(body, { status, headers: { "content-type": type, etag: '"version"' } });
  Object.defineProperty(value, "url", { value: "https://example.org/feed/" });
  return value;
}
describe("bounded public source fetching", () => {
  it("supports RSS and a conditional 304 without treating it as a redirect", async () => {
    const fetch = vi.fn().mockResolvedValueOnce(response("<rss/>"))
      .mockResolvedValueOnce(response(null, 304));
    vi.stubGlobal("fetch", fetch);
    const options = { contentTypes: ["application/rss+xml"], etag: '"version"' };
    expect(await fetchPublicText("https://example.org/feed/", options)).toMatchObject({ text: "<rss/>", etag: '"version"' });
    expect(await fetchPublicText("https://example.org/feed/", options)).toMatchObject({ status: 304, text: "" });
    expect(fetch.mock.calls[1]?.[1].headers["If-None-Match"]).toBe('"version"');
  });
  it("rejects wrong content types, oversized responses, and unsafe redirects", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(response("image", 200, "image/png"))
      .mockResolvedValueOnce(response("too much"))
      .mockResolvedValueOnce(new Response(null, { status: 302, headers: { location: "http://localhost/" } })));
    const options = { contentTypes: ["application/rss+xml"], maxBytes: 4 };
    await expect(fetchPublicText("https://example.org/feed/", options)).rejects.toThrow("content_type");
    await expect(fetchPublicText("https://example.org/feed/", options)).rejects.toThrow("byte cap");
    await expect(fetchPublicText("https://example.org/feed/", options)).rejects.toThrow("unsafe_redirect");
  });
});
