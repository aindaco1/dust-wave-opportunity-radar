import type { RuntimeConfig } from "../config";
import { getCheckpoint, setCheckpoint, upsertMessage } from "../storage/database";
import { parseDate, subtractDays, subtractHours } from "../util/dates";
import { sha256Hex } from "../util/crypto";
import { readBoundedBytes, readBoundedJson } from "../util/http";
import { logError, logInfo } from "../util/log";

interface ZohoAccount {
  accountId: string;
  primaryEmailAddress: string;
  mailboxAddress?: string;
  incomingUserName?: string;
  emailAddress?: Array<string | { mailId?: string }>;
}

interface ZohoFolder {
  folderId: string;
  folderName: string;
}

interface ZohoEmailSummary {
  messageId: string | number;
  folderId: string | number;
  subject?: string;
  sender?: string;
  fromAddress?: string;
  receivedTime?: string;
  sentDateInGMT?: string | number;
  summary?: string;
}

interface ZohoApiResponse<T> {
  data: T;
  status?: { code?: number; description?: string };
}

interface ZohoEndpoints {
  accounts: string;
  mail: string;
}

const DATA_CENTERS: Record<string, ZohoEndpoints> = {
  us: { accounts: "https://accounts.zoho.com/oauth/v2", mail: "https://mail.zoho.com/api" },
  eu: { accounts: "https://accounts.zoho.eu/oauth/v2", mail: "https://mail.zoho.eu/api" },
  in: { accounts: "https://accounts.zoho.in/oauth/v2", mail: "https://mail.zoho.in/api" },
  au: { accounts: "https://accounts.zoho.com.au/oauth/v2", mail: "https://mail.zoho.com.au/api" },
  jp: { accounts: "https://accounts.zoho.jp/oauth/v2", mail: "https://mail.zoho.jp/api" },
  ca: { accounts: "https://accounts.zohocloud.ca/oauth/v2", mail: "https://mail.zohocloud.ca/api" },
  sa: { accounts: "https://accounts.zoho.sa/oauth/v2", mail: "https://mail.zoho.sa/api" },
  uk: { accounts: "https://accounts.zoho.uk/oauth/v2", mail: "https://mail.zoho.uk/api" }
};

const MAX_RAW_BYTES = 26_214_400;

export interface ZohoSyncResult {
  folders: string[];
  fetched: number;
  ingested: number;
  failed: number;
  sampleErrors: string[];
  skipped: boolean;
}

export interface ZohoConnectionInspection {
  accountEmail: string;
  configuredFolders: string[];
  matchedFolders: string[];
}

interface ZohoConnection {
  mailBase: string;
  accessToken: string;
  account: ZohoAccount;
  selectedFolders: ZohoFolder[];
}

export async function inspectZohoConnection(env: Env, config: RuntimeConfig): Promise<ZohoConnectionInspection> {
  const connection = await connectZoho(env, config);
  return {
    accountEmail: connection.account.primaryEmailAddress || config.zohoAccountEmail,
    configuredFolders: [...config.zohoFolders],
    matchedFolders: connection.selectedFolders.map((folder) => folder.folderName)
  };
}

export async function syncZoho(env: Env, config: RuntimeConfig): Promise<ZohoSyncResult> {
  if (!config.zohoEnabled) {
    return { folders: [], fetched: 0, ingested: 0, failed: 0, sampleErrors: [], skipped: true };
  }
  const connection = await connectZoho(env, config);

  const result: ZohoSyncResult = {
    folders: connection.selectedFolders.map((folder) => folder.folderName),
    fetched: 0,
    ingested: 0,
    failed: 0,
    sampleErrors: [],
    skipped: false
  };

  for (const folder of connection.selectedFolders) {
    const folderResult = await syncZohoFolder(
      env,
      config,
      connection.mailBase,
      connection.accessToken,
      connection.account.accountId,
      folder
    );
    result.fetched += folderResult.fetched;
    result.ingested += folderResult.ingested;
    result.failed += folderResult.failed;
    for (const error of folderResult.sampleErrors) {
      if (result.sampleErrors.length < 5 && !result.sampleErrors.includes(error)) result.sampleErrors.push(error);
    }
  }
  logInfo("zoho_sync_completed", { ...result });
  return result;
}

async function connectZoho(env: Env, config: RuntimeConfig): Promise<ZohoConnection> {
  ensureZohoSecrets(env);
  const endpoints = DATA_CENTERS[config.zohoDatacenter];
  if (!endpoints) throw new Error(`Unsupported Zoho datacenter: ${config.zohoDatacenter}`);

  const accessToken = await refreshAccessToken(env, endpoints.accounts);
  const accounts = await zohoData<ZohoAccount[]>(endpoints.mail, "/accounts", accessToken);
  const account = accounts.find((candidate) =>
    accountEmailAddresses(candidate)
      .map((email) => email.toLowerCase())
      .includes(config.zohoAccountEmail)
  );
  if (!account) throw new Error(`Zoho account ${config.zohoAccountEmail} is not accessible to this OAuth client`);

  const folders = await zohoData<ZohoFolder[]>(
    endpoints.mail,
    `/accounts/${account.accountId}/folders`,
    accessToken
  );
  const requested = config.zohoFolders.map((name) => name.toLowerCase());
  const selectedFolders = folders.filter((folder) => requested.includes(folder.folderName.toLowerCase()));
  const missing = config.zohoFolders.filter(
    (name) => !selectedFolders.some((folder) => folder.folderName.toLowerCase() === name.toLowerCase())
  );
  if (missing.length) throw new Error(`Zoho folder(s) not found: ${missing.join(", ")}`);

  return { mailBase: endpoints.mail, accessToken, account, selectedFolders };
}

function accountEmailAddresses(account: ZohoAccount): string[] {
  return [
    account.primaryEmailAddress,
    account.mailboxAddress,
    account.incomingUserName,
    ...(account.emailAddress ?? []).map((address) => typeof address === "string" ? address : address.mailId)
  ].filter((address): address is string => typeof address === "string" && address.length > 0);
}

async function syncZohoFolder(
  env: Env,
  config: RuntimeConfig,
  mailBase: string,
  accessToken: string,
  accountId: string,
  folder: ZohoFolder
): Promise<{ fetched: number; ingested: number; failed: number; sampleErrors: string[] }> {
  const checkpoint = await getCheckpoint(env.DB, "zoho", folder.folderName);
  const now = new Date();
  const since = checkpoint
    ? subtractHours(parseDate(checkpoint, now), 1)
    : subtractDays(now, config.initialBackfillDays);
  let start = 1;
  let fetched = 0;
  let ingested = 0;
  let failed = 0;
  const sampleErrors: string[] = [];
  let newestSeen: Date | null = null;
  let retryFrom: Date | null = null;
  let reachedCutoff = false;

  while (!reachedCutoff && start <= 2_000) {
    const params = new URLSearchParams({
      folderId: folder.folderId,
      limit: "200",
      start: String(start),
      sortBy: "date",
      sortorder: "false"
    });
    const emails = await zohoData<ZohoEmailSummary[]>(
      mailBase,
      `/accounts/${accountId}/messages/view?${params}`,
      accessToken
    );
    if (!emails.length) break;

    fetched += emails.length;
    for (const email of emails) {
      const receivedAt = zohoDate(email.sentDateInGMT ?? email.receivedTime, now);
      if (receivedAt < since) {
        reachedCutoff = true;
        continue;
      }
      if (!newestSeen || receivedAt > newestSeen) newestSeen = receivedAt;

      try {
        const externalId = String(email.messageId);
        const raw = await fetchZohoRawMessage(mailBase, accessToken, accountId, folder.folderId, email);
        const id = await sha256Hex(`zoho:${externalId}`);
        const rawR2Key = `raw/zoho/${receivedAt.toISOString().slice(0, 10)}/${id}.eml`;
        await env.MAIL_BUCKET.put(rawR2Key, raw, {
          httpMetadata: { contentType: "message/rfc822" },
          customMetadata: {
            source: "zoho",
            externalId,
            receivedAt: receivedAt.toISOString(),
            folder: folder.folderName
          }
        });
        await upsertMessage(env.DB, {
          id,
          source: "zoho",
          externalId,
          mailbox: folder.folderName,
          subject: email.subject?.trim() || "(No subject)",
          senderName: email.sender?.trim(),
          senderEmail: email.fromAddress?.trim(),
          receivedAt: receivedAt.toISOString(),
          rawR2Key,
          rawSize: raw.byteLength
        });
        ingested += 1;
      } catch (error) {
        failed += 1;
        const detail = error instanceof Error ? error.message : String(error);
        if (sampleErrors.length < 3 && !sampleErrors.includes(detail)) sampleErrors.push(detail.slice(0, 500));
        if (!retryFrom || receivedAt < retryFrom) retryFrom = receivedAt;
        logError("zoho_message_ingest_failed", error, {
          messageId: email.messageId,
          folder: folder.folderName
        });
      }
    }

    if (emails.length < 200) break;
    start += emails.length;
  }

  const nextCheckpoint = retryFrom ?? newestSeen;
  if (nextCheckpoint) await setCheckpoint(env.DB, "zoho", folder.folderName, nextCheckpoint.toISOString());
  return { fetched, ingested, failed, sampleErrors };
}

async function fetchZohoRawMessage(
  mailBase: string,
  accessToken: string,
  accountId: string,
  folderId: string | number,
  email: ZohoEmailSummary
): Promise<ArrayBuffer> {
  const originalPath = `/accounts/${accountId}/messages/${email.messageId}/originalmessage`;
  const original = await zohoFetch(mailBase, originalPath, accessToken);
  if (original.ok) {
    const bytes = await readBoundedBytes(original, MAX_RAW_BYTES);
    const contentType = original.headers.get("content-type") ?? "";
    if (contentType.includes("application/json")) {
      const decoded = JSON.parse(new TextDecoder().decode(bytes)) as ZohoApiResponse<
        string | { content?: string }
      >;
      const mime = typeof decoded.data === "string" ? decoded.data : decoded.data?.content;
      if (mime) return new TextEncoder().encode(mime).buffer;
    } else {
      return new Uint8Array(bytes).buffer;
    }
  }

  if (!original.ok) await original.body?.cancel();
  const content = await zohoData<{ content?: string }>(
    mailBase,
    `/accounts/${accountId}/folders/${folderId}/messages/${email.messageId}/content`,
    accessToken
  );
  return new TextEncoder().encode(buildFallbackMime(email, content.content ?? email.summary ?? "")).buffer;
}

function buildFallbackMime(email: ZohoEmailSummary, html: string): string {
  const safe = (value: unknown) => String(value ?? "").replace(/[\r\n]+/g, " ");
  return [
    `Message-ID: <zoho-${safe(email.messageId)}@dustwave-opportunity-radar>`,
    `Subject: ${safe(email.subject)}`,
    `From: ${safe(email.sender)} <${safe(email.fromAddress)}>`,
    `Date: ${zohoDate(email.sentDateInGMT ?? email.receivedTime, new Date()).toUTCString()}`,
    "MIME-Version: 1.0",
    'Content-Type: text/html; charset="UTF-8"',
    "Content-Transfer-Encoding: 8bit",
    "",
    html
  ].join("\r\n");
}

async function refreshAccessToken(env: Env, accountsBase: string): Promise<string> {
  const params = new URLSearchParams({
    grant_type: "refresh_token",
    client_id: env.ZOHO_CLIENT_ID,
    client_secret: env.ZOHO_CLIENT_SECRET,
    refresh_token: env.ZOHO_REFRESH_TOKEN
  });
  const response = await fetch(`${accountsBase}/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: params.toString(),
    signal: AbortSignal.timeout(30_000)
  });
  const body = await boundedJson<{ access_token?: string; error?: string }>(response, 128_000);
  if (!response.ok || !body.access_token) {
    throw new Error(`Zoho OAuth refresh failed (${response.status}): ${body.error ?? "missing access token"}`);
  }
  return body.access_token;
}

async function zohoData<T>(mailBase: string, path: string, accessToken: string): Promise<T> {
  const response = await zohoFetch(mailBase, path, accessToken);
  const body = await boundedJson<ZohoApiResponse<T>>(response, 2_000_000);
  if (!response.ok) {
    throw new Error(`Zoho API ${path} failed (${response.status}): ${body.status?.description ?? "unknown error"}`);
  }
  return body.data;
}

async function zohoFetch(mailBase: string, path: string, accessToken: string): Promise<Response> {
  let lastResponse: Response | undefined;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const response = await fetch(`${mailBase}${path}`, {
      headers: { Authorization: `Zoho-oauthtoken ${accessToken}` },
      signal: AbortSignal.timeout(30_000)
    });
    lastResponse = response;
    if (response.status !== 429 && response.status < 500) return response;
    if (attempt === 3) return response;
    const retryAfter = Number(response.headers.get("retry-after") ?? 0);
    await response.body?.cancel();
    await delay(Math.max(retryAfter * 1_000, 500 * 2 ** attempt) + secureJitter(250));
  }
  if (!lastResponse) throw new Error("Zoho request failed without a response");
  return lastResponse;
}

async function boundedJson<T>(response: Response, maxBytes: number): Promise<T> {
  return readBoundedJson<T>(response, maxBytes);
}

function zohoDate(value: string | number | undefined, fallback: Date): Date {
  const text = value === undefined ? undefined : String(value);
  if (text && /^\d{10,13}$/.test(text)) {
    const numeric = Number(text);
    return new Date(text.length === 10 ? numeric * 1_000 : numeric);
  }
  return parseDate(text, fallback);
}

function ensureZohoSecrets(env: Env): void {
  if (!env.ZOHO_CLIENT_ID || !env.ZOHO_CLIENT_SECRET || !env.ZOHO_REFRESH_TOKEN) {
    throw new Error("Zoho is enabled but one or more OAuth secrets are missing");
  }
}

function secureJitter(maxExclusive: number): number {
  const bytes = new Uint32Array(1);
  crypto.getRandomValues(bytes);
  return (bytes[0] ?? 0) % maxExclusive;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
