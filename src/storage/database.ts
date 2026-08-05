import type { Classification, MessageRecord, MessageSource, MessageStatus, ProcessResult } from "../types";

export interface NewMessage {
  id: string;
  source: MessageSource;
  externalId: string;
  mailbox: string;
  subject: string;
  senderName?: string;
  senderEmail?: string;
  receivedAt: string;
  rawR2Key: string;
  rawSize: number;
}

export interface DigestItemRecord {
  message_id: string;
  category: string;
  title: string;
  summary: string;
  url: string | null;
  deadline: string | null;
  sender: string | null;
  received_at: string;
}

export async function upsertMessage(db: D1Database, message: NewMessage): Promise<void> {
  await db
    .prepare(
      `INSERT INTO messages(
        id, source, external_id, mailbox, subject, sender_name, sender_email,
        received_at, raw_r2_key, raw_size, status, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', CURRENT_TIMESTAMP)
      ON CONFLICT(source, external_id) DO UPDATE SET
        mailbox = excluded.mailbox,
        subject = excluded.subject,
        sender_name = excluded.sender_name,
        sender_email = excluded.sender_email,
        received_at = excluded.received_at,
        raw_r2_key = excluded.raw_r2_key,
        raw_size = excluded.raw_size,
        status = CASE
          WHEN messages.status = 'failed' AND messages.raw_r2_key = '' THEN 'queued'
          ELSE messages.status
        END,
        attempts = CASE
          WHEN messages.status = 'failed' AND messages.raw_r2_key = '' THEN 0
          ELSE messages.attempts
        END,
        last_error = CASE
          WHEN messages.status = 'failed' AND messages.raw_r2_key = '' THEN NULL
          ELSE messages.last_error
        END,
        updated_at = CURRENT_TIMESTAMP`
    )
    .bind(
      message.id,
      message.source,
      message.externalId,
      message.mailbox,
      message.subject,
      message.senderName ?? null,
      message.senderEmail ?? null,
      message.receivedAt,
      message.rawR2Key,
      message.rawSize
    )
    .run();
}

export async function getMessage(db: D1Database, id: string): Promise<MessageRecord | null> {
  return db.prepare("SELECT * FROM messages WHERE id = ?").bind(id).first<MessageRecord>();
}

export async function listQueuedMessages(
  db: D1Database,
  notionEnabled: boolean,
  limit = 250
): Promise<MessageRecord[]> {
  const result = await db
    .prepare(
      `SELECT * FROM messages
       WHERE (
         (status IN ('queued', 'failed') AND attempts < 4 AND raw_r2_key <> '')
         OR (status = 'processing' AND attempts < 4 AND raw_r2_key <> '' AND updated_at < datetime('now', '-15 minutes'))
         OR (status = 'pending_notion' AND ? = 1)
       )
       ORDER BY received_at ASC LIMIT ?`
    )
    .bind(notionEnabled ? 1 : 0, limit)
    .all<MessageRecord>();
  return result.results;
}

export async function claimMessageProcessing(db: D1Database, id: string): Promise<boolean> {
  const result = await db
    .prepare(
      `UPDATE messages
       SET status = 'processing', attempts = attempts + 1, last_error = NULL, updated_at = CURRENT_TIMESTAMP
       WHERE id = ? AND (
         status IN ('queued', 'failed', 'pending_notion')
         OR (status = 'processing' AND updated_at < datetime('now', '-15 minutes'))
       )`
    )
    .bind(id)
    .run();
  return (result.meta.changes ?? 0) > 0;
}

export async function saveParsedKey(db: D1Database, id: string, parsedR2Key: string): Promise<void> {
  await db
    .prepare("UPDATE messages SET parsed_r2_key = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?")
    .bind(parsedR2Key, id)
    .run();
}

export async function saveClassification(
  db: D1Database,
  id: string,
  classification: Classification,
  status: MessageStatus,
  canonicalUrl?: string | null
): Promise<void> {
  await db
    .prepare(
      `UPDATE messages
       SET classification_json = ?, status = ?, canonical_url = ?, last_error = NULL, updated_at = CURRENT_TIMESTAMP
       WHERE id = ?`
    )
    .bind(JSON.stringify(classification), status, canonicalUrl ?? null, id)
    .run();
}

export async function markMessageFailed(db: D1Database, id: string, error: unknown): Promise<void> {
  const message = error instanceof Error ? error.message : String(error);
  await db
    .prepare("UPDATE messages SET status = 'failed', last_error = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?")
    .bind(message.slice(0, 2_000), id)
    .run();
}

export async function markPendingNotionError(db: D1Database, id: string, error: unknown): Promise<void> {
  const message = error instanceof Error ? error.message : String(error);
  await db
    .prepare(
      "UPDATE messages SET status = 'pending_notion', last_error = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?"
    )
    .bind(message.slice(0, 2_000), id)
    .run();
}

export async function upsertDigestItem(
  db: D1Database,
  message: MessageRecord,
  classification: Classification
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO digest_items(
         message_id, category, title, summary, url, deadline, sender, received_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(message_id) DO UPDATE SET
         category = excluded.category,
         title = excluded.title,
         summary = excluded.summary,
         url = excluded.url,
         deadline = excluded.deadline,
         sender = excluded.sender,
         received_at = excluded.received_at`
    )
    .bind(
      message.id,
      classification.digestCategory ?? "Other Useful Finds",
      classification.title,
      classification.summary,
      classification.primaryUrl,
      classification.dueDate,
      message.sender_name ?? message.sender_email,
      message.received_at
    )
    .run();
}

export async function upsertOpportunity(
  db: D1Database,
  automationKey: string,
  messageId: string,
  classification: Classification,
  notionPageId: string
): Promise<void> {
  const now = new Date().toISOString();
  await db
    .prepare(
      `INSERT INTO opportunities(
         automation_key, canonical_url, title, organization, notion_page_id,
         latest_message_id, first_seen_at, last_seen_at, last_published_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(automation_key) DO UPDATE SET
         canonical_url = excluded.canonical_url,
         title = excluded.title,
         organization = excluded.organization,
         notion_page_id = excluded.notion_page_id,
         latest_message_id = excluded.latest_message_id,
         last_seen_at = excluded.last_seen_at,
         last_published_at = excluded.last_published_at`
    )
    .bind(
      automationKey,
      classification.primaryUrl,
      classification.title,
      classification.organization,
      notionPageId,
      messageId,
      now,
      now,
      now
    )
    .run();
}

export async function listUnsentDigestItems(db: D1Database): Promise<DigestItemRecord[]> {
  const result = await db
    .prepare("SELECT message_id, category, title, summary, url, deadline, sender, received_at FROM digest_items WHERE sent_at IS NULL ORDER BY created_at ASC")
    .all<DigestItemRecord>();
  return result.results;
}

export async function markDigestItemsSent(db: D1Database, messageIds: string[], runId: string): Promise<void> {
  if (!messageIds.length) return;
  const statements = messageIds.map((messageId) =>
    db
      .prepare("UPDATE digest_items SET sent_at = CURRENT_TIMESTAMP, run_id = ? WHERE message_id = ? AND sent_at IS NULL")
      .bind(runId, messageId)
  );
  await db.batch(statements);
}

export async function createRun(db: D1Database, id: string, scheduledFor: string): Promise<boolean> {
  const result = await db
    .prepare(
      "INSERT OR IGNORE INTO runs(id, scheduled_for, started_at, status) VALUES (?, ?, CURRENT_TIMESTAMP, 'running')"
    )
    .bind(id, scheduledFor)
    .run();
  return (result.meta.changes ?? 0) > 0;
}

export async function completeRun(
  db: D1Database,
  id: string,
  results: ProcessResult[],
  queuedCount: number
): Promise<void> {
  const count = (status: MessageStatus) => results.filter((result) => result.status === status).length;
  await db
    .prepare(
      `UPDATE runs SET
        completed_at = CURRENT_TIMESTAMP,
        status = 'completed',
        queued_count = ?,
        notion_count = ?,
        digest_count = ?,
        ignored_count = ?,
        failed_count = ?
       WHERE id = ?`
    )
    .bind(queuedCount, count("notion"), count("digest"), count("ignored"), count("failed"), id)
    .run();
}

export async function failRun(db: D1Database, id: string, error: unknown): Promise<void> {
  const message = error instanceof Error ? error.message : String(error);
  await db
    .prepare("UPDATE runs SET completed_at = CURRENT_TIMESTAMP, status = 'failed', error = ? WHERE id = ?")
    .bind(message.slice(0, 2_000), id)
    .run();
}

export async function getCheckpoint(
  db: D1Database,
  source: MessageSource,
  mailbox: string
): Promise<string | null> {
  const row = await db
    .prepare("SELECT last_received_at FROM source_checkpoints WHERE source = ? AND mailbox = ?")
    .bind(source, mailbox)
    .first<{ last_received_at: string }>();
  return row?.last_received_at ?? null;
}

export async function setCheckpoint(
  db: D1Database,
  source: MessageSource,
  mailbox: string,
  receivedAt: string
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO source_checkpoints(source, mailbox, last_received_at, updated_at)
       VALUES (?, ?, ?, CURRENT_TIMESTAMP)
       ON CONFLICT(source, mailbox) DO UPDATE SET
         last_received_at = excluded.last_received_at,
         updated_at = CURRENT_TIMESTAMP`
    )
    .bind(source, mailbox, receivedAt)
    .run();
}

export async function listExpiredR2Keys(db: D1Database, cutoffIso: string): Promise<string[]> {
  const result = await db
    .prepare(
      `SELECT raw_r2_key AS key FROM messages WHERE datetime(created_at) < datetime(?) AND raw_r2_key <> ''
       UNION ALL
       SELECT parsed_r2_key AS key FROM messages WHERE datetime(created_at) < datetime(?) AND parsed_r2_key IS NOT NULL`
    )
    .bind(cutoffIso, cutoffIso)
    .all<{ key: string }>();
  return result.results.map((row) => row.key);
}

export async function clearExpiredR2Keys(db: D1Database, cutoffIso: string): Promise<void> {
  await db
    .prepare(
      "UPDATE messages SET raw_r2_key = '', parsed_r2_key = NULL, updated_at = CURRENT_TIMESTAMP WHERE datetime(created_at) < datetime(?)"
    )
    .bind(cutoffIso)
    .run();
}
