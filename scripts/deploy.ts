import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFile, unlink, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { parse, printParseErrorCode, type ParseError } from "jsonc-parser";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const sourceConfigPath = join(projectRoot, "wrangler.jsonc");

export function createRoutineDeployConfig(config: Record<string, unknown>): Record<string, unknown> {
  const deployConfig = { ...config };
  Reflect.deleteProperty(deployConfig, "addresses");
  return deployConfig;
}

export function parseWranglerConfig(contents: string): Record<string, unknown> {
  const errors: ParseError[] = [];
  const parsed: unknown = parse(contents, errors, { allowTrailingComma: true });
  if (errors.length > 0) {
    const details = errors.map(({ error, offset }) => `${printParseErrorCode(error)} at offset ${offset}`).join(", ");
    throw new Error(`Unable to parse wrangler.jsonc: ${details}`);
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("wrangler.jsonc must contain a JSON object");
  }
  return parsed as Record<string, unknown>;
}

function runWrangler(configPath: string, args: string[]): Promise<number> {
  const executable = join(projectRoot, "node_modules", ".bin", process.platform === "win32" ? "wrangler.cmd" : "wrangler");
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(executable, ["deploy", "--config", configPath, ...args], {
      cwd: projectRoot,
      env: process.env,
      stdio: "inherit"
    });
    child.once("error", rejectRun);
    child.once("close", (code) => resolveRun(code ?? 1));
  });
}

async function main(): Promise<void> {
  const source = parseWranglerConfig(await readFile(sourceConfigPath, "utf8"));
  const configPath = join(projectRoot, `.wrangler-deploy-${randomUUID()}.json`);
  await writeFile(configPath, `${JSON.stringify(createRoutineDeployConfig(source), null, 2)}\n`, {
    encoding: "utf8",
    flag: "wx",
    mode: 0o600
  });

  try {
    process.exitCode = await runWrangler(configPath, process.argv.slice(2));
  } finally {
    await unlink(configPath);
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  await main();
}
