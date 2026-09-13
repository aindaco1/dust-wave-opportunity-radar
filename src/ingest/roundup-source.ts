import type { RuntimeConfig } from "../config";
import {
  getSourceValidators, listSourceDocuments, rememberSourceDocument,
  saveSourceDocumentProgress, saveSourceValidators, type HttpValidators
} from "../storage/source-documents";
import { sha256Hex } from "../util/crypto";
import { logInfo } from "../util/log";
import { DiscoverySafetyError, syncPublicDocument, type PublicDocumentSource } from "./public-document";
import { fetchPublicText } from "./public-fetch";
import { roundupWindow, type Roundup } from "./roundup-parser";

export interface RoundupSource extends PublicDocumentSource {
  feedUrl: string;
  archiveUrl: string;
  parseFeed(xml: string): { roundups: Roundup[]; invalid: number };
  parseArchive(html: string): Roundup[];
}

const XML_TYPES = ["application/rss+xml", "application/xml", "text/xml"];
const HTML_TYPES = ["text/html"];
const MAX_DOCUMENTS = 4;
const MAX_ENTRIES = 200;
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
      const outcome = await syncPublicDocument(source, env, document, post, runAt, budget, result);
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
