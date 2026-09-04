import { discoveryContextSchema } from "../types";
import { unzip } from "fflate";
import PostalMime, { type Address, type Attachment } from "postal-mime";
import { extractText, getDocumentProxy } from "unpdf";
import type { MessageRecord, ParsedAttachment, ParsedMessage } from "../types";

const MAX_PDF_PAGES = 100;
const MAX_EXTRACTED_ATTACHMENT_CHARS = 80_000;
const MAX_DOCX_XML_BYTES = 40_000_000;
const PDF_TIMEOUT_MS = 25_000;
const DOCX_MIME = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

export async function parseStoredMessage(
  bucket: R2Bucket,
  record: MessageRecord,
  attachmentMaxBytes: number
): Promise<ParsedMessage> {
  if (!record.raw_r2_key) throw new Error("Raw message has expired from R2");
  const object = await bucket.get(record.raw_r2_key);
  if (!object) throw new Error(`Raw message is missing from R2: ${record.raw_r2_key}`);
  const raw = await object.arrayBuffer();
  const email = await PostalMime.parse(raw, {
    attachmentEncoding: "arraybuffer",
    maxNestingDepth: 20,
    maxHeadersSize: 256_000
  });

  const warnings: string[] = [];
  const attachments: ParsedAttachment[] = [];
  for (const attachment of email.attachments) {
    if (attachment.disposition === "inline" && attachment.related) continue;
    attachments.push(await parseAttachment(attachment, attachmentMaxBytes, warnings));
  }

  const from = mailboxAddress(email.from);
  const text = cleanText(email.text || htmlToText(email.html ?? ""));
  const combinedForUrls = `${email.html ?? ""}\n${text}\n${attachments.map((item) => item.text ?? "").join("\n")}`;
  return {
    source: record.source,
    discoveryContext: record.discovery_context_json
      ? discoveryContextSchema.parse(JSON.parse(record.discovery_context_json))
      : undefined,
    mailbox: record.mailbox,
    externalId: record.external_id,
    messageId: email.messageId,
    subject: email.subject?.trim() || record.subject,
    senderName: from?.name || record.sender_name || undefined,
    senderEmail: from?.address || record.sender_email || undefined,
    receivedAt: email.date ? safeIsoDate(email.date, record.received_at) : record.received_at,
    text,
    html: email.html,
    urls: extractUrls(combinedForUrls),
    attachments,
    warnings
  };
}

export function htmlToText(html: string): string {
  return decodeHtmlEntities(
    html
      .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
      .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<\/(p|div|li|tr|h[1-6])>/gi, "\n")
      .replace(/<li\b[^>]*>/gi, "- ")
      .replace(/<[^>]+>/g, " ")
  );
}

export function extractUrls(value: string): string[] {
  const candidates = value.match(/https?:\/\/[^\s<>"'\])}]+/gi) ?? [];
  const seen = new Set<string>();
  const urls: string[] = [];
  for (const candidate of candidates) {
    const normalized = canonicalizeUrl(decodeHtmlEntities(candidate.replace(/[.,;:!?]+$/, "")));
    if (!normalized || seen.has(normalized) || isLowSignalUrl(normalized)) continue;
    seen.add(normalized);
    urls.push(normalized);
    if (urls.length >= 30) break;
  }
  return urls;
}

export function canonicalizeUrl(value: string): string | null {
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    url.hash = "";
    for (const key of [...url.searchParams.keys()]) {
      const lower = key.toLowerCase();
      if (
        lower.startsWith("utm_") ||
        ["fbclid", "gclid", "mc_cid", "mc_eid", "ref", "referrer", "source"].includes(lower)
      ) {
        url.searchParams.delete(key);
      }
    }
    url.hostname = url.hostname.toLowerCase().replace(/^www\./, "");
    if (url.pathname !== "/") url.pathname = url.pathname.replace(/\/+$/, "");
    return url.toString();
  } catch {
    return null;
  }
}

async function parseAttachment(
  attachment: Attachment,
  attachmentMaxBytes: number,
  warnings: string[]
): Promise<ParsedAttachment> {
  const bytes = attachmentBytes(attachment);
  const filename = attachment.filename?.trim() || "unnamed-attachment";
  const result: ParsedAttachment = { filename, mimeType: attachment.mimeType, size: bytes.byteLength };
  if (bytes.byteLength > attachmentMaxBytes) {
    result.warning = `Skipped: ${bytes.byteLength} bytes exceeds the ${attachmentMaxBytes} byte attachment cap`;
    warnings.push(`${filename}: ${result.warning}`);
    return result;
  }

  try {
    if (attachment.mimeType === "application/pdf" || filename.toLowerCase().endsWith(".pdf")) {
      result.text = await parsePdfText(bytes);
    } else if (attachment.mimeType === DOCX_MIME || filename.toLowerCase().endsWith(".docx")) {
      result.text = await parseDocxText(bytes);
    }
  } catch (error) {
    result.warning = error instanceof Error ? error.message : String(error);
    warnings.push(`${filename}: ${result.warning}`);
  }
  return result;
}

export async function parsePdfText(bytes: Uint8Array): Promise<string> {
  const document = await withTimeout(
    getDocumentProxy(bytes, { maxImageSize: 16_777_216 }),
    PDF_TIMEOUT_MS,
    "PDF loading timed out"
  );
  if (document.numPages > MAX_PDF_PAGES) {
    throw new Error(`Skipped PDF with ${document.numPages} pages; cap is ${MAX_PDF_PAGES}`);
  }
  const result = await withTimeout(
    extractText(document, { mergePages: true }),
    PDF_TIMEOUT_MS,
    "PDF text extraction timed out"
  );
  return cleanText(result.text).slice(0, MAX_EXTRACTED_ATTACHMENT_CHARS);
}

export async function parseDocxText(bytes: Uint8Array): Promise<string> {
  const wanted = /^(word\/(document|footnotes|endnotes|header\d+|footer\d+)\.xml)$/i;
  let rejectedForSize = false;
  let acceptedXmlBytes = 0;
  const files = await new Promise<Record<string, Uint8Array>>((resolve, reject) => {
    unzip(
      bytes,
      {
        filter(file) {
          if (!wanted.test(file.name)) return false;
          acceptedXmlBytes += file.originalSize;
          if (file.originalSize > MAX_DOCX_XML_BYTES || acceptedXmlBytes > MAX_DOCX_XML_BYTES) {
            rejectedForSize = true;
            return false;
          }
          return true;
        }
      },
      (error, output) => {
        if (error) reject(error);
        else resolve(output);
      }
    );
  });
  if (rejectedForSize) throw new Error(`DOCX XML exceeded ${MAX_DOCX_XML_BYTES} bytes`);
  const xmlFiles = Object.entries(files).sort(([left], [right]) => left.localeCompare(right));
  if (!xmlFiles.length) throw new Error("DOCX did not contain readable Word XML");
  return cleanText(
    xmlFiles
      .map(([, content]) => xmlToText(new TextDecoder().decode(content)))
      .join("\n\n")
  ).slice(0, MAX_EXTRACTED_ATTACHMENT_CHARS);
}

function xmlToText(xml: string): string {
  return decodeHtmlEntities(
    xml
      .replace(/<w:tab\b[^>]*\/>/gi, "\t")
      .replace(/<w:(br|cr)\b[^>]*\/>/gi, "\n")
      .replace(/<\/w:(p|tr|tbl)>/gi, "\n")
      .replace(/<[^>]+>/g, "")
  );
}

function attachmentBytes(attachment: Attachment): Uint8Array {
  if (attachment.content instanceof ArrayBuffer) return new Uint8Array(attachment.content);
  if (attachment.content instanceof Uint8Array) return attachment.content;
  if (attachment.encoding === "base64") {
    const binary = atob(attachment.content);
    return Uint8Array.from(binary, (character) => character.charCodeAt(0));
  }
  return new TextEncoder().encode(attachment.content);
}

function mailboxAddress(address: Address | undefined): { name: string; address: string } | undefined {
  if (!address) return undefined;
  if (address.group?.length) return address.group[0];
  if (address.address) return { name: address.name, address: address.address };
  return undefined;
}

function safeIsoDate(value: string, fallback: string): string {
  const parsed = new Date(value);
  return Number.isNaN(parsed.valueOf()) ? fallback : parsed.toISOString();
}

function cleanText(value: string): string {
  return value
    .replace(/\r\n?/g, "\n")
    .replace(/[\t ]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function decodeHtmlEntities(value: string): string {
  const named: Record<string, string> = {
    amp: "&",
    lt: "<",
    gt: ">",
    quot: '"',
    apos: "'",
    nbsp: " "
  };
  return value.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (match, entity: string) => {
    if (entity.startsWith("#")) {
      const hex = entity[1]?.toLowerCase() === "x";
      const code = Number.parseInt(entity.slice(hex ? 2 : 1), hex ? 16 : 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : match;
    }
    return named[entity.toLowerCase()] ?? match;
  });
}

function isLowSignalUrl(value: string): boolean {
  const url = new URL(value);
  const text = `${url.hostname}${url.pathname}`.toLowerCase();
  return [
    "unsubscribe",
    "manage-preferences",
    "email-preferences",
    "privacy-policy",
    "facebook.com",
    "instagram.com",
    "twitter.com",
    "x.com/intent",
    "linkedin.com/share"
  ].some((needle) => text.includes(needle));
}

async function withTimeout<T>(promise: Promise<T>, milliseconds: number, message: string): Promise<T> {
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => reject(new Error(message)), milliseconds);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timeoutId !== undefined) clearTimeout(timeoutId);
  }
}
