import type { RuntimeConfig } from "../../src/config";
import type { Classification, MessageRecord, ParsedMessage } from "../../src/types";

export function runtimeConfig(overrides: Partial<RuntimeConfig> = {}): RuntimeConfig {
  return {
    environment: "test",
    timezone: "America/Denver",
    batchHours: new Set([7, 19]),
    aiModel: "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
    aiConfidenceThreshold: 0.82,
    digestToEmail: "alonso@hey.com",
    digestFromEmail: "opportunities@digest.dustwave.xyz",
    digestFromName: "Dust Wave Opportunity Radar",
    notionEnabled: true,
    notionDataSourceId: "248a67e1-4d47-48f8-bc84-a9602ca91b78",
    zohoEnabled: true,
    creativeWestEnabled: true,
    zohoAccountEmail: "alonso@dustwave.xyz",
    zohoDatacenter: "us",
    zohoFolders: ["Inbox", "Dust Wave", "Newsletter", "Notification"],
    initialBackfillDays: 7,
    attachmentMaxBytes: 20_971_520,
    r2RetentionHours: 24,
    ...overrides
  };
}

export function classification(overrides: Partial<Classification> = {}): Classification {
  return {
    decision: "notion",
    confidence: 0.95,
    title: "Dust Wave Film Grant",
    organization: "Example Foundation",
    summary: "A film grant for independent artists.",
    bodyMarkdown: "## Overview\n\nA film grant for independent artists.",
    primaryUrl: "https://example.org/grant",
    applicationUrl: "https://example.org/apply",
    dueDate: "2026-10-01",
    applicationOpenStart: "2026-09-01",
    applicationOpenEnd: "2026-10-01",
    type: "Grant",
    tags: ["Film"],
    digestCategory: null,
    eligibleStates: ["New Mexico", "Illinois", "Pennsylvania"],
    explicitlyExcludedStates: [],
    evidence: ["Applications close October 1."],
    rationale: "A concrete application-based funding opportunity.",
    ...overrides
  };
}

export function messageRecord(overrides: Partial<MessageRecord> = {}): MessageRecord {
  return {
    id: "message-1",
    source: "zoho",
    external_id: "external-1",
    mailbox: "Dust Wave",
    subject: "Film grant applications open",
    sender_name: "Example Foundation",
    sender_email: "calls@example.org",
    received_at: "2026-08-05T12:00:00.000Z",
    raw_r2_key: "raw/zoho/2026-08-05/message-1.eml",
    parsed_r2_key: null,
    raw_size: 1024,
    status: "queued",
    classification_json: null,
    canonical_url: null,
    attempts: 0,
    last_error: null,
    created_at: "2026-08-05 12:00:00",
    updated_at: "2026-08-05 12:00:00",
    ...overrides
  };
}

export function parsedMessage(overrides: Partial<ParsedMessage> = {}): ParsedMessage {
  return {
    source: "zoho",
    mailbox: "Dust Wave",
    externalId: "external-1",
    subject: "Film grant applications open",
    senderName: "Example Foundation",
    senderEmail: "calls@example.org",
    receivedAt: "2026-08-05T12:00:00.000Z",
    text: "Applications are open for independent filmmakers.",
    urls: ["https://example.org/grant"],
    attachments: [],
    warnings: [],
    ...overrides
  };
}

export function env(overrides: Record<string, unknown> = {}): Env {
  return {
    ENVIRONMENT: "test",
    TIMEZONE: "America/Denver",
    BATCH_HOURS: "7,19",
    AI_MODEL: "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
    AI_CONFIDENCE_THRESHOLD: "0.82",
    DIGEST_TO_EMAIL: "alonso@hey.com",
    DIGEST_FROM_EMAIL: "opportunities@digest.dustwave.xyz",
    DIGEST_FROM_NAME: "Dust Wave Opportunity Radar",
    NOTION_ENABLED: "true",
    NOTION_DATA_SOURCE_ID: "248a67e1-4d47-48f8-bc84-a9602ca91b78",
    ZOHO_ENABLED: "true",
    CREATIVE_WEST_ENABLED: "true",
    ZOHO_ACCOUNT_EMAIL: "alonso@dustwave.xyz",
    ZOHO_DATACENTER: "us",
    ZOHO_FOLDERS: "Inbox,Dust Wave,Newsletter,Notification",
    INITIAL_BACKFILL_DAYS: "7",
    ATTACHMENT_MAX_BYTES: "20971520",
    R2_RETENTION_HOURS: "24",
    ADMIN_TOKEN: "test-admin-token",
    NOTION_TOKEN: "test-notion-token",
    ZOHO_CLIENT_ID: "test-client",
    ZOHO_CLIENT_SECRET: "test-client-secret",
    ZOHO_REFRESH_TOKEN: "test-refresh-token",
    ...overrides
  } as unknown as Env;
}
