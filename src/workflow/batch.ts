import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import { buildManualReviewClassification, classifyMessage } from "../ai/classify";
import { loadRuntimeConfig } from "../config";
import { renderOpportunityDigest, sendOpportunityDigest } from "../email/digest";
import { parseStoredMessage } from "../email/parse";
import { syncColossal } from "../ingest/colossal";
import { syncHyperallergic } from "../ingest/hyperallergic";
import { syncCreativeWest } from "../ingest/creative-west";
import { syncZoho } from "../ingest/zoho";
import { enrichCandidateUrls } from "../ingest/web-enrichment";
import {
  ensureNotionSchema,
  NotionReviewRequiredError,
  opportunityAutomationKey,
  publishOpportunity
} from "../notion/client";
import {
  clearExpiredR2Keys,
  completeRun,
  createRun,
  failRun,
  getMessage,
  listExpiredR2Keys,
  listQueuedMessages,
  listUnsentDigestItems,
  markDigestItemsSent,
  markMessageFailed,
  markNotionReviewRequired,
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
import { localBatchSlot, subtractHours } from "../util/dates";
import { logError, logInfo } from "../util/log";
const MESSAGE_PREPARATION_CONCURRENCY = 4;

type PreparedMessageResult =
  | { kind: "complete"; result: ProcessResult | null }
  | { kind: "notion"; messageId: string };

export class OpportunityBatchWorkflow extends WorkflowEntrypoint<Env, BatchParams> {
  override async run(event: WorkflowEvent<BatchParams>, step: WorkflowStep): Promise<BatchSummary> {
    const config = loadRuntimeConfig(this.env);
    const runId = event.instanceId;
    const created = await step.do("create batch run", async () =>
      createRun(this.env.DB, runId, event.payload.scheduledFor)
    );
    if (!created && !event.payload.force) {
      return {
        runId,
        queued: 0,
        notion: 0,
        pendingNotion: 0,
        notionReview: 0,
        digest: 0,
        ignored: 0,
        failed: 0,
        digestSent: false
      };
    }

    try {
      await step.do(
        "sync Zoho folders",
        { retries: { limit: 3, delay: "10 seconds", backoff: "exponential" }, timeout: "10 minutes" },
        async () => syncZoho(this.env, config)
      );

      await step.do(
        "sync Creative West opportunities",
        { retries: { limit: 3, delay: "10 seconds", backoff: "exponential" }, timeout: "10 minutes" },
        async () => syncCreativeWest(this.env, config, new Date(event.payload.scheduledFor))
      );

      await step.do(
        "sync Colossal opportunities",
        { retries: { limit: 3, delay: "10 seconds", backoff: "exponential" }, timeout: "10 minutes" },
        async () => syncColossal(this.env, config, new Date(event.payload.scheduledFor))
      );

      await step.do(
        "sync Hyperallergic opportunities",
        { retries: { limit: 3, delay: "10 seconds", backoff: "exponential" }, timeout: "10 minutes" },
        async () => syncHyperallergic(this.env, config, new Date(event.payload.scheduledFor))
      );

      if (config.notionEnabled) {
        await step.do(
          "ensure Notion schema",
          { retries: { limit: 3, delay: "5 seconds", backoff: "exponential" } },
          async () => ensureNotionSchema(this.env, config)
        );
      }

      const messageIds = await step.do("load queued message ids", async () =>
        (await listQueuedMessages(this.env.DB, config.notionEnabled)).map((message) => message.id)
      );
      const preparedResults: PreparedMessageResult[] = [];
      for (let offset = 0; offset < messageIds.length; offset += MESSAGE_PREPARATION_CONCURRENCY) {
        const chunk = messageIds.slice(offset, offset + MESSAGE_PREPARATION_CONCURRENCY);
        const preparedChunk = await Promise.all(
          chunk.map((messageId) =>
            step.do(
              `prepare ${messageId.slice(0, 24)}`,
              { retries: { limit: 2, delay: "10 seconds", backoff: "exponential" }, timeout: "5 minutes" },
              async () => this.prepareMessage(messageId, config, localBatchSlot(new Date(event.payload.scheduledFor), config.timezone).dateLabel)
            )
          )
        );
        preparedResults.push(...preparedChunk);
      }

      const results: ProcessResult[] = [];
      for (const prepared of preparedResults) {
        if (prepared.kind === "complete") {
          if (prepared.result) results.push(prepared.result);
          continue;
        }
        const result = await step.do(
          `publish ${prepared.messageId.slice(0, 24)}`,
          { retries: { limit: 2, delay: "10 seconds", backoff: "exponential" }, timeout: "5 minutes" },
          async () => this.publishToNotionOrKeepPending(prepared.messageId, config)
        );
        results.push(result);
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

      await step.do("purge expired source payloads", async () => cleanupExpiredMail(this.env, config.r2RetentionHours));
      await step.do("complete batch run", async () => completeRun(this.env.DB, runId, results, messageIds.length));

      const count = (status: ProcessResult["status"]) => results.filter((result) => result.status === status).length;
      return {
        runId,
        queued: messageIds.length,
        notion: count("notion"),
        pendingNotion: count("pending_notion"),
        notionReview: count("notion_review"),
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

  private async prepareMessage(
    messageId: string,
    config: ReturnType<typeof loadRuntimeConfig>,
    asOfDate: string
  ): Promise<PreparedMessageResult> {
    const message = await getMessage(this.env.DB, messageId);
    if (!message) return { kind: "complete", result: null };
    try {
      const claimed = await claimMessageProcessing(this.env.DB, message.id);
      if (!claimed) return { kind: "complete", result: null };

      if (message.status === "pending_notion" && message.classification_json) {
        classificationSchema.parse(JSON.parse(message.classification_json));
        return { kind: "notion", messageId: message.id };
      }

      const parsed = await parseStoredMessage(this.env.MAIL_BUCKET, message, config.attachmentMaxBytes);
      parsed.asOfDate = asOfDate;
      const parsedKey = `parsed/${message.source}/${message.id}.json`;
      await this.env.MAIL_BUCKET.put(parsedKey, JSON.stringify(parsed), {
        httpMetadata: { contentType: "application/json; charset=utf-8" },
        customMetadata: { messageId: message.id, source: message.source }
      });
      await saveParsedKey(this.env.DB, message.id, parsedKey);

      const pages = await enrichCandidateUrls(parsed.discoveryContext?.officialUrls ?? parsed.urls);
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
          return {
            kind: "complete",
            result: { messageId: message.id, status: "pending_notion" }
          };
        }
        return { kind: "notion", messageId: message.id };
      }
      if (classification.decision === "digest") {
        await upsertDigestItem(this.env.DB, message, classification);
        await saveClassification(this.env.DB, message.id, classification, "digest", classification.primaryUrl);
        return {
          kind: "complete",
          result: { messageId: message.id, status: "digest" }
        };
      }
      await saveClassification(this.env.DB, message.id, classification, "ignored", classification.primaryUrl);
      return {
        kind: "complete",
        result: { messageId: message.id, status: "ignored" }
      };
    } catch (error) {
      await markMessageFailed(this.env.DB, message.id, error);
      logError("message_processing_failed", error, { messageId: message.id, source: message.source });
      return {
        kind: "complete",
        result: {
          messageId: message.id,
          status: "failed"
        }
      };
    }
  }

  private async publishToNotionOrKeepPending(
    messageId: string,
    config: ReturnType<typeof loadRuntimeConfig>
  ): Promise<ProcessResult> {
    try {
      const { message, classification } = await this.loadNotionMessage(messageId);
      return await this.publishToNotion(message, classification, config);
    } catch (error) {
      if (error instanceof NotionReviewRequiredError) {
        await markNotionReviewRequired(this.env.DB, messageId, error.reason);
        logInfo("notion_review_required", { messageId, reason: error.reason });
        return { messageId, status: "notion_review" };
      }
      await markPendingNotionError(this.env.DB, messageId, error);
      logError("notion_publish_deferred", error, { messageId });
      return {
        messageId,
        status: "pending_notion"
      };
    }
  }

  private async publishToNotion(
    message: Pick<MessageRecord, "id" | "source">,
    classification: ReturnType<typeof classificationSchema.parse>,
    config: ReturnType<typeof loadRuntimeConfig>
  ): Promise<ProcessResult> {
    const automationKey = await opportunityAutomationKey(classification);
    const published = await publishOpportunity(this.env, config, message, classification, automationKey);
    await upsertOpportunity(
      this.env.DB,
      automationKey,
      message.id,
      classification,
      published.pageId,
      published.managedMarkdown,
      published.bodyManagement
    );
    await saveClassification(this.env.DB, message.id, classification, "notion", classification.primaryUrl);
    logInfo("notion_opportunity_published", {
      messageId: message.id,
      pageId: published.pageId,
      created: published.created,
      trashedDuplicatePageIds: published.trashedDuplicatePageIds
    });
    return { messageId: message.id, status: "notion" };
  }

  private async loadNotionMessage(messageId: string): Promise<{
    message: Pick<MessageRecord, "id" | "source">;
    classification: Classification;
  }> {
    const message = await getMessage(this.env.DB, messageId);
    if (!message?.classification_json) throw new Error("Stored Notion classification is unavailable");
    return {
      message: { id: message.id, source: message.source },
      classification: classificationSchema.parse(JSON.parse(message.classification_json))
    };
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
