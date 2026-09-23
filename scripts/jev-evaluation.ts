import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { z } from "zod";
import { evaluateJevCases, type JevCase, type JevReport, type JevRequest } from "@dustwave/test-core/jev";
import { buildEvidencePacket, classifyMessage } from "../src/ai/classify";
import { loadRuntimeConfig } from "../src/config";
import type { EnrichedPage } from "../src/ingest/web-enrichment";
import { classificationSchema, discoveryContextSchema, type Classification } from "../src/types";
import { parsedMessage } from "../test/support/fixtures";
import { parseWranglerConfig } from "./deploy";
import corpusJson from "../test/fixtures/jev-radar.json";

const radarCaseSchema = z.object({
  id: z.string().min(1), text: z.string().min(1), urls: z.array(z.string().url()),
  pageText: z.string().optional(), discoveryContext: discoveryContextSchema.optional(),
  expected: classificationSchema.partial(), requirements: z.record(z.string(), z.string().min(1)),
  control: z.object({ question: z.string(), good: z.string().min(1), bad: z.string().min(1) })
});
type RadarCase = z.infer<typeof radarCaseSchema>;

// No file argument, saved-output importer, production lookup or custom-source input.
export const corpus = z.object({
  policy: z.object({ minimumMargin: z.number().min(0).max(1), models: z.array(z.string()).min(1) }),
  cases: z.array(radarCaseSchema).min(1).max(12)
}).parse(corpusJson);
export const platformCommit = "816da7b52ed346025f5bbe3a7a420e9ad7c4a815";
const evaluationConfig = loadRuntimeConfig(parseWranglerConfig(
  readFileSync(new URL("../wrangler.jsonc", import.meta.url), "utf8")
).vars as Env);
export const classifierModel = evaluationConfig.aiModel;
const maxQuestions = 100;

export function prepareCase(item: RadarCase) {
  const message = parsedMessage({
    subject: item.id, externalId: item.id, asOfDate: "2026-09-23",
    receivedAt: "2026-09-23T12:00:00.000Z", text: item.text, urls: item.urls,
    discoveryContext: item.discoveryContext,
    source: item.discoveryContext ? "colossal" : "zoho"
  });
  const pages: EnrichedPage[] = item.pageText ? [{
    requestedUrl: item.urls[0]!, finalUrl: item.urls[0]!, title: "Official synthetic program",
    text: item.pageText
  }] : [];
  return { message, pages, reference: buildEvidencePacket(message, pages) };
}

export function exactFailures(value: Classification, expected: Partial<Classification>): string[] {
  return Object.entries(expected).flatMap(([key, wanted]) => {
    const actual = value[key as keyof Classification];
    const comparable = (v: unknown) => JSON.stringify(Array.isArray(v) ? [...v].sort() : v);
    return comparable(actual) === comparable(wanted) ? [] : [key];
  });
}

export function judgeFailures(report: JevReport, labels: Record<string, "pass" | "fail"> = {}): string[] {
  const failures = report.complete ? [] : ["incomplete"];
  for (const row of report.cases) {
    if (!row.result) failures.push(`${row.id}:missing`);
    for (const [key, finding] of Object.entries(row.result?.findings ?? {})) {
      if (finding.decision !== (labels[row.id] ?? "pass")) failures.push(`${row.id}:${key}:${finding.decision}`);
    }
  }
  return failures;
}

export interface RadarReport {
  schemaVersion: 1;
  mode: "live" | "preview";
  complete: boolean;
  passed: boolean;
  releaseAccepted: false;
  platformCommit: string;
  classifierModel: string;
  classifierConfidenceThreshold: number;
  corpusSha256: string;
  classifierSha256: string;
  startedAt: string;
  calibration?: JevReport;
  evaluation?: JevReport;
  calibrationFailures: string[];
  semanticFailures: string[];
  candidates: Array<{ id: string; source: string; output: Classification; exactFailures: string[] }>;
  error?: string;
}

// Dependency injection is for offline contract tests; the CLI always uses the fixed corpus.
export async function runRadarEvaluation(options: {
  ai?: Ai;
  judge?: (request: JevRequest) => Promise<unknown>;
  save?: (report: RadarReport) => Promise<void>;
} = {}): Promise<RadarReport> {
  if (Boolean(options.ai) !== Boolean(options.judge)) throw new Error("Both live providers are required");
  const save = options.save ?? (async () => {});
  const sha = (value: string) => createHash("sha256").update(value).digest("hex");
  const report: RadarReport = {
    schemaVersion: 1, mode: options.ai ? "live" : "preview", complete: false, passed: false,
    releaseAccepted: false, platformCommit, classifierModel,
    classifierConfidenceThreshold: evaluationConfig.aiConfidenceThreshold,
    corpusSha256: sha(JSON.stringify(corpus)),
    classifierSha256: sha(readFileSync(new URL("../src/ai/classify.ts", import.meta.url), "utf8")),
    startedAt: new Date().toISOString(), calibrationFailures: [], semanticFailures: [], candidates: []
  };
  const labels: Record<string, "pass" | "fail"> = {};
  const controls = corpus.cases.flatMap((item): JevCase[] => {
    const reference = prepareCase(item).reference;
    return (["good", "bad"] as const).map((variant) => {
      const id = `${item.id}-${variant}`;
      labels[id] = variant === "good" ? "pass" : "fail";
      return { id, reference, candidate: item.control[variant],
        requirements: { [item.control.question]: item.requirements[item.control.question]! } };
    });
  });
  // Preflight the complete fixed calibration batch before any calls.
  await evaluateJevCases(controls, { policy: corpus.policy, maxQuestions });
  await save(report);
  report.calibration = await evaluateJevCases(controls, {
    policy: corpus.policy, maxQuestions, call: options.judge,
    onProgress: async (partial) => { report.calibration = partial; await save(report); }
  });
  report.calibrationFailures = judgeFailures(report.calibration, labels);
  if (!options.ai || !options.judge || !report.calibration.complete) {
    await save(report);
    return report;
  }
  // Keep gathering candidate evidence on semantic disagreements. Transport errors stop the run.
  for (const item of corpus.cases) {
    const { message, pages, reference } = prepareCase(item);
    try {
      const output = classificationSchema.parse(await classifyMessage(options.ai, evaluationConfig, message, pages));
      report.candidates.push({ id: item.id, source: reference, output, exactFailures: exactFailures(output, item.expected) });
    } catch {
      report.error = `Classification incomplete for ${item.id}; see provider status, not source content`;
      await save(report);
      return report;
    }
    await save(report);
  }
  report.evaluation = await evaluateJevCases(report.candidates.map((row, index) => ({
    id: row.id, candidate: JSON.stringify(row.output), reference: row.source,
    requirements: corpus.cases[index]!.requirements
  })), {
    policy: corpus.policy, maxQuestions, call: options.judge,
    onProgress: async (partial) => { report.evaluation = partial; await save(report); }
  });
  report.semanticFailures = judgeFailures(report.evaluation);
  report.complete = report.evaluation.complete;
  report.passed = report.complete && !report.calibrationFailures.length && !report.semanticFailures.length
    && report.candidates.every((row) => !row.exactFailures.length);
  await save(report);
  return report;
}
