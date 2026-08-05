import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import { buildManualReviewClassification, classifyMessage } from "../ai/classify";
import { loadRuntimeConfig } from "../config";
import { renderOpportunityDigest, sendOpportunityDigest } from "../email/digest";
import { parseStoredMessage } from "../email/parse";
import { syncZoho } from "../ingest/zoho";
import { enrichCandidateUrls } from "../ingest/web-enrichment";
import { ensureNotionSchema, publishOpportunity } from "../notion/client";
import {
  clearExpiredR2Keys,
  completeRun,
  createRun,
  failRun,
  listExpiredR2Keys,
  listQueuedMessages,
  listUnsentDigestItems,
  markDigestItemsSent,
  markMessageFailed,
  claimMessageProcessing,
  markPendingNotionError,
  saveClassification,
  saveParsedKey,
  upsertDigestItem,
  upsertOpportunity
} from "../storage/database";
import {
  classificationSchema,
  type BatchParams,
  type BatchSummary,
  type Classification,
  type MessageRecord,
  type ProcessResult
} from "../types";
import { sha256Hex } from "../util/crypto";
import { subtractHours } from "../util/dates";
import { logError, logInfo } from "../util/log";

export class OpportunityBatchWorkflow extends WorkflowEntrypoint<Env, BatchParams> {
  override async run(event: WorkflowEvent<BatchParams>, step: WorkflowStep): Promise<BatchSummary> {
    const config = loadRuntimeConfig(this.env);
    const runId = event.instanceId;
    const created = await step.do("create batch run", async () =>
      createRun(this.env.DB, runId, event.payload.scheduledFor)
    );
    if (!created && !event.payload.force) {
      return { runId, queued: 0, notion: 0, digest: 0, ignored: 0, failed: 0, digestSent: false };
    }

    try {
      await step.do(
        "sync Zoho folders",
        { retries: { limit: 3, delay: "10 seconds", backoff: "exponential" }, timeout: "10 minutes" },
        async () => syncZoho(this.env, config)
      );

      if (config.notionEnabled) {
        await step.do(
          "ensure Notion schema",
          { retries: { limit: 3, delay: "5 seconds", backoff: "exponential" } },
          async () => ensureNotionSchema(this.env, config)
        );
      }

      const messages = await step.do("load queued messages", async () =>
        listQueuedMessages(this.env.DB, config.notionEnabled)
      );
      const results: ProcessResult[] = [];
      for (const message of messages) {
        const result = await step.do(
          `process ${message.id.slice(0, 24)}`,
          { retries: { limit: 2, delay: "10 seconds", backoff: "exponential" }, timeout: "5 minutes" },
          async () => this.processMessage(message, config)
        );
        if (result) results.push(result);
      }

      const digestSent = await step.do(
        "send non-empty digest",
        { retries: { limit: 3, delay: "30 seconds", backoff: "exponential" } },
        async () => {
          const items = await listUnsentDigestItems(this.env.DB);
          if (!items.length) return false;
          const rendered = renderOpportunityDigest(items, new Date(event.payload.scheduledFor), config.timezone);
          const emailId = await sendOpportunityDigest(this.env.EMAIL, config, rendered);
          await markDigestItemsSent(
            this.env.DB,
            items.map((item) => item.message_id),
            runId
          );
          logInfo("digest_sent", { runId, emailId, itemCount: items.length });
          return true;
        }
      );

      await step.do("purge expired raw mail", async () => cleanupExpiredMail(this.env, config.r2RetentionHours));
      await step.do("complete batch run", async () => completeRun(this.env.DB, runId, results, messages.length));

      const count = (status: ProcessResult["status"]) => results.filter((result) => result.status === status).length;
      return {
        runId,
        queued: messages.length,
        notion: count("notion"),
        digest: count("digest"),
        ignored: count("ignored"),
        failed: count("failed"),
        digestSent
      };
    } catch (error) {
      await failRun(this.env.DB, runId, error);
      logError("batch_failed", error, { runId });
      throw error;
    }
  }

  private async processMessage(
    message: MessageRecord,
    config: ReturnType<typeof loadRuntimeConfig>
  ): Promise<ProcessResult | null> {
    try {
      const claimed = await claimMessageProcessing(this.env.DB, message.id);
      if (!claimed) return null;

      if (message.status === "pending_notion" && message.classification_json) {
        const stored = classificationSchema.parse(JSON.parse(message.classification_json));
        return await this.publishToNotionOrKeepPending(message, stored, config);
      }

      const parsed = await parseStoredMessage(this.env.MAIL_BUCKET, message, config.attachmentMaxBytes);
      const parsedKey = `parsed/${message.source}/${message.id}.json`;
      await this.env.MAIL_BUCKET.put(parsedKey, JSON.stringify(parsed), {
        httpMetadata: { contentType: "application/json; charset=utf-8" },
        customMetadata: { messageId: message.id, source: message.source }
      });
      await saveParsedKey(this.env.DB, message.id, parsedKey);

      const pages = await enrichCandidateUrls(parsed.urls);
      let classification: Classification;
      try {
        classification = await classifyMessage(this.env.AI, config, parsed, pages);
      } catch (error) {
        classification = buildManualReviewClassification(parsed, error);
        logInfo("classification_exhausted_sent_to_digest", {
          messageId: message.id,
          source: message.source,
          attempts: message.attempts + 1
        });
      }
      if (classification.decision === "notion") {
        await saveClassification(this.env.DB, message.id, classification, "pending_notion", classification.primaryUrl);
        if (!config.notionEnabled) {
          return { messageId: message.id, status: "pending_notion", title: classification.title };
        }
        return await this.publishToNotionOrKeepPending(message, classification, config);
      }
      if (classification.decision === "digest") {
        await upsertDigestItem(this.env.DB, message, classification);
        await saveClassification(this.env.DB, message.id, classification, "digest", classification.primaryUrl);
        return { messageId: message.id, status: "digest", title: classification.title };
      }
      await saveClassification(this.env.DB, message.id, classification, "ignored", classification.primaryUrl);
      return { messageId: message.id, status: "ignored", title: classification.title };
    } catch (error) {
      await markMessageFailed(this.env.DB, message.id, error);
      logError("message_processing_failed", error, { messageId: message.id, source: message.source });
      return {
        messageId: message.id,
        status: "failed",
        error: error instanceof Error ? error.message : String(error)
      };
    }
  }

  private async publishToNotionOrKeepPending(
    message: MessageRecord,
    classification: ReturnType<typeof classificationSchema.parse>,
    config: ReturnType<typeof loadRuntimeConfig>
  ): Promise<ProcessResult> {
    try {
      return await this.publishToNotion(message, classification, config);
    } catch (error) {
      await markPendingNotionError(this.env.DB, message.id, error);
      logError("notion_publish_deferred", error, { messageId: message.id, title: classification.title });
      return {
        messageId: message.id,
        status: "pending_notion",
        title: classification.title,
        error: error instanceof Error ? error.message : String(error)
      };
    }
  }

  private async publishToNotion(
    message: MessageRecord,
    classification: ReturnType<typeof classificationSchema.parse>,
    config: ReturnType<typeof loadRuntimeConfig>
  ): Promise<ProcessResult> {
    const automationKey = await sha256Hex(
      classification.primaryUrl ?? `${classification.organization ?? ""}|${classification.title.toLowerCase()}`
    );
    const published = await publishOpportunity(this.env, config, message, classification, automationKey);
    await upsertOpportunity(
      this.env.DB,
      automationKey,
      message.id,
      classification,
      published.pageId,
      published.managedMarkdown
    );
    await saveClassification(this.env.DB, message.id, classification, "notion", classification.primaryUrl);
    logInfo("notion_opportunity_published", {
      messageId: message.id,
      pageId: published.pageId,
      created: published.created,
      trashedDuplicatePageIds: published.trashedDuplicatePageIds,
      title: classification.title
    });
    return { messageId: message.id, status: "notion", title: classification.title };
  }
}

async function cleanupExpiredMail(env: Env, retentionHours: number): Promise<number> {
  const cutoff = subtractHours(new Date(), retentionHours).toISOString();
  const keys = await listExpiredR2Keys(env.DB, cutoff);
  for (let offset = 0; offset < keys.length; offset += 500) {
    await env.MAIL_BUCKET.delete(keys.slice(offset, offset + 500));
  }
  await clearExpiredR2Keys(env.DB, cutoff);
  return keys.length;
}
