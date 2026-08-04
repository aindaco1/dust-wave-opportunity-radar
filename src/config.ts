import type { MessageSource } from "./types";

export interface RuntimeConfig {
  environment: string;
  timezone: string;
  batchHours: ReadonlySet<number>;
  aiModel: string;
  aiConfidenceThreshold: number;
  digestToEmail: string;
  digestFromEmail: string;
  digestFromName: string;
  notionEnabled: boolean;
  notionDataSourceId: string;
  zohoEnabled: boolean;
  zohoAccountEmail: string;
  zohoDatacenter: string;
  zohoFolders: string[];
  initialBackfillDays: number;
  attachmentMaxBytes: number;
  r2RetentionHours: number;
}

export function loadRuntimeConfig(env: Env): RuntimeConfig {
  return {
    environment: env.ENVIRONMENT,
    timezone: env.TIMEZONE,
    batchHours: new Set(parseCsvIntegers(env.BATCH_HOURS, 0, 23)),
    aiModel: env.AI_MODEL,
    aiConfidenceThreshold: numberInRange(env.AI_CONFIDENCE_THRESHOLD, 0, 1),
    digestToEmail: env.DIGEST_TO_EMAIL,
    digestFromEmail: env.DIGEST_FROM_EMAIL,
    digestFromName: env.DIGEST_FROM_NAME,
    notionEnabled: String(env.NOTION_ENABLED) === "true",
    notionDataSourceId: env.NOTION_DATA_SOURCE_ID,
    zohoEnabled: String(env.ZOHO_ENABLED) === "true",
    zohoAccountEmail: env.ZOHO_ACCOUNT_EMAIL.toLowerCase(),
    zohoDatacenter: env.ZOHO_DATACENTER.toLowerCase(),
    zohoFolders: parseCsv(env.ZOHO_FOLDERS),
    initialBackfillDays: positiveInteger(env.INITIAL_BACKFILL_DAYS),
    attachmentMaxBytes: positiveInteger(env.ATTACHMENT_MAX_BYTES),
    r2RetentionHours: positiveInteger(env.R2_RETENTION_HOURS)
  };
}

export function sourceLabel(source: MessageSource, mailbox: string): string {
  return source === "hey" ? `HEY · ${mailbox}` : `Zoho · ${mailbox}`;
}

function parseCsv(value: string): string[] {
  return value
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
}

function parseCsvIntegers(value: string, min: number, max: number): number[] {
  const parsed = parseCsv(value).map((part) => Number(part));
  if (!parsed.length || parsed.some((item) => !Number.isSafeInteger(item) || item < min || item > max)) {
    throw new Error(`Expected comma-separated integers between ${min} and ${max}`);
  }
  return parsed;
}

function positiveInteger(value: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) throw new Error(`Expected a positive integer, received ${value}`);
  return parsed;
}

function numberInRange(value: string, min: number, max: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < min || parsed > max) {
    throw new Error(`Expected a number between ${min} and ${max}, received ${value}`);
  }
  return parsed;
}
