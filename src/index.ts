import { loadRuntimeConfig } from "./config";
import { ingestForwardedHeyEmail, ingestImportedHeyEmail, type ImportedHeyEmail } from "./ingest/email-worker";
import { inspectZohoConnection, syncZoho } from "./ingest/zoho";
import { inspectNotionSchema, trashNotionPage } from "./notion/client";
import { readBoundedJson } from "./util/http";
import { timingSafeEqualText } from "./util/crypto";
import { localBatchSlot, shouldStartBatch } from "./util/dates";
import { logError, logInfo } from "./util/log";
export { OpportunityBatchWorkflow } from "./workflow/batch";

const worker = {
  async email(message: ForwardableEmailMessage, env: Env): Promise<void> {
    await ingestForwardedHeyEmail(message, env);
  },

  async scheduled(controller: ScheduledController, env: Env): Promise<void> {
    const config = loadRuntimeConfig(env);
    const scheduledAt = new Date(controller.scheduledTime);
    if (!shouldStartBatch(scheduledAt, config.timezone, config.batchHours)) {
      logInfo("scheduled_tick_skipped", { scheduledAt: scheduledAt.toISOString() });
      return;
    }
    const slot = localBatchSlot(scheduledAt, config.timezone);
    const instance = await env.BATCH_WORKFLOW.create({
      id: `batch-${slot.key}`,
      params: { scheduledFor: scheduledAt.toISOString(), trigger: "cron" }
    });
    logInfo("batch_workflow_started", { instanceId: instance.id, slot: slot.key });
  },

  async fetch(request: Request, env: Env): Promise<Response> {
    try {
      const url = new URL(request.url);
      if (request.method === "GET" && url.pathname === "/health") {
        const config = loadRuntimeConfig(env);
        return Response.json({
          ok: true,
          service: "dustwave-opportunity-radar",
          timezone: config.timezone,
          batchHours: [...config.batchHours],
          notionEnabled: config.notionEnabled,
          zohoEnabled: config.zohoEnabled
        });
      }

      if (url.pathname.startsWith("/admin/")) {
        if (!(await isAuthorized(request, env))) return Response.json({ error: "Unauthorized" }, { status: 401 });
        if (request.method === "POST" && url.pathname === "/admin/run") {
          const scheduledFor = new Date().toISOString();
          const instance = await env.BATCH_WORKFLOW.create({
            id: `manual-${crypto.randomUUID()}`,
            params: { scheduledFor, trigger: "manual", force: true }
          });
          return Response.json({ accepted: true, instanceId: instance.id }, { status: 202 });
        }
        if (request.method === "GET" && url.pathname === "/admin/runs") {
          const runs = await env.DB.prepare("SELECT * FROM runs ORDER BY started_at DESC LIMIT 25").all();
          return Response.json({ runs: runs.results });
        }
        if (request.method === "GET" && url.pathname === "/admin/integrations") {
          const config = loadRuntimeConfig(env);
          const notion = await inspectIntegration(() => inspectNotionSchema(env, config));
          const zoho = await inspectIntegration(() => inspectZohoConnection(env, config));
          return Response.json({ ok: notion.ok && zoho.ok, notion, zoho }, { status: notion.ok && zoho.ok ? 200 : 502 });
        }
        if (request.method === "POST" && url.pathname === "/admin/sync/zoho") {
          const config = loadRuntimeConfig(env);
          return Response.json(await syncZoho(env, config));
        }
        if (request.method === "POST" && url.pathname === "/admin/notion/trash") {
          try {
            const input = await readBoundedJson<{ pageId?: string }>(request, 2_000);
            if (!input.pageId) return Response.json({ error: "pageId is required" }, { status: 400 });
            await trashNotionPage(env, input.pageId);
            return Response.json({ trashed: true, pageId: input.pageId });
          } catch (error) {
            const detail = error instanceof Error ? error.message : "Invalid request";
            return Response.json({ error: detail }, { status: 400 });
          }
        }
        if (request.method === "POST" && url.pathname === "/admin/import/hey") {
          let input: ImportedHeyEmail;
          try {
            input = await readBoundedJson<ImportedHeyEmail>(request, 36_000_000);
            const result = await ingestImportedHeyEmail(input, env);
            return Response.json({ accepted: true, id: result.id }, { status: 201 });
          } catch (error) {
            const detail = error instanceof Error ? error.message : "Invalid import";
            return Response.json({ error: detail }, { status: 400 });
          }
        }
        return Response.json({ error: "Admin route not found" }, { status: 404 });
      }

      return Response.json({ error: "Not found" }, { status: 404 });
    } catch (error) {
      logError("http_request_failed", error, { path: new URL(request.url).pathname });
      return Response.json({ error: "Internal server error" }, { status: 500 });
    }
  }
} satisfies ExportedHandler<Env>;

export default worker;

async function isAuthorized(request: Request, env: Env): Promise<boolean> {
  if (!env.ADMIN_TOKEN) return false;
  const header = request.headers.get("authorization") ?? "";
  const prefix = "Bearer ";
  const token = header.startsWith(prefix) ? header.slice(prefix.length) : "";
  return timingSafeEqualText(token, env.ADMIN_TOKEN);
}

async function inspectIntegration<T>(operation: () => Promise<T>): Promise<
  { ok: true; value: T } | { ok: false; error: string }
> {
  try {
    return { ok: true, value: await operation() };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}
