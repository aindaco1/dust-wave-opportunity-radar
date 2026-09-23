import { loadEnvFile } from "node:process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { it } from "vitest";
import { cloudflareProviders, evaluationCredentials } from "../scripts/jev-cloudflare";
import { runRadarEvaluation } from "../scripts/jev-evaluation";

it("checks Radar's real classifier with exact expectations and Jev", async () => {
  const preview = process.env.JEV_MODE === "preview";
  if (process.env.JEV_MODE && !preview) throw new Error("Only JEV_MODE=preview is supported; omit it for live evaluation");
  await mkdir(".jev-results", { recursive: true, mode: 0o700 });
  const directory = await mkdtemp(".jev-results/run-");
  console.log(`Jev evidence: ${directory}/report.json`);
  if (!preview && existsSync(".dev.vars")) loadEnvFile(".dev.vars");
  const providers = preview ? undefined : cloudflareProviders(evaluationCredentials());
  const report = await runRadarEvaluation({
    ai: providers?.ai, judge: providers?.judge,
    save: async (value) => {
      await writeFile(`${directory}/report.json`, JSON.stringify({ ...value, transport: providers?.stats }, null, 2) + "\n", { mode: 0o600 });
    }
  });
  if (preview) {
    console.log("Preview only: zero inference calls; classifier and semantic quality remain unevaluated.");
    return;
  }
  const exact = report.candidates.flatMap((row) => row.exactFailures.map((key) => `${row.id}:${key}`));
  console.log(JSON.stringify({ complete: report.complete, passed: report.passed,
    calibrationFailures: report.calibrationFailures, semanticFailures: report.semanticFailures, exactFailures: exact }));
  if (!report.passed) throw new Error(`Live evaluation needs attention. Review ${directory}/report.json`);
});
