import type { MessageSource } from "../types";
import {
  linkSourceMessage, markDiscoveryUrlCollisions, saveSourceDocumentProgress,
  type HttpValidators, type SourceDocument
} from "../storage/source-documents";
import { sha256Hex } from "../util/crypto";
import { ingestPublicSnapshot } from "./public-snapshot";
import { fetchPublicText } from "./public-fetch";
import type { Roundup, RoundupEntry } from "./roundup-parser";

export interface PublicDocumentSource {
  id: Extract<MessageSource, "colossal" | "hyperallergic" | "artwork_archive">;
  label: string;
  senderEmail: string;
  documentUrl(value: string): string | null;
  parseEntries(html: string): RoundupEntry[];
  normalizeText?(text: string): string;
}
export interface PublicDocumentSyncCounts {
  extracted: number;
  ingested: number;
  unchanged: number;
  cached: number;
  unresolved: number;
  failed: number;
  deferred: number;
}
export class DiscoverySafetyError extends Error {
  constructor(source: string) { super(`${source}_discovery_safety_failed`); }
}
const HTML_TYPES = ["text/html"];

export async function syncPublicDocument(
  source: PublicDocumentSource, env: Env, document: SourceDocument, post: Roundup | undefined, runAt: Date,
  budget: number, result: PublicDocumentSyncCounts
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
    if (!source.documentUrl(response.finalUrl)) throw new Error(`${source.id}_article_redirect`);
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
  // Persist unfinished work before the first entry write. A failed safety check or
  // interrupted import must force a fresh body even if the server next returns 304.
  await env.DB.prepare("UPDATE source_documents SET pending = 1 WHERE id = ?").bind(document.id).run();
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

async function ingestEntry(source: PublicDocumentSource, env: Env, entry: RoundupEntry, document: SourceDocument, runAt: Date) {
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
      `Discovery ${document.roundup_month ? "article" : "guide"} (secondary source): ${document.url}`,
      ...(document.roundup_month ? [`Roundup month: ${document.roundup_month}`, `Article publication: ${document.published_at || "(unknown)"}`] : []),
      `Section: ${entry.section}`, "", entry.text
    ].join("\r\n")
  });
}
