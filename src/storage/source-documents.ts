import type { MessageSource } from "../types";
import { sha256Hex } from "../util/crypto";

export interface SourceDocument {
  id: string;
  source: MessageSource;
  url: string;
  roundup_month: string;
  published_at: string;
  etag: string | null;
  last_modified: string | null;
  content_hash: string | null;
  next_entry: number;
  pending: number;
  last_error_code: string | null;
  checked_at: string | null;
  needs_restore: number;
}
export interface HttpValidators { etag: string | null; last_modified: string | null }

export async function rememberSourceDocument(
  db: D1Database, source: MessageSource, document: { url: string; month: string; publishedAt: string }
): Promise<void> {
  const id = await sha256Hex(`${source}:${document.url}`);
  await db.prepare(`INSERT INTO source_documents(id, source, url, roundup_month, published_at)
    VALUES (?, ?, ?, ?, ?) ON CONFLICT(source, url) DO UPDATE SET
    published_at = CASE WHEN excluded.published_at <> '' THEN excluded.published_at ELSE source_documents.published_at END`)
    .bind(id, source, document.url, document.month, document.publishedAt).run();
}

export async function listSourceDocuments(db: D1Database, source: MessageSource, months: string[]): Promise<SourceDocument[]> {
  const result = await db.prepare(`SELECT d.*, EXISTS (
      SELECT 1 FROM source_document_messages dm JOIN messages m ON m.id = dm.message_id
      WHERE dm.document_id = d.id AND m.status IN ('queued', 'failed') AND m.raw_r2_key = ''
    ) AS needs_restore FROM source_documents d
    WHERE d.source = ? AND (d.roundup_month IN (${months.map(() => "?").join(",")}) OR d.pending = 1 OR EXISTS (
      SELECT 1 FROM source_document_messages dm JOIN messages m ON m.id = dm.message_id
      WHERE dm.document_id = d.id AND m.status IN ('queued', 'failed') AND m.raw_r2_key = ''
    )) ORDER BY d.pending DESC, needs_restore DESC, d.checked_at ASC, d.roundup_month ASC, d.id ASC`)
    .bind(source, ...months).all<SourceDocument>();
  return result.results;
}

export async function saveSourceDocumentProgress(
  db: D1Database, document: SourceDocument,
  progress: { hash: string | null; nextEntry: number; pending: boolean; error: string | null; checkedAt: string; validators?: HttpValidators }
): Promise<void> {
  await db.prepare(`UPDATE source_documents SET content_hash = ?, next_entry = ?, pending = ?, last_error_code = ?,
    checked_at = ?, etag = ?, last_modified = ? WHERE id = ?`)
    .bind(progress.hash, progress.nextEntry, progress.pending ? 1 : 0, progress.error, progress.checkedAt,
      progress.validators?.etag ?? null, progress.validators?.last_modified ?? null, document.id).run();
}

export async function linkSourceMessage(db: D1Database, documentId: string, messageId: string): Promise<void> {
  await db.prepare("INSERT OR IGNORE INTO source_document_messages(document_id, message_id) VALUES (?, ?)")
    .bind(documentId, messageId).run();
}
export async function getSourceValidators(db: D1Database, source: MessageSource): Promise<HttpValidators | null> {
  return db.prepare("SELECT etag, last_modified FROM source_http_cache WHERE source = ?").bind(source).first<HttpValidators>();
}
export async function saveSourceValidators(db: D1Database, source: MessageSource, validators: HttpValidators): Promise<void> {
  await db.prepare(`INSERT INTO source_http_cache(source, etag, last_modified) VALUES (?, ?, ?)
    ON CONFLICT(source) DO UPDATE SET etag = excluded.etag, last_modified = excluded.last_modified`)
    .bind(source, validators.etag, validators.last_modified).run();
}

/** Mark shared landing pages before the batch classifies any of the queued programs. */
export async function markDiscoveryUrlCollisions(
  db: D1Database, source: MessageSource, title: string, urls: string[]
): Promise<boolean> {
  let ambiguous = false;
  for (const url of urls) {
    const collision = await db.prepare(`SELECT 1 AS found FROM messages m
      WHERE m.source = ? AND lower(m.subject) <> lower(?) AND m.discovery_context_json IS NOT NULL
      AND EXISTS (SELECT 1 FROM json_each(m.discovery_context_json, '$.officialUrls') WHERE value = ?) LIMIT 1`)
      .bind(source, title, url).first();
    if (!collision) continue;
    ambiguous = true;
    await db.prepare(`UPDATE messages SET discovery_context_json = json_set(discovery_context_json, '$.ambiguousUrls', json((
      SELECT json_group_array(value) FROM (
        SELECT value FROM json_each(messages.discovery_context_json, '$.ambiguousUrls') UNION SELECT ?
      )
    ))) WHERE source = ? AND status IN ('queued', 'failed') AND discovery_context_json IS NOT NULL
      AND EXISTS (SELECT 1 FROM json_each(messages.discovery_context_json, '$.officialUrls') WHERE value = ?)`)
      .bind(url, source, url).run();
  }
  return ambiguous;
}
