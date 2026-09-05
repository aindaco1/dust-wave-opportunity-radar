import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const exec = promisify(execFile);
const script = fileURLToPath(new URL("../scripts/hey-cli-verify.mjs", import.meta.url));

async function runFixture(mode: string) {
  const root = await mkdtemp(path.join(tmpdir(), "radar-cli-test-"));
  try {
    const cacheParent = path.join(root, "tmp");
    await mkdir(cacheParent);
    // A synthetic executable tests the actual wrapper, including subprocess
    // errors and finally cleanup. It never invokes HEY or reads operator config.
    await writeFile(path.join(root, "hey"), `#!${process.execPath}
import {mkdirSync, writeFileSync} from "node:fs";
import path from "node:path";
const mode = process.env.FIXTURE_MODE;
const command = process.argv.slice(2).join(" ");
mkdirSync(process.env.XDG_CACHE_HOME, {recursive:true});
writeFileSync(path.join(process.env.XDG_CACHE_HOME, "synthetic-cache"), "PRIVATE_FIXTURE_CONTENT");
if (command.startsWith("doctor")) {
  console.log(JSON.stringify({ok:true,data:[{name:"Authentication",status:mode==="unauthenticated"?"error":"ok"}]}));
} else if (command === "version") {
  console.log(JSON.stringify({ok:true,data:{version:mode==="version"?"9.9.9":mode==="prerelease"?"1.4.1-radar-pr346":"1.4.1"}}));
} else if (command.startsWith("search")) {
  if (mode==="rejected") { console.error("PRIVATE_FIXTURE_CONTENT"); process.exit(1); }
  console.log(JSON.stringify({ok:true,data:mode==="empty"?[]:[{id:1001,topic_id:9001}]}));
} else if (command === "thread read 9001 --html") {
  if (mode==="partial") { console.error("PRIVATE_FIXTURE_CONTENT"); process.exit(1); }
  console.log(mode==="no_evidence"?"<p>PRIVATE_FIXTURE_CONTENT</p>":'<action-text-attachment filename="synthetic.pdf" content-type="application/pdf" url="https://app.hey.com/rails/active_storage/blobs/redirect/synthetic/synthetic.pdf"></action-text-attachment>');
} else if (command === "attachment list 9001 --json") {
  console.log(JSON.stringify({ok:true,data:mode==="missing"||mode==="no_evidence"?[]:[{filename:"synthetic.pdf"}]}));
} else { console.error("PRIVATE_FIXTURE_CONTENT"); process.exit(1); }
`, { mode: 0o700 });
    let stdout = "";
    let stderr = "";
    let code = 0;
    try {
      ({ stdout, stderr } = await exec(process.execPath, [script], {
        cwd: root,
        timeout: 15_000,
        // Wrangler adds required Worker bindings to ProcessEnv, but this
        // isolated child must not inherit them or any operator credentials.
        env: {
          PATH: root, TMPDIR: cacheParent, FIXTURE_MODE: mode,
          HEY_CLI_EXPECTED_VERSION: mode === "prerelease" ? "1.4.1-radar-pr346" : "1.4.1",
          XDG_CONFIG_HOME: root, XDG_STATE_HOME: root, HEY_NO_KEYRING: "1"
        } as unknown as NodeJS.ProcessEnv
      }));
    } catch (error) {
      const failure = error as { stdout: string; stderr: string; code: number };
      ({ stdout, stderr, code } = failure);
    }
    expect(stdout + stderr).not.toContain("PRIVATE_FIXTURE_CONTENT");
    expect(await readdir(cacheParent)).toEqual([]);
    const summary = JSON.parse(stdout);
    expect(summary.temporaryCacheRemoved).toBe(true);
    return { code, summary };
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

describe("HEY CLI verification process", () => {
  it("qualifies a nonempty complete sample and removes its cache", async () => {
    expect(await runFixture("complete")).toMatchObject({ code: 0, summary: { ok: true, checkedThreads: 1, evidenceCount: 1 } });
  });

  it("requires an explicitly matching version for a pinned patched build", async () => {
    expect(await runFixture("prerelease")).toMatchObject({ code: 0, summary: { ok: true, version: "1.4.1-radar-pr346" } });
  });

  it.each([
    ["empty", "no_threads_verified"],
    ["no_evidence", "no_attachment_evidence"],
    ["version", "unexpected_cli_version"],
    ["missing", "attachment_evidence_missing_from_cli"],
    ["partial", "thread_command_failed"]
  ])("fails closed on %s", async (mode, reason) => {
    expect(await runFixture(mode!)).toMatchObject({ code: 2, summary: { ok: false, reasons: { [reason!]: 1 } } });
  });

  it.each(["unauthenticated", "rejected"])("redacts and cleans up after %s authentication", async (mode) => {
    expect(await runFixture(mode)).toMatchObject({ code: 2, summary: { ok: false, diagnostic: "qualification_command_failed" } });
  });
});
