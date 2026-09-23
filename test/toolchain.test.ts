import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
  allowScripts: Record<string, boolean>;
};
const lock = JSON.parse(readFileSync(new URL("../package-lock.json", import.meta.url), "utf8")) as {
  packages: Record<string, { version: string }>;
};

describe("locked toolchain compatibility", () => {
  it("generates the checked-in runtime types with the locked workerd version", () => {
    const declarations = readFileSync(new URL("../worker-configuration.d.ts", import.meta.url), "utf8");
    const generatedVersion = declarations.match(/^\/\/ Runtime types generated with workerd@(\S+) /m)?.[1];
    const runtime = lock.packages["node_modules/workerd"];
    expect(runtime).toBeDefined();
    expect(generatedVersion).toBe(runtime!.version);
  });

  it("allows the exact locked workerd installer needed by local runtime tests", () => {
    const runtime = lock.packages["node_modules/workerd"];
    expect(runtime).toBeDefined();
    expect(manifest.allowScripts[`workerd@${runtime!.version}`]).toBe(true);
  });

  it("does not retain stale or broad workerd installer allowances", () => {
    const runtime = lock.packages["node_modules/workerd"];
    expect(runtime).toBeDefined();
    const allowedInstallers = Object.entries(manifest.allowScripts)
      .filter(([name, allowed]) => allowed && (name === "workerd" || name.startsWith("workerd@")))
      .map(([name]) => name);
    expect(allowedInstallers).toEqual([`workerd@${runtime!.version}`]);
  });

  it("keeps the Vitest runner and coverage provider on the same version", () => {
    const runner = lock.packages["node_modules/vitest"];
    const coverage = lock.packages["node_modules/@vitest/coverage-v8"];
    expect(runner).toBeDefined();
    expect(coverage).toBeDefined();
    expect(coverage!.version).toBe(runner!.version);
  });
});
