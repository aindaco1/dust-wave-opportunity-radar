import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

// Exercise the real CLI against loopback using invented credentials only.
// Never inherit operator credentials, config, account settings, or caches.
const exec = promisify(execFile);
const binary = process.env.HEY_CLI_TEST_BINARY || "hey";
const root = await mkdtemp(path.join(tmpdir(), "radar-hey-auth-"));
const samples = [];
let failure = false;
try {
  for (const scenario of ["valid_env", "missing", "rejected_env", "expired_stored", "rejected_refresh", "midrun_401"]) {
    samples.push(await runScenario(scenario));
  }
} catch {
  failure = true;
} finally {
  await rm(root, { recursive: true, force: true });
}
const ok = !failure && samples.length === 6 && samples.every((sample) => sample.passed);
console.log(JSON.stringify({ ok, scope: "synthetic_loopback_authentication", samples, temporaryDataRemoved: true }));
if (!ok) process.exitCode = 2;

async function runScenario(scenario) {
  const directory = path.join(root, scenario);
  const config = path.join(directory, "config", "hey-cli");
  await mkdir(config, { recursive: true, mode: 0o700 });
  let reads = 0;
  let refreshes = 0;
  let unexpectedRequests = 0;
  const server = createServer(async (request, response) => {
    response.setHeader("Content-Type", "application/json");
    if (request.method === "POST" && request.url === "/oauth/tokens") {
      refreshes++;
      let body = "";
      for await (const chunk of request) body += chunk;
      if (new URLSearchParams(body).get("refresh_token") !== "synthetic-refresh") unexpectedRequests++;
      if (scenario === "rejected_refresh") {
        response.writeHead(401).end('{"error":"invalid_grant"}');
      } else {
        response.end(JSON.stringify({ access_token: "synthetic-new-access", refresh_token: "synthetic-rotated-refresh", expires_in: 3600 }));
      }
    } else if (request.method === "GET" && request.url?.startsWith("/advanced_search.json")) {
      reads++;
      const authorized = request.headers.authorization === "Bearer synthetic-new-access"
        || (scenario === "valid_env" && request.headers.authorization === "Bearer synthetic-env-access");
      response.writeHead(authorized ? 200 : 401).end(authorized ? '{"matches":[]}' : '{"error":"unauthorized"}');
    } else {
      unexpectedRequests++;
      response.writeHead(404).end("{}");
    }
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  try {
    const origin = `http://127.0.0.1:${server.address().port}`;
    const credentialFile = path.join(config, "credentials.json");
    const stored = ["expired_stored", "rejected_refresh", "midrun_401"].includes(scenario);
    if (stored) {
      await writeFile(credentialFile, JSON.stringify({
        [origin]: {
          access_token: "synthetic-old-access", refresh_token: "synthetic-refresh", oauth_type: "oauth",
          expires_at: Math.floor(Date.now() / 1000) + (scenario === "midrun_401" ? 3600 : -600),
          token_endpoint: `${origin}/oauth/tokens`
        }
      }), { mode: 0o600 });
    }
    const env = {
      PATH: process.env.PATH, HEY_NO_KEYRING: "1", HEY_NONINTERACTIVE: "1",
      HEY_TOKEN: scenario === "valid_env" ? "synthetic-env-access" : scenario === "rejected_env" ? "synthetic-rejected-access" : "",
      XDG_CONFIG_HOME: path.join(directory, "config"), XDG_STATE_HOME: path.join(directory, "state"),
      XDG_CACHE_HOME: path.join(directory, "cache")
    };
    async function search(term) {
      try {
        const { stdout } = await exec(binary, ["search", term, "--json", "--base-url", origin], {
          cwd: directory, env, timeout: 15_000, maxBuffer: 1024 * 1024
        });
        const response = JSON.parse(stdout);
        return response.ok === true && Array.isArray(response.data);
      } catch {
        return false;
      }
    }
    const readSucceeded = await search("synthetic-first");
    let storedRotationVerified = null;
    let restartSucceeded = null;
    if (stored) {
      const saved = JSON.parse(await readFile(credentialFile, "utf8"))[origin];
      const expectedFailure = scenario === "rejected_refresh";
      storedRotationVerified = expectedFailure
        ? saved.access_token === "synthetic-old-access" && saved.refresh_token === "synthetic-refresh"
        : saved.access_token === "synthetic-new-access" && saved.refresh_token === "synthetic-rotated-refresh";
      storedRotationVerified &&= ((await stat(credentialFile)).mode & 0o077) === 0;
      if (!expectedFailure) restartSucceeded = await search("synthetic-second");
    }
    const expected = {
      valid_env: [true, 1, 0], missing: [false, 0, 0], rejected_env: [false, 1, 0],
      expired_stored: [true, 2, 1], rejected_refresh: [false, 0, 1], midrun_401: [true, 3, 1]
    }[scenario];
    const passed = readSucceeded === expected[0] && reads === expected[1] && refreshes === expected[2]
      && unexpectedRequests === 0 && storedRotationVerified !== false && restartSucceeded !== false;
    return { scenario, passed, readSucceeded, reads, refreshes, unexpectedRequests, storedRotationVerified, restartSucceeded };
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}
