import { afterEach, describe, expect, it, vi } from "vitest";
import { inspectZohoConnection, syncZoho } from "../src/ingest/zoho";
import { getCheckpoint } from "../src/storage/database";
import { env as baseEnv, runtimeConfig } from "./support/fixtures";
import { createTestDatabase, type TestDatabase } from "./support/d1";

const open: TestDatabase[] = [];

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  while (open.length) open.pop()?.close();
});

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });
}

function setup() {
  const testDb = createTestDatabase();
  open.push(testDb);
  const objects = new Map<string, Uint8Array>();
  const bucket = {
    put: vi.fn(async (key: string, value: ArrayBuffer) => {
      objects.set(key, new Uint8Array(value));
      return null;
    })
  };
  return { testDb, bucket, objects, env: baseEnv({ DB: testDb.db, MAIL_BUCKET: bucket }) };
}

function connectionFetch(folders = [
  { folderId: "1", folderName: "Inbox" },
  { folderId: "2", folderName: "Dust Wave" },
  { folderId: "3", folderName: "Newsletter" },
  { folderId: "4", folderName: "Notification" }
]) {
  return vi.fn()
    .mockResolvedValueOnce(json({ access_token: "access-token" }))
    .mockResolvedValueOnce(json({ data: [{
      accountId: "account-1",
      primaryEmailAddress: "primary@example.org",
      emailAddress: [{ mailId: "alonso@dustwave.xyz" }]
    }] }))
    .mockResolvedValueOnce(json({ data: folders }));
}

describe("Zoho connection", () => {
  it("validates the account alias and all configured folders", async () => {
    const { env } = setup();
    const fetchMock = connectionFetch();
    vi.stubGlobal("fetch", fetchMock);
    await expect(inspectZohoConnection(env, runtimeConfig())).resolves.toEqual({
      accountEmail: "primary@example.org",
      configuredFolders: ["Inbox", "Dust Wave", "Newsletter", "Notification"],
      matchedFolders: ["Inbox", "Dust Wave", "Newsletter", "Notification"]
    });
    expect(fetchMock.mock.calls[0]?.[0]).toBe("https://accounts.zoho.com/oauth/v2/token");
    expect(fetchMock.mock.calls[1]?.[1]).toMatchObject({ headers: { Authorization: "Zoho-oauthtoken access-token" } });
  });

  it("fails early when OAuth credentials are incomplete", async () => {
    const { env } = setup();
    await expect(inspectZohoConnection(baseEnv({ ...env, ZOHO_CLIENT_SECRET: "" }), runtimeConfig()))
      .rejects.toThrow("OAuth secrets are missing");
  });

  it("rejects an unsupported data center", async () => {
    const { env } = setup();
    await expect(inspectZohoConnection(env, runtimeConfig({ zohoDatacenter: "moon" })))
      .rejects.toThrow("Unsupported Zoho datacenter");
  });

  it("names every configured folder that is missing", async () => {
    const { env } = setup();
    vi.stubGlobal("fetch", connectionFetch([{ folderId: "1", folderName: "Inbox" }]));
    await expect(inspectZohoConnection(env, runtimeConfig())).rejects.toThrow("Dust Wave, Newsletter, Notification");
  });
});

describe("Zoho synchronization", () => {
  it("skips without touching credentials or the network when disabled", async () => {
    const { env } = setup();
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    await expect(syncZoho(env, runtimeConfig({ zohoEnabled: false }))).resolves.toEqual({
      folders: [], fetched: 0, ingested: 0, failed: 0, sampleErrors: [], skipped: true
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("stores an original MIME message and advances the folder checkpoint", async () => {
    const { env, objects, bucket, testDb } = setup();
    const receivedAt = new Date(Date.now() - 60_000).toISOString();
    const mime = "Subject: Film call\r\nFrom: Arts <calls@example.org>\r\n\r\nApplications open";
    const fetchMock = connectionFetch([{ folderId: "2", folderName: "Dust Wave" }])
      .mockResolvedValueOnce(json({ data: [{
        messageId: "zoho-1",
        folderId: "2",
        subject: " Film call ",
        sender: " Arts ",
        fromAddress: " calls@example.org ",
        sentDateInGMT: receivedAt
      }] }))
      .mockResolvedValueOnce(new Response(mime, { status: 200, headers: { "content-type": "message/rfc822" } }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(syncZoho(env, runtimeConfig({ zohoFolders: ["Dust Wave"] }))).resolves.toMatchObject({
      folders: ["Dust Wave"], fetched: 1, ingested: 1, failed: 0, skipped: false
    });
    expect(bucket.put).toHaveBeenCalledOnce();
    expect(objects.size).toBe(1);
    expect(new TextDecoder().decode([...objects.values()][0])).toBe(mime);
    expect(testDb.sqlite.prepare("SELECT source, external_id, mailbox, subject, sender_name, sender_email, status FROM messages").get()).toEqual({
      source: "zoho",
      external_id: "zoho-1",
      mailbox: "Dust Wave",
      subject: "Film call",
      sender_name: "Arts",
      sender_email: "calls@example.org",
      status: "queued"
    });
    expect(await getCheckpoint(env.DB, "zoho", "Dust Wave")).toBe(receivedAt);
  });

  it("builds fallback MIME when the original-message endpoint is unavailable", async () => {
    const { env, objects } = setup();
    const receivedAt = new Date(Date.now() - 60_000).toISOString();
    const fetchMock = connectionFetch([{ folderId: "1", folderName: "Inbox" }])
      .mockResolvedValueOnce(json({ data: [{
        messageId: "zoho-2",
        folderId: "1",
        subject: "Open call",
        sender: "Arts Group",
        fromAddress: "calls@example.org",
        sentDateInGMT: receivedAt
      }] }))
      .mockResolvedValueOnce(json({ status: { description: "not available" } }, 404))
      .mockResolvedValueOnce(json({ data: { content: "<p>Apply now</p>" } }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await syncZoho(env, runtimeConfig({ zohoFolders: ["Inbox"] }));
    expect(result.ingested).toBe(1);
    const mime = new TextDecoder().decode([...objects.values()][0]);
    expect(mime).toContain("Message-ID: <zoho-zoho-2@dustwave-opportunity-radar>");
    expect(mime).toContain("Content-Type: text/html");
    expect(mime).toContain("<p>Apply now</p>");
  });
});
