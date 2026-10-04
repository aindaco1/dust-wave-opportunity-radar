import { callCloudflareJev, type JevRequest } from "@dustwave/test-core/jev";
import { readBoundedJson } from "@dustwave/worker-core/response-body";
import { classifierModel, corpus } from "./jev-evaluation";

interface Credentials { accountId: string; token: string }

export function evaluationCredentials(
  environment: Readonly<Record<string, string | undefined>> = process.env
): Credentials {
  // Prefer a dedicated account-owned inference token over a deployment credential.
  // Never depend on the permissions or expiry of a personal Wrangler login.
  const accountId = environment.CLOUDFLARE_ACCOUNT_ID;
  const token = environment.CLOUDFLARE_AI_API_TOKEN ?? environment.CLOUDFLARE_API_TOKEN;
  if (!/^[a-fA-F0-9]{32}$/.test(accountId ?? "")) throw new Error("Set CLOUDFLARE_ACCOUNT_ID to select one evaluation account");
  if (typeof token !== "string" || !token.trim()) throw new Error("Set CLOUDFLARE_AI_API_TOKEN to an account-owned token with Workers AI Read and Edit permissions for live evaluation");
  return { accountId: accountId!, token };
}

export function cloudflareProviders(credentials: Credentials, fetchTarget: typeof fetch = globalThis.fetch) {
  const stats = { classifierAttempts: 0, judgeAttempts: 0, classifierInputTokens: 0, classifierOutputTokens: 0 };
  let stopped = false;
  const ai = { run: async (model: string, input: unknown) => {
    if (stopped || model !== classifierModel || stats.classifierAttempts >= corpus.cases.length * 2) {
      throw new Error("Classifier request budget or model boundary reached");
    }
    const body = JSON.stringify(input);
    if (Buffer.byteLength(body) > 32_000) throw new Error("Classifier input exceeds evaluation budget");
    stats.classifierAttempts++;
    const signal = AbortSignal.timeout(45_000);
    try {
      const response = await fetchTarget(`https://api.cloudflare.com/client/v4/accounts/${credentials.accountId}/ai/run/${classifierModel}`, {
        method: "POST", redirect: "manual", signal, body,
        headers: { Authorization: `Bearer ${credentials.token}`, "Content-Type": "application/json", "cf-aig-skip-cache": "true", "cf-aig-collect-log": "false" }
      });
      if (!response.ok) { await response.body?.cancel(); throw new Error("Classifier HTTP error"); }
      const raw = await readBoundedJson<{ success?: boolean; result?: { usage?: { prompt_tokens?: number; completion_tokens?: number } } }>(response, 1_000_000);
      signal.throwIfAborted();
      if (!raw || raw.success !== true || !raw.result) throw new Error("Invalid classifier response");
      const usage = raw.result.usage;
      for (const [target, value] of [["classifierInputTokens", usage?.prompt_tokens], ["classifierOutputTokens", usage?.completion_tokens]] as const) {
        if (Number.isSafeInteger(value) && value! >= 0) stats[target] += value!;
      }
      return raw.result;
    } catch {
      stopped = true; // Do not turn a transport failure into a second billable recovery call.
      throw new Error("Classifier request failed or returned invalid data; no network retry performed");
    }
  } } as unknown as Ai;
  const judge = async (request: JevRequest) => {
    if (stopped || stats.judgeAttempts >= corpus.cases.length * 3) throw new Error("Jev request budget reached");
    stats.judgeAttempts++;
    try { return await callCloudflareJev(request, { ...credentials, fetchTarget }); }
    catch { stopped = true; throw new Error("Jev request failed; no retry performed"); }
  };
  return { ai, judge, stats };
}
