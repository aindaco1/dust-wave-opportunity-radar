import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import type { JevRequest } from "@dustwave/test-core/jev";
import { corpus, exactFailures, prepareCase, runRadarEvaluation } from "../scripts/jev-evaluation";
import { cloudflareProviders, evaluationCredentials } from "../scripts/jev-cloudflare";
import { classification } from "./support/fixtures";

function judgeResponse(request: JevRequest, decision: "pass" | "fail" | "uncertain" = "pass", model = "jev-1.13.0") {
  return { model, usage: { input_tokens: 100, output_tokens: 10 },
    answers: Object.fromEntries(Object.keys(request.input.questions).map((key) => [key, {
      type: "choice", choice: decision,
      probabilities: { pass: decision === "pass" ? 0.98 : 0.01, fail: decision === "fail" ? 0.98 : 0.01, uncertain: decision === "uncertain" ? 0.98 : 0.01 }
    }])) };
}

function mockProviders() {
  let index = 0;
  const run = vi.fn(async () => {
    const item = corpus.cases[index++]!;
    return { ...classification({ title: item.id, primaryUrl: item.urls[0] ?? null, ...item.expected }),
      applicationOpenStartEvidence: item.expected.applicationOpenStart ? item.text : null };
  });
  const judge = vi.fn(async (request: JevRequest) => judgeResponse(request,
    corpus.cases.some((item) => item.control.bad === request.input.state.candidate) ? "fail" : "pass"));
  return { ai: { run } as unknown as Ai, judge, run };
}

describe("Radar Jev evaluation", () => {
  it("previews only fixed synthetic cases without claiming a live pass", async () => {
    const report = await runRadarEvaluation();
    expect(report).toMatchObject({ mode: "preview", complete: false, passed: false, releaseAccepted: false });
    expect(report.calibration?.networkAttempts).toBe(0);
    expect(report.calibration?.cases).toHaveLength(corpus.cases.length * 2);
    expect(report.candidates).toEqual([]);
    for (const row of report.calibration!.cases) {
      expect(row.request.input.state.reference).toContain("2026-09-23");
      expect(Object.keys(row.request.input.questions)).toHaveLength(1);
    }
  });

  it("calls the real classifier and combines exact, calibration and semantic results", async () => {
    const providers = mockProviders();
    const report = await runRadarEvaluation(providers);
    expect(report).toMatchObject({ mode: "live", complete: true, passed: true, releaseAccepted: false });
    expect(providers.run).toHaveBeenCalledTimes(corpus.cases.length);
    expect(providers.judge).toHaveBeenCalledTimes(corpus.cases.length * 3);
    const input = providers.run.mock.calls[0] as unknown as [string, { messages: Array<{ content: string }> }];
    expect(input[1].messages[0]?.content).toContain("DECISIONS:");
    expect(input[1].messages[1]?.content).toContain(corpus.cases[0]!.text);
    expect(report.corpusSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(report.classifierSha256).toMatch(/^[a-f0-9]{64}$/);
  });

  it("an always-pass judge fails the negative controls", async () => {
    const providers = mockProviders();
    const report = await runRadarEvaluation({ ...providers, judge: async (request) => judgeResponse(request) });
    expect(report.complete).toBe(true);
    expect(report.passed).toBe(false);
    expect(report.calibrationFailures).toHaveLength(corpus.cases.length);
  });

  it.each(["uncertain", "unknown-model"])("does not accept %s judgments", async (kind) => {
    const providers = mockProviders();
    const report = await runRadarEvaluation({ ...providers,
      judge: async (request) => judgeResponse(request, kind === "uncertain" ? "uncertain" : "pass", kind === "unknown-model" ? "new-version" : "jev-1.13.0")
    });
    expect(report.complete).toBe(true);
    expect(report.passed).toBe(false);
    expect(report.semanticFailures.every((failure) => failure.endsWith(":review"))).toBe(true);
  });

  it("an exact deadline regression fails even when Jev passes", async () => {
    const providers = mockProviders();
    const classify = providers.run.getMockImplementation()!;
    providers.run.mockImplementationOnce(async () => ({ ...await classify(), dueDate: "2026-10-01" }));
    const report = await runRadarEvaluation(providers);
    expect(report.semanticFailures).toEqual([]);
    expect(report.candidates[0]?.exactFailures).toEqual(["dueDate"]);
    expect(report.passed).toBe(false);
  });

  it("semantic failure blocks the result even when exact fields pass", async () => {
    const providers = mockProviders();
    const report = await runRadarEvaluation({ ...providers, judge: async (request) => {
      if (request.input.state.candidate.startsWith("{")) return judgeResponse(request, "fail");
      return providers.judge(request);
    } });
    expect(report.candidates.every((row) => row.exactFailures.length === 0)).toBe(true);
    expect(report.semanticFailures.length).toBeGreaterThan(0);
    expect(report.passed).toBe(false);
  });

  it("independently catches invented opening dates in otherwise correct classifier output", () => {
    const candidate = classification({ dueDate: "2026-11-15", applicationOpenStart: "2026-09-23" });
    expect(exactFailures(candidate, corpus.cases[0]!.expected)).toEqual(["applicationOpenStart"]);
  });

  it("stops on incomplete judge evidence without classifying or leaking provider errors", async () => {
    const providers = mockProviders();
    const report = await runRadarEvaluation({ ...providers, judge: async () => { throw new Error("sensitive provider diagnostic"); } });
    expect(report.passed).toBe(false);
    expect(report.complete).toBe(false);
    expect(providers.run).not.toHaveBeenCalled();
    expect(JSON.stringify(report)).not.toContain("sensitive provider diagnostic");
  });

  it("keeps classification exhaustion incomplete and source errors out of the report", async () => {
    const providers = mockProviders();
    providers.run.mockRejectedValue(new Error("private error"));
    const report = await runRadarEvaluation(providers);
    expect(report).toMatchObject({ complete: false, passed: false });
    expect(report.error).toContain("Classification incomplete");
    expect(JSON.stringify(report)).not.toContain("private error");
  });

  it("compares set-valued exact fields without treating order as a regression", () => {
    expect(exactFailures(classification(), { eligibleStates: ["Pennsylvania", "Illinois", "New Mexico"] })).toEqual([]);
    expect(exactFailures(classification(), { decision: "ignore" })).toEqual(["decision"]);
    const pageCase = corpus.cases.find((item) => item.pageText)!;
    expect(prepareCase(pageCase).reference).toContain(pageCase.pageText);
  });

  it("keeps default checks live and names offline hosted checks explicitly", () => {
    const pkg = JSON.parse(readFileSync("package.json", "utf8"));
    expect(pkg.scripts.check).toBe("npm run check:offline && npm run test:jev");
    expect(pkg.scripts["check:offline"]).not.toContain("test:jev");
    expect(readFileSync(".github/workflows/ci.yml", "utf8")).toContain("npm run check:offline");
  });
});

describe("evaluation Cloudflare adapter", () => {
  const credentials = { accountId: "a".repeat(32), token: "synthetic-token" };

  it("uses explicit credentials or an unambiguous existing login without printing them", () => {
    const auth = vi.fn((args: string[]) => args[0] === "whoami" ? { accounts: [{ id: credentials.accountId }] } : { token: credentials.token });
    expect(evaluationCredentials({}, auth)).toEqual(credentials);
    auth.mockClear();
    expect(evaluationCredentials({ CLOUDFLARE_ACCOUNT_ID: credentials.accountId, CLOUDFLARE_API_TOKEN: credentials.token }, auth)).toEqual(credentials);
    expect(auth).not.toHaveBeenCalled();
    expect(() => evaluationCredentials({ CI: "true" }, auth)).toThrow("requires Cloudflare");
    expect(() => evaluationCredentials({}, () => ({ accounts: [{ id: "a" }, { id: "b" }] }))).toThrow("select one");
  });

  it("bounds classifier transport and rejects redirects without retry or provider-body leakage", async () => {
    const fetchTarget = vi.fn(async () => new Response("sensitive provider body", { status: 302, headers: { location: "https://untrusted.example.org" } }));
    const providers = cloudflareProviders(credentials, fetchTarget as typeof fetch);
    const { message, pages } = prepareCase(corpus.cases[0]!);
    const { classifyMessage } = await import("../src/ai/classify");
    const { runtimeConfig } = await import("./support/fixtures");
    await expect(classifyMessage(providers.ai, runtimeConfig(), message, pages)).rejects.toThrow("no network retry");
    expect(fetchTarget).toHaveBeenCalledTimes(1);
    const call = fetchTarget.mock.calls[0] as unknown as [string, RequestInit];
    expect(call[0]).toContain("https://api.cloudflare.com/client/v4/accounts/");
    expect(call[1]).toMatchObject({ redirect: "manual", headers: { "cf-aig-collect-log": "false" } });
    expect(call[1].signal).toBeInstanceOf(AbortSignal);
  });

  it("records classifier usage and permits the existing schema-recovery pass", async () => {
    const fetchTarget = vi.fn(async () => Response.json({ success: true, result: { response: "{}", usage: { prompt_tokens: 32, completion_tokens: 2 } } }));
    const providers = cloudflareProviders(credentials, fetchTarget as typeof fetch);
    const { message, pages } = prepareCase(corpus.cases[0]!);
    const { classifyMessage } = await import("../src/ai/classify");
    const { runtimeConfig } = await import("./support/fixtures");
    await expect(classifyMessage(providers.ai, runtimeConfig(), message, pages)).rejects.toThrow("both failed");
    expect(providers.stats).toMatchObject({ classifierAttempts: 2, classifierInputTokens: 64, classifierOutputTokens: 4 });
  });

  it("rejects oversized classifier responses and stops subsequent network calls", async () => {
    const fetchTarget = vi.fn(async () => new Response("x".repeat(1_000_001)));
    const providers = cloudflareProviders(credentials, fetchTarget as typeof fetch);
    const request = (await runRadarEvaluation()).calibration!.cases[0]!.request;
    await expect(providers.ai.run("@cf/meta/llama-3.3-70b-instruct-fp8-fast", { messages: [] })).rejects.toThrow("no network retry");
    await expect(providers.judge(request)).rejects.toThrow("budget");
    expect(fetchTarget).toHaveBeenCalledTimes(1);
  });
});
