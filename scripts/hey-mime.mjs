import { randomUUID } from "node:crypto";

// Shared by the legacy MCP backfill and the narrowly scoped official-CLI recovery.
export function buildMime({ id, subject, fromName, fromEmail, to, date, body, attachments }) {
  const boundary = `dustwave-${randomUUID()}`;
  const address = cleanHeader(fromEmail);
  const sender = /^[^\s<>@]+@[^\s<>@]+$/.test(address) ? address : "unknown@hey.com";
  const headers = [
    `Message-ID: <mcp-hey-${cleanHeader(id)}@dustwave-opportunity-radar>`,
    `Subject: ${encodedWords(subject)}`,
    `From: ${encodedWords(fromName)} <${sender}>`,
    `To: ${cleanHeader(to)}`,
    `Date: ${date.toUTCString()}`,
    "MIME-Version: 1.0"
  ];
  const textPart = [
    'Content-Type: text/plain; charset="UTF-8"',
    "Content-Transfer-Encoding: base64", "", wrapBase64(Buffer.from(body, "utf8").toString("base64"))
  ];
  if (!attachments.length) return Buffer.from([...headers, ...textPart].join("\r\n"));
  const parts = [...headers, `Content-Type: multipart/mixed; boundary="${boundary}"`, "", `--${boundary}`, ...textPart];
  for (const attachment of attachments) {
    const mime = /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/i.test(attachment.mime)
      ? attachment.mime : "application/octet-stream";
    const filename = filenameParameters(attachment.filename);
    parts.push(
      `--${boundary}`, `Content-Type: ${mime}`, "Content-Transfer-Encoding: base64",
      `Content-Disposition: attachment;\r\n ${filename}`, "", wrapBase64(attachment.bytes.toString("base64"))
    );
  }
  parts.push(`--${boundary}--`, "");
  return Buffer.from(parts.join("\r\n"));
}

function encodedWords(value) {
  const words = [];
  let chunk = "";
  for (const character of cleanHeader(value)) {
    if (Buffer.byteLength(chunk + character) > 39) {
      words.push(`=?UTF-8?B?${Buffer.from(chunk).toString("base64")}?=`);
      chunk = "";
    }
    chunk += character;
  }
  if (chunk) words.push(`=?UTF-8?B?${Buffer.from(chunk).toString("base64")}?=`);
  return words.join("\r\n ");
}

function cleanHeader(value) { return String(value ?? "").replace(/[\r\n\0]+/g, " ").trim(); }
function wrapBase64(value) { return value.match(/.{1,76}/g)?.join("\r\n") ?? ""; }

function filenameParameters(value) {
  const pieces = [];
  let piece = "";
  for (const character of cleanHeader(value)) {
    const encoded = encodeURIComponent(character).replace(/['()*]/g, (item) => `%${item.charCodeAt(0).toString(16).toUpperCase()}`);
    if (piece.length + encoded.length > 48) { pieces.push(piece); piece = ""; }
    piece += encoded;
  }
  pieces.push(piece);
  if (pieces.length === 1) return `filename*=UTF-8''${pieces[0]}`;
  return pieces.map((part, index) => `filename*${index}*=${index === 0 ? "UTF-8''" : ""}${part}`).join(";\r\n ");
}
