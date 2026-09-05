import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { execFile } from "node:child_process";
import { lstat, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { recoverHeyRecord, RecoveryError, validateMessageId } from "./hey-cli-recovery.mjs";

if (process.argv.slice(2).some((arg) => arg === "--help" || arg === "-h")) {
  console.log(`Usage: npm run recover:hey-cli

Recover one existing failed HEY topic whose raw payload has expired.
HEY_RECOVERY_MESSAGE_ID  Existing 64-character D1 message ID (required).
HEY_RECOVERY_MODE        preview (default) or import (explicitly authorized only).
HEY_CLI_BINARY           Path to the pinned, patched CLI (default: hey).
HEY_TOKEN               Temporary credential; no stored-login fallback.
CLOUDFLARE_API_TOKEN     D1 read access for the configured production database.
CLOUDFLARE_ACCOUNT_ID    Production Cloudflare account.
ADMIN_TOKEN             Existing import-endpoint credential (import mode only).

Preview downloads and validates historical content without production writes.
Import posts once, verifies D1, then repeats the guard to prove a no-write skip.
No mailbox scan, mailbox mutation, forced batch, deployment, or Notion write.
Output is one content-free JSON summary; exit 0 on success, 2 on failure.`);
  process.exit(0);
}

const exec = promisify(execFile);
const project = fileURLToPath(new URL("../", import.meta.url));
const workerUrl = "https://dustwave-opportunity-radar.jogo.workers.dev";
let root;
let client;
let transport;
let summary;
let writeAttempted = false;
process.umask(0o077);
try {
  if (process.argv.length !== 2) throw new RecoveryError("unexpected_arguments");
  const messageId = validateMessageId(process.env.HEY_RECOVERY_MESSAGE_ID);
  const mode = process.env.HEY_RECOVERY_MODE ?? "preview";
  if (!["preview", "import"].includes(mode)) throw new RecoveryError("invalid_recovery_mode");
  for (const key of ["HEY_TOKEN", "CLOUDFLARE_API_TOKEN", "CLOUDFLARE_ACCOUNT_ID", ...(mode === "import" ? ["ADMIN_TOKEN"] : [])]) {
    if (!process.env[key]) throw new RecoveryError("required_credential_missing");
  }
  root = await mkdtemp(path.join(tmpdir(), "radar-hey-recovery-"));
  await mkdir(path.join(root, "tmp"), { mode: 0o700 });
  const binary = process.env.HEY_CLI_BINARY ?? "hey";
  const heyEnv = {
    PATH: process.env.PATH ?? "", HEY_TOKEN: process.env.HEY_TOKEN,
    HEY_NO_KEYRING: "1", HEY_NONINTERACTIVE: "1", HEY_BASE_URL: "https://app.hey.com",
    XDG_CONFIG_HOME: path.join(root, "config"), XDG_STATE_HOME: path.join(root, "state"),
    XDG_CACHE_HOME: path.join(root, "cache"), TMPDIR: path.join(root, "tmp")
  };
  let fileNumber = 0;
  async function heyJson(args) {
    const result = await exec(binary, args, { cwd: root, env: heyEnv, maxBuffer: 8 * 1024 * 1024, timeout: 60_000 });
    // Warnings can signal a partial download/read; never print provider diagnostics.
    if (result.stderr.trim()) throw new RecoveryError("hey_command_warning");
    return JSON.parse(result.stdout);
  }
  const ports = {
    heyJson,
    async readRecord(id) {
      validateMessageId(id);
      const sql = `SELECT m.*, (SELECT COUNT(*) FROM messages x WHERE x.source=m.source AND x.external_id=m.external_id) AS identity_count FROM messages m WHERE m.id='${id}'`;
      const result = await exec(path.join(project, "node_modules/.bin/wrangler"), [
        "d1", "execute", "DB", "--remote", "--json", "--command", sql
      ], {
        cwd: project, maxBuffer: 1024 * 1024, timeout: 30_000,
        env: { PATH: process.env.PATH ?? "", CLOUDFLARE_API_TOKEN: process.env.CLOUDFLARE_API_TOKEN,
          CLOUDFLARE_ACCOUNT_ID: process.env.CLOUDFLARE_ACCOUNT_ID, CI: "true",
          WRANGLER_SEND_METRICS: "false", WRANGLER_WRITE_LOGS: "false",
          XDG_CONFIG_HOME: path.join(root, "wrangler-config"), XDG_CACHE_HOME: path.join(root, "wrangler-cache") }
      });
      const response = JSON.parse(result.stdout);
      if (response.length !== 1 || response[0]?.success !== true || !Array.isArray(response[0].results)
        || response[0].results.length > 1) throw new RecoveryError("database_read_failed");
      return response[0].results[0] ?? null;
    },
    async getMessage(id) {
      // The gateway's integer parameter must not round a source identity.
      if (!Number.isSafeInteger(Number(id))) throw new RecoveryError("unsafe_gateway_identity");
      if (!client) {
        transport = new StdioClientTransport({ command: binary, args: ["mcp", "--read-only", "--domains", "threads"],
          cwd: root, env: heyEnv, stderr: "pipe", maxBufferSize: 12 * 1024 * 1024 });
        transport.stderr?.resume();
        client = new Client({ name: "radar-historical-recovery", version: "1.0.0" });
        await client.connect(transport, { timeout: 30_000 });
      }
      const response = await client.callTool({ name: "hey_threads",
        arguments: { action: "get_message", params: { messageId: Number(id) } }
      }, undefined, { timeout: 60_000 });
      if (response.isError || !Array.isArray(response.content) || response.content.length !== 1
        || response.content[0].type !== "text" || Buffer.byteLength(response.content[0].text) > 8 * 1024 * 1024) {
        throw new RecoveryError("original_message_read_failed");
      }
      return JSON.parse(response.content[0].text);
    },
    async download(attachment) {
      // No source-provided filename ever becomes a filesystem path.
      const destination = path.join(root, `attachment-${++fileNumber}`);
      const result = await heyJson(["attachment", "save", attachment.id, "--output", destination, "--json"]);
      if (!result.ok || result.notice || result.data?.id !== attachment.id || result.data?.filename !== attachment.filename
        || result.data?.byte_size !== attachment.byte_size || result.data?.path !== destination) {
        throw new RecoveryError("download_receipt_mismatch");
      }
      const stat = await lstat(destination);
      if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0 || stat.size !== attachment.byte_size) {
        throw new RecoveryError("download_file_invalid");
      }
      const bytes = await readFile(destination);
      await rm(destination);
      return bytes;
    },
    async postImport(payload) {
      writeAttempted = true;
      const response = await fetch(`${workerUrl}/admin/import/hey`, {
        method: "POST", redirect: "error", signal: AbortSignal.timeout(60_000),
        headers: { Authorization: `Bearer ${process.env.ADMIN_TOKEN}`, "Content-Type": "application/json" },
        body: JSON.stringify(payload)
      });
      // Never retry an uncertain write; reconcile the existing D1 identity first.
      if (response.status !== 201) { await response.body?.cancel(); throw new RecoveryError("import_response_failed"); }
      const reader = response.body.getReader();
      let text = "";
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          text += Buffer.from(value).toString("utf8");
          if (Buffer.byteLength(text) > 4096) throw new RecoveryError("import_response_oversize");
        }
      } finally { await reader.cancel(); }
      return JSON.parse(text);
    }
  };
  summary = await recoverHeyRecord({ messageId, mode, ports });
  if (summary.imported === 1) {
    const repeated = await recoverHeyRecord({ messageId, mode, ports });
    if (repeated.decision !== "already_queued" || repeated.imported !== 0) throw new RecoveryError("repeat_guard_failed");
    summary = { ...summary, repeatImported: 0, repeatDecision: repeated.decision };
  }
} catch (error) {
  summary = { ok: false, decision: "stopped", diagnostic: error instanceof RecoveryError ? error.message : "operation_failed",
    writeAttempted, reconciliationRequired: writeAttempted };
} finally {
  let cleanupOk = true;
  await client?.close().catch(() => { cleanupOk = false; });
  await transport?.close().catch(() => { cleanupOk = false; });
  if (root) await rm(root, { recursive: true, force: true }).catch(() => { cleanupOk = false; });
  summary = { ...summary, temporaryStateRemoved: cleanupOk };
  if (!cleanupOk) summary.ok = false;
}
console.log(JSON.stringify(summary));
if (!summary.ok) process.exitCode = 2;
