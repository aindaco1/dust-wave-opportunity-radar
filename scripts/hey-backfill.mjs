import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { readFile, unlink } from "node:fs/promises";
import path from "node:path";
import { parseBackfillTargets } from "./hey-backfill-targets.mjs";

const workerUrl = requiredEnv("WORKER_URL").replace(/\/$/, "");
const adminToken = requiredEnv("ADMIN_TOKEN");
const mcpRoot = path.resolve(requiredEnv("HEY_MCP_ROOT"));
const days = positiveInteger(process.env.BACKFILL_DAYS ?? "7", "BACKFILL_DAYS", 31);
const cutoff = new Date(Date.now() - days * 86_400_000);
const folders = ["imbox", "feed", "paper_trail"];
const targets = parseBackfillTargets(process.env.HEY_BACKFILL_TARGETS_JSON);
const seen = new Set();
let imported = 0;
let skipped = 0;

const transport = new StdioClientTransport({
  command: process.env.BUN_BIN || "bun",
  args: ["run", path.join(mcpRoot, "src/index.ts")],
  cwd: mcpRoot,
  stderr: "inherit"
});
const client = new Client({ name: "dustwave-hey-backfill", version: "0.1.0" });

try {
  await client.connect(transport);
  if (targets.length) {
    for (const target of targets) await importThread(target.id, target.folder, {});
  } else {
    for (const folder of folders) await importFolder(folder);
  }
  console.log(JSON.stringify({
    imported,
    skipped,
    cutoff: cutoff.toISOString(),
    mode: targets.length ? "targeted" : "folders",
    targetCount: targets.length,
    folders: targets.length ? [...new Set(targets.map((target) => target.folder))] : folders
  }));
} finally {
  await client.close().catch(() => undefined);
}

async function importFolder(folder) {
  for (let page = 1; page <= 20; page += 1) {
    const listing = await callJson("hey_list_emails", {
      folder,
      limit: 100,
      page,
      force_refresh: true
    });
    const emails = Array.isArray(listing?.data) ? listing.data : [];
    if (!emails.length) return;

    let pageHasRecent = false;
    let pageAddedNew = false;
    for (const email of emails) {
      const id = String(email.topicId ?? email.id ?? "").trim();
      if (!id || seen.has(id)) continue;
      seen.add(id);
      pageAddedNew = true;

      const listedDate = parseDate(email.date);
      if (listedDate && listedDate < cutoff) {
        skipped += 1;
        continue;
      }
      pageHasRecent = true;
      await importThread(id, folder, email);
    }

    if (!pageAddedNew || (!pageHasRecent && emails.every((email) => parseDate(email.date)))) return;
  }
}

async function importThread(id, folder, summary) {
  const read = await callJson("hey_read_email", {
    id,
    format: "text",
    force_refresh: true,
    max_entries: 20
  });
  const detail = read?.data ?? read;
  const receivedAt = parseDate(detail?.date ?? summary?.date);
  if (!receivedAt || receivedAt < cutoff) {
    skipped += 1;
    return;
  }

  const attachments = await downloadAttachments(id, detail?.attachments);
  const raw = buildMime({
    id,
    subject: String(detail?.subject ?? summary?.subject ?? "(No subject)"),
    fromName: String(detail?.from ?? summary?.from ?? "Unknown"),
    fromEmail: String(detail?.fromEmail ?? summary?.fromEmail ?? "unknown@hey.com"),
    to: Array.isArray(detail?.to) ? detail.to.join(", ") : "alonso@hey.com",
    date: receivedAt,
    body: String(detail?.body ?? summary?.snippet ?? ""),
    attachments
  });

  const response = await fetch(`${workerUrl}/admin/import/hey`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${adminToken}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      externalId: `mcp-hey:${id}`,
      mailbox: heyMailboxName(folder),
      subject: String(detail?.subject ?? summary?.subject ?? "(No subject)"),
      senderName: String(detail?.from ?? summary?.from ?? ""),
      senderEmail: String(detail?.fromEmail ?? summary?.fromEmail ?? ""),
      receivedAt: receivedAt.toISOString(),
      rawBase64: raw.toString("base64")
    }),
    signal: AbortSignal.timeout(60_000)
  });
  if (!response.ok) throw new Error(`Worker import failed for HEY ${id} (${response.status}): ${await response.text()}`);
  imported += 1;
}

async function downloadAttachments(emailId, metadata) {
  if (!Array.isArray(metadata)) return [];
  const attachments = [];
  let total = 0;
  for (const item of metadata) {
    if (!item?.id || Number(item.size ?? 0) > 20 * 1024 * 1024) continue;
    try {
      const result = await callJson("hey_download_attachment", {
        email_id: emailId,
        attachment_id: item.id,
        save_path: "~/hey-backfill-attachments/"
      });
      const downloaded = result?.data ?? result;
      const localPath = downloaded?.local_path;
      if (!localPath) continue;
      const bytes = await readFile(localPath);
      await unlink(localPath).catch(() => undefined);
      total += bytes.byteLength;
      if (total > 20 * 1024 * 1024) break;
      attachments.push({
        filename: cleanHeader(downloaded.filename ?? item.filename ?? "attachment"),
        mime: cleanHeader(downloaded.mime ?? item.mime ?? "application/octet-stream"),
        bytes
      });
    } catch (error) {
      console.error(`Attachment ${item.id} on HEY ${emailId} was skipped: ${error instanceof Error ? error.message : error}`);
    }
  }
  return attachments;
}

function buildMime({ id, subject, fromName, fromEmail, to, date, body, attachments }) {
  const boundary = `dustwave-${id}-${Date.now()}`.replace(/[^a-zA-Z0-9-]/g, "");
  const headers = [
    `Message-ID: <mcp-hey-${cleanHeader(id)}@dustwave-opportunity-radar>`,
    `Subject: ${cleanHeader(subject)}`,
    `From: ${cleanHeader(fromName)} <${cleanHeader(fromEmail)}>`,
    `To: ${cleanHeader(to)}`,
    `Date: ${date.toUTCString()}`,
    "MIME-Version: 1.0"
  ];
  if (!attachments.length) {
    return Buffer.from([...headers, 'Content-Type: text/plain; charset="UTF-8"', "Content-Transfer-Encoding: 8bit", "", body].join("\r\n"));
  }
  const parts = [
    ...headers,
    `Content-Type: multipart/mixed; boundary="${boundary}"`,
    "",
    `--${boundary}`,
    'Content-Type: text/plain; charset="UTF-8"',
    "Content-Transfer-Encoding: 8bit",
    "",
    body
  ];
  for (const attachment of attachments) {
    parts.push(
      `--${boundary}`,
      `Content-Type: ${attachment.mime}; name="${attachment.filename.replace(/"/g, "")}"`,
      "Content-Transfer-Encoding: base64",
      `Content-Disposition: attachment; filename="${attachment.filename.replace(/"/g, "")}"`,
      "",
      wrapBase64(attachment.bytes.toString("base64"))
    );
  }
  parts.push(`--${boundary}--`, "");
  return Buffer.from(parts.join("\r\n"));
}

async function callJson(name, args) {
  const result = await client.callTool({ name, arguments: args });
  if (result.isError) throw new Error(textContent(result) || `${name} failed`);
  const text = textContent(result);
  if (!text) throw new Error(`${name} returned no JSON`);
  return JSON.parse(text);
}

function textContent(result) {
  return result.content?.filter((item) => item.type === "text").map((item) => item.text).join("\n") ?? "";
}

function parseDate(value) {
  if (!value) return null;
  const date = new Date(String(value));
  return Number.isNaN(date.getTime()) ? null : date;
}

function heyMailboxName(folder) {
  return folder === "paper_trail" ? "Paper Trail" : folder === "imbox" ? "Imbox" : "Feed";
}

function cleanHeader(value) {
  return String(value).replace(/[\r\n\0]+/g, " ").trim();
}

function wrapBase64(value) {
  return value.match(/.{1,76}/g)?.join("\r\n") ?? "";
}

function positiveInteger(value, name, maximum) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > maximum) throw new Error(`${name} must be an integer from 1 to ${maximum}`);
  return parsed;
}

function requiredEnv(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}
