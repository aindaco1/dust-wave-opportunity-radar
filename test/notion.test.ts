import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ensureNotionSchema,
  inspectNotionReview,
  inspectNotionReviewQueue,
  inspectNotionSchema,
  opportunityAutomationKey,
  publishOpportunity,
  reconcileNotionReview,
  trashNotionPage
} from "../src/notion/client";
import {
  markNotionReviewRequired,
  saveClassification,
  upsertMessage,
  upsertOpportunity
} from "../src/storage/database";
import { classification, env as baseEnv, messageRecord, runtimeConfig } from "./support/fixtures";
import { createTestDatabase, type TestDatabase } from "./support/d1";

const open: TestDatabase[] = [];

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  while (open.length) open.pop()?.close();
});

function setup(overrides: Record<string, unknown> = {}) {
  const testDb = createTestDatabase();
  open.push(testDb);
  return { testDb, env: baseEnv({ DB: testDb.db, ...overrides }), config: runtimeConfig() };
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });
}

function propertyPage(
  id: string,
  title: string,
  options: { automationKey?: string; website?: string; created?: string } = {}
) {
  return {
    id,
    created_time: options.created ?? "2026-01-01T00:00:00.000Z",
    url: `https://notion.so/${id}`,
    properties: {
      Name: { title: [{ plain_text: title }] },
      Website: { rich_text: options.website ? [{ plain_text: options.website }] : [] },
      "Automation Key": { rich_text: options.automationKey ? [{ plain_text: options.automationKey }] : [] }
    }
  };
}

async function seedNotionReview(
  env: Env,
  pageId: string,
  previousMarkdown: string,
  classificationValue = classification()
): Promise<string> {
  await upsertMessage(env.DB, {
    id: "a".repeat(64),
    source: "zoho",
    externalId: "review-external-1",
    mailbox: "Inbox",
    subject: "Synthetic review item",
    receivedAt: "2026-08-05T12:00:00.000Z",
    rawR2Key: "",
    rawSize: 0
  });
  await saveClassification(env.DB, "a".repeat(64), classificationValue, "pending_notion", classificationValue.primaryUrl);
  const automationKey = await opportunityAutomationKey(classificationValue);
  await upsertOpportunity(
    env.DB,
    automationKey,
    "a".repeat(64),
    classificationValue,
    pageId,
    previousMarkdown
  );
  await markNotionReviewRequired(env.DB, "a".repeat(64), "managed_content_changed");
  return automationKey;
}

describe("Notion schema management", () => {
  it("does nothing when publishing is disabled", async () => {
    const { env } = setup();
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    await ensureNotionSchema(env, runtimeConfig({ notionEnabled: false }));
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("adds only missing automation properties", async () => {
    const { env, config } = setup();
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(json({ id: config.notionDataSourceId, properties: { Name: { type: "title" }, Source: { type: "select" } } }))
      .mockResolvedValueOnce(json({ id: config.notionDataSourceId }));
    vi.stubGlobal("fetch", fetchMock);
    await ensureNotionSchema(env, config);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const request = fetchMock.mock.calls[1]?.[1] as RequestInit;
    expect(request.method).toBe("PATCH");
    expect(JSON.parse(String(request.body))).toEqual({
      properties: { "Automation Key": { rich_text: {} }, "Last Checked": { date: {} } }
    });
  });

  it("reports the current schema in stable alphabetical order", async () => {
    const { env, config } = setup();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(json({
      id: config.notionDataSourceId,
      properties: { Website: { type: "rich_text" }, Name: { type: "title" } }
    })));
    await expect(inspectNotionSchema(env, config)).resolves.toEqual({
      dataSourceId: config.notionDataSourceId,
      properties: [{ name: "Name", type: "title" }, { name: "Website", type: "rich_text" }]
    });
  });

  it("requires an integration token", async () => {
    const { config } = setup();
    await expect(inspectNotionSchema(baseEnv({ NOTION_TOKEN: "" }), config)).rejects.toThrow("NOTION_TOKEN is missing");
  });
});

describe("Notion publishing", () => {
  it("creates a clean page when no equivalent opportunity exists", async () => {
    const { env, config } = setup();
    const pageId = "11111111-1111-1111-1111-111111111111";
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(json({ results: [], has_more: false }))
      .mockResolvedValueOnce(json({ id: pageId, url: `https://notion.so/${pageId}` }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await publishOpportunity(env, config, messageRecord(), classification(), "example-foundation:film-grant");
    expect(result).toMatchObject({ pageId, created: true, trashedDuplicatePageIds: [] });
    const [url, request] = fetchMock.mock.calls[1] as [string, RequestInit];
    expect(url).toBe("https://api.notion.com/v1/pages");
    expect(request.method).toBe("POST");
    expect(request.headers).toMatchObject({
      Authorization: "Bearer test-notion-token",
      "Notion-Version": "2026-03-11"
    });
    const body = JSON.parse(String(request.body));
    expect(body.properties.Name.title[0].text.content).toBe("Dust Wave Film Grant");
    expect(body.properties.Source.select.name).toBe("Zoho");
    expect(body.markdown).toContain("## Key dates and application");
    expect(body.markdown).not.toContain("Opportunity Radar managed section");
    expect(body.markdown).not.toContain("Automation change history");
  });

  it("labels Creative West as its own Notion source", async () => {
    const { env, config } = setup();
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(json({ results: [], has_more: false }))
      .mockResolvedValueOnce(json({ id: "11111111-1111-1111-1111-111111111111" }));
    vi.stubGlobal("fetch", fetchMock);

    await publishOpportunity(
      env,
      config,
      messageRecord({ source: "creative_west" }),
      classification(),
      "creative-west-opportunity"
    );

    const request = fetchMock.mock.calls[1]?.[1] as RequestInit;
    expect(JSON.parse(String(request.body)).properties.Source.select.name).toBe("Creative West");
  });

  it("updates a manual canonical page and trashes only the automated duplicate", async () => {
    const { env, config } = setup();
    const manualId = "11111111-1111-1111-1111-111111111111";
    const automatedId = "22222222-2222-2222-2222-222222222222";
    const fetchMock = vi.fn(async (urlValue: string | URL | Request, init?: RequestInit) => {
      const url = String(urlValue);
      const method = init?.method ?? "GET";
      if (url.endsWith(`/data_sources/${config.notionDataSourceId}/query`)) {
        return json({ results: [
          propertyPage(automatedId, "2027 Taos Film Festival", { automationKey: "old-key", created: "2026-01-01T00:00:00Z" }),
          propertyPage(manualId, "Taos Film Festival Submission", { created: "2026-02-01T00:00:00Z" })
        ] });
      }
      if (url.endsWith(`/pages/${manualId}`) && method === "PATCH") return json({ id: manualId });
      if (url.endsWith(`/pages/${manualId}/markdown`) && method === "GET") {
        return json({ markdown: "My manual notes.", truncated: false, unknown_block_ids: [] });
      }
      if (url.endsWith(`/pages/${manualId}/markdown`) && method === "PATCH") return json({ markdown: "updated" });
      if (url.endsWith(`/pages/${automatedId}`) && method === "PATCH") return json({ id: automatedId });
      throw new Error(`Unexpected Notion request: ${method} ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await publishOpportunity(
      env,
      config,
      messageRecord(),
      classification({ title: "2027 Taos Film Festival" }),
      "taos-film-festival"
    );
    expect(result).toMatchObject({ created: false, pageId: manualId, trashedDuplicatePageIds: [automatedId] });
    const markdownPatch = fetchMock.mock.calls.find(([url, init]) =>
      String(url).endsWith(`/pages/${manualId}/markdown`) && (init as RequestInit | undefined)?.method === "PATCH"
    );
    expect(JSON.parse(String((markdownPatch?.[1] as RequestInit).body))).toMatchObject({
      type: "insert_content",
      insert_content: { position: { type: "end" } }
    });
    const trashPatch = fetchMock.mock.calls.find(([url]) => String(url).endsWith(`/pages/${automatedId}`));
    expect(JSON.parse(String((trashPatch?.[1] as RequestInit).body))).toEqual({ in_trash: true });
  });

  it("refuses to overwrite a stored managed section that a person edited", async () => {
    const { env, config, testDb } = setup();
    const pageId = "11111111-1111-1111-1111-111111111111";
    testDb.sqlite.exec(`
      INSERT INTO messages(id, source, external_id, mailbox, received_at, raw_r2_key) VALUES ('message-1', 'zoho', 'external-1', 'Inbox', '2026-08-05T00:00:00Z', 'raw/key');
      INSERT INTO opportunities(automation_key, title, notion_page_id, latest_message_id, first_seen_at, last_seen_at, managed_markdown)
      VALUES ('key', 'Old title', '${pageId}', 'message-1', '2026-08-05', '2026-08-05', 'Original managed text');
    `);
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(json({ results: [propertyPage(pageId, "Dust Wave Film Grant", { automationKey: "key" })] }))
      .mockResolvedValueOnce(json({ id: pageId }))
      .mockResolvedValueOnce(json({ markdown: "A person changed the managed text", truncated: false, unknown_block_ids: [] }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(publishOpportunity(env, config, messageRecord(), classification(), "key"))
      .rejects.toThrow("managed opportunity text was edited");
  });

  it("preserves a substantively edited body as manual and keeps future body writes disabled", async () => {
    const { env, config, testDb } = setup();
    const pageId = "11111111-1111-1111-1111-111111111111";
    const automationKey = await seedNotionReview(env, pageId, "Original managed text");
    const markdown = "A person rewrote this opportunity with useful notes.";
    const fetchMock = vi.fn(async (urlValue: string | URL | Request, init?: RequestInit) => {
      const url = String(urlValue);
      const method = init?.method ?? "GET";
      if (url.endsWith(`/data_sources/${config.notionDataSourceId}/query`)) {
        return json({ results: [propertyPage(pageId, "Dust Wave Film Grant", { automationKey })], has_more: false });
      }
      if (url.endsWith(`/pages/${pageId}/markdown`) && method === "GET") {
        return json({ markdown, truncated: false, unknown_block_ids: [] });
      }
      if (url.endsWith(`/pages/${pageId}`) && method === "PATCH") return json({ id: pageId });
      throw new Error(`Unexpected Notion request: ${method} ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(inspectNotionReview(env, config, "a".repeat(64))).resolves.toMatchObject({
      messageId: "a".repeat(64),
      comparison: "manual_changes"
    });
    await expect(reconcileNotionReview(env, config, "a".repeat(64), "preserve_manual")).resolves.toMatchObject({
      messageId: "a".repeat(64),
      selectedMessageId: "a".repeat(64),
      reconciledCount: 1,
      action: "preserve_manual",
      status: "notion"
    });
    expect(testDb.sqlite.prepare("SELECT status FROM messages WHERE id = ?").get("a".repeat(64)))
      .toEqual({ status: "notion" });
    expect(testDb.sqlite.prepare(
      "SELECT managed_markdown, body_management FROM opportunities WHERE notion_page_id = ?"
    ).get(pageId)).toEqual({ managed_markdown: null, body_management: "manual" });
    expect(fetchMock.mock.calls.filter(([url, init]) =>
      String(url).endsWith(`/pages/${pageId}/markdown`) && (init as RequestInit | undefined)?.method === "PATCH"
    )).toHaveLength(0);
  });

  it("refreshes only formatting-equivalent managed content", async () => {
    const { env, config, testDb } = setup();
    const pageId = "11111111-1111-1111-1111-111111111111";
    const automationKey = await seedNotionReview(env, pageId, "Line one<br>Line two");
    let markdown = "Line one\nLine two";
    const fetchMock = vi.fn(async (urlValue: string | URL | Request, init?: RequestInit) => {
      const url = String(urlValue);
      const method = init?.method ?? "GET";
      if (url.endsWith(`/data_sources/${config.notionDataSourceId}/query`)) {
        return json({ results: [propertyPage(pageId, "Dust Wave Film Grant", { automationKey })], has_more: false });
      }
      if (url.endsWith(`/pages/${pageId}/markdown`) && method === "GET") {
        return json({ markdown, truncated: false, unknown_block_ids: [] });
      }
      if (url.endsWith(`/pages/${pageId}/markdown`) && method === "PATCH") {
        const input = JSON.parse(String(init?.body)) as { replace_content?: { new_str?: string } };
        markdown = input.replace_content?.new_str ?? markdown;
        return json({ markdown, truncated: false, unknown_block_ids: [] });
      }
      if (url.endsWith(`/pages/${pageId}`) && method === "PATCH") return json({ id: pageId });
      throw new Error(`Unexpected Notion request: ${method} ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(inspectNotionReview(env, config, "a".repeat(64))).resolves.toMatchObject({
      comparison: "formatting_equivalent"
    });
    await reconcileNotionReview(env, config, "a".repeat(64), "refresh_managed");
    expect(testDb.sqlite.prepare(
      "SELECT body_management FROM opportunities WHERE notion_page_id = ?"
    ).get(pageId)).toEqual({ body_management: "managed" });
    expect(fetchMock.mock.calls.filter(([url, init]) =>
      String(url).endsWith(`/pages/${pageId}/markdown`) && (init as RequestInit | undefined)?.method === "PATCH"
    )).toHaveLength(1);
  });

  it("refreshes an exact managed block without replacing surrounding manual notes", async () => {
    const { env, config } = setup();
    const pageId = "11111111-1111-1111-1111-111111111111";
    const previousMarkdown = "Original managed text";
    const automationKey = await seedNotionReview(env, pageId, previousMarkdown);
    let markdown = `Manual introduction.\n\n${previousMarkdown}\n\nManual follow-up.`;
    const fetchMock = vi.fn(async (urlValue: string | URL | Request, init?: RequestInit) => {
      const url = String(urlValue);
      const method = init?.method ?? "GET";
      if (url.endsWith(`/data_sources/${config.notionDataSourceId}/query`)) {
        return json({ results: [propertyPage(pageId, "Dust Wave Film Grant", { automationKey })], has_more: false });
      }
      if (url.endsWith(`/pages/${pageId}/markdown`) && method === "GET") {
        return json({ markdown, truncated: false, unknown_block_ids: [] });
      }
      if (url.endsWith(`/pages/${pageId}/markdown`) && method === "PATCH") {
        const input = JSON.parse(String(init?.body)) as {
          update_content?: { content_updates?: Array<{ old_str: string; new_str: string }> };
        };
        const update = input.update_content?.content_updates?.[0];
        if (update) markdown = markdown.replace(update.old_str, update.new_str);
        return json({ markdown, truncated: false, unknown_block_ids: [] });
      }
      if (url.endsWith(`/pages/${pageId}`) && method === "PATCH") return json({ id: pageId });
      throw new Error(`Unexpected Notion request: ${method} ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(inspectNotionReview(env, config, "a".repeat(64))).resolves.toMatchObject({
      comparison: "stored_exact"
    });
    await reconcileNotionReview(env, config, "a".repeat(64), "refresh_managed");
    expect(markdown).toMatch(/^Manual introduction\./);
    expect(markdown).toContain("## Key dates and application");
    expect(markdown).toMatch(/Manual follow-up\.$/);
    const markdownPatch = fetchMock.mock.calls.find(([url, init]) =>
      String(url).endsWith(`/pages/${pageId}/markdown`) && (init as RequestInit | undefined)?.method === "PATCH"
    );
    expect(JSON.parse(String((markdownPatch?.[1] as RequestInit).body))).toMatchObject({
      type: "update_content",
      update_content: { content_updates: [{ old_str: previousMarkdown }] }
    });
  });

  it("reconciles one page group once using its newest review message", async () => {
    const { env, config, testDb } = setup();
    const pageId = "11111111-1111-1111-1111-111111111111";
    const previousMarkdown = "Line one<br>Line two";
    const firstClassification = classification({ bodyMarkdown: "Older managed body." });
    const latestClassification = classification({ title: "Newest opportunity title", bodyMarkdown: "Newest managed body." });
    const automationKey = await seedNotionReview(env, pageId, previousMarkdown, firstClassification);
    const latestMessageId = "b".repeat(64);
    await upsertMessage(env.DB, {
      id: latestMessageId,
      source: "zoho",
      externalId: "review-external-2",
      mailbox: "Inbox",
      subject: "Newer synthetic review item",
      receivedAt: "2026-08-06T12:00:00.000Z",
      rawR2Key: "",
      rawSize: 0
    });
    await saveClassification(env.DB, latestMessageId, latestClassification, "pending_notion", latestClassification.primaryUrl);
    await upsertOpportunity(
      env.DB,
      automationKey,
      latestMessageId,
      latestClassification,
      pageId,
      previousMarkdown
    );
    await markNotionReviewRequired(env.DB, latestMessageId, "managed_content_changed");
    let markdown = "Line one\nLine two";
    const propertyUpdates: Record<string, unknown>[] = [];
    const fetchMock = vi.fn(async (urlValue: string | URL | Request, init?: RequestInit) => {
      const url = String(urlValue);
      const method = init?.method ?? "GET";
      if (url.endsWith(`/data_sources/${config.notionDataSourceId}/query`)) {
        return json({ results: [propertyPage(pageId, "Dust Wave Film Grant", { automationKey })], has_more: false });
      }
      if (url.endsWith(`/pages/${pageId}/markdown`) && method === "GET") {
        return json({ markdown, truncated: false, unknown_block_ids: [] });
      }
      if (url.endsWith(`/pages/${pageId}/markdown`) && method === "PATCH") {
        const input = JSON.parse(String(init?.body)) as { replace_content?: { new_str?: string } };
        markdown = input.replace_content?.new_str ?? markdown;
        return json({ markdown, truncated: false, unknown_block_ids: [] });
      }
      if (url.endsWith(`/pages/${pageId}`) && method === "PATCH") {
        propertyUpdates.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
        return json({ id: pageId });
      }
      throw new Error(`Unexpected Notion request: ${method} ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const inspection = await inspectNotionReviewQueue(env, config);
    expect(inspection).toHaveLength(2);
    expect(new Set(inspection.map((item) => item.pageKey)).size).toBe(1);
    expect(inspection.find((item) => item.messageId === "a".repeat(64))).toMatchObject({
      groupSize: 2,
      isLatest: false
    });
    expect(inspection.find((item) => item.messageId === latestMessageId)).toMatchObject({
      groupSize: 2,
      isLatest: true
    });

    await expect(reconcileNotionReview(env, config, "a".repeat(64), "refresh_managed")).resolves.toMatchObject({
      messageId: "a".repeat(64),
      selectedMessageId: latestMessageId,
      reconciledCount: 2,
      action: "refresh_managed",
      status: "notion"
    });
    expect(markdown).toContain("Newest managed body.");
    expect(markdown).not.toContain("Older managed body.");
    expect(propertyUpdates.at(-1)).toMatchObject({
      properties: { Name: { title: [{ text: { content: "Newest opportunity title" } }] } }
    });
    expect(testDb.sqlite.prepare(
      "SELECT id, status FROM messages WHERE id IN (?, ?) ORDER BY id"
    ).all("a".repeat(64), latestMessageId)).toEqual([
      { id: "a".repeat(64), status: "notion" },
      { id: latestMessageId, status: "notion" }
    ]);
  });

  it("rejects a managed refresh when substantive edits are present", async () => {
    const { env, config } = setup();
    const pageId = "11111111-1111-1111-1111-111111111111";
    const automationKey = await seedNotionReview(env, pageId, "Original managed text");
    vi.stubGlobal("fetch", vi.fn(async (urlValue: string | URL | Request, init?: RequestInit) => {
      const url = String(urlValue);
      const method = init?.method ?? "GET";
      if (url.endsWith(`/data_sources/${config.notionDataSourceId}/query`)) {
        return json({ results: [propertyPage(pageId, "Dust Wave Film Grant", { automationKey })], has_more: false });
      }
      if (url.endsWith(`/pages/${pageId}/markdown`) && method === "GET") {
        return json({ markdown: "A person added substantive notes.", truncated: false, unknown_block_ids: [] });
      }
      throw new Error(`Unexpected Notion request: ${method} ${url}`);
    }));
    await expect(reconcileNotionReview(env, config, "a".repeat(64), "refresh_managed"))
      .rejects.toThrow("substantive changes");
  });

  it("rejects disabled publishing before making a request", async () => {
    const { env } = setup();
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    await expect(publishOpportunity(env, runtimeConfig({ notionEnabled: false }), messageRecord(), classification(), "key"))
      .rejects.toThrow("publishing is disabled");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("Notion page trashing", () => {
  it("validates the page ID before calling Notion", async () => {
    const { env } = setup();
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    await expect(trashNotionPage(env, "not-a-page-id")).rejects.toThrow("Invalid Notion page ID");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("sends a reversible in-trash update for a valid ID", async () => {
    const { env } = setup();
    const pageId = "11111111111111111111111111111111";
    const fetchMock = vi.fn().mockResolvedValue(json({ id: pageId }));
    vi.stubGlobal("fetch", fetchMock);
    await trashNotionPage(env, pageId);
    expect(JSON.parse(String((fetchMock.mock.calls[0]?.[1] as RequestInit).body))).toEqual({ in_trash: true });
  });
});
