import { upsertMessage } from "../storage/database";
import { parseDate } from "../util/dates";
import { sha256Hex } from "../util/crypto";
import { logError, logInfo } from "../util/log";

const MAX_RAW_MESSAGE_BYTES = 26_214_400;

export interface ImportedHeyEmail {
  externalId: string;
  mailbox: string;
  subject: string;
  senderName?: string;
  senderEmail?: string;
  receivedAt: string;
  rawBase64: string;
}

export async function ingestForwardedHeyEmail(message: ForwardableEmailMessage, env: Env): Promise<void> {
  if (message.rawSize > MAX_RAW_MESSAGE_BYTES) {
    message.setReject("Message exceeds the 25 MiB ingestion limit");
    return;
  }

  const headerMessageId = cleanHeader(message.headers.get("message-id"));
  const externalId = headerMessageId || crypto.randomUUID();
  const id = await sha256Hex(`hey:${externalId}`);
  const receivedAt = parseDate(message.headers.get("date"), new Date()).toISOString();
  const datePrefix = receivedAt.slice(0, 10);
  const rawR2Key = `raw/hey/${datePrefix}/${id}.eml`;

  try {
    await env.MAIL_BUCKET.put(rawR2Key, message.raw, {
      httpMetadata: { contentType: "message/rfc822" },
      customMetadata: {
        source: "hey",
        externalId: externalId.slice(0, 900),
        receivedAt
      }
    });

    await upsertMessage(env.DB, {
      id,
      source: "hey",
      externalId,
      mailbox: "Forwarded non-spam",
      subject: cleanHeader(message.headers.get("subject")) || "(No subject)",
      senderName: undefined,
      senderEmail: cleanHeader(message.headers.get("from")) || message.from,
      receivedAt,
      rawR2Key,
      rawSize: message.rawSize
    });
    logInfo("hey_email_ingested", { id, externalId, rawSize: message.rawSize });
  } catch (error) {
    await env.MAIL_BUCKET.delete(rawR2Key).catch((cleanupError: unknown) => {
      logError("hey_ingest_cleanup_failed", cleanupError, { rawR2Key });
    });
    logError("hey_email_ingest_failed", error, { id, externalId });
    throw error;
  }
}

export async function ingestImportedHeyEmail(input: ImportedHeyEmail, env: Env): Promise<{ id: string }> {
  const externalId = cleanRequired(input.externalId, "externalId", 900);
  const mailbox = cleanRequired(input.mailbox, "mailbox", 200);
  const subject = cleanRequired(input.subject, "subject", 998);
  const receivedAt = parseDate(input.receivedAt, new Date(0));
  if (receivedAt.getTime() === 0) throw new Error("receivedAt must be a valid date");
  if (typeof input.rawBase64 !== "string" || !input.rawBase64.length) throw new Error("rawBase64 is required");
  const estimatedSize = Math.floor(input.rawBase64.length * 3 / 4);
  if (estimatedSize > MAX_RAW_MESSAGE_BYTES) throw new Error("Imported HEY message exceeds the 25 MiB limit");

  let binary: string;
  try {
    binary = atob(input.rawBase64);
  } catch {
    throw new Error("rawBase64 is not valid base64");
  }
  if (binary.length > MAX_RAW_MESSAGE_BYTES) throw new Error("Imported HEY message exceeds the 25 MiB limit");
  const raw = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) raw[index] = binary.charCodeAt(index);

  const id = await sha256Hex(`hey:${externalId}`);
  const receivedIso = receivedAt.toISOString();
  const rawR2Key = `raw/hey/${receivedIso.slice(0, 10)}/${id}.eml`;
  await env.MAIL_BUCKET.put(rawR2Key, raw, {
    httpMetadata: { contentType: "message/rfc822" },
    customMetadata: { source: "hey", externalId, receivedAt: receivedIso, import: "mcp-hey" }
  });
  try {
    await upsertMessage(env.DB, {
      id,
      source: "hey",
      externalId,
      mailbox,
      subject,
      senderName: cleanOptional(input.senderName, 300),
      senderEmail: cleanOptional(input.senderEmail, 320),
      receivedAt: receivedIso,
      rawR2Key,
      rawSize: raw.byteLength
    });
  } catch (error) {
    await env.MAIL_BUCKET.delete(rawR2Key).catch(() => undefined);
    throw error;
  }
  logInfo("hey_email_backfill_ingested", { id, externalId, rawSize: raw.byteLength, mailbox });
  return { id };
}

function cleanHeader(value: string | null): string {
  return (value ?? "").replace(/[\r\n\0]+/g, " ").trim();
}

function cleanRequired(value: unknown, field: string, maxLength: number): string {
  if (typeof value !== "string") throw new Error(`${field} must be a string`);
  const cleaned = value.replace(/[\r\n\0]+/g, " ").trim();
  if (!cleaned || cleaned.length > maxLength) throw new Error(`${field} must be 1-${maxLength} characters`);
  return cleaned;
}

function cleanOptional(value: unknown, maxLength: number): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") throw new Error("Optional metadata fields must be strings");
  const cleaned = value.replace(/[\r\n\0]+/g, " ").trim();
  if (cleaned.length > maxLength) throw new Error(`Optional metadata field exceeds ${maxLength} characters`);
  return cleaned || undefined;
}
