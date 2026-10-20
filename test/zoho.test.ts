import { afterEach, describe, expect, it, vi } from "vitest";
import { inspectZohoConnection, inspectZohoMessage, recoverZohoMessage, syncZoho } from "../src/ingest/zoho";
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
      folders: [], fetched: 0, ingested: 0, failed: 0, reviewRequired: 0, sampleErrors: [], skipped: true
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


describe("Zoho message inspection", () => {
  it("returns only sizes and supported attachment kinds without storing mail", async () => {
    const { env, bucket, testDb } = setup();
    const fetchMock = connectionFetch()
      .mockResolvedValueOnce(json({ data: { size: "30000000", subject: "Private subject", sender: "private@example.org" } }))
      .mockResolvedValueOnce(json({ data: { attachments: [
        { attachmentSize: 25000000, attachmentName: "Private.PDF" },
        { attachmentSize: "12", attachmentName: "Private.docx" },
        { attachmentSize: -1, attachmentName: "Private.png" }
      ], inline: [{ attachmentSize: 123 }] } }))
      .mockResolvedValueOnce(json({ data: { content: "Private body" } }));
    vi.stubGlobal("fetch", fetchMock);
    const result = await inspectZohoMessage(env, runtimeConfig(), "123456", "Inbox");
    expect(result).toEqual({ messageKey: expect.stringMatching(/^[a-f0-9]{64}$/), folder: "Inbox",
      reportedBytes: 30000000, bodyBytes: 12, attachments: [{ bytes: 25000000, kind: "pdf" },
        { bytes: 12, kind: "docx" }, { bytes: null, kind: "other" }], inlineCount: 1, inlineBytes: 123 });
    expect(JSON.stringify(result)).not.toContain("Private");
    expect(bucket.put).not.toHaveBeenCalled();
    expect(testDb.sqlite.prepare("SELECT COUNT(*) AS n FROM messages").get()).toEqual({ n: 0 });
    expect(fetchMock.mock.calls[4]?.[0]).toContain("/folders/1/messages/123456/attachmentinfo?includeInline=true");
  });

  it.each([["../123", "Inbox"], ["123", "Unconfigured"]])("rejects invalid scope before fetching (%s, %s)", async (id, folder) => {
    const { env } = setup();
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    await expect(inspectZohoMessage(env, runtimeConfig(), id, folder)).rejects.toThrow();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});


describe("oversized Zoho recovery", () => {
  it.each(["declared", "streamed"])("recovers a %s oversized message for review and advances the checkpoint", async (mode) => {
    const { env, objects, bucket } = setup();
    const receivedAt = new Date().toISOString();
    const cancel = vi.fn();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) { if (mode === "streamed") controller.enqueue(new Uint8Array(26_214_401)); }, cancel
    });
    const original = new Response(stream, { headers: mode === "declared" ? { "content-length": "33581835" } : {} });
    const fetchMock = connectionFetch([{ folderId: "1", folderName: "Inbox" }])
      .mockResolvedValueOnce(json({ data: [{ messageId: "123", folderId: "1", sentDateInGMT: receivedAt, subject: "Synthetic oversized message" }] }))
      .mockResolvedValueOnce(original)
      .mockResolvedValueOnce(json({ data: { content: "<p>Small body; attachments are in Zoho.</p>" } }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(syncZoho(env, runtimeConfig({ zohoFolders: ["Inbox"] }))).resolves.toMatchObject({
      ingested: 1, failed: 0, reviewRequired: 1
    });
    expect(cancel).toHaveBeenCalled();
    expect(await getCheckpoint(env.DB, "zoho", "Inbox")).toBe(receivedAt);
    expect(new TextDecoder().decode([...objects.values()][0])).toContain("Small body");
    expect(bucket.put).toHaveBeenCalledWith(expect.any(String), expect.any(ArrayBuffer), expect.objectContaining({
      customMetadata: expect.objectContaining({ ingestionWarning: "zoho_original_too_large" })
    }));
  });

  it("retains retry state if an oversized message has no recoverable body", async () => {
    const { env, bucket } = setup();
    const receivedAt = new Date().toISOString();
    vi.stubGlobal("fetch", connectionFetch([{ folderId: "1", folderName: "Inbox" }])
      .mockResolvedValueOnce(json({ data: [{ messageId: "123", folderId: "1", sentDateInGMT: receivedAt }] }))
      .mockResolvedValueOnce(new Response(null, { headers: { "content-length": "33581835" } }))
      .mockResolvedValueOnce(json({ data: { content: "" } })));
    await expect(syncZoho(env, runtimeConfig({ zohoFolders: ["Inbox"] }))).resolves.toMatchObject({ ingested: 0, failed: 1, reviewRequired: 0 });
    expect(bucket.put).not.toHaveBeenCalled();
    expect(await getCheckpoint(env.DB, "zoho", "Inbox")).toBe(receivedAt);
  });

  it("does not reinterpret malformed originals as oversize or include their content in errors", async () => {
    const { env, bucket } = setup();
    const fetchMock = connectionFetch([{ folderId: "1", folderName: "Inbox" }])
      .mockResolvedValueOnce(json({ data: [{ messageId: "123", folderId: "1", sentDateInGMT: new Date().toISOString() }] }))
      .mockResolvedValueOnce(new Response("Private invalid JSON", { headers: { "content-type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(syncZoho(env, runtimeConfig({ zohoFolders: ["Inbox"] }))).resolves.toMatchObject({
      ingested: 0, failed: 1, reviewRequired: 0, sampleErrors: ["Zoho original-message response was invalid JSON"]
    });
    expect(fetchMock).toHaveBeenCalledTimes(5);
    expect(bucket.put).not.toHaveBeenCalled();
  });
});


describe("targeted Zoho recovery", () => {
  it("recovers one oversized identity without listing, advancing checkpoints, or changing an existing record on repeat", async () => {
    const { env, testDb, bucket } = setup();
    const fetchMock = connectionFetch([{ folderId: "1", folderName: "Inbox" }])
      .mockResolvedValueOnce(json({ data: { messageId: "123", folderId: "1", subject: "Recovery fixture", sentDateInGMT: new Date().toISOString() } }))
      .mockResolvedValueOnce(new Response(null, { headers: { "content-length": "33581835" } }))
      .mockResolvedValueOnce(json({ data: { content: "<p>Recover this body.</p>" } }));
    vi.stubGlobal("fetch", fetchMock);
    const result = await recoverZohoMessage(env, runtimeConfig({ zohoFolders: ["Inbox"] }), "123", "Inbox");
    expect(result).toMatchObject({ ingested: true, reviewRequired: true, status: "queued" });
    expect(await getCheckpoint(env.DB, "zoho", "Inbox")).toBeNull();
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes("/messages/view"))).toBe(false);
    expect(bucket.put).toHaveBeenCalledOnce();
    testDb.sqlite.prepare("UPDATE messages SET status = 'digest' WHERE id = ?").run(result.messageKey);
    await expect(recoverZohoMessage(env, runtimeConfig(), "123", "Inbox")).resolves.toMatchObject({ ingested: false, status: "digest" });
    expect(fetchMock).toHaveBeenCalledTimes(6);
    expect(bucket.put).toHaveBeenCalledOnce();
  });

  it.each([{ messageId: "456", folderId: "1" }, { messageId: "123", folderId: "other" }])("rejects mismatched provider scope %j", async (details) => {
    const { env, bucket } = setup();
    vi.stubGlobal("fetch", connectionFetch([{ folderId: "1", folderName: "Inbox" }]).mockResolvedValueOnce(json({ data: details })));
    await expect(recoverZohoMessage(env, runtimeConfig({ zohoFolders: ["Inbox"] }), "123", "Inbox")).rejects.toThrow("did not match");
    expect(bucket.put).not.toHaveBeenCalled();
  });
});
