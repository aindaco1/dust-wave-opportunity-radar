import { describe, expect, it, vi } from "vitest";
import { auditRadar } from "../scripts/audit-dependencies";

function report(severity?: "moderate" | "high") {
  const counts = { info: 0, low: 0, moderate: 0, high: 0, critical: 0, total: severity ? 1 : 0 };
  if (severity) counts[severity] = 1;
  return { status: severity ? 1 : 0, stdout: JSON.stringify({ auditReportVersion: 2,
    vulnerabilities: severity ? { undici: { severity, isDirect: false } } : {},
    metadata: { vulnerabilities: counts } }) };
}

describe("Radar dependency audit", () => {
  it.each(["moderate", "high"] as const)("blocks %s transitive toolchain vulnerabilities", async severity => {
    const runCommandFn = vi.fn(() => report(severity));
    const result = await auditRadar({ runCommandFn, log: vi.fn() });
    expect(result.state).toBe("findings");
    const [command, args, limits] = runCommandFn.mock.calls[0]! as unknown as [string, string[], object];
    expect(command).toBe("npm");
    expect(args).toEqual(expect.arrayContaining(["--include=dev", "--include=optional", "--include=peer",
      "--package-lock-only", "--ignore-scripts", "--audit-level=moderate"]));
    expect(args).not.toContain("--omit=dev");
    expect(limits).toMatchObject({ timeoutMs: 45_000, killSignal: "SIGKILL" });
    expect(runCommandFn).toHaveBeenCalledTimes(1);
  });

  it("passes complete clean evidence but rejects empty or contradictory reports", async () => {
    expect((await auditRadar({ runCommandFn: () => report(), log: vi.fn() })).state).toBe("passed");
    for (const result of [{ status: 0, stdout: "" }, { ...report(), status: 1 }]) {
      expect((await auditRadar({ runCommandFn: () => result, log: vi.fn() })).state).toBe("incomplete");
    }
  });

  it("bounds transient audit retries without exposing raw transport diagnostics", async () => {
    const runCommandFn = vi.fn(() => ({ status: 1,
      stdout: JSON.stringify({ error: { code: "E503" } }), stderr: "private transport diagnostic" }));
    const sleepFn = vi.fn();
    const log = vi.fn();
    expect((await auditRadar({ runCommandFn, sleepFn, log })).state).toBe("incomplete");
    expect(runCommandFn).toHaveBeenCalledTimes(3);
    expect(sleepFn.mock.calls).toEqual([[5000], [10000]]);
    expect(JSON.stringify(log.mock.calls)).not.toContain("private transport diagnostic");
  });
});
