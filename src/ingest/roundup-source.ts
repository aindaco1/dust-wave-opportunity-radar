import type { RuntimeConfig } from "../config";
import type { MessageSource } from "../types";
import {
  getSourceValidators, linkSourceMessage, markDiscoveryUrlCollisions, listSourceDocuments, rememberSourceDocument,
  saveSourceDocumentProgress, saveSourceValidators, type HttpValidators, type SourceDocument
} from "../storage/source-documents";
import { sha256Hex } from "../util/crypto";
import { logInfo } from "../util/log";
import { ingestPublicSnapshot } from "./public-snapshot";
import { fetchPublicText } from "./public-fetch";
import { roundupWindow, type RoundupEntry, type Roundup } from "./roundup-parser";

export interface RoundupSource {
  id: Extract<MessageSource, "colossal" | "hyperallergic">;
  label: string;
  senderEmail: string;
  feedUrl: string;
  archiveUrl: string;
  articleUrl(value: string): string | null;
  parseFeed(xml: string): { roundups: Roundup[]; invalid: number };
  parseArchive(html: string): Roundup[];
  parseEntries(html: string): RoundupEntry[];
  normalizeText?(text: string): string;
}

const XML_TYPES = ["application/rss+xml", "application/xml", "text/xml"];
const HTML_TYPES = ["text/html"];
const MAX_DOCUMENTS = 4;
const MAX_ENTRIES = 200;
class DiscoverySafetyError extends Error {
  constructor(source: string) { super(`${source}_discovery_safety_failed`); }
}
export interface RoundupSyncResult {
  discovered: number;
  extracted: number;
  ingested: number;
  unchanged: number;
  cached: number;
  unresolved: number;
  failed: number;
  deferred: number;
  missingMonths: number;
  skipped: boolean;
}

async function discover(source: RoundupSource, months: string[], validators?: HttpValidators | null) {
  const response = await fetchPublicText(source.feedUrl, {
    contentTypes: XML_TYPES, etag: validators?.etag ?? undefined, lastModified: validators?.last_modified ?? undefined
  });
  if (response.status === 304 && !validators) throw new Error(`${source.id}_unexpected_304`);
  const parsed = response.status === 304 ? { roundups: [], invalid: 0 } : source.parseFeed(response.text);
  return {
    ...parsed, roundups: parsed.roundups.filter((post) => months.includes(post.month)),
    notModified: response.status === 304,
    validators: { etag: response.etag, last_modified: response.lastModified }
  };
}

export async function inspectRoundupConnection(source: RoundupSource, enabled: boolean, config: RuntimeConfig, runAt: Date) {
  if (!enabled) return { matchingRoundups: 0, invalid: 0, skipped: true };
  const { roundups, invalid } = await discover(source, roundupWindow(runAt, config.timezone));
  return { matchingRoundups: roundups.length, invalid, skipped: false };
}

export async function syncRoundups(source: RoundupSource, enabled: boolean, env: Env, config: RuntimeConfig, runAt: Date): Promise<RoundupSyncResult> {
  const result: RoundupSyncResult = {
    discovered: 0, extracted: 0, ingested: 0, unchanged: 0, cached: 0, unresolved: 0,
    failed: 0, deferred: 0, missingMonths: 0, skipped: !enabled
  };
  if (!enabled) return result;
  const months = roundupWindow(runAt, config.timezone);
  const discovered = await discover(source, months, await getSourceValidators(env.DB, source.id));
  result.failed += discovered.invalid;
  const posts = new Map(discovered.roundups.map((post) => [post.url, post]));
  for (const post of posts.values()) await rememberSourceDocument(env.DB, source.id, post);
  let documents = await listSourceDocuments(env.DB, source.id, months);
  // Only follow links on the bounded archive page; never guess historical article URLs.
  if (months.slice(0, 2).some((month) => !documents.some((doc) => doc.roundup_month === month))) {
    const archive = await fetchPublicText(source.archiveUrl, { contentTypes: HTML_TYPES });
    for (const post of source.parseArchive(archive.text).filter((post) => months.includes(post.month))) {
      if (!posts.has(post.url)) posts.set(post.url, post);
      await rememberSourceDocument(env.DB, source.id, post);
    }
    documents = await listSourceDocuments(env.DB, source.id, months);
  }
  // Mark changed documents pending before advancing the feed cache, including work beyond this run's cap.
  if (!discovered.notModified) {
    for (const document of documents) {
      const post = posts.get(document.url);
      if (post && (!post.html || await sha256Hex(post.html) !== document.content_hash)) {
        await env.DB.prepare("UPDATE source_documents SET pending = 1 WHERE id = ?").bind(document.id).run();
      }
    }
    documents = await listSourceDocuments(env.DB, source.id, months);
  }
  result.discovered = posts.size;
  result.missingMonths = months.slice(0, 2).filter((month) => !documents.some((doc) => doc.roundup_month === month)).length;
  let budget = MAX_ENTRIES;
  let processed = 0;
  for (const document of documents.slice(0, MAX_DOCUMENTS)) {
    if (!budget) break;
    processed++;
    try {
      const post = posts.get(document.url);
      if (discovered.notModified && !post && !document.pending && !document.needs_restore) {
        result.cached++;
        continue;
      }
      const outcome = await syncDocument(source, env, document, post, runAt, budget, result);
      budget -= outcome.processed;
    } catch (error) {
      if (error instanceof DiscoverySafetyError) throw error;
      result.failed++;
      // Never persist the parser/network error: it may contain untrusted HTML or URLs.
      await saveSourceDocumentProgress(env.DB, document, {
        hash: document.content_hash, nextEntry: document.next_entry, pending: true,
        error: "document_sync_failed", checkedAt: runAt.toISOString()
      });
    }
  }
  result.deferred += documents.length - processed;
  // Pending documents and their cursors are durable before the discovery validator advances.
  if (!discovered.invalid && !discovered.notModified) await saveSourceValidators(env.DB, source.id, discovered.validators);
  logInfo(`${source.id}_sync_completed`, { ...result });
  return result;
}

async function syncDocument(
  source: RoundupSource, env: Env, document: SourceDocument, post: Roundup | undefined, runAt: Date,
  budget: number, result: RoundupSyncResult
): Promise<{ processed: number }> {
  let html = post?.html;
  let entries: RoundupEntry[] | undefined;
  let validators: HttpValidators | undefined;
  if (html && !/continue reading|read (?:more|the rest)|\[\.\.\.\]/i.test(html)) {
    try { entries = source.parseEntries(html); }
    catch { html = undefined; }
  }
  if (!entries) {
    const response = await fetchPublicText(document.url, {
      contentTypes: HTML_TYPES,
      etag: !document.pending && !document.needs_restore ? document.etag ?? undefined : undefined,
      lastModified: !document.pending && !document.needs_restore ? document.last_modified ?? undefined : undefined
    });
    if (!source.articleUrl(response.finalUrl)) throw new Error(`${source.id}_article_redirect`);
    if (response.status === 304) {
      if (document.pending || document.needs_restore) throw new Error(`${source.id}_unexpected_304`);
      result.cached++;
      return { processed: 0 };
    }
    html = response.text;
    entries = source.parseEntries(html);
    validators = { etag: response.etag, last_modified: response.lastModified };
  }
  const hash = await sha256Hex(html!);
  const start = hash === document.content_hash && !document.needs_restore ? document.next_entry : 0;
  let next = start;
  // A previous partial pass that failed an item needs another complete pass after reaching the end.
  let failed = hash === document.content_hash && start > 0 && Boolean(document.last_error_code);
  for (const entry of entries.slice(start, start + budget)) {
    next++;
    result.extracted++;
    const unresolved = entry.requiresReview || entry.ambiguousUrls.length > 0 || !entry.urls.length;
    try {
      const stored = await ingestEntry(source, env, entry, document, runAt);
      let shared: boolean;
      try { shared = await markDiscoveryUrlCollisions(env.DB, source.id, entry.title, entry.urls); }
      catch { throw new DiscoverySafetyError(source.id); }
      if (unresolved || shared) result.unresolved++;
      await linkSourceMessage(env.DB, document.id, stored.id);
      if (stored.ingested) result.ingested++; else result.unchanged++;
    } catch (error) {
      if (error instanceof DiscoverySafetyError) throw error;
      failed = true; result.failed++;
    }
  }
  const remaining = next < entries.length;
  if (remaining) result.deferred++;
  await saveSourceDocumentProgress(env.DB, document, {
    hash, nextEntry: remaining ? next : 0, pending: remaining || failed,
    error: failed ? "entry_sync_failed" : null, checkedAt: runAt.toISOString(), validators
  });
  return { processed: next - start };
}

async function ingestEntry(source: RoundupSource, env: Env, entry: RoundupEntry, document: SourceDocument, runAt: Date) {
  // Provenance and HTML layout never enter the snapshot identity: monthly repeats dedupe.
  const normalized = {
    title: entry.title.normalize("NFKC").toLowerCase(),
    text: (source.normalizeText?.(entry.text) ?? entry.text).replace(/\s+/g, " ").trim(),
    urls: entry.urls, ambiguousUrls: entry.ambiguousUrls, requiresReview: entry.requiresReview
  };
  const externalId = await sha256Hex(JSON.stringify(normalized));
  const receivedAt = runAt.toISOString();
  return ingestPublicSnapshot(env, {
    source: source.id, externalId, namespace: source.id, mailbox: "Opportunities",
    subject: entry.title, senderName: source.label, receivedAt,
    discoveryContext: {
      sourceUrl: document.url, officialUrls: entry.urls,
      ambiguousUrls: entry.ambiguousUrls, requiresReview: entry.requiresReview
    },
    mime: () => [
      `Message-ID: <${source.id}-${externalId}@dustwave-opportunity-radar>`,
      `Subject: ${entry.title.replace(/[\r\n\0]/g, " ")}`,
      `From: "${source.label}" <${source.senderEmail}>`,
      `Date: ${runAt.toUTCString()}`, "MIME-Version: 1.0",
      'Content-Type: text/plain; charset="UTF-8"', "Content-Transfer-Encoding: 8bit", "",
      ...entry.urls.map((url) => `Organizer/application link: ${url}`),
      `Discovery article (secondary source): ${document.url}`,
      `Roundup month: ${document.roundup_month}`, `Article publication: ${document.published_at || "(unknown)"}`,
      `Section: ${entry.section}`, "", entry.text
    ].join("\r\n")
  });
}
