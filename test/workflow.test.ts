import { afterEach, describe, expect, it, vi } from "vitest";
import type { WorkflowEvent, WorkflowStep } from "cloudflare:workers";
import { OpportunityBatchWorkflow } from "../src/workflow/batch";
import { createRun, getMessage, upsertMessage } from "../src/storage/database";
import type { BatchParams } from "../src/types";
import { classification, env as baseEnv } from "./support/fixtures";
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
    NOTION_ENABLED: "false"
  });
  const names: string[] = [];
  const step = {
    async do<T>(name: string, optionsOrCallback: unknown, maybeCallback?: () => Promise<T>): Promise<T> {
      names.push(name);
      const callback = (typeof optionsOrCallback === "function" ? optionsOrCallback : maybeCallback) as () => Promise<T>;
      return callback();
    }
  } as WorkflowStep;
  const workflow = new OpportunityBatchWorkflow({} as ExecutionContext, env);
  return { testDb, bucket, email, ai, env, names, objects, step, workflow };
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

describe("batch workflow orchestration", () => {
  it("completes an empty batch without sending an empty digest", async () => {
    const { workflow, step, names, email, testDb } = setup();
    await expect(workflow.run(event(), step)).resolves.toEqual({
      runId: "run-1",
      queued: 0,
      notion: 0,
      digest: 0,
      ignored: 0,
      failed: 0,
      digestSent: false
    });
    expect(names).toEqual([
      "create batch run",
      "sync Zoho folders",
      "load queued messages",
      "send non-empty digest",
      "purge expired raw mail",
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
    const { workflow, step, env, ai, email, objects } = setup();
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
      digest: 1,
      ignored: 0,
      failed: 0,
      digestSent: true
    });
    expect(await getMessage(env.DB, "message-1")).toMatchObject({ status: "digest", attempts: 1, parsed_r2_key: "parsed/hey/message-1.json" });
    expect(objects.has("parsed/hey/message-1.json")).toBe(true);
    expect(email.send).toHaveBeenCalledOnce();
    expect(email.send.mock.calls[0]?.[0]).toMatchObject({ to: "alonso@hey.com", subject: expect.stringContaining("Dust Wave Opportunity Radar") });
  });
});
