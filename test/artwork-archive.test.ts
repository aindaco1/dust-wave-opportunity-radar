import { afterEach, describe, expect, it, vi } from "vitest";
import worker from "../src/index";
import { inspectArtworkArchiveConnection, syncArtworkArchive } from "../src/ingest/artwork-archive";
import { ARTWORK_ARCHIVE_GUIDE } from "../src/ingest/artwork-archive-parser";
import { parseStoredMessage } from "../src/email/parse";
import { getMessage } from "../src/storage/database";
import { env as baseEnv, runtimeConfig } from "./support/fixtures";
import { createTestDatabase, type TestDatabase } from "./support/d1";
import { responseAt } from "./support/colossal";
import { entryHtml, guideHtml } from "./support/artwork-archive";

const databases: TestDatabase[] = [];
const at = new Date("2026-09-08T13:00:00Z");
const config = () => runtimeConfig({ artworkArchiveEnabled: true });
afterEach(() => {
  vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks();
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
  const env = baseEnv({ DB: database.db, MAIL_BUCKET: bucket, ARTWORK_ARCHIVE_ENABLED: "true" });
  return { database, objects, bucket, env };
}
function network(html: () => string = guideHtml) {
  const fetch = vi.fn(async (url: string, init?: RequestInit) => {
    expect(url).toBe(ARTWORK_ARCHIVE_GUIDE);
    expect(init?.redirect).toBe("manual");
    return responseAt(url, html());
  });
  vi.stubGlobal("fetch", fetch); return fetch;
}

describe("Artwork Archive source integration", () => {
  it("imports each listing with discovery context and caches a completed guide on 304", async () => {
    const { env, database, bucket } = setup();
    const fetch = network(() => guideHtml(entryHtml() + entryHtml("Rolling Residency", "https://example.org/rolling", "Ongoing")));
    expect(await syncArtworkArchive(env, config(), at)).toMatchObject({ extracted: 2, ingested: 2, failed: 0 });
    const row = database.sqlite.prepare("SELECT id FROM messages WHERE subject = 'Fictional Film Residency'").get() as { id: string };
    const parsed = await parseStoredMessage(env.MAIL_BUCKET, (await getMessage(env.DB, row.id))!, 20_971_520);
    expect(parsed).toMatchObject({ source: "artwork_archive", senderName: "Artwork Archive", receivedAt: at.toISOString() });
    expect(parsed.discoveryContext).toEqual({ sourceUrl: ARTWORK_ARCHIVE_GUIDE, officialUrls: ["https://example.org/residency"], ambiguousUrls: [], requiresReview: false });
    expect(parsed.text).toContain("Entry Fee: $40");
    expect(parsed.text).not.toContain("Roundup month:");
    expect(database.sqlite.prepare("SELECT COUNT(*) AS n FROM source_document_messages").get()).toEqual({ n: 2 });
    fetch.mockImplementationOnce(async (url, init) => {
      expect(new Headers(init?.headers).get("if-none-match")).toBe('"v1"');
      return responseAt(url, null, 304);
    });
    expect(await syncArtworkArchive(env, config(), at)).toMatchObject({ ingested: 0, cached: 1, failed: 0 });
    expect(bucket.put).toHaveBeenCalledTimes(2);
  });
  it("deduplicates countdown/formatting changes and versions deadline changes without resetting terminal state", async () => {
    const { env, database } = setup(); let html = guideHtml(); network(() => html);
    await syncArtworkArchive(env, config(), at);
    database.sqlite.exec("UPDATE messages SET status = 'notion', raw_r2_key = ''");
    html = html.replace("56 days left", "55 days left").replace("Submit a film", "Submit   a <em>film</em>");
    expect(await syncArtworkArchive(env, config(), at)).toMatchObject({ ingested: 0, unchanged: 1 });
    html = html.replaceAll("November 3, 2026", "December 4, 2026");
    expect(await syncArtworkArchive(env, config(), at)).toMatchObject({ ingested: 1 });
    expect(database.sqlite.prepare("SELECT COUNT(*) AS n FROM messages WHERE status = 'notion'").get()).toEqual({ n: 1 });
  });
  it.each(["queued", "failed"])("restores expired %s payloads with the same identity and without conditional requests", async (status) => {
    const { env, database } = setup(); const fetch = network();
    await syncArtworkArchive(env, config(), at);
    const before = database.sqlite.prepare("SELECT id FROM messages").get();
    database.sqlite.prepare("UPDATE messages SET status = ?, attempts = ?, raw_r2_key = ''").run(status, status === "failed" ? 4 : 0);
    expect(await syncArtworkArchive(env, config(), new Date("2027-01-04T14:00:00Z"))).toMatchObject({ ingested: 1, failed: 0 });
    expect(new Headers(fetch.mock.calls.at(-1)?.[1]?.headers).has("if-none-match")).toBe(false);
    expect(database.sqlite.prepare("SELECT id FROM messages").get()).toEqual(before);
    expect(database.sqlite.prepare("SELECT status, attempts, raw_r2_key FROM messages").get())
      .toMatchObject({ status: "queued", attempts: 0, raw_r2_key: expect.stringContaining("raw/artwork_archive/2027-01-04/") });
  });
  it("resumes capped work and retries an individual failed upload", async () => {
    const { env, database, bucket } = setup();
    const html = guideHtml(Array.from({ length: 201 }, (_, i) => `<div class="opportunity-guide-entry"><h2>Film Call ${i}</h2>
      <ul class="opportunity-info-list"><li>Submission Deadline: Ongoing</li></ul><p>Submit for selection.</p>
      <div class="external-opportunity-links"><a href="https://example.org/${i}">Apply</a></div></div>`).join(""));
    network(() => html);
    bucket.put.mockRejectedValueOnce(new Error("untrusted storage detail"));
    expect(await syncArtworkArchive(env, config(), at)).toMatchObject({ extracted: 200, ingested: 199, failed: 1, deferred: 1 });
    expect(database.sqlite.prepare("SELECT next_entry, pending FROM source_documents").get()).toEqual({ next_entry: 200, pending: 1 });
    expect(await syncArtworkArchive(env, config(), at)).toMatchObject({ extracted: 1, ingested: 1 });
    expect(database.sqlite.prepare("SELECT pending FROM source_documents").get()).toEqual({ pending: 1 });
    await syncArtworkArchive(env, config(), at);
    await syncArtworkArchive(env, config(), at);
    expect(database.sqlite.prepare("SELECT COUNT(*) AS n FROM messages").get()).toEqual({ n: 201 });
    expect(database.sqlite.prepare("SELECT pending, last_error_code FROM source_documents").get()).toEqual({ pending: 0, last_error_code: null });
  });
  it.each(["http", "layout", "redirect", "304"])("retains pending work on %s failure and logs only counters", async (kind) => {
    const { env, database } = setup();
    vi.stubGlobal("fetch", vi.fn(async () => kind === "304" ? responseAt(ARTWORK_ARCHIVE_GUIDE, null, 304)
      : responseAt(kind === "redirect" ? "https://www.artworkarchive.com/logins/sign_in" : ARTWORK_ARCHIVE_GUIDE,
        kind === "layout" ? "<h1>untrusted private-looking text</h1>" : guideHtml(), kind === "http" ? 403 : 200)));
    const logs = vi.spyOn(console, "log").mockImplementation(() => {});
    expect(await syncArtworkArchive(env, config(), at)).toMatchObject({ failed: 1, ingested: 0, cached: 0 });
    expect(database.sqlite.prepare("SELECT pending, etag, last_error_code FROM source_documents").get())
      .toEqual({ pending: 1, etag: null, last_error_code: "document_sync_failed" });
    expect(JSON.stringify(logs.mock.calls)).not.toMatch(/Fictional|private-looking|example\.org/);
    network();
    expect(await syncArtworkArchive(env, config(), at)).toMatchObject({ ingested: 1, failed: 0 });
  });
  it("marks previously queued programs sharing official links and fails closed if those guards cannot persist", async () => {
    const { env, database } = setup(); let html = guideHtml(); network(() => html);
    await syncArtworkArchive(env, config(), at);
    html = guideHtml(entryHtml("Different Residency"));
    expect(await syncArtworkArchive(env, config(), at)).toMatchObject({ ingested: 1, unresolved: 1 });
    const contexts = database.sqlite.prepare("SELECT discovery_context_json FROM messages").all() as { discovery_context_json: string }[];
    expect(contexts.every((row) => JSON.parse(row.discovery_context_json).ambiguousUrls.includes("https://example.org/residency"))).toBe(true);
    const prepare = env.DB.prepare.bind(env.DB);
    const guardFailure = vi.spyOn(env.DB, "prepare").mockImplementation((sql) => {
      if (sql.includes("SELECT 1 AS found")) throw new Error("untrusted DB error");
      return prepare(sql);
    });
    await expect(syncArtworkArchive(env, config(), at)).rejects.toThrow("artwork_archive_discovery_safety_failed");
    expect(database.sqlite.prepare("SELECT pending FROM source_documents").get()).toEqual({ pending: 1 });
    guardFailure.mockRestore();
    const fetch = network(() => html);
    expect(await syncArtworkArchive(env, config(), at)).toMatchObject({ failed: 0, ingested: 0 });
    expect(new Headers(fetch.mock.calls[0]?.[1]?.headers).has("if-none-match")).toBe(false);
  });
  it("has a disabled no-I/O switch and read-only count inspection", async () => {
    const { env, database, bucket } = setup(); const fetch = network();
    expect(await inspectArtworkArchiveConnection(config())).toEqual({ matchingEntries: 1, skipped: false });
    expect(database.sqlite.prepare("SELECT COUNT(*) AS n FROM messages").get()).toEqual({ n: 0 });
    expect(bucket.put).not.toHaveBeenCalled(); fetch.mockClear();
    expect(await syncArtworkArchive({} as Env, runtimeConfig(), at)).toMatchObject({ skipped: true });
    expect(await inspectArtworkArchiveConnection(runtimeConfig())).toMatchObject({ skipped: true });
    expect(fetch).not.toHaveBeenCalled();
    await expect(syncArtworkArchive(env, config(), new Date("invalid"))).rejects.toThrow("artwork_archive_invalid_run_date");
    fetch.mockResolvedValueOnce(responseAt(ARTWORK_ARCHIVE_GUIDE, null, 304));
    await expect(inspectArtworkArchiveConnection(config())).rejects.toThrow("artwork_archive_unverified_response");
  });
  it("protects source-only routing and does not start AI, publication, or a batch", async () => {
    vi.useFakeTimers(); vi.setSystemTime(at);
    const { env, database } = setup(); network();
    const ai = { run: vi.fn() }; const create = vi.fn(); const email = { send: vi.fn() };
    const bound = { ...env, AI: ai, BATCH_WORKFLOW: { create }, EMAIL: email } as unknown as Env;
    const request = (authorized: boolean) => new Request("https://radar.example/admin/sync/artwork-archive", {
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
