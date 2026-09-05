import { Parser } from "htmlparser2";

const MAX_HTML_BYTES = 8 * 1024 * 1024;
const MAX_TOTAL_EMBEDDED_BYTES = 12 * 1024 * 1024;
const MAX_EMBEDDED_DEPTH = 4;
const MAX_EVIDENCE_ITEMS = 500;
const FILE_EXTENSION = /\.([a-z0-9]{1,12})$/i;
const HEY_BLOB_PATH = /\/(?:rails\/active_storage\/blobs|blobs\/(?:redirect|proxy))\//i;

/**
 * Search result IDs identify postings, while topic_id is the value accepted by
 * `hey thread read` and `hey attachment list`. Refuse ambiguous results rather
 * than silently importing under the wrong identity.
 */
export function extractHeySearchTopicIds(response) {
  if (!response || response.ok !== true || !Array.isArray(response.data)) {
    throw new Error("HEY search did not return a successful data array");
  }

  const topicIds = [];
  const seen = new Set();
  for (const item of response.data) {
    const value = item?.topic_id;
    const topicId = typeof value === "string" ? value.trim()
      : typeof value === "number" && Number.isSafeInteger(value) ? String(value) : "";
    if (topicId.length > 200 || !/^[1-9][0-9]*$/.test(topicId)) {
      throw new Error("HEY search result is missing a valid topic_id");
    }
    if (!seen.has(topicId)) {
      seen.add(topicId);
      topicIds.push(topicId);
    }
  }
  return topicIds;
}

export function extractHeyAttachmentList(response) {
  if (!response || response.ok !== true || !Array.isArray(response.data)) {
    throw new Error("HEY attachment list did not return a successful data array");
  }
  return response.data;
}

/**
 * Compares the CLI's attachment inventory with attachment-shaped evidence in
 * the original HTML. The result deliberately contains counts and reason codes,
 * never filenames, message text, IDs, or private URLs.
 */
export function inspectHeyAttachmentFidelity({ html, attachments }) {
  if (typeof html !== "string") throw new Error("HEY thread HTML must be a string");
  if (!Array.isArray(attachments)) throw new Error("HEY attachments must be an array");

  const state = {
    evidence: new Map(),
    malformedMetadata: 0,
    unsafeEvidence: 0,
    inspectionLimitExceeded: false,
    totalBytes: 0
  };

  scanHtml(html, 0, state);

  const listedCounts = new Map();
  for (const attachment of attachments) {
    const filename = normalizedFilename(attachment?.filename);
    if (!filename) continue;
    listedCounts.set(filename, (listedCounts.get(filename) ?? 0) + 1);
  }

  let missingEvidenceCount = 0;
  for (const evidence of state.evidence.values()) {
    if (!evidence.safe || !evidence.filename) {
      missingEvidenceCount += 1;
      continue;
    }
    const available = listedCounts.get(evidence.filename) ?? 0;
    if (available < 1) {
      missingEvidenceCount += 1;
    } else {
      listedCounts.set(evidence.filename, available - 1);
    }
  }

  const reasons = [];
  if (missingEvidenceCount > 0) reasons.push("attachment_evidence_missing_from_cli");
  if (state.unsafeEvidence > 0) reasons.push("unsafe_attachment_url");
  if (state.malformedMetadata > 0) reasons.push("malformed_attachment_metadata");
  if (state.inspectionLimitExceeded) reasons.push("inspection_limit_exceeded");

  return {
    complete: reasons.length === 0,
    evidenceCount: state.evidence.size,
    listedCount: attachments.length,
    missingEvidenceCount,
    unsafeEvidenceCount: state.unsafeEvidence,
    malformedMetadataCount: state.malformedMetadata,
    inspectionLimitExceeded: state.inspectionLimitExceeded,
    reasons
  };
}

function scanHtml(html, depth, state) {
  const byteLength = Buffer.byteLength(html, "utf8");
  state.totalBytes += byteLength;
  if (
    byteLength > MAX_HTML_BYTES ||
    state.totalBytes > MAX_TOTAL_EMBEDDED_BYTES ||
    depth > MAX_EMBEDDED_DEPTH
  ) {
    state.inspectionLimitExceeded = true;
    return;
  }

  const embedded = [];
  const parser = new Parser({
    onopentag(name, attributes) {
      if (state.evidence.size >= MAX_EVIDENCE_ITEMS) {
        state.inspectionLimitExceeded = true;
        return;
      }

      if (name === "action-text-attachment") {
        addEvidence(state, {
          filename: attributes.filename,
          url: attributes.url,
          contentType: attributes["content-type"]
        });
        return;
      }

      if (name === "figure" && attributes["data-trix-attachment"]) {
        const raw = attributes["data-trix-attachment"];
        let attachment;
        try {
          attachment = JSON.parse(raw);
        } catch {
          if (attachmentSignal(raw)) state.malformedMetadata += 1;
          return;
        }

        if (attachment?.filename || attachment?.url) {
          addEvidence(state, {
            filename: attachment.filename,
            url: attachment.url,
            contentType: attachment.contentType
          });
        }
        if (typeof attachment?.content === "string" && attachment.content.trim()) {
          embedded.push(attachment.content);
        }
        return;
      }

      if (name === "a" && looksLikeHeyBlob(attributes.href)) {
        addEvidence(state, { url: attributes.href });
      }
    }
  }, { decodeEntities: true });

  parser.write(html);
  parser.end();
  for (const content of embedded) scanHtml(content, depth + 1, state);
}

function addEvidence(state, candidate) {
  const parsedUrl = parseAttachmentUrl(candidate.url);
  // HEY renders remote inline images as unnamed Action Text attachments with
  // content-type="image". They remain in the body, not the downloadable list.
  // Keep named files, HEY blobs, and document URLs in the comparison.
  if (
    candidate.contentType === "image" && !candidate.filename &&
    parsedUrl.safe && parsedUrl.remote && !parsedUrl.blob &&
    /\.(?:png|jpe?g|gif|webp|svg|avif|ico)$/i.test(parsedUrl.filename ?? "")
  ) return;
  const filename = normalizedFilename(candidate.filename) ?? parsedUrl.filename;
  const explicitAttachment = Boolean(candidate.filename || candidate.contentType);
  if (!explicitAttachment && (!parsedUrl.blob || !filename)) return;

  const key = parsedUrl.key || (filename ? `filename:${filename}` : `anonymous:${state.evidence.size}`);
  if (state.evidence.has(key)) return;

  if (!parsedUrl.safe) state.unsafeEvidence += 1;
  state.evidence.set(key, { filename, safe: parsedUrl.safe });
}

function parseAttachmentUrl(value) {
  const raw = typeof value === "string" ? value.trim() : "";
  if (!raw || raw.length > 4096) {
    return { safe: false, blob: false, filename: null, key: raw ? `unsafe:${raw}` : "" };
  }

  let url;
  try {
    url = new URL(raw, "https://app.hey.com");
  } catch {
    return { safe: false, blob: false, filename: null, key: `unsafe:${raw}` };
  }
  const safe = url.protocol === "https:" && !url.username && !url.password;
  const pathname = url.pathname;
  const blob = HEY_BLOB_PATH.test(pathname);
  const basename = pathname.split("/").filter(Boolean).at(-1) ?? "";
  return {
    safe,
    blob,
    remote: url.origin !== "https://app.hey.com",
    filename: normalizedFilename(safeDecodeURIComponent(basename)),
    key: `${url.origin}${pathname}`.toLowerCase()
  };
}

function looksLikeHeyBlob(value) {
  if (typeof value !== "string" || !HEY_BLOB_PATH.test(value)) return false;
  const parsed = parseAttachmentUrl(value);
  return parsed.blob && Boolean(parsed.filename && FILE_EXTENSION.test(parsed.filename));
}

function normalizedFilename(value) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > 512 || /[\r\n\0]/.test(trimmed)) return null;
  return trimmed.normalize("NFKC").toLowerCase();
}

function safeDecodeURIComponent(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function attachmentSignal(value) {
  return /active_storage\/blobs|\/blobs\/(?:redirect|proxy)|application\/(?:pdf|zip)|officedocument|\.(?:pdf|docx?|xlsx?|pptx?|zip)(?:\b|[?#])/i.test(value);
}
