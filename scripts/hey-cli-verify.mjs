import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import {
  extractHeyAttachmentList,
  extractHeySearchTopicIds,
  inspectHeyAttachmentFidelity
} from "./hey-cli-fidelity.mjs";

const execFileAsync = promisify(execFile);
const allowedBoxes = new Set(["imbox", "feed", "papertrail"]);
const allowedAttachmentKinds = new Set([
  "any", "images", "pdfs", "calendar_invites", "documents", "spreadsheets", "presentations", "media", "zip_files"
]);
const allowedDateRanges = new Set(["last_7_days", "last_30_days", "last_90_days", "year"]);

const box = allowedValue(process.env.HEY_CLI_BOX ?? "papertrail", "HEY_CLI_BOX", allowedBoxes);
const attachmentKind = allowedValue(process.env.HEY_CLI_ATTACHMENT_KIND ?? "pdfs", "HEY_CLI_ATTACHMENT_KIND", allowedAttachmentKinds);
const dateRange = allowedValue(process.env.HEY_CLI_DATE_RANGE ?? "last_7_days", "HEY_CLI_DATE_RANGE", allowedDateRanges);
const maxThreads = positiveInteger(process.env.HEY_CLI_MAX_THREADS ?? "50", "HEY_CLI_MAX_THREADS", 100);
const expectedVersion = versionValue(process.env.HEY_CLI_EXPECTED_VERSION ?? "1.4.1");
const cacheRoot = await mkdtemp(path.join(tmpdir(), "dustwave-hey-cli-"));

let summary;
try {
  summary = await verify();
} catch {
  summary = {
    ok: false,
    decision: "blocked",
    diagnostic: "qualification_command_failed",
    checkedThreads: 0,
    temporaryCacheRemoved: true
  };
} finally {
  await rm(cacheRoot, { recursive: true, force: true });
}

console.log(JSON.stringify({ ...summary, temporaryCacheRemoved: true }));
if (!summary.ok) process.exitCode = 2;

async function verify() {
  const doctor = await heyJson(["doctor", "--json"], "doctor");
  if (doctor.ok !== true || !Array.isArray(doctor.data)) throw new Error("doctor failed");
  // The CLI's top-level ok only means doctor ran, even without a login.
  const authentication = doctor.data.find((check) => check?.name === "Authentication");
  if (!authentication || authentication.status === "error") throw new Error("authentication unavailable");

  const versionResponse = await heyJson(["version"], "version");
  const version = typeof versionResponse?.data?.version === "string" ? versionResponse.data.version : "unknown";
  const versionMatches = version === expectedVersion;
  const search = await heyJson([
    "search", "--attachment", attachmentKind, "--date", dateRange, "--in", box, "--all", "--json"
  ], "search");
  const allTopicIds = extractHeySearchTopicIds(search);
  const truncated = allTopicIds.length > maxThreads;
  const topicIds = allTopicIds.slice(0, maxThreads);

  const totals = {
    checkedThreads: 0,
    completeThreads: 0,
    incompleteThreads: 0,
    evidenceCount: 0,
    listedCount: 0,
    missingEvidenceCount: 0,
    unsafeEvidenceCount: 0,
    malformedMetadataCount: 0,
    commandFailures: 0
  };
  const reasonCounts = new Map();

  for (const topicId of topicIds) {
    try {
      const html = await heyText(["thread", "read", topicId, "--html"], "thread_read", 16 * 1024 * 1024);
      const attachmentResponse = await heyJson([
        "attachment", "list", topicId, "--json"
      ], "attachment_list");
      const attachments = extractHeyAttachmentList(attachmentResponse);
      const result = inspectHeyAttachmentFidelity({ html, attachments });
      totals.checkedThreads += 1;
      totals.evidenceCount += result.evidenceCount;
      totals.listedCount += result.listedCount;
      totals.missingEvidenceCount += result.missingEvidenceCount;
      totals.unsafeEvidenceCount += result.unsafeEvidenceCount;
      totals.malformedMetadataCount += result.malformedMetadataCount;
      if (result.complete) totals.completeThreads += 1;
      else totals.incompleteThreads += 1;
      for (const reason of result.reasons) reasonCounts.set(reason, (reasonCounts.get(reason) ?? 0) + 1);
    } catch {
      totals.commandFailures += 1;
    }
  }

  if (truncated) reasonCounts.set("search_results_truncated", 1);
  if (!versionMatches) reasonCounts.set("unexpected_cli_version", 1);
  if (totals.commandFailures > 0) reasonCounts.set("thread_command_failed", totals.commandFailures);
  if (totals.checkedThreads === 0) reasonCounts.set("no_threads_verified", 1);
  if (totals.evidenceCount === 0) reasonCounts.set("no_attachment_evidence", 1);
  const ok = reasonCounts.size === 0;
  return {
    ok,
    decision: ok ? "qualified" : "blocked",
    version,
    expectedVersion,
    versionMatches,
    query: { box, attachmentKind, dateRange, maxThreads },
    matchedThreads: allTopicIds.length,
    ...totals,
    reasons: Object.fromEntries([...reasonCounts].sort(([left], [right]) => left.localeCompare(right)))
  };
}

async function heyJson(args, stage) {
  const text = await heyText(args, stage, 8 * 1024 * 1024);
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`${stage} returned invalid JSON`);
  }
}

async function heyText(args, stage, maxBuffer) {
  try {
    const { stdout } = await execFileAsync("hey", args, {
      encoding: "utf8",
      env: { ...process.env, XDG_CACHE_HOME: cacheRoot },
      maxBuffer,
      timeout: 60_000
    });
    return stdout;
  } catch {
    throw new Error(`${stage} failed`);
  }
}

function allowedValue(value, name, allowed) {
  if (!allowed.has(value)) throw new Error(`${name} has an unsupported value`);
  return value;
}

function positiveInteger(value, name, maximum) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > maximum) {
    throw new Error(`${name} must be an integer from 1 to ${maximum}`);
  }
  return parsed;
}

function versionValue(value) {
  if (value.length > 100 || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z]+(?:[.-][0-9A-Za-z]+)*)?$/.test(value)) {
    throw new Error("HEY_CLI_EXPECTED_VERSION must be an explicit release or prerelease version");
  }
  return value;
}
