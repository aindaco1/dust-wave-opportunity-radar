import type { RuntimeConfig } from "../config";
import { classificationSchema, type Classification, type MessageRecord } from "../types";
import { canonicalizeUrl } from "../email/parse";
import { saveClassification, upsertOpportunity } from "../storage/database";
import { sha256Hex } from "../util/crypto";
import { readBoundedText } from "../util/http";

const NOTION_API = "https://api.notion.com/v1";
const NOTION_VERSION = "2026-03-11";
const LEGACY_MANAGED_START = "**Opportunity Radar managed section — do not edit below this line**";
const LEGACY_MANAGED_END = "**End Opportunity Radar managed section**";

interface NotionPage {
  id: string;
  url?: string;
  created_time?: string;
  properties?: Record<string, unknown>;
}

interface NotionQueryResponse {
  results: NotionPage[];
  has_more?: boolean;
  next_cursor?: string | null;
}

interface NotionMarkdownResponse {
  markdown: string;
  truncated: boolean;
  unknown_block_ids: string[];
}

interface DataSourceResponse {
  id: string;
  properties: Record<string, { type?: string; [key: string]: unknown }>;
}

export interface NotionPublishResult {
  pageId: string;
  url?: string;
  created: boolean;
  managedMarkdown: string | null;
  bodyManagement: "managed" | "manual";
  trashedDuplicatePageIds: string[];
}

export type NotionReviewReason = "managed_content_changed" | "truncated_markdown";
export type NotionReviewComparison =
  | "already_current"
  | "stored_exact"
  | "formatting_equivalent"
  | "manual_changes"
  | "missing_baseline"
  | "truncated";

export interface NotionReviewInspection {
  messageId: string;
  reason: NotionReviewReason;
  comparison: NotionReviewComparison;
  currentLength: number;
  previousLength: number;
  nextLength: number;
}

export type NotionReconciliationAction = "refresh_managed" | "preserve_manual";

export class NotionReviewRequiredError extends Error {
  constructor(
    readonly reason: NotionReviewReason,
    readonly pageId: string
  ) {
    super(reason === "truncated_markdown"
      ? `Cannot safely update truncated Notion page ${pageId}`
      : `Cannot safely update Notion page ${pageId} because its managed opportunity text was edited`);
    this.name = "NotionReviewRequiredError";
  }
}

export interface NotionSchemaInspection {
  dataSourceId: string;
  properties: Array<{ name: string; type: string }>;
}

export async function inspectNotionSchema(env: Env, config: RuntimeConfig): Promise<NotionSchemaInspection> {
  requireNotionToken(env);
  const source = await notionJson<DataSourceResponse>(
    env.NOTION_TOKEN,
    `/data_sources/${config.notionDataSourceId}`
  );
  return {
    dataSourceId: source.id,
    properties: Object.entries(source.properties)
      .map(([name, property]) => ({ name, type: property.type ?? "unknown" }))
      .sort((left, right) => left.name.localeCompare(right.name))
  };
}

export async function ensureNotionSchema(env: Env, config: RuntimeConfig): Promise<void> {
  if (!config.notionEnabled) return;
  requireNotionToken(env);
  const source = await notionJson<DataSourceResponse>(
    env.NOTION_TOKEN,
    `/data_sources/${config.notionDataSourceId}`
  );
  const properties: Record<string, unknown> = {};
  if (!source.properties["Automation Key"]) properties["Automation Key"] = { rich_text: {} };
  if (!source.properties.Source) {
    properties.Source = {
      select: {
        options: [
          { name: "HEY", color: "blue" },
          { name: "Zoho", color: "green" },
          { name: "Creative West", color: "orange" }
        ]
      }
    };
  }
  if (!source.properties["Last Checked"]) properties["Last Checked"] = { date: {} };
  if (Object.keys(properties).length) {
    await notionJson(env.NOTION_TOKEN, `/data_sources/${config.notionDataSourceId}`, {
      method: "PATCH",
      body: JSON.stringify({ properties })
    });
  }
}

export async function trashNotionPage(env: Env, pageId: string): Promise<void> {
  requireNotionToken(env);
  if (!/^[0-9a-f]{32}$|^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(pageId)) {
    throw new Error("Invalid Notion page ID");
  }
  await notionJson<NotionPage>(env.NOTION_TOKEN, `/pages/${pageId}`, {
    method: "PATCH",
    body: JSON.stringify({ in_trash: true })
  });
}

export async function publishOpportunity(
  env: Env,
  config: RuntimeConfig,
  message: Pick<MessageRecord, "id" | "source">,
  classification: Classification,
  automationKey: string
): Promise<NotionPublishResult> {
  if (!config.notionEnabled) throw new Error("Notion publishing is disabled");
  requireNotionToken(env);

  const match = await findExistingPages(env, config.notionDataSourceId, automationKey, classification);
  const existing = match?.canonical ?? null;
  const checkedAt = new Date().toISOString();
  const properties = buildProperties(message, classification, automationKey, checkedAt);
  const managedMarkdown = buildOpportunityMarkdown(classification);

  if (!existing) {
    const created = await notionJson<NotionPage>(env.NOTION_TOKEN, "/pages", {
      method: "POST",
      body: JSON.stringify({
        parent: { type: "data_source_id", data_source_id: config.notionDataSourceId },
        properties,
        markdown: managedMarkdown
      })
    });
    return {
      pageId: created.id,
      url: created.url,
      created: true,
      managedMarkdown,
      bodyManagement: "managed",
      trashedDuplicatePageIds: []
    };
  }

  await notionJson<NotionPage>(env.NOTION_TOKEN, `/pages/${existing.id}`, {
    method: "PATCH",
    body: JSON.stringify({ properties })
  });
  const storedBody = await loadStoredBodyState(env.DB, existing.id);
  if (storedBody.bodyManagement === "managed") {
    await updateManagedContent(env, existing.id, managedMarkdown, storedBody.managedMarkdown);
  }
  const trashedDuplicatePageIds = await trashAutomationOwnedDuplicates(env, match?.duplicates ?? []);
  return {
    pageId: existing.id,
    url: existing.url,
    created: false,
    managedMarkdown: storedBody.bodyManagement === "managed" ? managedMarkdown : null,
    bodyManagement: storedBody.bodyManagement,
    trashedDuplicatePageIds
  };
}

export async function opportunityAutomationKey(classification: Classification): Promise<string> {
  return sha256Hex(
    classification.primaryUrl ?? `${classification.organization ?? ""}|${classification.title.toLowerCase()}`
  );
}

export async function inspectNotionReviewQueue(
  env: Env,
  config: RuntimeConfig
): Promise<NotionReviewInspection[]> {
  requireNotionToken(env);
  const rows = await env.DB
    .prepare("SELECT id FROM messages WHERE status = 'notion_review' ORDER BY updated_at ASC LIMIT 100")
    .all<{ id: string }>();
  const inspections: NotionReviewInspection[] = [];
  for (const row of rows.results) inspections.push(await inspectNotionReview(env, config, row.id));
  return inspections;
}

export async function inspectNotionReview(
  env: Env,
  config: RuntimeConfig,
  messageId: string
): Promise<NotionReviewInspection> {
  const context = await loadNotionReviewContext(env, config, messageId);
  return publicNotionReviewInspection(context);
}

export async function reconcileNotionReview(
  env: Env,
  config: RuntimeConfig,
  messageId: string,
  action: NotionReconciliationAction
): Promise<{ messageId: string; action: NotionReconciliationAction; status: "notion" }> {
  const context = await loadNotionReviewContext(env, config, messageId);
  const inspection = publicNotionReviewInspection(context);
  if (action === "refresh_managed") {
    if (!["already_current", "stored_exact", "formatting_equivalent"].includes(inspection.comparison)) {
      throw new Error("Managed refresh is unsafe because the current Notion body contains substantive changes");
    }
    if (inspection.comparison === "stored_exact") {
      await updateManagedContent(env, context.page.id, context.nextMarkdown, context.previousMarkdown);
    } else if (inspection.comparison === "formatting_equivalent") {
      await replaceNotionMarkdown(env, context.page.id, context.nextMarkdown);
    }
    await upsertOpportunity(
      env.DB,
      context.automationKey,
      context.message.id,
      context.classification,
      context.page.id,
      context.nextMarkdown,
      "managed"
    );
  } else {
    await upsertOpportunity(
      env.DB,
      context.automationKey,
      context.message.id,
      context.classification,
      context.page.id,
      null,
      "manual"
    );
  }
  const published = await publishOpportunity(
    env,
    config,
    context.message,
    context.classification,
    context.automationKey
  );
  await upsertOpportunity(
    env.DB,
    context.automationKey,
    context.message.id,
    context.classification,
    published.pageId,
    published.managedMarkdown,
    published.bodyManagement
  );
  await saveClassification(env.DB, context.message.id, context.classification, "notion", context.classification.primaryUrl);
  return { messageId, action, status: "notion" };
}

async function findExistingPages(
  env: Env,
  dataSourceId: string,
  automationKey: string,
  classification: Classification
): Promise<{ canonical: NotionPage; duplicates: NotionPage[] } | null> {
  const or: Record<string, unknown>[] = [
    { property: "Automation Key", rich_text: { equals: automationKey } }
  ];
  for (const website of notionWebsiteVariants(classification.primaryUrl)) {
    or.push({ property: "Website", rich_text: { equals: website } });
  }
  or.push({ property: "Name", title: { equals: classification.title } });
  or.push(...fuzzyTitleFilters(classification.title));
  const candidates: NotionPage[] = [];
  let cursor: string | null | undefined;
  do {
    const response = await notionJson<NotionQueryResponse>(env.NOTION_TOKEN, `/data_sources/${dataSourceId}/query`, {
      method: "POST",
      body: JSON.stringify({
        filter: { or },
        page_size: 100,
        ...(cursor ? { start_cursor: cursor } : {})
      })
    });
    candidates.push(...response.results);
    cursor = response.has_more ? response.next_cursor : null;
  } while (cursor);
  const acceptable = candidates.filter((page) => {
    const key = notionPropertyText(page, "Automation Key");
    const website = notionPropertyText(page, "Website");
    const title = notionPropertyText(page, "Name");
    return key === automationKey
      || notionWebsiteVariants(website).some((variant) => notionWebsiteVariants(classification.primaryUrl).includes(variant))
      || opportunityTitlesLikelySame(title, classification.title);
  });
  const sorted = acceptable.sort((left, right) => (left.created_time ?? "").localeCompare(right.created_time ?? ""));
  const oldest = sorted[0];
  if (!oldest) return null;
  const ownership = await Promise.all(sorted.map(async (page) => ({
    page,
    automated: await isAutomationOwnedPage(env, page)
  })));
  const canonical = ownership.find((candidate) => !candidate.automated)?.page ?? oldest;
  return { canonical, duplicates: sorted.filter((page) => page.id !== canonical.id) };
}

const TITLE_NOISE = new Set([
  "a", "an", "and", "application", "applications", "apply", "call", "calls", "for", "of", "open",
  "deadline", "deadlines", "entries", "entry", "opportunity", "program", "programme", "register",
  "registration", "submission", "submissions", "submit", "submitting", "the", "to"
]);

export function meaningfulOpportunityTitleTokens(value: string): string[] {
  return [...new Set(
    value
      .normalize("NFKD")
      .toLowerCase()
      .replace(/[\u0300-\u036f]/g, "")
      .split(/[^a-z0-9]+/)
      .filter((token) =>
        token.length > 1
        && !/^\d{4}$/.test(token)
        && !/^\d+(?:st|nd|rd|th)$/.test(token)
        && !TITLE_NOISE.has(token)
      )
  )];
}

export function opportunityTitlesLikelySame(left: string, right: string): boolean {
  const leftYears = titleYears(left);
  const rightYears = titleYears(right);
  if (leftYears.length && rightYears.length && !leftYears.some((year) => rightYears.includes(year))) return false;
  const leftTokens = meaningfulOpportunityTitleTokens(left);
  const rightTokens = meaningfulOpportunityTitleTokens(right);
  if (leftTokens.length < 2 || rightTokens.length < 2) return false;
  const rightSet = new Set(rightTokens);
  const intersection = leftTokens.filter((token) => rightSet.has(token)).length;
  const shorter = Math.min(leftTokens.length, rightTokens.length);
  const union = new Set([...leftTokens, ...rightTokens]).size;
  if (shorter === 2) return intersection === 2 && union === 2;
  return intersection === shorter || (intersection >= 3 && intersection / union >= 0.75);
}

function titleYears(value: string): string[] {
  return [...new Set(value.match(/\b(?:19|20)\d{2}\b/g) ?? [])];
}

function fuzzyTitleFilters(title: string): Record<string, unknown>[] {
  const tokens = meaningfulOpportunityTitleTokens(title).slice(0, 6);
  if (tokens.length < 2) return [];
  if (tokens.length === 2) {
    return [{
      and: tokens.map((token) => ({ property: "Name", title: { contains: token } }))
    }];
  }
  const filters: Record<string, unknown>[] = [];
  for (let first = 0; first < tokens.length - 2; first += 1) {
    for (let second = first + 1; second < tokens.length - 1; second += 1) {
      for (let third = second + 1; third < tokens.length; third += 1) {
        filters.push({
          and: [tokens[first], tokens[second], tokens[third]].map((token) => ({
            property: "Name",
            title: { contains: token }
          }))
        });
      }
    }
  }
  return filters;
}

async function trashAutomationOwnedDuplicates(env: Env, duplicates: NotionPage[]): Promise<string[]> {
  const trashed: string[] = [];
  for (const duplicate of duplicates) {
    if (!(await isAutomationOwnedPage(env, duplicate))) continue;
    await trashNotionPage(env, duplicate.id);
    trashed.push(duplicate.id);
  }
  return trashed;
}

async function isAutomationOwnedPage(env: Env, page: NotionPage): Promise<boolean> {
  if (notionPropertyText(page, "Automation Key")) return true;
  return Boolean(await env.DB
    .prepare("SELECT notion_page_id FROM opportunities WHERE notion_page_id = ? LIMIT 1")
    .bind(page.id)
    .first("notion_page_id"));
}

function notionPropertyText(page: NotionPage, propertyName: string): string {
  const property = page.properties?.[propertyName] as {
    title?: Array<{ plain_text?: string }>;
    rich_text?: Array<{ plain_text?: string }>;
  } | undefined;
  const fragments = property?.title ?? property?.rich_text ?? [];
  return fragments.map((fragment) => fragment.plain_text ?? "").join("").trim();
}

export function notionWebsiteVariants(value: string | null): string[] {
  if (!value) return [];
  const canonical = canonicalizeUrl(value);
  if (!canonical) return [];
  const url = new URL(canonical);
  const variants = new Set<string>([canonical]);
  if (!url.hostname.startsWith("www.")) {
    const withWww = new URL(url);
    withWww.hostname = `www.${url.hostname}`;
    variants.add(withWww.toString());
  }
  for (const variant of [...variants]) {
    if (variant.endsWith("/")) variants.add(variant.slice(0, -1));
  }
  return [...variants];
}

async function updateManagedContent(
  env: Env,
  pageId: string,
  next: string,
  previous: string | null
): Promise<void> {
  const current = await notionJson<NotionMarkdownResponse>(env.NOTION_TOKEN, `/pages/${pageId}/markdown`);
  if (current.truncated) {
    throw new NotionReviewRequiredError("truncated_markdown", pageId);
  }
  const legacy = extractLegacyManagedBlock(current.markdown);
  const managed = legacy ?? previous;
  if (current.markdown.includes(next)) return;
  if (managed) {
    if (!current.markdown.includes(managed)) {
      throw new NotionReviewRequiredError("managed_content_changed", pageId);
    }
    await notionJson(env.NOTION_TOKEN, `/pages/${pageId}/markdown`, {
      method: "PATCH",
      body: JSON.stringify({
        type: "update_content",
        update_content: { content_updates: [{ old_str: managed, new_str: next }] }
      })
    });
    return;
  }
  if (!current.markdown.trim()) {
    await notionJson(env.NOTION_TOKEN, `/pages/${pageId}/markdown`, {
      method: "PATCH",
      body: JSON.stringify({
        type: "replace_content",
        replace_content: { new_str: next }
      })
    });
    return;
  }
  await notionJson(env.NOTION_TOKEN, `/pages/${pageId}/markdown`, {
    method: "PATCH",
    body: JSON.stringify({
      type: "insert_content",
      insert_content: { position: { type: "end" }, content: `\n\n${next}` }
    })
  });
}

async function loadStoredBodyState(
  db: D1Database,
  pageId: string
): Promise<{ managedMarkdown: string | null; bodyManagement: "managed" | "manual" }> {
  const row = await db
    .prepare("SELECT managed_markdown, body_management FROM opportunities WHERE notion_page_id = ? LIMIT 1")
    .bind(pageId)
    .first<{ managed_markdown: string | null; body_management: "managed" | "manual" }>();
  return {
    managedMarkdown: row?.managed_markdown ?? null,
    bodyManagement: row?.body_management ?? "managed"
  };
}

interface NotionReviewContext {
  message: Pick<MessageRecord, "id" | "source">;
  classification: Classification;
  automationKey: string;
  page: NotionPage;
  reason: NotionReviewReason;
  current: NotionMarkdownResponse;
  previousMarkdown: string | null;
  nextMarkdown: string;
}

async function loadNotionReviewContext(
  env: Env,
  config: RuntimeConfig,
  messageId: string
): Promise<NotionReviewContext> {
  requireNotionToken(env);
  if (!/^[a-f0-9]{64}$/i.test(messageId)) throw new Error("Invalid messageId");
  const message = await env.DB
    .prepare("SELECT id, source, status, classification_json, last_error FROM messages WHERE id = ? LIMIT 1")
    .bind(messageId)
    .first<Pick<MessageRecord, "id" | "source" | "status" | "classification_json" | "last_error">>();
  if (!message || message.status !== "notion_review" || !message.classification_json) {
    throw new Error("Notion review item was not found");
  }
  const classification = classificationSchema.parse(JSON.parse(message.classification_json));
  const automationKey = await opportunityAutomationKey(classification);
  const match = await findExistingPages(env, config.notionDataSourceId, automationKey, classification);
  if (!match) throw new Error("No matching Notion page was found for the review item");
  const current = await notionJson<NotionMarkdownResponse>(env.NOTION_TOKEN, `/pages/${match.canonical.id}/markdown`);
  const storedBody = await loadStoredBodyState(env.DB, match.canonical.id);
  const reason = message.last_error === "truncated_markdown" || message.last_error?.includes("truncated Notion page")
    ? "truncated_markdown"
    : "managed_content_changed";
  return {
    message: { id: message.id, source: message.source },
    classification,
    automationKey,
    page: match.canonical,
    reason,
    current,
    previousMarkdown: storedBody.managedMarkdown,
    nextMarkdown: buildOpportunityMarkdown(classification)
  };
}

function publicNotionReviewInspection(context: NotionReviewContext): NotionReviewInspection {
  let comparison: NotionReviewComparison;
  if (context.current.truncated) comparison = "truncated";
  else if (context.current.markdown.includes(context.nextMarkdown)) comparison = "already_current";
  else if (!context.previousMarkdown) comparison = "missing_baseline";
  else if (context.current.markdown.includes(context.previousMarkdown)) comparison = "stored_exact";
  else if (normalizeMarkdownForComparison(context.current.markdown) === normalizeMarkdownForComparison(context.previousMarkdown)) {
    comparison = "formatting_equivalent";
  } else comparison = "manual_changes";
  return {
    messageId: context.message.id,
    reason: context.reason,
    comparison,
    currentLength: context.current.markdown.length,
    previousLength: context.previousMarkdown?.length ?? 0,
    nextLength: context.nextMarkdown.length
  };
}

function normalizeMarkdownForComparison(markdown: string): string {
  return markdown
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t]+/g, " ")
    .replace(/\n+/g, "\n")
    .trim();
}

async function replaceNotionMarkdown(env: Env, pageId: string, markdown: string): Promise<void> {
  await notionJson(env.NOTION_TOKEN, `/pages/${pageId}/markdown`, {
    method: "PATCH",
    body: JSON.stringify({
      type: "replace_content",
      replace_content: { new_str: markdown }
    })
  });
}

function buildProperties(
  message: Pick<MessageRecord, "source">,
  classification: Classification,
  automationKey: string,
  checkedAt: string
): Record<string, unknown> {
  const properties: Record<string, unknown> = {
    Name: { title: [{ text: { content: classification.title } }] },
    Website: { rich_text: classification.primaryUrl ? [{ text: { content: classification.primaryUrl } }] : [] },
    Tags: { multi_select: classification.tags.map((name) => ({ name })) },
    Type: { select: classification.type ? { name: classification.type } : null },
    "Due Date": { date: classification.dueDate ? { start: classification.dueDate } : null },
    "Application open": {
      date: classification.applicationOpenStart
        ? {
            start: classification.applicationOpenStart,
            end: classification.applicationOpenEnd ?? undefined
          }
        : null
    },
    "Automation Key": { rich_text: [{ text: { content: automationKey } }] },
    Source: { select: { name: notionSourceName(message.source) } },
    "Last Checked": { date: { start: checkedAt } }
  };
  return properties;
}

function notionSourceName(source: MessageRecord["source"]): string {
  if (source === "hey") return "HEY";
  if (source === "zoho") return "Zoho";
  return "Creative West";
}

export function buildOpportunityMarkdown(classification: Classification): string {
  const applicationLine = classification.applicationUrl
    ? `- [Apply or submit here](${classification.applicationUrl})`
    : "- Use the official opportunity page linked above.";
  return `${classification.bodyMarkdown.trim()}

## Key dates and application

- Current deadline: ${classification.dueDate ?? "Rolling or not stated"}
- Application opens: ${classification.applicationOpenStart ?? "Not stated"}
- Application closes: ${classification.applicationOpenEnd ?? classification.dueDate ?? "Not stated"}
${applicationLine}

## Classification evidence

${classification.evidence.map((item) => `- ${item}`).join("\n") || "- No short evidence excerpt returned."}`.trim();
}

function extractLegacyManagedBlock(markdown: string): string | null {
  const start = markdown.indexOf(LEGACY_MANAGED_START);
  const end = markdown.indexOf(LEGACY_MANAGED_END, start);
  if (start === -1 || end === -1) return null;
  return markdown.slice(start, end + LEGACY_MANAGED_END.length);
}

async function notionJson<T = Record<string, unknown>>(
  token: string,
  path: string,
  init: RequestInit = {}
): Promise<T> {
  let lastError: Error | undefined;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const response = await fetch(`${NOTION_API}${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${token}`,
        "Notion-Version": NOTION_VERSION,
        "Content-Type": "application/json",
        ...init.headers
      },
      signal: AbortSignal.timeout(30_000)
    });
    const text = await readBoundedText(response, 2_000_000);
    if (response.ok) return (text ? JSON.parse(text) : {}) as T;
    let detail = text;
    try {
      const body = JSON.parse(text) as { message?: string };
      detail = body.message ?? text;
    } catch {
      // Keep the original response text.
    }
    lastError = new Error(`Notion ${init.method ?? "GET"} ${path} failed (${response.status}): ${detail}`);
    if (response.status !== 429 && response.status < 500) throw lastError;
    const retryAfter = Number(response.headers.get("retry-after") ?? 0);
    await delay(Math.max(retryAfter * 1_000, 500 * 2 ** attempt));
  }
  throw lastError ?? new Error(`Notion request failed: ${path}`);
}

function requireNotionToken(env: Env): void {
  if (!env.NOTION_TOKEN) throw new Error("Notion is enabled but NOTION_TOKEN is missing");
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
