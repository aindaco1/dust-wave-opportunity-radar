import { createHash } from "node:crypto";
import { inspectHeyAttachmentFidelity } from "./hey-cli-fidelity.mjs";
import { buildMime } from "./hey-mime.mjs";

export const RECOVERY_CLI_VERSION = "1.4.1-radar-pr346";
export class RecoveryError extends Error {}
function requireThat(condition, code) { if (!condition) throw new RecoveryError(code); }
const digest = (value) => createHash("sha256").update(value).digest("hex");
const MAX_ATTACHMENTS = 50;
const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024;
const MAX_MIME_BYTES = 26_214_400;

export function validateMessageId(value) {
  requireThat(typeof value === "string" && /^[0-9a-f]{64}$/.test(value), "invalid_message_id");
  return value;
}

function exactId(value) {
  requireThat(typeof value === "string" || (typeof value === "number" && Number.isSafeInteger(value)), "invalid_source_identity");
  const id = String(value);
  requireThat(/^[1-9][0-9]{0,18}$/.test(id), "invalid_source_identity");
  return id;
}

function instant(value) {
  requireThat(typeof value === "string" && /^\d{4}-\d\d-\d\dT.*(?:Z|[+-]\d\d:\d\d)$/.test(value), "timestamp_requires_timezone");
  const result = Date.parse(value);
  requireThat(Number.isFinite(result), "invalid_timestamp");
  return result;
}

function recordIdentity(record, messageId) {
  requireThat(record?.id === messageId && record.source === "hey", "existing_hey_record_required");
  requireThat(/^mcp-hey:[1-9][0-9]{0,18}$/.test(record.external_id), "legacy_topic_identity_required");
  requireThat(digest(`hey:${record.external_id}`) === messageId && record.identity_count === 1, "identity_mismatch");
}

function snapshot(record) { return JSON.stringify(record); }

export async function recoverHeyRecord({ messageId, mode, ports }) {
  validateMessageId(messageId);
  requireThat(mode === "preview" || mode === "import", "invalid_recovery_mode");
  const record = await ports.readRecord(messageId);
  recordIdentity(record, messageId);
  if (record.status === "queued" && record.raw_r2_key && record.attempts === 0) {
    return { ok: true, decision: "already_queued", imported: 0, identityCount: 1 };
  }
  requireThat(record.status === "failed" && record.raw_r2_key === "", "failed_expired_record_required");
  requireThat(typeof record.subject === "string" && record.subject.trim() && record.subject.length <= 998, "invalid_stored_metadata");
  requireThat(typeof record.mailbox === "string" && record.mailbox.length > 0 && record.mailbox.length <= 200, "invalid_stored_metadata");
  for (const [field, limit] of [["sender_name", 300], ["sender_email", 320]]) {
    requireThat(record[field] == null || (typeof record[field] === "string" && record[field].length <= limit), "invalid_stored_metadata");
  }
  requireThat(record.discovery_context_json == null, "unexpected_discovery_context");
  const receivedAt = new Date(instant(record.received_at));
  const cutoff = instant(/^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d$/.test(record.created_at)
    ? record.created_at.replace(" ", "T") + "Z" : record.created_at);
  const version = await ports.heyJson(["version"]);
  requireThat(version?.ok === true && version.data?.version === RECOVERY_CLI_VERSION, "unqualified_cli_version");
  const topic = record.external_id.slice(8);
  const thread = await ports.heyJson(["thread", "read", topic, "--json"]);
  requireThat(thread?.ok === true && !thread.notice && Array.isArray(thread.data) && thread.data.length > 0 && thread.data.length <= 50, "incomplete_thread");
  const allIds = thread.data.map((entry) => exactId(entry.id));
  requireThat(new Set(allIds).size === allIds.length, "duplicate_entry_identity");
  const selected = [];
  let excludedNewerEntries = 0;
  for (const entry of thread.data) {
    requireThat(entry.kind === "message" && entry.body_state === "hydrated", "unreadable_entry");
    // Normal CLI dates deliberately omit the zone and seconds. The read-only
    // MCP gateway retains API timestamps and original HTML for exact recovery.
    const message = await ports.getMessage(exactId(entry.id));
    requireThat(exactId(message?.id) === exactId(entry.id), "message_identity_mismatch");
    const created = instant(message.created_at);
    const updated = instant(message.updated_at);
    if (created > cutoff) { excludedNewerEntries++; continue; }
    requireThat(updated <= cutoff && updated >= created, "historical_message_changed");
    requireThat(typeof message.content === "string" && Buffer.byteLength(message.content) <= 8 * 1024 * 1024, "invalid_original_html");
    requireThat(typeof entry.body === "string" && entry.body.trim() && Buffer.byteLength(entry.body) <= 2 * 1024 * 1024, "empty_or_oversize_body");
    selected.push({ entry, message });
  }
  requireThat(selected.length > 0, "no_historical_entries");
  const response = await ports.heyJson(["attachment", "list", topic, "--json"]);
  requireThat(response?.ok === true && !response.notice && Array.isArray(response.data) && response.data.length <= MAX_ATTACHMENTS, "incomplete_attachment_inventory");
  const seenAttachments = new Set();
  for (const attachment of response.data) {
    const owner = exactId(attachment.message_id);
    requireThat(allIds.includes(owner) && typeof attachment.id === "string"
      && attachment.id.startsWith(`${owner}:`) && /^[1-9][0-9]*:[1-9][0-9]*$/.test(attachment.id), "attachment_identity_mismatch");
    requireThat(!seenAttachments.has(attachment.id), "duplicate_attachment_identity");
    seenAttachments.add(attachment.id);
  }
  const downloaded = [];
  let attachmentBytes = 0;
  for (const { entry, message } of selected) {
    const attachments = response.data.filter((item) => exactId(item.message_id) === exactId(entry.id));
    const fidelity = inspectHeyAttachmentFidelity({ html: message.content, attachments });
    requireThat(fidelity.complete, "attachment_evidence_incomplete");
    for (const attachment of attachments) {
      requireThat(typeof attachment.filename === "string" && attachment.filename.length > 0 && attachment.filename.length <= 512
        && !/[\r\n\0]/.test(attachment.filename), "invalid_attachment_filename");
      requireThat(Number.isSafeInteger(attachment.byte_size) && attachment.byte_size > 0, "attachment_size_unknown");
      attachmentBytes += attachment.byte_size;
      requireThat(attachmentBytes <= MAX_ATTACHMENT_BYTES, "attachment_budget_exceeded");
      const bytes = await ports.download(attachment);
      requireThat(Buffer.isBuffer(bytes) && bytes.length === attachment.byte_size, "attachment_download_mismatch");
      if (attachment.content_type === "application/pdf" || /\.pdf$/i.test(attachment.filename)) {
        requireThat(bytes.subarray(0, 5).toString("ascii") === "%PDF-", "invalid_pdf_download");
      }
      downloaded.push({ filename: attachment.filename, mime: attachment.content_type || "application/octet-stream", bytes });
    }
  }
  selected.sort((a, b) => instant(a.message.created_at) - instant(b.message.created_at));
  const body = selected.map(({ entry, message }) => `Message received ${message.created_at}\n\n${entry.body}`).join("\n\n---\n\n");
  const raw = buildMime({ id: topic, subject: record.subject, fromName: record.sender_name ?? "",
    fromEmail: record.sender_email ?? "", to: "alonso@hey.com", date: receivedAt, body, attachments: downloaded });
  const rawBase64 = raw.toString("base64");
  requireThat(raw.length <= MAX_MIME_BYTES && Math.floor(rawBase64.length * 3 / 4) <= MAX_MIME_BYTES, "mime_budget_exceeded");
  const counts = { selectedEntries: selected.length, excludedNewerEntries, attachments: downloaded.length, attachmentBytes, rawBytes: raw.length };
  const beforeWrite = await ports.readRecord(messageId);
  requireThat(snapshot(beforeWrite) === snapshot(record), "target_changed_during_recovery");
  if (mode === "preview") return { ok: true, decision: "preview", imported: 0, ...counts };
  // This is the sole write seam. No queue/batch/Notion operation exists here.
  const result = await ports.postImport({ externalId: record.external_id, mailbox: record.mailbox, subject: record.subject,
    ...(record.sender_name ? { senderName: record.sender_name } : {}),
    ...(record.sender_email ? { senderEmail: record.sender_email } : {}), receivedAt: receivedAt.toISOString(), rawBase64 });
  requireThat(result?.accepted === true && result.id === messageId, "unexpected_import_response");
  const after = await ports.readRecord(messageId);
  recordIdentity(after, messageId);
  const expectedKey = `raw/hey/${receivedAt.toISOString().slice(0, 10)}/${messageId}.eml`;
  requireThat(after.status === "queued" && after.attempts === 0 && after.raw_r2_key === expectedKey
    && after.raw_size === raw.length && after.last_error === null, "post_import_state_not_verified");
  for (const field of ["subject", "mailbox", "sender_name", "sender_email", "created_at", "classification_json", "canonical_url", "parsed_r2_key"]) {
    requireThat(after[field] === record[field], "stored_metadata_changed");
  }
  requireThat(instant(after.received_at) === receivedAt.getTime(), "stored_metadata_changed");
  return { ok: true, decision: "recovered", imported: 1, identityCount: 1, ...counts };
}
