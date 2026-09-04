import type { RuntimeConfig } from "../config";
import { htmlToText } from "../email/parse";
import { ingestPublicSnapshot } from "./public-snapshot";
import { sha256Hex } from "../util/crypto";
import { localBatchSlot } from "../util/dates";
import { readBoundedJson } from "../util/http";
import { logError, logInfo } from "../util/log";
import { isSafePublicUrl } from "./web-enrichment";

const CREATIVE_WEST_API = "https://opportunities-api.wearecreativewest.org/graphql";
const CREATIVE_WEST_PORTAL = "https://opportunities.wearecreativewest.org";
const DEADLINE_WINDOW_DAYS = 31;
const PAGE_SIZE = 40;
const MAX_PAGES = 25;
const MAX_RESPONSE_BYTES = 8_000_000;
const MAX_SOURCE_BODY_CHARACTERS = 200_000;

const SEARCH_QUERY = `
  query GetSearchOpportunities($input: SearchOpportunitiesInput!) {
    searchOpportunities(input: $input) {
      total
      items {
        id
        name
        applyUrl
        budget
        city
        source
        sourceUrl
        state
        status
        type
        rollingDeadline
        invitationOnly
        applicationDeadline
        eventEnd
        eventStart
        openDate
        intentDeadline
        juryStart
        juryEnd
        juryResults
        providerName
        providerEmail
        providerPhone
        providerWebsite
        eligibilityApplicantType
        eligibilityLocation
        emergingArtists
        applicationsAllowed
        description
        shortDescription
        requirementDescription
        eligibilityDescription
        boothInfo
        refundPolicy
        legalAgreement
        attachmentUrl
        originalTimezone
        fees {
          name
          value
          type
          currency
        }
      }
    }
  }
`;

interface CreativeWestOpportunity extends Record<string, unknown> {
  id: string;
  name: string;
  source: string;
}

interface CreativeWestSearchPage {
  total: number;
  items: unknown[];
}

interface CreativeWestGraphqlResponse {
  data?: { searchOpportunities?: CreativeWestSearchPage };
  errors?: Array<{ message?: string }>;
}

export interface CreativeWestSyncResult {
  deadlineFrom: string;
  deadlineTo: string;
  fetched: number;
  ingested: number;
  unchanged: number;
  failed: number;
  sampleErrors: string[];
  skipped: boolean;
}

export interface CreativeWestConnectionInspection {
  deadlineFrom: string;
  deadlineTo: string;
  matchingOpportunities: number;
  skipped: boolean;
}

export function creativeWestDeadlineRange(
  runAt: Date,
  timezone: string
): { from: string; to: string } {
  if (Number.isNaN(runAt.valueOf())) throw new Error("Creative West sync requires a valid run date");
  const from = localBatchSlot(runAt, timezone).dateLabel;
  const end = new Date(`${from}T12:00:00.000Z`);
  end.setUTCDate(end.getUTCDate() + DEADLINE_WINDOW_DAYS);
  return { from, to: end.toISOString().slice(0, 10) };
}

export async function inspectCreativeWestConnection(
  config: RuntimeConfig,
  runAt: Date
): Promise<CreativeWestConnectionInspection> {
  const range = creativeWestDeadlineRange(runAt, config.timezone);
  if (!config.creativeWestEnabled) {
    return {
      deadlineFrom: range.from,
      deadlineTo: range.to,
      matchingOpportunities: 0,
      skipped: true
    };
  }
  const page = await fetchCreativeWestPage(range.from, range.to, 1, 1);
  return {
    deadlineFrom: range.from,
    deadlineTo: range.to,
    matchingOpportunities: page.total,
    skipped: false
  };
}

export async function syncCreativeWest(
  env: Env,
  config: RuntimeConfig,
  runAt: Date
): Promise<CreativeWestSyncResult> {
  const range = creativeWestDeadlineRange(runAt, config.timezone);
  const result: CreativeWestSyncResult = {
    deadlineFrom: range.from,
    deadlineTo: range.to,
    fetched: 0,
    ingested: 0,
    unchanged: 0,
    failed: 0,
    sampleErrors: [],
    skipped: !config.creativeWestEnabled
  };
  if (!config.creativeWestEnabled) return result;

  for (let pageNumber = 1; pageNumber <= MAX_PAGES; pageNumber += 1) {
    const page = await fetchCreativeWestPage(range.from, range.to, pageNumber, PAGE_SIZE);
    result.fetched += page.items.length;
    for (let itemIndex = 0; itemIndex < page.items.length; itemIndex += 1) {
      try {
        const changed = await ingestCreativeWestOpportunity(env, page.items[itemIndex], runAt);
        if (changed) result.ingested += 1;
        else result.unchanged += 1;
      } catch (error) {
        result.failed += 1;
        const detail = error instanceof Error ? error.message : String(error);
        if (result.sampleErrors.length < 5 && !result.sampleErrors.includes(detail)) {
          result.sampleErrors.push(detail.slice(0, 500));
        }
        logError("creative_west_opportunity_ingest_failed", error, { page: pageNumber, itemIndex });
      }
    }

    if (result.fetched >= page.total || page.items.length < PAGE_SIZE) break;
    if (pageNumber === MAX_PAGES) {
      throw new Error(`Creative West search exceeded the ${MAX_PAGES * PAGE_SIZE} item safety cap`);
    }
  }

  logInfo("creative_west_sync_completed", { ...result, sampleErrors: result.sampleErrors.length });
  return result;
}

async function fetchCreativeWestPage(
  deadlineFrom: string,
  deadlineTo: string,
  page: number,
  limit: number
): Promise<CreativeWestSearchPage> {
  const response = await fetch(CREATIVE_WEST_API, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      "User-Agent": "DustwaveOpportunityRadar/0.1 (+https://dustwave.xyz)"
    },
    body: JSON.stringify({
      operationName: "GetSearchOpportunities",
      query: SEARCH_QUERY,
      variables: {
        input: {
          sort: { field: "OPEN_DATE", direction: "DESC" },
          states: ["NEW_MEXICO"],
          eligibilityApplicantType: ["ORGANIZATION", "ARTIST", "BOTH", "ALL"],
          applicationDeadline: { from: deadlineFrom, to: deadlineTo },
          status: ["OPEN"],
          pagination: { limit, page }
        }
      }
    }),
    signal: AbortSignal.timeout(30_000)
  });
  const body = await readBoundedJson<CreativeWestGraphqlResponse>(response, MAX_RESPONSE_BYTES);
  if (!response.ok) throw new Error(`Creative West API request failed (${response.status})`);
  if (body.errors?.length) throw new Error("Creative West API returned a GraphQL error");
  const search = body.data?.searchOpportunities;
  if (!search || !Number.isSafeInteger(search.total) || search.total < 0 || !Array.isArray(search.items)) {
    throw new Error("Creative West API returned an invalid search response");
  }
  return search;
}

async function ingestCreativeWestOpportunity(env: Env, value: unknown, runAt: Date): Promise<boolean> {
  const opportunity = parseOpportunity(value);
  const snapshotHash = await sha256Hex(JSON.stringify(opportunity));
  const externalId = `${opportunity.source}:${opportunity.id}:${snapshotHash}`;
  const receivedAt = runAt.toISOString();
  const result = await ingestPublicSnapshot(env, {
    source: "creative_west",
    externalId,
    namespace: "creative-west",
    mailbox: "New Mexico · Artist/Organization",
    subject: opportunity.name,
    senderName: cleanOptionalText(opportunity.providerName, 300),
    senderEmail: cleanOptionalText(opportunity.providerEmail, 320),
    receivedAt,
    mime: () => buildOpportunityMime(opportunity, receivedAt),
    customMetadata: { opportunityId: opportunity.id }
  });
  return result.ingested;
}

function parseOpportunity(value: unknown): CreativeWestOpportunity {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Creative West opportunity was not an object");
  }
  const opportunity = value as Record<string, unknown>;
  const id = requiredIdentifier(opportunity.id, "id", 100);
  const source = requiredIdentifier(opportunity.source, "source", 40);
  const name = requiredText(opportunity.name, "name", 998);
  return { ...opportunity, id, source, name };
}

function buildOpportunityMime(opportunity: CreativeWestOpportunity, receivedAt: string): string {
  const portalUrl = `${CREATIVE_WEST_PORTAL}/opportunity/${encodeURIComponent(opportunity.id)}/${encodeURIComponent(opportunity.source)}`;
  const sourceUrl = safePublicUrl(opportunity.sourceUrl) ?? portalUrl;
  const applyUrl = safePublicUrl(opportunity.applyUrl);
  const providerWebsite = safePublicUrl(opportunity.providerWebsite);
  const attachmentUrl = safePublicUrl(opportunity.attachmentUrl);
  const body = [
    "Creative West opportunity listing",
    "",
    `Title: ${opportunity.name}`,
    `Provider: ${plainValue(opportunity.providerName)}`,
    `Provider contact email: ${plainValue(opportunity.providerEmail)}`,
    `Provider contact phone: ${plainValue(opportunity.providerPhone)}`,
    `Official source URL: ${sourceUrl}`,
    `Creative West listing: ${portalUrl}`,
    applyUrl ? `Application URL: ${applyUrl}` : "",
    providerWebsite ? `Provider website: ${providerWebsite}` : "",
    attachmentUrl ? `Attachment URL: ${attachmentUrl}` : "",
    `Platform source: ${opportunity.source}`,
    `Opportunity type: ${plainValue(opportunity.type)}`,
    `Status: ${plainValue(opportunity.status)}`,
    `Location: ${[plainValue(opportunity.city), plainValue(opportunity.state)].filter(Boolean).join(", ")}`,
    `Eligible applicant types: ${plainValue(opportunity.eligibilityApplicantType)}`,
    `Location eligibility: ${plainValue(opportunity.eligibilityLocation)}`,
    `Open date: ${plainValue(opportunity.openDate)}`,
    `Application deadline: ${plainValue(opportunity.applicationDeadline)}`,
    `Rolling deadline: ${plainValue(opportunity.rollingDeadline)}`,
    `Intent deadline: ${plainValue(opportunity.intentDeadline)}`,
    `Event dates: ${plainValue(opportunity.eventStart)} to ${plainValue(opportunity.eventEnd)}`,
    `Jury dates: ${plainValue(opportunity.juryStart)} to ${plainValue(opportunity.juryEnd)}`,
    `Notification date: ${plainValue(opportunity.juryResults)}`,
    `Budget: ${plainValue(opportunity.budget)}`,
    `Fees: ${formatFees(opportunity.fees)}`,
    `Applications allowed: ${plainValue(opportunity.applicationsAllowed)}`,
    `Invitation only: ${plainValue(opportunity.invitationOnly)}`,
    `Emerging artists: ${plainValue(opportunity.emergingArtists)}`,
    `Original timezone: ${plainValue(opportunity.originalTimezone)}`,
    "",
    section("Opportunity summary", opportunity.shortDescription),
    section("Eligibility", opportunity.eligibilityDescription),
    section("Application requirements", opportunity.requirementDescription),
    section("General information", opportunity.description),
    section("Booth information", opportunity.boothInfo),
    section("Refund policy", opportunity.refundPolicy),
    section("Legal agreement", opportunity.legalAgreement)
  ]
    .filter(Boolean)
    .join("\n")
    .slice(0, MAX_SOURCE_BODY_CHARACTERS);
  const sender = quotedHeader(cleanOptionalText(opportunity.providerName, 300) ?? "Creative West");
  return [
    `Message-ID: <creative-west-${opportunity.source.toLowerCase()}-${opportunity.id}@dustwave-opportunity-radar>`,
    `Subject: ${cleanHeader(opportunity.name)}`,
    `From: ${sender} <opportunities@wearecreativewest.org>`,
    `Date: ${new Date(receivedAt).toUTCString()}`,
    "MIME-Version: 1.0",
    'Content-Type: text/plain; charset="UTF-8"',
    "Content-Transfer-Encoding: 8bit",
    "",
    body
  ].join("\r\n");
}

function section(label: string, value: unknown): string {
  if (typeof value !== "string" || !value.trim()) return "";
  return `\n## ${label}\n${htmlToText(value).slice(0, 50_000)}`;
}

function formatFees(value: unknown): string {
  if (!Array.isArray(value)) return plainValue(value);
  return value
    .map((fee) => {
      if (!fee || typeof fee !== "object") return plainValue(fee);
      const record = fee as Record<string, unknown>;
      return [plainValue(record.name), plainValue(record.value), plainValue(record.currency), plainValue(record.type)]
        .filter(Boolean)
        .join(" ");
    })
    .filter(Boolean)
    .join("; ");
}

function plainValue(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) return value.map(plainValue).filter(Boolean).join(", ");
  return "";
}

function safePublicUrl(value: unknown): string | null {
  if (typeof value !== "string") return null;
  try {
    const url = new URL(value);
    if (!isSafePublicUrl(url.toString())) return null;
    return url.toString();
  } catch {
    return null;
  }
}

function requiredIdentifier(value: unknown, field: string, maxLength: number): string {
  if (typeof value !== "string" || !new RegExp(`^[A-Za-z0-9_-]{1,${maxLength}}$`).test(value)) {
    throw new Error(`Creative West opportunity ${field} was invalid`);
  }
  return value;
}

function requiredText(value: unknown, field: string, maxLength: number): string {
  if (typeof value !== "string") throw new Error(`Creative West opportunity ${field} was invalid`);
  const cleaned = cleanHeader(value);
  if (!cleaned || cleaned.length > maxLength) throw new Error(`Creative West opportunity ${field} was invalid`);
  return cleaned;
}

function cleanOptionalText(value: unknown, maxLength: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const cleaned = cleanHeader(value).slice(0, maxLength);
  return cleaned || undefined;
}

function cleanHeader(value: string): string {
  return value.replace(/[\r\n\0]+/g, " ").trim();
}

function quotedHeader(value: string): string {
  return `"${value.replace(/(["\\])/g, "\\$1")}"`;
}
