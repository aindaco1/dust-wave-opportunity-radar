import { afterEach, describe, expect, it, vi } from "vitest";
import worker from "../src/index";
import { createRun } from "../src/storage/database";
import { env as baseEnv } from "./support/fixtures";
import { createTestDatabase, type TestDatabase } from "./support/d1";

const open: TestDatabase[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  while (open.length) open.pop()?.close();
});

function setup(overrides: Record<string, unknown> = {}) {
  const testDb = createTestDatabase();
  open.push(testDb);
  const create = vi.fn().mockResolvedValue({ id: "workflow-instance-1" });
  const env = baseEnv({ DB: testDb.db, BATCH_WORKFLOW: { create }, ...overrides });
  return { testDb, env, create };
}

async function body(response: Response): Promise<Record<string, unknown>> {
  return response.json() as Promise<Record<string, unknown>>;
}

function admin(path: string, init: RequestInit = {}): Request {
  return new Request(`https://radar.example${path}`, {
    ...init,
    headers: { authorization: "Bearer test-admin-token", ...init.headers }
  });
}

describe("Worker HTTP routes", () => {
  it("serves public health state without exposing secrets", async () => {
    const { env } = setup();
    const response = await worker.fetch(new Request("https://radar.example/health"), env);
    expect(response.status).toBe(200);
    expect(await body(response)).toEqual({
      ok: true,
      service: "dustwave-opportunity-radar",
      timezone: "America/Denver",
      batchHours: [7, 19],
      notionEnabled: true,
      zohoEnabled: true,
      creativeWestEnabled: true
    });
  });

  it("returns 404 for unknown public and admin routes", async () => {
    const { env } = setup();
    expect((await worker.fetch(new Request("https://radar.example/nope"), env)).status).toBe(404);
    expect((await worker.fetch(admin("/admin/nope"), env)).status).toBe(404);
  });

  it.each([
    [undefined, 401],
    ["Bearer wrong", 401],
    ["Basic test-admin-token", 401]
  ])("protects every admin route (%s)", async (authorization, status) => {
    const { env } = setup();
    const headers = authorization ? { authorization } : undefined;
    const response = await worker.fetch(new Request("https://radar.example/admin/runs", { headers }), env);
    expect(response.status).toBe(status);
    expect(await body(response)).toEqual({ error: "Unauthorized" });
  });

  it("starts a manual forced batch", async () => {
    const { env, create } = setup();
    const response = await worker.fetch(admin("/admin/run", { method: "POST" }), env);
    expect(response.status).toBe(202);
    expect(await body(response)).toEqual({ accepted: true, instanceId: "workflow-instance-1" });
    expect(create).toHaveBeenCalledWith(expect.objectContaining({
      id: expect.stringMatching(/^manual-/),
      params: expect.objectContaining({ trigger: "manual", force: true })
    }));
  });

  it("lists the most recent batch runs", async () => {
    const { env } = setup();
    await createRun(env.DB, "run-1", "2026-08-05T13:00:00Z");
    const response = await worker.fetch(admin("/admin/runs"), env);
    expect(response.status).toBe(200);
    expect(await body(response)).toMatchObject({ runs: [expect.objectContaining({ id: "run-1", status: "running" })] });
  });

  it("exposes a source-only Creative West sync route", async () => {
    const { env } = setup({ CREATIVE_WEST_ENABLED: "false" });
    const response = await worker.fetch(admin("/admin/sync/creative-west", { method: "POST" }), env);
    expect(response.status).toBe(200);
    expect(await body(response)).toMatchObject({ fetched: 0, ingested: 0, skipped: true });
  });

  it("lists the Notion review queue without returning page content", async () => {
    const { env } = setup();
    const response = await worker.fetch(admin("/admin/notion/review"), env);
    expect(response.status).toBe(200);
    expect(await body(response)).toEqual({ items: [] });
  });

  it("validates the explicit Notion reconciliation action", async () => {
    const { env } = setup();
    const response = await worker.fetch(admin("/admin/notion/reconcile", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ messageId: "a".repeat(64), action: "overwrite" })
    }), env);
    expect(response.status).toBe(400);
    expect(await body(response)).toEqual({ error: "action must be refresh_managed or preserve_manual" });
  });

  it("validates trash and HEY import bodies at the HTTP boundary", async () => {
    const { env } = setup();
    const trash = await worker.fetch(admin("/admin/notion/trash", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}"
    }), env);
    expect(trash.status).toBe(400);
    expect(await body(trash)).toEqual({ error: "pageId is required" });

    const imported = await worker.fetch(admin("/admin/import/hey", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}"
    }), env);
    expect(imported.status).toBe(400);
    expect(await body(imported)).toMatchObject({ error: expect.stringContaining("externalId") });
  });
});

describe("Worker schedule routing", () => {
  it("starts one workflow for a configured Mountain-time slot", async () => {
    const { env, create } = setup();
    await worker.scheduled({ scheduledTime: new Date("2026-08-05T13:00:00Z").valueOf() } as ScheduledController, env);
    expect(create).toHaveBeenCalledWith({
      id: "batch-2026-08-05-07",
      params: { scheduledFor: "2026-08-05T13:00:00.000Z", trigger: "cron" }
    });
  });

  it("skips hourly ticks outside configured local hours", async () => {
    const { env, create } = setup();
    await worker.scheduled({ scheduledTime: new Date("2026-08-05T14:00:00Z").valueOf() } as ScheduledController, env);
    expect(create).not.toHaveBeenCalled();
  });
});
