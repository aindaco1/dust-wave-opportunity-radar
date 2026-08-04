import type { RuntimeConfig } from "../config";
import type { Classification, MessageRecord } from "../types";
import { readBoundedText } from "../util/http";

const NOTION_API = "https://api.notion.com/v1";
const NOTION_VERSION = "2026-03-11";
const MANAGED_START = "**Opportunity Radar managed section — do not edit below this line**";
const MANAGED_END = "**End Opportunity Radar managed section**";

interface NotionPage {
  id: string;
  url?: string;
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
      select: { options: [{ name: "HEY", color: "blue" }, { name: "Zoho", color: "green" }] }
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

export async function publishOpportunity(
  env: Env,
  config: RuntimeConfig,
  message: MessageRecord,
  classification: Classification,
  automationKey: string
): Promise<NotionPublishResult> {
  if (!config.notionEnabled) throw new Error("Notion publishing is disabled");
  requireNotionToken(env);

  const existing = await findExistingPage(env.NOTION_TOKEN, config.notionDataSourceId, automationKey, classification);
  const checkedAt = new Date().toISOString();
  const properties = buildProperties(message, classification, automationKey, checkedAt);

  if (!existing) {
    const created = await notionJson<NotionPage>(env.NOTION_TOKEN, "/pages", {
      method: "POST",
      body: JSON.stringify({
        parent: { type: "data_source_id", data_source_id: config.notionDataSourceId },
        properties,
        markdown: buildManagedMarkdown(classification, message, checkedAt)
      })
    });
    return { pageId: created.id, url: created.url, created: true };
  }

  await notionJson<NotionPage>(env.NOTION_TOKEN, `/pages/${existing.id}`, {
    method: "PATCH",
    body: JSON.stringify({ properties })
  });
  await updateManagedContent(env.NOTION_TOKEN, existing.id, classification, message, checkedAt);
  return { pageId: existing.id, url: existing.url, created: false };
}

async function findExistingPage(
  token: string,
  dataSourceId: string,
  automationKey: string,
  classification: Classification
): Promise<NotionPage | null> {
  const or: Record<string, unknown>[] = [
    { property: "Automation Key", rich_text: { equals: automationKey } }
  ];
  if (classification.primaryUrl) {
    or.push({ property: "Website", rich_text: { equals: classification.primaryUrl } });
  }
  const response = await notionJson<NotionQueryResponse>(token, `/data_sources/${dataSourceId}/query`, {
    method: "POST",
    body: JSON.stringify({ filter: { or }, page_size: 5 })
  });
  return response.results[0] ?? null;
}

async function updateManagedContent(
  token: string,
  pageId: string,
  classification: Classification,
  message: MessageRecord,
  checkedAt: string
): Promise<void> {
  const current = await notionJson<NotionMarkdownResponse>(token, `/pages/${pageId}/markdown`);
  if (current.truncated) {
    throw new Error(`Cannot safely update truncated Notion page ${pageId}`);
  }
  const previous = extractManagedBlock(current.markdown);
  const next = buildManagedMarkdown(classification, message, checkedAt, previous ?? undefined);
  if (previous) {
    await notionJson(token, `/pages/${pageId}/markdown`, {
      method: "PATCH",
      body: JSON.stringify({
        type: "update_content",
        update_content: { content_updates: [{ old_str: previous, new_str: next }] }
      })
    });
  } else {
    await notionJson(token, `/pages/${pageId}/markdown`, {
      method: "PATCH",
      body: JSON.stringify({
        type: "insert_content",
        insert_content: { position: { type: "end" }, content: `\n\n${next}` }
      })
    });
  }
}

function buildProperties(
  message: MessageRecord,
  classification: Classification,
  automationKey: string,
  checkedAt: string
): Record<string, unknown> {
  const properties: Record<string, unknown> = {
    Name: { title: [{ text: { content: classification.title } }] },
    Website: { rich_text: classification.primaryUrl ? [{ text: { content: classification.primaryUrl } }] : [] },
    Tags: { multi_select: classification.tags.map((name) => ({ name })) },
    "Automation Key": { rich_text: [{ text: { content: automationKey } }] },
    Source: { select: { name: message.source === "hey" ? "HEY" : "Zoho" } },
    "Last Checked": { date: { start: checkedAt } }
  };
  if (classification.type) properties.Type = { select: { name: classification.type } };
  if (classification.dueDate) properties["Due Date"] = { date: { start: classification.dueDate } };
  if (classification.applicationOpenStart) {
    properties["Application open"] = {
      date: {
        start: classification.applicationOpenStart,
        end: classification.applicationOpenEnd ?? undefined
      }
    };
  }
  return properties;
}

function buildManagedMarkdown(
  classification: Classification,
  message: MessageRecord,
  checkedAt: string,
  previous?: string
): string {
  const history = updateHistory(previous, classification, checkedAt);
  const applicationLine = classification.applicationUrl
    ? `- [Apply or submit here](${classification.applicationUrl})`
    : "- Use the official opportunity page linked above.";
  return `${MANAGED_START}

_Last checked ${checkedAt} from ${message.source === "hey" ? "HEY" : "Zoho"}: ${escapeInline(message.subject)}._

${classification.bodyMarkdown.trim()}

## Key dates and application

- Current deadline: ${classification.dueDate ?? "Rolling or not stated"}
- Application opens: ${classification.applicationOpenStart ?? "Not stated"}
- Application closes: ${classification.applicationOpenEnd ?? classification.dueDate ?? "Not stated"}
${applicationLine}

## Classification evidence

${classification.evidence.map((item) => `- ${item}`).join("\n") || "- No short evidence excerpt returned."}

## Automation change history

${history.join("\n")}

${MANAGED_END}`;
}

function updateHistory(previous: string | undefined, classification: Classification, checkedAt: string): string[] {
  const priorLines = previous
    ?.match(/## Automation change history\s+([\s\S]*?)\s+\*\*End Opportunity Radar managed section\*\*/)?.[1]
    ?.split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith("- ")) ?? [];
  const priorDeadline = previous?.match(/- Current deadline: ([^\n]+)/)?.[1]?.trim();
  const date = checkedAt.slice(0, 10);
  const currentDeadline = classification.dueDate ?? "Rolling or not stated";
  const event = priorDeadline && priorDeadline !== currentDeadline
    ? `- ${date}: deadline changed from ${priorDeadline} to ${currentDeadline}.`
    : `- ${date}: opportunity details refreshed.`;
  return [event, ...priorLines.filter((line) => line !== event)].slice(0, 12);
}

function extractManagedBlock(markdown: string): string | null {
  const start = markdown.indexOf(MANAGED_START);
  const end = markdown.indexOf(MANAGED_END, start);
  if (start === -1 || end === -1) return null;
  return markdown.slice(start, end + MANAGED_END.length);
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

function escapeInline(value: string): string {
  return value.replace(/[\r\n]+/g, " ").replace(/([*_`])/g, "\\$1");
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
