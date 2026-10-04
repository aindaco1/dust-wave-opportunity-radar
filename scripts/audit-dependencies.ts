import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { auditDependencies } from "@dustwave/release-core/dependency-audit";

type AuditOptions = Parameters<typeof auditDependencies>[0];

const runCommand: AuditOptions["runCommandFn"] = (command, args, { cwd, timeoutMs, killSignal }) => {
  const result = spawnSync(command, args, {
    cwd, timeout: timeoutMs, killSignal, encoding: "utf8", maxBuffer: 16 * 1024 * 1024
  });
  return { ...result, stdout: result.stdout || "", stderr: result.stderr || "",
    timedOut: (result.error as NodeJS.ErrnoException | undefined)?.code === "ETIMEDOUT" };
};

export function auditRadar(options: Pick<AuditOptions, "runCommandFn" | "sleepFn" | "log"> = { runCommandFn: runCommand }) {
  return auditDependencies({
    cwd: fileURLToPath(new URL("../", import.meta.url)), scope: "full",
    label: "radar/full", minimumSeverity: "moderate", ...options
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  auditRadar().then(result => { process.exitCode = { passed: 0, findings: 1, incomplete: 2 }[result.state]; })
    .catch(() => { console.error("Dependency audit failed before producing a complete result."); process.exitCode = 2; });
}
