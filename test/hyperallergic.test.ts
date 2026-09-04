import { afterEach, describe, expect, it, vi } from "vitest";
import worker from "../src/index";
import { inspectHyperallergicConnection, syncHyperallergic } from "../src/ingest/hyperallergic";
import { HYPERALLERGIC_ARCHIVE, HYPERALLERGIC_FEED } from "../src/ingest/hyperallergic-parser";
import { parseStoredMessage } from "../src/email/parse";
import { getMessage } from "../src/storage/database";
import { env as baseEnv, runtimeConfig } from "./support/fixtures";
import { createTestDatabase, type TestDatabase } from "./support/d1";
import { responseAt, rss } from "./support/colossal";
import { articleHtml, entryHtml, feed, augustUrl, septemberUrl } from "./support/hyperallergic";

const databases: TestDatabase[] = [];
const at = new Date("2026-09-04T13:00:00Z");
const config = () => runtimeConfig({ hyperallergicEnabled: true });
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals(); vi.restoreAllMocks();
  databases.splice(0).forEach((db) => db.close());
});
function setup() {
  const database = createTestDatabase(); databases.push(database);
  const objects = new Map<string, Uint8Array>();
  const bucket = {
    put: vi.fn(async (key: string, bytes: Uint8Array) => { objects.set(key, bytes); return null; }),
    delete: vi.fn(async (key: string) => { objects.delete(key); }),
    get: vi.fn(async (key: string) => {
      const bytes = objects.get(key);
      return bytes ? { arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) } : null;
    })
  };
  const env = baseEnv({ DB: database.db, MAIL_BUCKET: bucket, HYPERALLERGIC_ENABLED: "true" });
  return { database, objects, bucket, env };
}
function network(options: { feed?: () => string; article?: () => string; cached?: () => boolean } = {}) {
  const mock = vi.fn(async (url: string) => {
    if (url === HYPERALLERGIC_FEED) return responseAt(url, options.cached?.() ? null : options.feed?.() ?? feed(),
      options.cached?.() ? 304 : 200, "application/rss+xml");
    if (url === HYPERALLERGIC_ARCHIVE) return responseAt(url,
      `<a href="${augustUrl}">Opportunities in August 2026</a><a href="${septemberUrl}">Opportunities in September 2026</a>`);
    if (url === augustUrl || url === septemberUrl) return responseAt(url, options.article?.() ?? articleHtml());
    throw new Error("Unexpected synthetic request");
  });
  vi.stubGlobal("fetch", mock); return mock;
}

describe("Hyperallergic source integration", () => {
  it("imports separate entries, dedupes monthly repeats, and leaves unchanged source data cached", async () => {
    const { env, database, bucket } = setup(); let cached = false;
    const html = articleHtml(entryHtml() + entryHtml("Other Award", "https://example.org/award"));
    const fetch = network({ feed: () => feed(html), cached: () => cached });
    expect(await syncHyperallergic(env, config(), at)).toMatchObject({ discovered: 2, extracted: 4, ingested: 2, unchanged: 2, failed: 0 });
    const row = database.sqlite.prepare("SELECT id FROM messages WHERE subject = 'Fictional Film Grant'").get() as { id: string };
    const parsed = await parseStoredMessage(env.MAIL_BUCKET, (await getMessage(env.DB, row.id))!, 20_971_520);
    expect(parsed).toMatchObject({ source: "hyperallergic", receivedAt: at.toISOString(), senderName: "Hyperallergic" });
    expect(parsed.discoveryContext).toMatchObject({ sourceUrl: augustUrl, officialUrls: ["https://example.org/apply/film"] });
    expect(database.sqlite.prepare("SELECT COUNT(*) AS n FROM source_document_messages").get()).toEqual({ n: 4 });
    cached = true;
    expect(await syncHyperallergic(env, config(), at)).toMatchObject({ cached: 2, ingested: 0, failed: 0 });
    expect(bucket.put).toHaveBeenCalledTimes(2);
    expect(fetch).toHaveBeenCalledTimes(2);
  });
  it("versions changed deadlines but not formatting, preserving successful snapshots", async () => {
    const { env, database } = setup(); let html = articleHtml(); network({ feed: () => feed(html) });
    await syncHyperallergic(env, config(), at);
    database.sqlite.exec("UPDATE messages SET status = 'digest'");
    html = html.replace("Submit a film", "Submit   a film").replace("Awards &amp; Grants", "Grants &amp; Awards");
    expect(await syncHyperallergic(env, config(), at)).toMatchObject({ ingested: 0, unchanged: 2 });
    html = html.replace("September 30, 2026", "October 12, 2026");
    expect(await syncHyperallergic(env, config(), at)).toMatchObject({ ingested: 1, unchanged: 1 });
    expect(database.sqlite.prepare("SELECT COUNT(*) AS n FROM messages WHERE status = 'digest'").get()).toEqual({ n: 1 });
  });
  it("uses archive/full-page fallback for omitted or truncated roundup content", async () => {
    const { env } = setup();
    const fetch = network({ feed: () => rss([{ title: "Opportunities in September 2026", url: septemberUrl, html: "<p>Read more</p>" }]) });
    expect(await syncHyperallergic(env, config(), at)).toMatchObject({ missingMonths: 0, ingested: 1, failed: 0 });
    expect(fetch.mock.calls.map(([url]) => url)).toEqual(expect.arrayContaining([HYPERALLERGIC_ARCHIVE, augustUrl, septemberUrl]));
  });
  it.each(["queued", "failed"])("restores expired %s payloads beyond the month window even on 304", async (status) => {
    const { env, database } = setup(); let cached = false; network({ cached: () => cached });
    await syncHyperallergic(env, config(), at);
    database.sqlite.prepare("UPDATE messages SET status = ?, attempts = 4, raw_r2_key = ''").run(status);
    cached = true;
    expect(await syncHyperallergic(env, config(), new Date("2026-12-04T14:00:00Z"))).toMatchObject({ ingested: 1 });
    expect(database.sqlite.prepare("SELECT status, raw_r2_key FROM messages").get()).toMatchObject({ status: "queued", raw_r2_key: expect.stringContaining("raw/hyperallergic/") });
  });
  it("keeps parser failures pending and counts deferred work without logging source content", async () => {
    const { env, database } = setup();
    let html = "<h2>Grants</h2><p>Unsupported structure</p>";
    network({ feed: () => feed(html), article: () => html });
    expect(await syncHyperallergic(env, config(), at)).toMatchObject({ failed: 2, ingested: 0 });
    expect(database.sqlite.prepare("SELECT COUNT(*) AS n FROM source_documents WHERE pending = 1").get()).toEqual({ n: 2 });
    html = articleHtml(Array.from({ length: 201 }, (_, i) => entryHtml(`Fictional Grant ${i}`, `https://example.org/grant/${i}`)).join(""));
    const logs = vi.spyOn(console, "log").mockImplementation(() => {});
    const first = await syncHyperallergic(env, config(), at);
    expect(first).toMatchObject({ extracted: 200, ingested: 200 });
    expect(first.deferred).toBeGreaterThan(0);
    for (let i = 0; i < 2; i++) await syncHyperallergic(env, config(), at);
    expect(database.sqlite.prepare("SELECT COUNT(*) AS n FROM messages").get()).toEqual({ n: 201 });
    expect(JSON.stringify(logs.mock.calls)).not.toContain("Fictional Grant");
    expect(Object.values(first).every((value) => typeof value === "number" || typeof value === "boolean")).toBe(true);
  });
  it("has a disabled no-I/O switch and metadata-only connection inspection", async () => {
    const { env, bucket } = setup(); const fetch = network();
    expect(await inspectHyperallergicConnection(config(), at)).toEqual({ matchingRoundups: 2, invalid: 0, skipped: false });
    fetch.mockClear();
    expect(await syncHyperallergic(env, runtimeConfig(), at)).toMatchObject({ skipped: true });
    expect(await inspectHyperallergicConnection(runtimeConfig(), at)).toMatchObject({ skipped: true });
    expect(fetch).not.toHaveBeenCalled(); expect(bucket.put).not.toHaveBeenCalled();
  });
  it("protects the source-only route and queues data without classification or publication", async () => {
    vi.useFakeTimers(); vi.setSystemTime(at);
    const { env, database } = setup(); network();
    const ai = { run: vi.fn() }; const create = vi.fn(); const email = { send: vi.fn() };
    const bound = { ...env, AI: ai, BATCH_WORKFLOW: { create }, EMAIL: email } as unknown as Env;
    const request = (authorized: boolean) => new Request("https://radar.example/admin/sync/hyperallergic", {
      method: "POST", headers: authorized ? { authorization: "Bearer test-admin-token" } : {}
    });
    expect((await worker.fetch(request(false), bound)).status).toBe(401);
    const response = await worker.fetch(request(true), bound);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ingested: 1, skipped: false });
    expect(database.sqlite.prepare("SELECT status FROM messages").get()).toEqual({ status: "queued" });
    expect(ai.run).not.toHaveBeenCalled(); expect(create).not.toHaveBeenCalled(); expect(email.send).not.toHaveBeenCalled();
  });
});
