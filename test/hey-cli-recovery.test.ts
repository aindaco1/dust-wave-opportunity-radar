import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { describe, expect, it, vi } from "vitest";
import PostalMime from "postal-mime";
import { zipSync, strToU8 } from "fflate";
import { recoverHeyRecord, RECOVERY_CLI_VERSION, validateMessageId, type RecoveryPorts, type RecoveryRecord } from "../scripts/hey-cli-recovery.mjs";
import { buildMime } from "../scripts/hey-mime.mjs";
import { ingestImportedHeyEmail, type ImportedHeyEmail } from "../src/ingest/email-worker";
import { parseStoredMessage } from "../src/email/parse";
import { env as baseEnv, messageRecord } from "./support/fixtures";
import { createTestDatabase } from "./support/d1";

const id = createHash("sha256").update("hey:mcp-hey:9001").digest("hex");
const pdf = Buffer.from("%PDF-1.4\nsynthetic attachment bytes");
function fixture() {
  let record: RecoveryRecord = { ...messageRecord({ id, source: "hey", external_id: "mcp-hey:9001", status: "failed",
    raw_r2_key: "", attempts: 3, last_error: "expired", created_at: "2026-08-06 12:00:00" }), identity_count: 1 };
  const entries = [1001, 1002, 1003, 1004].map((entryId) => ({ id: entryId, kind: "message", body_state: "hydrated", body: `Historical body ${entryId}` }));
  const originals = entries.map((entry, index) => ({ id: entry.id, content: "<p>Historical body</p>",
    created_at: index === 3 ? "2026-08-07T12:00:00Z" : "2026-08-05T12:00:00Z",
    updated_at: index === 3 ? "2026-08-07T12:00:00Z" : "2026-08-05T12:00:00Z" }));
  const attachments = [{ id: "1001:1", message_id: 1001, filename: "call.pdf", content_type: "application/pdf", byte_size: pdf.length },
    { id: "1004:1", message_id: 1004, filename: "newer.pdf", content_type: "application/pdf", byte_size: pdf.length }];
  originals[0]!.content = '<a href="https://app.hey.com/rails/active_storage/blobs/redirect/invented/call.pdf">Call</a>';
  const ports = {
    readRecord: vi.fn(async () => structuredClone(record)),
    heyJson: vi.fn(async (args: string[]) => args[0] === "version" ? { ok: true, data: { version: RECOVERY_CLI_VERSION } }
      : { ok: true, data: args[0] === "thread" ? entries : attachments }),
    getMessage: vi.fn(async (entryId: string) => originals.find((entry) => String(entry.id) === entryId)),
    download: vi.fn(async () => pdf),
    postImport: vi.fn(async (input: ImportedHeyEmail) => {
      record = { ...record, raw_r2_key: `raw/hey/2026-08-05/${id}.eml`, raw_size: Buffer.from(input.rawBase64, "base64").length,
        status: "queued", attempts: 0, last_error: null };
      return { accepted: true, id };
    })
  } satisfies RecoveryPorts;
  const run = (mode: "preview" | "import" = "import") => recoverHeyRecord({ messageId: id, mode, ports });
  return { record, entries, originals, attachments, ports, run };
}

describe("narrow HEY CLI historical recovery", () => {
  it("previews complete historical content without importing newer replies", async () => {
    const f = fixture();
    expect(await f.run("preview")).toMatchObject({ decision: "preview", imported: 0, selectedEntries: 3, excludedNewerEntries: 1, attachments: 1 });
    expect(f.ports.postImport).not.toHaveBeenCalled();
    expect(f.ports.download).toHaveBeenCalledOnce();
    expect(f.ports.download).toHaveBeenCalledWith(f.attachments[0]);
  });

  it("restores the same identity and repeats without downloading or posting again", async () => {
    const f = fixture();
    expect(await f.run()).toMatchObject({ decision: "recovered", imported: 1, identityCount: 1 });
    const input = f.ports.postImport.mock.calls[0]![0];
    expect(input).toMatchObject({ externalId: "mcp-hey:9001", subject: f.record.subject, mailbox: f.record.mailbox });
    const parsed = await PostalMime.parse(Buffer.from(input.rawBase64, "base64"));
    expect(parsed.messageId).toBe("<mcp-hey-9001@dustwave-opportunity-radar>");
    expect(parsed.text).toContain("Historical body 1003");
    expect(parsed.text).not.toContain("1004");
    expect(parsed.attachments).toHaveLength(1);
    expect(Buffer.from(parsed.attachments[0]!.content as ArrayBuffer)).toEqual(pdf);
    const calls = f.ports.heyJson.mock.calls.length;
    expect(await f.run()).toEqual({ ok: true, decision: "already_queued", imported: 0, identityCount: 1 });
    expect(f.ports.postImport).toHaveBeenCalledOnce();
    expect(f.ports.heyJson).toHaveBeenCalledTimes(calls);
  });

  it.each(["", "x", "A".repeat(64), "a".repeat(63), "'; DELETE FROM messages;--"]) ("rejects an invalid D1 ID before any operation", (value) => {
    expect(() => validateMessageId(value)).toThrow("invalid_message_id");
  });

  const invalid: [string, (f: ReturnType<typeof fixture>) => void, string][] = [
    ["forwarded identity", (f) => { f.record.external_id = "<original@example.org>"; }, "legacy_topic_identity_required"],
    ["wrong source", (f) => { f.record.source = "zoho"; }, "existing_hey_record_required"],
    ["wrong topic", (f) => { f.record.external_id = "mcp-hey:9002"; }, "identity_mismatch"],
    ["duplicate identity", (f) => { f.record.identity_count = 2; }, "identity_mismatch"],
    ["successful record", (f) => { f.record.status = "notion"; }, "failed_expired_record_required"],
    ["retained failed payload", (f) => { f.record.raw_r2_key = "raw/existing.eml"; }, "failed_expired_record_required"],
    ["nonzero queued attempts", (f) => { f.record.status = "queued"; f.record.raw_r2_key = "raw/a"; }, "failed_expired_record_required"],
    ["edited historical message", (f) => { f.originals[0]!.updated_at = "2026-08-07T00:00:00Z"; }, "historical_message_changed"],
    ["timezone-free timestamp", (f) => { f.originals[0]!.created_at = "2026-08-05T12:00"; }, "timestamp_requires_timezone"],
    ["invalid timestamp", (f) => { f.originals[0]!.created_at = "2026-88-99T12:00Z"; }, "invalid_timestamp"],
    ["duplicate entry", (f) => { f.entries[1]!.id = f.entries[0]!.id; }, "duplicate_entry_identity"],
    ["lossy entry ID", (f) => { f.entries[0]!.id = Number.MAX_SAFE_INTEGER + 1; }, "invalid_source_identity"],
    ["omitted body", (f) => { f.entries[0]!.body_state = "over_limit"; }, "unreadable_entry"],
    ["non-message entry", (f) => { f.entries[0]!.kind = "note"; }, "unreadable_entry"],
    ["empty body", (f) => { f.entries[0]!.body = ""; }, "empty_or_oversize_body"],
    ["no historical entries", (f) => { f.originals.forEach((m) => { m.created_at = "2026-08-07T12:00:00Z"; }); }, "no_historical_entries"],
    ["missing attachment", (f) => { f.attachments.shift(); }, "attachment_evidence_incomplete"],
    ["unknown owner", (f) => { f.attachments[0]!.message_id = 9999; }, "attachment_identity_mismatch"],
    ["wrong attachment ID", (f) => { f.attachments[0]!.id = "1002:1"; }, "attachment_identity_mismatch"],
    ["duplicate attachment", (f) => { f.attachments.push(f.attachments[0]!); }, "duplicate_attachment_identity"],
    ["missing size", (f) => { f.attachments[0]!.byte_size = NaN; }, "attachment_size_unknown"],
    ["oversize attachment", (f) => { f.attachments[0]!.byte_size = 21 * 1024 * 1024; }, "attachment_budget_exceeded"],
    ["filename injection", (f) => { f.attachments[0]!.filename += "\r\nBcc: evil@example.org"; f.originals[0]!.content = "<p>body</p>"; }, "invalid_attachment_filename"],
    ["download length mismatch", (f) => { f.ports.download.mockResolvedValue(Buffer.from("short")); }, "attachment_download_mismatch"],
    ["HTML returned as PDF", (f) => { f.ports.download.mockResolvedValue(Buffer.alloc(pdf.length, 65)); }, "invalid_pdf_download"],
    ["unqualified CLI", (f) => { f.ports.heyJson.mockResolvedValueOnce({ ok: true, data: { version: "1.4.1" } }); }, "unqualified_cli_version"],
    ["partial thread", (f) => { f.ports.heyJson.mockImplementation(async () => ({ ok: true, data: { version: RECOVERY_CLI_VERSION } })); }, "incomplete_thread"],
    ["missing message", (f) => { f.ports.getMessage.mockResolvedValue(undefined); }, "invalid_source_identity"],
    ["database changed", (f) => { f.ports.readRecord.mockResolvedValueOnce(structuredClone(f.record)).mockResolvedValue({ ...f.record, attempts: 4 }); }, "target_changed_during_recovery"]
  ];
  it.each(invalid)("stops before import for %s", async (_name, change, error) => {
    const f = fixture(); change(f);
    await expect(f.run()).rejects.toThrow(error);
    expect(f.ports.postImport).not.toHaveBeenCalled();
  });

  it("rejects a missing database row", async () => {
    const f = fixture();
    await expect(recoverHeyRecord({ messageId: id, mode: "import", ports: { ...f.ports, readRecord: async () => null } }))
      .rejects.toThrow("existing_hey_record_required");
    expect(f.ports.postImport).not.toHaveBeenCalled();
  });

  it("accepts attachment-free content only when the original HTML also has no evidence", async () => {
    const f = fixture(); f.attachments.splice(0); f.originals[0]!.content = "<p>No files</p>";
    expect(await f.run()).toMatchObject({ imported: 1, attachments: 0 });
    expect(f.ports.download).not.toHaveBeenCalled();
  });

  it("compares timezone-aware instants at the original-import cutoff", async () => {
    const f = fixture();
    f.originals[0]!.created_at = f.originals[0]!.updated_at = "2026-08-06T06:00:00-06:00";
    expect(await f.run()).toMatchObject({ selectedEntries: 3 });
  });

  it("never retries an uncertain write", async () => {
    const f = fixture(); f.ports.postImport.mockRejectedValue(new Error("network failed"));
    await expect(f.run()).rejects.toThrow("network failed");
    expect(f.ports.postImport).toHaveBeenCalledOnce();
  });

  it("requires the expected receipt and verified post-import state", async () => {
    const f = fixture(); f.ports.postImport.mockResolvedValue({ accepted: true, id: "wrong" });
    await expect(f.run()).rejects.toThrow("unexpected_import_response");
    f.ports.postImport.mockResolvedValue({ accepted: true, id });
    await expect(f.run()).rejects.toThrow("post_import_state_not_verified");
  });
});

describe("shared historical MIME", () => {
  it("round-trips long Unicode headers, text, filenames and binary attachments", async () => {
    const subject = "🎥 Convocatoria artística — ".repeat(20);
    const bytes = Buffer.from([0, 255, 13, 10, 200, 129]);
    const mime = buildMime({ id: "9001", subject, fromName: "Organización artística", fromEmail: "calls@example.org",
      to: "receiver@example.org", date: new Date("2026-08-05T12:00:00Z"), body: "Apply — café 🎥\n--dustwave-fake-boundary", attachments: [
        { filename: "応募 ".repeat(90) + "'Film' (2026).pdf", mime: "application/pdf", bytes },
        { filename: "../escape\r\nX-Evil: header.txt", mime: "text/plain\r\nBcc: evil@example.org", bytes }
      ] });
    const parsed = await PostalMime.parse(mime);
    expect(parsed.subject).toBe(subject.trim());
    expect(parsed.from).toMatchObject({ name: "Organización artística", address: "calls@example.org" });
    expect(parsed.text).toContain("Apply — café 🎥");
    expect(parsed.attachments[0]!.filename).toBe("応募 ".repeat(90) + "'Film' (2026).pdf");
    expect(mime.toString("utf8").split("\r\n").every((line) => Buffer.byteLength(line) <= 998)).toBe(true);
    for (const attachment of parsed.attachments) expect(Buffer.from(attachment.content as ArrayBuffer)).toEqual(bytes);
    expect(parsed.attachments[1]!.mimeType).toBe("application/octet-stream");
    expect(parsed.headers.some((header) => ["bcc", "x-evil"].includes(header.key))).toBe(false);
  });

  it("round-trips attachment-free text and sanitizes untrusted headers", async () => {
    const parsed = await PostalMime.parse(buildMime({ id: "9001", subject: "Call\r\nBcc: bad@example.org", fromName: "", fromEmail: "not an address",
      to: "receiver@example.org", date: new Date("2026-08-05T12:00:00Z"), body: "Hello — café", attachments: [] }));
    expect(parsed.from?.address).toBe("unknown@hey.com");
    expect(parsed.text?.trim()).toBe("Hello — café");
    expect(parsed.attachments).toEqual([]);
    expect(parsed.headers.some((header) => header.key === "bcc")).toBe(false);
  });
});

describe("production importer seam", () => {
  it("restores one real D1/R2 identity, parses DOCX, and leaves downstream tables alone", async () => {
    const f = fixture();
    const db = createTestDatabase();
    const objects = new Map<string, Uint8Array>();
    const bucket = {
      put: vi.fn(async (key: string, bytes: Uint8Array) => { objects.set(key, bytes); }),
      delete: vi.fn(async (key: string) => { objects.delete(key); }),
      get: async (key: string) => objects.has(key) ? { arrayBuffer: async () => objects.get(key)!.slice().buffer } : null
    };
    const env = baseEnv({ DB: db.db, MAIL_BUCKET: bucket });
    const docx = Buffer.from(zipSync({ "[Content_Types].xml": strToU8("<Types/>"),
      "word/document.xml": strToU8("<w:document><w:body><w:p><w:r><w:t>Synthetic application deadline September 15</w:t></w:r></w:p></w:body></w:document>") }));
    f.attachments[0] = { ...f.attachments[0]!, filename: "application.docx", content_type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", byte_size: docx.length };
    f.originals[0]!.content = '<a href="https://app.hey.com/rails/active_storage/blobs/redirect/invented/application.docx">Apply</a>';
    f.ports.download.mockResolvedValue(docx);
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    try {
      await ingestImportedHeyEmail({ externalId: "mcp-hey:9001", mailbox: f.record.mailbox, subject: f.record.subject,
        senderName: f.record.sender_name!, senderEmail: f.record.sender_email!, receivedAt: f.record.received_at, rawBase64: Buffer.from("old expired payload").toString("base64") }, env);
      objects.clear(); bucket.put.mockClear();
      db.sqlite.prepare("UPDATE messages SET status='failed', raw_r2_key='', attempts=3, last_error='expired', created_at='2026-08-06 12:00:00', classification_json=? WHERE id=?")
        .run('{"preserved":"classification"}', id);
      const ports: RecoveryPorts = { ...f.ports,
        readRecord: async () => db.sqlite.prepare("SELECT *, 1 AS identity_count FROM messages WHERE id=?").get(id) as unknown as RecoveryRecord,
        postImport: async (input) => ({ accepted: true, ...await ingestImportedHeyEmail(input, env) }) };
      expect(await recoverHeyRecord({ messageId: id, mode: "import", ports })).toMatchObject({ imported: 1, attachments: 1 });
      const restored = await ports.readRecord(id);
      expect(restored).toMatchObject({ id, status: "queued", attempts: 0, classification_json: '{"preserved":"classification"}' });
      const parsed = await parseStoredMessage(env.MAIL_BUCKET, restored!, 20_971_520);
      expect(parsed.text).toContain("Historical body 1003");
      expect(parsed.text).not.toContain("Historical body 1004");
      expect(parsed.attachments[0]?.text).toContain("Synthetic application deadline September 15");
      expect(parsed.warnings).toEqual([]);
      expect(await recoverHeyRecord({ messageId: id, mode: "import", ports })).toMatchObject({ decision: "already_queued", imported: 0 });
      expect(bucket.put).toHaveBeenCalledOnce(); expect(objects.size).toBe(1);
      expect(db.sqlite.prepare("SELECT COUNT(*) AS count FROM messages").get()).toEqual({ count: 1 });
      for (const table of ["opportunities", "digest_items"]) expect(db.sqlite.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get()).toEqual({ count: 0 });
    } finally { db.close(); log.mockRestore(); }
  });
});

describe("recovery command boundary", () => {
  it("explains safe defaults without credentials", async () => {
    const result = await promisify(execFile)(process.execPath, ["scripts/hey-cli-recover.mjs", "--help"], { env: { PATH: process.env.PATH } as unknown as NodeJS.ProcessEnv });
    expect(result.stdout).toContain("preview (default)");
    expect(result.stdout).toContain("No mailbox scan");
    expect(result.stderr).toBe("");
  });

  it("emits only a static failure summary for invalid input", async () => {
    const result = await promisify(execFile)(process.execPath, ["scripts/hey-cli-recover.mjs"], {
      env: { PATH: process.env.PATH, HEY_RECOVERY_MESSAGE_ID: "private-input-must-not-appear" } as unknown as NodeJS.ProcessEnv
    }).catch((error: { code: number; stdout: string; stderr: string }) => error);
    expect(result.stdout).not.toContain("private-input"); expect(result.stderr).toBe("");
    expect(JSON.parse(result.stdout)).toMatchObject({ ok: false, diagnostic: "invalid_message_id", writeAttempted: false, temporaryStateRemoved: true });
  });
});
