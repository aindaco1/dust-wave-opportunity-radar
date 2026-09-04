import { HYPERALLERGIC_FEED } from "../src/ingest/hyperallergic-parser";
import { articleHtml as hyperArticleHtml, entryHtml as hyperEntryHtml, augustUrl as hyperAugustUrl, septemberUrl as hyperSeptemberUrl } from "./support/hyperallergic";
import { COLOSSAL_FEED } from "../src/ingest/colossal-parser";
import { articleHtml, entryHtml, responseAt, rss, augustUrl, septemberUrl } from "./support/colossal";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { WorkflowEvent, WorkflowStep } from "cloudflare:workers";
import { OpportunityBatchWorkflow } from "../src/workflow/batch";
import { createRun, getMessage, saveClassification, upsertMessage, upsertOpportunity } from "../src/storage/database";
import { opportunityAutomationKey } from "../src/notion/client";
import type { BatchParams } from "../src/types";
import { classification, env as baseEnv } from "./support/fixtures";
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
  const objects = new Map<string, Uint8Array>();
  const bucket = {
    get: vi.fn(async (key: string) => {
      const value = objects.get(key);
      return value ? { arrayBuffer: async () => value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength) } : null;
    }),
    put: vi.fn(async (key: string, value: string | Uint8Array | ArrayBuffer) => {
      const bytes = typeof value === "string"
        ? new TextEncoder().encode(value)
        : value instanceof Uint8Array
          ? value
          : new Uint8Array(value);
      objects.set(key, bytes);
      return null;
    }),
    delete: vi.fn(async (keys: string | string[]) => {
      for (const key of Array.isArray(keys) ? keys : [keys]) objects.delete(key);
    })
  };
  const email = { send: vi.fn().mockResolvedValue({ messageId: "digest-email-1" }) };
  const ai = { run: vi.fn() };
  const env = baseEnv({
    DB: testDb.db,
    MAIL_BUCKET: bucket,
    EMAIL: email,
    AI: ai,
    ZOHO_ENABLED: "false",
    CREATIVE_WEST_ENABLED: "false",
    NOTION_ENABLED: "false",
    ...overrides
  });
  const names: string[] = [];
  const outputs: Array<{ name: string; value: unknown }> = [];
  const step = {
    async do<T>(name: string, optionsOrCallback: unknown, maybeCallback?: () => Promise<T>): Promise<T> {
      names.push(name);
      const callback = (typeof optionsOrCallback === "function" ? optionsOrCallback : maybeCallback) as () => Promise<T>;
      const value = await callback();
      outputs.push({ name, value });
      return value;
    }
  } as WorkflowStep;
  const workflow = new OpportunityBatchWorkflow({} as ExecutionContext, env);
  return { testDb, bucket, email, ai, env, names, outputs, objects, step, workflow };
}

function event(id = "run-1", overrides: Partial<BatchParams> = {}): WorkflowEvent<BatchParams> {
  return {
    instanceId: id,
    payload: {
      scheduledFor: "2026-08-05T13:00:00.000Z",
      trigger: "cron",
      ...overrides
    },
    timestamp: new Date("2026-08-05T13:00:00.000Z")
  } as WorkflowEvent<BatchParams>;
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });
}

describe("batch workflow orchestration", () => {
  it("completes an empty batch without sending an empty digest", async () => {
    const { workflow, step, names, email, testDb } = setup();
    await expect(workflow.run(event(), step)).resolves.toEqual({
      runId: "run-1",
      queued: 0,
      notion: 0,
      pendingNotion: 0,
      notionReview: 0,
      digest: 0,
      ignored: 0,
      failed: 0,
      digestSent: false
    });
    expect(names).toEqual([
      "create batch run",
      "sync Zoho folders",
      "sync Creative West opportunities",
      "sync Colossal opportunities",
      "sync Hyperallergic opportunities",
      "load queued message ids",
      "send non-empty digest",
      "purge expired source payloads",
      "complete batch run"
    ]);
    expect(email.send).not.toHaveBeenCalled();
    expect(testDb.sqlite.prepare("SELECT status, queued_count FROM runs WHERE id = 'run-1'").get()).toEqual({
      status: "completed", queued_count: 0
    });
  });

  it("returns a no-op summary for a duplicate non-forced run", async () => {
    const { workflow, step, env, names } = setup();
    await createRun(env.DB, "run-1", "2026-08-05T13:00:00.000Z");
    await expect(workflow.run(event(), step)).resolves.toMatchObject({ runId: "run-1", queued: 0, digestSent: false });
    expect(names).toEqual(["create batch run"]);
  });

  it("marks the run failed when a durable step exhausts", async () => {
    const { workflow, testDb } = setup();
    const step = {
      async do<T>(name: string, optionsOrCallback: unknown, maybeCallback?: () => Promise<T>): Promise<T> {
        if (name === "sync Zoho folders") throw new Error("step unavailable");
        const callback = (typeof optionsOrCallback === "function" ? optionsOrCallback : maybeCallback) as () => Promise<T>;
        return callback();
      }
    } as WorkflowStep;
    await expect(workflow.run(event(), step)).rejects.toThrow("step unavailable");
    expect(testDb.sqlite.prepare("SELECT status, error FROM runs WHERE id = 'run-1'").get()).toEqual({
      status: "failed", error: "step unavailable"
    });
  });

  it("processes a queued MIME message into a non-empty digest end to end", async () => {
    const { workflow, step, env, ai, email, outputs, objects } = setup();
    const rawKey = "raw/hey/2026-08-05/message-1.eml";
    const mime = [
      "Message-ID: <message-1@example.org>",
      "Subject: Film workshop",
      "From: Arts Group <hello@example.org>",
      "Date: Wed, 05 Aug 2026 12:00:00 GMT",
      "Content-Type: text/plain; charset=UTF-8",
      "",
      "A practical workshop for independent filmmakers."
    ].join("\r\n");
    objects.set(rawKey, new TextEncoder().encode(mime));
    await upsertMessage(env.DB, {
      id: "message-1",
      source: "hey",
      externalId: "message-1@example.org",
      mailbox: "Feed",
      subject: "Film workshop",
      receivedAt: "2026-08-05T12:00:00.000Z",
      rawR2Key: rawKey,
      rawSize: mime.length
    });
    ai.run.mockResolvedValue({ response: JSON.stringify(classification({
      decision: "digest",
      title: "Independent Film Workshop",
      type: null,
      digestCategory: "Workshops & Training"
    })) });

    await expect(workflow.run(event(), step)).resolves.toEqual({
      runId: "run-1",
      queued: 1,
      notion: 0,
      pendingNotion: 0,
      notionReview: 0,
      digest: 1,
      ignored: 0,
      failed: 0,
      digestSent: true
    });
    expect(await getMessage(env.DB, "message-1")).toMatchObject({ status: "digest", attempts: 1, parsed_r2_key: "parsed/hey/message-1.json" });
    expect(objects.has("parsed/hey/message-1.json")).toBe(true);
    expect(email.send).toHaveBeenCalledOnce();
    expect(email.send.mock.calls[0]?.[0]).toMatchObject({ to: "alonso@hey.com", subject: expect.stringContaining("Dust Wave Opportunity Radar") });
    const durableOutput = JSON.stringify(outputs);
    expect(durableOutput).not.toContain("Independent Film Workshop");
    expect(durableOutput).not.toContain("A film grant for independent artists");
    expect(outputs.find((output) => output.name === "load queued message ids")?.value).toEqual(["message-1"]);
  });

  it("prepares messages with bounded concurrency", async () => {
    const { workflow, step, env, ai, email, names, objects } = setup();
    const total = 5;
    for (let index = 0; index < total; index += 1) {
      const id = `message-${index}`;
      const rawKey = `raw/hey/2026-08-05/${id}.eml`;
      const mime = [
        `Message-ID: <${id}@example.org>`,
        `Subject: Routine update ${index}`,
        "From: Example Sender <sender@example.org>",
        "Date: Wed, 05 Aug 2026 12:00:00 GMT",
        "Content-Type: text/plain; charset=UTF-8",
        "",
        "This synthetic fixture contains no opportunity."
      ].join("\r\n");
      objects.set(rawKey, new TextEncoder().encode(mime));
      await upsertMessage(env.DB, {
        id,
        source: "hey",
        externalId: `${id}@example.org`,
        mailbox: "Paper Trail",
        subject: `Routine update ${index}`,
        receivedAt: `2026-08-05T12:00:0${index}.000Z`,
        rawR2Key: rawKey,
        rawSize: mime.length
      });
    }

    let active = 0;
    let maximumActive = 0;
    ai.run.mockImplementation(async () => {
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      await new Promise((resolve) => setTimeout(resolve, 20));
      active -= 1;
      return { response: JSON.stringify(classification({
        decision: "ignore",
        confidence: 0.2,
        title: "Routine update",
        organization: null,
        summary: "No concrete opportunity is present.",
        bodyMarkdown: "No concrete opportunity is present.",
        primaryUrl: null,
        applicationUrl: null,
        dueDate: null,
        applicationOpenStart: null,
        applicationOpenEnd: null,
        type: null,
        tags: [],
        eligibleStates: [],
        evidence: ["No application mechanism."],
        rationale: "This is a routine update."
      })) };
    });

    await expect(workflow.run(event(), step)).resolves.toMatchObject({
      queued: total,
      ignored: total,
      failed: 0,
      digestSent: false
    });
    expect(maximumActive).toBe(4);
    expect(names.filter((name) => name.startsWith("prepare message-"))).toHaveLength(total);
    expect(email.send).not.toHaveBeenCalled();
  });

  it("serializes Notion publishing after concurrent preparation", async () => {
    const { workflow, step, env, ai, names, objects } = setup();
    env.NOTION_ENABLED = "true";
    for (let index = 0; index < 2; index += 1) {
      const id = `notion-message-${index}`;
      const rawKey = `raw/hey/2026-08-05/${id}.eml`;
      const mime = [
        `Message-ID: <${id}@example.org>`,
        `Subject: Open call ${index}`,
        "From: Example Foundation <calls@example.org>",
        "Date: Wed, 05 Aug 2026 12:00:00 GMT",
        "Content-Type: text/plain; charset=UTF-8",
        "",
        "Applications are open at https://example.org/apply."
      ].join("\r\n");
      objects.set(rawKey, new TextEncoder().encode(mime));
      await upsertMessage(env.DB, {
        id,
        source: "hey",
        externalId: `${id}@example.org`,
        mailbox: "Imbox",
        subject: `Open call ${index}`,
        receivedAt: `2026-08-05T12:00:0${index}.000Z`,
        rawR2Key: rawKey,
        rawSize: mime.length
      });
    }

    let classificationIndex = 0;
    ai.run.mockImplementation(async () => {
      const index = classificationIndex;
      classificationIndex += 1;
      return { response: JSON.stringify(classification({
        title: `Open Call ${index}`,
        primaryUrl: `https://example.org/call-${index}`,
        applicationUrl: `https://example.org/apply-${index}`
      })) };
    });

    let activeCreates = 0;
    let maximumActiveCreates = 0;
    let created = 0;
    vi.stubGlobal("fetch", vi.fn(async (urlValue: string | URL | Request, init?: RequestInit) => {
      const url = String(urlValue);
      const method = init?.method ?? "GET";
      if (url.startsWith("https://example.org/") && method === "GET") {
        return new Response("<html><body>Synthetic application page.</body></html>", {
          headers: { "content-type": "text/html; charset=utf-8" }
        });
      }
      if (url.includes("/data_sources/") && method === "GET") {
        return json({
          id: "248a67e1-4d47-48f8-bc84-a9602ca91b78",
          properties: { "Automation Key": { type: "rich_text" }, Source: { type: "select" }, "Last Checked": { type: "date" } }
        });
      }
      if (url.endsWith("/query") && method === "POST") return json({ results: [], has_more: false });
      if (url.endsWith("/pages") && method === "POST") {
        activeCreates += 1;
        maximumActiveCreates = Math.max(maximumActiveCreates, activeCreates);
        await new Promise((resolve) => setTimeout(resolve, 20));
        activeCreates -= 1;
        created += 1;
        return json({ id: `00000000-0000-0000-0000-${String(created).padStart(12, "0")}`, url: "https://notion.so/test" });
      }
      throw new Error(`Unexpected Notion request: ${method} ${url}`);
    }));

    await expect(workflow.run(event(), step)).resolves.toMatchObject({
      queued: 2,
      notion: 2,
      failed: 0
    });
    expect(maximumActiveCreates).toBe(1);
    const lastPreparation = Math.max(...names.map((name, index) => name.startsWith("prepare ") ? index : -1));
    const firstPublish = names.findIndex((name) => name.startsWith("publish "));
    expect(firstPublish).toBeGreaterThan(lastPreparation);
  });

  it("moves a managed-body conflict to counted human review without durable content output", async () => {
    const { workflow, step, env, outputs, testDb } = setup();
    env.NOTION_ENABLED = "true";
    const messageId = "b".repeat(64);
    await upsertMessage(env.DB, {
      id: messageId,
      source: "zoho",
      externalId: "review-external",
      mailbox: "Inbox",
      subject: "Synthetic opportunity",
      receivedAt: "2026-08-05T12:00:00.000Z",
      rawR2Key: "",
      rawSize: 0
    });
    const classified = classification();
    await saveClassification(env.DB, messageId, classified, "pending_notion", classified.primaryUrl);
    const automationKey = await opportunityAutomationKey(classified);
    const pageId = "11111111-1111-1111-1111-111111111111";
    await upsertOpportunity(env.DB, automationKey, messageId, classified, pageId, "Original managed body");
    vi.stubGlobal("fetch", vi.fn(async (urlValue: string | URL | Request, init?: RequestInit) => {
      const url = String(urlValue);
      const method = init?.method ?? "GET";
      if (url.endsWith(`/data_sources/${env.NOTION_DATA_SOURCE_ID}`) && method === "GET") {
        return json({ id: env.NOTION_DATA_SOURCE_ID, properties: {
          "Automation Key": { type: "rich_text" }, Source: { type: "select" }, "Last Checked": { type: "date" }
        } });
      }
      if (url.endsWith(`/data_sources/${env.NOTION_DATA_SOURCE_ID}/query`) && method === "POST") {
        return json({ results: [{
          id: pageId,
          created_time: "2026-01-01T00:00:00.000Z",
          properties: {
            Name: { title: [{ plain_text: classified.title }] },
            Website: { rich_text: [{ plain_text: classified.primaryUrl }] },
            "Automation Key": { rich_text: [{ plain_text: automationKey }] }
          }
        }], has_more: false });
      }
      if (url.endsWith(`/pages/${pageId}`) && method === "PATCH") return json({ id: pageId });
      if (url.endsWith(`/pages/${pageId}/markdown`) && method === "GET") {
        return json({ markdown: "A person changed this body.", truncated: false, unknown_block_ids: [] });
      }
      throw new Error(`Unexpected request: ${method} ${url}`);
    }));

    await expect(workflow.run(event(), step)).resolves.toMatchObject({
      queued: 1,
      notion: 0,
      pendingNotion: 0,
      notionReview: 1,
      failed: 0
    });
    expect(await getMessage(env.DB, messageId)).toMatchObject({
      status: "notion_review",
      last_error: "managed_content_changed"
    });
    expect(testDb.sqlite.prepare(
      "SELECT queued_count, pending_notion_count, notion_review_count FROM runs WHERE id = 'run-1'"
    ).get()).toEqual({ queued_count: 1, pending_notion_count: 0, notion_review_count: 1 });
    expect(JSON.stringify(outputs)).not.toContain(classified.title);
    expect(JSON.stringify(outputs)).not.toContain(classified.bodyMarkdown);
  });
});


describe.each(["colossal", "hyperallergic"] as const)("%s through the shared batch", (source) => {
  const hyper = source === "hyperallergic";
  const label = hyper ? "Hyperallergic" : "Colossal";
  const feedUrl = hyper ? HYPERALLERGIC_FEED : COLOSSAL_FEED;
  const sourceAugustUrl = hyper ? hyperAugustUrl : augustUrl;
  const sourceSeptemberUrl = hyper ? hyperSeptemberUrl : septemberUrl;
  const renderArticle = hyper ? hyperArticleHtml : articleHtml;
  const renderEntry = hyper ? hyperEntryHtml : entryHtml;
  it("splits and deduplicates roundups, publishes only qualified calls, and suppresses an empty second digest", async () => {
    const { workflow, step, ai, email, env, outputs, testDb } = setup({ [hyper ? "HYPERALLERGIC_ENABLED" : "COLOSSAL_ENABLED"]: "true", NOTION_ENABLED: "true" });
    const titles = ["Qualified Film Grant", "Possible Call", "Creative Job", "Closed Film Grant"];
    const html = renderArticle(titles.map((title, index) => renderEntry(title, `https://example.org/apply/${index}`)).join(""));
    ai.run.mockImplementation(async (_model: string, input: { messages: Array<{ content: string }> }) => {
      const evidence = input.messages[1]!.content;
      const title = evidence.match(/^Subject: (.+)$/m)?.[1]!;
      const index = titles.indexOf(title);
      return { response: JSON.stringify(classification({
        title, primaryUrl: index === 1 ? sourceSeptemberUrl : `https://example.org/apply/${index}`,
        applicationUrl: `https://example.org/apply/${index}`,
        decision: index === 2 ? "digest" : "notion", digestCategory: index === 2 ? "Jobs & Commissions" : null,
        dueDate: index === 3 ? "2026-09-01" : "2026-09-30"
      })) };
    });
    const creates: unknown[] = [];
    const fetch = vi.fn(async (urlValue: string | URL | Request, init?: RequestInit) => {
      const url = String(urlValue); const method = init?.method ?? "GET";
      if (url === feedUrl) return responseAt(url, rss([
        { title: hyper ? "Opportunities in August 2026" : "August 2026 Opportunities", url: sourceAugustUrl, html },
        { title: hyper ? "Opportunities in September 2026" : "September 2026 Opportunities", url: sourceSeptemberUrl, html }
      ]), 200, "application/rss+xml");
      if (url.startsWith("https://example.org/")) return responseAt(url, "<p>Official application details for the fictional program.</p>");
      if (url.endsWith(`/data_sources/${env.NOTION_DATA_SOURCE_ID}`) && method === "GET") return json({ id: env.NOTION_DATA_SOURCE_ID, properties: {
        "Automation Key": { type: "rich_text" }, Source: { type: "select" }, "Last Checked": { type: "date" }
      } });
      if (url.endsWith("/query")) return json({ results: [], has_more: false });
      if (url.endsWith("/pages") && method === "POST") {
        creates.push(JSON.parse(String(init?.body)));
        return json({ id: "00000000-0000-0000-0000-000000000099", url: "https://notion.so/fictional" });
      }
      throw new Error("Unexpected synthetic request");
    });
    vi.stubGlobal("fetch", fetch);
    expect(await workflow.run(event(`${source}-1`, { scheduledFor: "2026-09-04T13:00:00Z" }), step))
      .toMatchObject({ queued: 4, notion: 1, digest: 2, ignored: 1, failed: 0, digestSent: true });
    expect(creates).toEqual([expect.objectContaining({ properties: expect.objectContaining({ Source: { select: { name: label } } }) })]);
    expect(ai.run).toHaveBeenCalledTimes(4);
    expect(email.send).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(outputs)).not.toContain("Qualified Film Grant");
    expect(JSON.stringify(outputs)).not.toContain("example.org");
    expect(testDb.sqlite.prepare("SELECT COUNT(*) AS n FROM messages WHERE source = ?").get(source)).toEqual({ n: 4 });
    expect(await workflow.run(event(`${source}-2`, { scheduledFor: "2026-09-05T01:00:00Z" }), step))
      .toMatchObject({ queued: 0, digestSent: false });
    expect(email.send).toHaveBeenCalledTimes(1);
  });
});
