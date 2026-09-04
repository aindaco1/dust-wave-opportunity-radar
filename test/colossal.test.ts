import { afterEach, describe, expect, it, vi } from "vitest";
import { inspectColossalConnection, syncColossal } from "../src/ingest/colossal";
import { COLOSSAL_ARCHIVE, COLOSSAL_FEED } from "../src/ingest/colossal-parser";
import { parseStoredMessage } from "../src/email/parse";
import { getMessage } from "../src/storage/database";
import { env as baseEnv, runtimeConfig } from "./support/fixtures";
import { createTestDatabase, type TestDatabase } from "./support/d1";
import { articleHtml, entryHtml, responseAt, rss, augustUrl, septemberUrl } from "./support/colossal";

const databases: TestDatabase[] = [];
const at = new Date("2026-09-04T13:00:00.000Z");
const config = () => runtimeConfig({ colossalEnabled: true });
afterEach(() => {
  vi.unstubAllGlobals(); vi.restoreAllMocks();
  databases.splice(0).forEach((db) => db.close());
});
function setup() {
  const database = createTestDatabase(); databases.push(database);
  const objects = new Map<string, Uint8Array>();
  const bucket = {
    put: vi.fn(async (key: string, value: Uint8Array) => { objects.set(key, value); return null; }),
    delete: vi.fn(async (key: string) => { objects.delete(key); }),
    get: vi.fn(async (key: string) => {
      const bytes = objects.get(key);
      return bytes ? { arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) } : null;
    })
  };
  return { database, objects, bucket, env: baseEnv({ DB: database.db, MAIL_BUCKET: bucket }) };
}
function network(options: { body?: () => string; article?: () => string; notModified?: () => boolean } = {}) {
  const mock = vi.fn(async (url: string, init?: RequestInit) => {
    if (url === COLOSSAL_FEED) return responseAt(url, options.notModified?.() ? null : options.body?.() ?? rss(),
      options.notModified?.() ? 304 : 200, "application/rss+xml");
    if (url === COLOSSAL_ARCHIVE) return responseAt(url, `<a href="${augustUrl}">August 2026 Opportunities</a><a href="${septemberUrl}">September 2026 Opportunities</a>`);
    if (url === augustUrl || url === septemberUrl) {
      expect(init?.redirect).toBe("manual");
      return responseAt(url, options.article?.() ?? articleHtml());
    }
    throw new Error("Unexpected synthetic request");
  });
  vi.stubGlobal("fetch", mock); return mock;
}

describe("Colossal synchronization", () => {
  it("imports named months through shared MIME/D1, dedupes monthly repeats, and skips a cached feed", async () => {
    const { env, database, bucket } = setup();
    let cached = false; const fetch = network({ notModified: () => cached });
    expect(await syncColossal(env, config(), at)).toMatchObject({ discovered: 2, extracted: 2, ingested: 1, unchanged: 1, failed: 0 });
    const row = database.sqlite.prepare("SELECT id FROM messages").get() as { id: string };
    const stored = await getMessage(env.DB, row.id);
    const parsed = await parseStoredMessage(env.MAIL_BUCKET, stored!, 20_971_520);
    expect(parsed).toMatchObject({ source: "colossal", subject: "Fictional Film Grant", receivedAt: at.toISOString() });
    expect(parsed.discoveryContext).toMatchObject({ sourceUrl: augustUrl, officialUrls: ["https://example.org/apply/film"] });
    expect(database.sqlite.prepare("SELECT COUNT(*) AS n FROM source_document_messages").get()).toEqual({ n: 2 });
    cached = true;
    expect(await syncColossal(env, config(), at)).toMatchObject({ cached: 2, ingested: 0, failed: 0 });
    expect(bucket.put).toHaveBeenCalledTimes(1);
    expect(fetch.mock.calls.at(-1)?.[1]?.headers).toMatchObject({ "If-None-Match": '"v1"' });
  });
  it("only versions substantive changes, preserving terminal snapshots", async () => {
    const { env, database } = setup();
    let html = articleHtml();
    network({ body: () => rss([{ title: "August 2026 Opportunities", url: augustUrl, html }, { title: "September 2026 Opportunities", url: septemberUrl, html }]) });
    await syncColossal(env, config(), at);
    database.sqlite.exec("UPDATE messages SET status = 'digest'");
    html = html.replace("Submit a film", "Submit   a film").replace("<strong>Open Calls</strong>", "<strong>Grants</strong>");
    expect(await syncColossal(env, config(), at)).toMatchObject({ ingested: 0, unchanged: 2 });
    html = html.replace("September 30, 2026", "October 10, 2026");
    expect(await syncColossal(env, config(), at)).toMatchObject({ ingested: 1, unchanged: 1 });
    expect(database.sqlite.prepare("SELECT COUNT(*) AS n FROM messages WHERE status = 'digest'").get()).toEqual({ n: 1 });
  });
  it.each(["queued", "failed"])("restores expired %s source data even on HTTP 304 and after a month rollover", async (status) => {
    const { env, database, bucket } = setup();
    let cached = false; const fetch = network({ notModified: () => cached });
    await syncColossal(env, config(), at);
    database.sqlite.prepare("UPDATE messages SET status = ?, attempts = ?, raw_r2_key = ''").run(status, status === "failed" ? 4 : 0);
    cached = true;
    expect(await syncColossal(env, config(), new Date("2026-12-04T14:00:00Z"))).toMatchObject({ ingested: 1 });
    expect(database.sqlite.prepare("SELECT status, attempts FROM messages").get()).toEqual({ status: "queued", attempts: 0 });
    expect(bucket.put).toHaveBeenCalledTimes(2);
    const restored = fetch.mock.calls.find(([url]) => url === augustUrl);
    expect(restored?.[1]?.headers).not.toHaveProperty("If-None-Match");
  });
  it("falls back to archive discovery and full HTML when the feed omits an article or is truncated", async () => {
    const { env, database } = setup();
    const fetch = network({ body: () => rss([{ title: "September 2026 Opportunities", url: septemberUrl, html: `${articleHtml()}<a>Read more</a>` }]) });
    expect(await syncColossal(env, config(), at)).toMatchObject({ discovered: 2, ingested: 1, failed: 0, missingMonths: 0 });
    expect(fetch.mock.calls.map(([url]) => url)).toEqual(expect.arrayContaining([COLOSSAL_ARCHIVE, augustUrl, septemberUrl]));
    expect(database.sqlite.prepare("SELECT published_at FROM source_documents WHERE url = ?").get(augustUrl)).toEqual({ published_at: "" });
    network();
    await syncColossal(env, config(), at);
    expect(database.sqlite.prepare("SELECT published_at FROM source_documents WHERE url = ?").get(augustUrl)).toEqual({ published_at: "2026-07-29T12:00:00.000Z" });
  });
  it("retains partial failures for retry while importing other entries", async () => {
    const { env, bucket, database } = setup();
    network(); bucket.put.mockRejectedValueOnce(new Error("synthetic failure"));
    expect(await syncColossal(env, config(), at)).toMatchObject({ failed: 1, ingested: 1 });
    expect(database.sqlite.prepare("SELECT COUNT(*) AS n FROM source_documents WHERE pending = 1").get()).toEqual({ n: 1 });
    expect(await syncColossal(env, config(), at)).toMatchObject({ failed: 0, ingested: 0 });
    expect(database.sqlite.prepare("SELECT COUNT(*) AS n FROM source_documents WHERE pending = 1").get()).toEqual({ n: 0 });
  });
  it("resumes capped imports without losing candidates or exposing content in results/logs", async () => {
    const { env, database } = setup();
    const html = articleHtml(Array.from({ length: 205 }, (_, i) => entryHtml(`Fictional Grant ${i}`, `https://example.org/grant/${i}`)).join(""));
    let cached = false;
    network({ body: () => rss([{ title: "August 2026 Opportunities", url: augustUrl, html }, { title: "September 2026 Opportunities", url: septemberUrl, html }]), article: () => html, notModified: () => cached });
    const logs = vi.spyOn(console, "log").mockImplementation(() => {});
    const first = await syncColossal(env, config(), at);
    expect(first).toMatchObject({ extracted: 200, ingested: 200 });
    expect(first.deferred).toBeGreaterThan(0);
    cached = true;
    for (let i = 0; i < 3; i++) await syncColossal(env, config(), at);
    expect(database.sqlite.prepare("SELECT COUNT(*) AS n FROM messages").get()).toEqual({ n: 205 });
    expect(database.sqlite.prepare("SELECT COUNT(*) AS n FROM source_documents WHERE pending = 1").get()).toEqual({ n: 0 });
    expect(JSON.stringify(logs.mock.calls)).not.toContain("Fictional Grant");
    expect(Object.values(first).every((value) => typeof value === "number" || typeof value === "boolean")).toBe(true);
  });
  it("retains article revisions beyond the document cap when the next feed response is 304", async () => {
    const { env, database } = setup();
    let cached = false;
    let deadline = "September 30, 2026";
    const posts = () => Array.from({ length: 6 }, (_, i) => ({
      title: `${i < 3 ? "August" : "September"} 2026 Opportunities ${i}`,
      url: `https://www.thisiscolossal.com/2026/08/fictional-roundup-${i}/`,
      html: articleHtml(entryHtml(`Fictional Grant ${i}`, `https://example.org/grant/${i}`, deadline))
    }));
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      if (url === COLOSSAL_FEED) return responseAt(url, cached ? null : rss(posts()), cached ? 304 : 200, "application/rss+xml");
      const post = posts().find((post) => post.url === url);
      if (!post) throw new Error("Unexpected synthetic request");
      return responseAt(url, post.html);
    }));
    expect(await syncColossal(env, config(), at)).toMatchObject({ ingested: 4, deferred: 2 });
    cached = true;
    expect(await syncColossal(env, config(), at)).toMatchObject({ ingested: 2 });
    deadline = "October 15, 2026";
    cached = false;
    expect(await syncColossal(env, config(), at)).toMatchObject({ ingested: 4, deferred: 2 });
    expect(database.sqlite.prepare("SELECT COUNT(*) AS n FROM source_documents WHERE pending = 1").get()).toEqual({ n: 2 });
    cached = true;
    expect(await syncColossal(env, config(), at)).toMatchObject({ ingested: 2 });
    expect(database.sqlite.prepare("SELECT COUNT(*) AS n FROM messages").get()).toEqual({ n: 12 });
    expect(database.sqlite.prepare("SELECT COUNT(*) AS n FROM source_documents WHERE pending = 1").get()).toEqual({ n: 0 });
  });
  it("marks shared URLs across different roundups before either program is classified", async () => {
    const { env, database } = setup();
    network({ body: () => rss([
      { title: "August 2026 Opportunities", url: augustUrl, html: articleHtml(entryHtml("Film Grant", "https://example.org/shared")) },
      { title: "September 2026 Opportunities", url: septemberUrl, html: articleHtml(entryHtml("Sculpture Residency", "https://example.org/shared")) }
    ]) });
    await syncColossal(env, config(), at);
    const rows = database.sqlite.prepare("SELECT discovery_context_json FROM messages").all() as { discovery_context_json: string }[];
    expect(rows).toHaveLength(2);
    for (const row of rows) expect(JSON.parse(row.discovery_context_json).ambiguousUrls).toEqual(["https://example.org/shared"]);
  });
  it("stops the source step if discovery safety metadata cannot be persisted", async () => {
    const { env, database } = setup(); network();
    database.sqlite.exec("CREATE TRIGGER fail_context BEFORE UPDATE OF discovery_context_json ON messages BEGIN SELECT RAISE(FAIL, 'synthetic'); END");
    network({ body: () => rss([
      { title: "August 2026 Opportunities", url: augustUrl, html: articleHtml(entryHtml("Film Grant", "https://example.org/shared")) },
      { title: "September 2026 Opportunities", url: septemberUrl, html: articleHtml(entryHtml("Sculpture Residency", "https://example.org/shared")) }
    ]) });
    await expect(syncColossal(env, config(), at)).rejects.toThrow("discovery_safety_failed");
  });
  it("has read-only inspection and an inert disabled switch", async () => {
    const { env, bucket } = setup(); const fetch = network();
    expect(await inspectColossalConnection(config(), at)).toEqual({ matchingRoundups: 2, invalid: 0, skipped: false });
    fetch.mockClear();
    expect(await syncColossal(env, runtimeConfig(), at)).toMatchObject({ skipped: true, ingested: 0 });
    expect(await inspectColossalConnection(runtimeConfig(), at)).toMatchObject({ skipped: true });
    expect(fetch).not.toHaveBeenCalled(); expect(bucket.put).not.toHaveBeenCalled();
  });
  it("fails the source step on unusable feeds and retains article parse failures as pending", async () => {
    const { env, database } = setup();
    network({ body: () => "<broken>" });
    await expect(syncColossal(env, config(), at)).rejects.toThrow("invalid_xml");
    network({ body: () => rss([{ title: "September 2026 Opportunities", url: septemberUrl, html: "" }]), article: () => "<p>No entries</p>" });
    expect(await syncColossal(env, config(), at)).toMatchObject({ failed: 2, ingested: 0 });
    expect(database.sqlite.prepare("SELECT COUNT(*) AS n FROM source_documents WHERE pending = 1").get()).toEqual({ n: 2 });
  });
});
