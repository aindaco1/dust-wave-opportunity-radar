import { afterEach, describe, expect, it, vi } from "vitest";
import {
  creativeWestDeadlineRange,
  inspectCreativeWestConnection,
  syncCreativeWest
} from "../src/ingest/creative-west";
import { parseStoredMessage } from "../src/email/parse";
import { getMessage } from "../src/storage/database";
import { env as baseEnv, runtimeConfig } from "./support/fixtures";
import { createTestDatabase, type TestDatabase } from "./support/d1";

const open: TestDatabase[] = [];

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  while (open.length) open.pop()?.close();
});

function setup() {
  const testDb = createTestDatabase();
  open.push(testDb);
  const objects = new Map<string, Uint8Array>();
  const bucket = {
    get: vi.fn(async (key: string) => {
      const value = objects.get(key);
      return value
        ? { arrayBuffer: async () => value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength) }
        : null;
    }),
    put: vi.fn(async (key: string, value: Uint8Array) => {
      objects.set(key, value);
      return null;
    }),
    delete: vi.fn(async (key: string) => {
      objects.delete(key);
    })
  };
  const env = baseEnv({ DB: testDb.db, MAIL_BUCKET: bucket });
  return { testDb, objects, bucket, env };
}

function opportunity(overrides: Record<string, unknown> = {}) {
  return {
    id: "12345",
    name: "Southwest Moving Image Open Call",
    source: "CAFE",
    sourceUrl: "https://example.org/opportunities/moving-image",
    applyUrl: "https://example.org/apply/moving-image",
    providerName: "Example Arts Council",
    providerEmail: "calls@example.org",
    providerWebsite: "https://example.org",
    status: "OPEN",
    state: "NEW_MEXICO",
    city: "Santa Fe",
    type: "COMPETITION",
    eligibilityApplicantType: ["ARTIST", "ORGANIZATION"],
    eligibilityLocation: "NATIONAL",
    openDate: "2026-08-01T06:00:00.000Z",
    applicationDeadline: "2026-08-30T05:59:59.000Z",
    shortDescription: "<p>Submit a completed moving-image work for jury selection.</p>",
    eligibilityDescription: "<p>Artists and organizations in the United States may apply.</p>",
    requirementDescription: "<p>Provide a work sample and project statement.</p>",
    description: "<p>A juried exhibition for independent moving-image artists.</p>",
    fees: [{ name: "Entry fee", value: 10, currency: "USD", type: "APPLICATION" }],
    ...overrides
  };
}

function searchResponse(items: unknown[], total = items.length): Response {
  return Response.json({ data: { searchOpportunities: { total, items } } });
}

describe("Creative West deadline window", () => {
  it("uses the radar's Mountain date through 31 calendar days later", () => {
    expect(creativeWestDeadlineRange(new Date("2026-08-05T00:30:00.000Z"), "America/Denver"))
      .toEqual({ from: "2026-08-04", to: "2026-09-04" });
    expect(creativeWestDeadlineRange(new Date("2026-12-15T14:00:00.000Z"), "America/Denver"))
      .toEqual({ from: "2026-12-15", to: "2027-01-15" });
    expect(() => creativeWestDeadlineRange(new Date("invalid"), "America/Denver")).toThrow("valid run date");
  });
});

describe("Creative West ingestion", () => {
  it("sends the URL's effective filters, stores MIME, and skips unchanged snapshots", async () => {
    const { env, testDb, bucket, objects } = setup();
    let current = opportunity();
    const fetchMock = vi.fn(async () => searchResponse([current]));
    vi.stubGlobal("fetch", fetchMock);
    const runAt = new Date("2026-08-10T13:00:00.000Z");

    await expect(syncCreativeWest(env, runtimeConfig(), runAt)).resolves.toMatchObject({
      deadlineFrom: "2026-08-10",
      deadlineTo: "2026-09-10",
      fetched: 1,
      ingested: 1,
      unchanged: 0,
      failed: 0,
      skipped: false
    });

    const [url, request] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://opportunities-api.wearecreativewest.org/graphql");
    const payload = JSON.parse(String(request.body));
    expect(payload.variables.input).toEqual({
      sort: { field: "OPEN_DATE", direction: "DESC" },
      states: ["NEW_MEXICO"],
      eligibilityApplicantType: ["ORGANIZATION", "ARTIST", "BOTH", "ALL"],
      applicationDeadline: { from: "2026-08-10", to: "2026-09-10" },
      status: ["OPEN"],
      pagination: { limit: 40, page: 1 }
    });

    const row = testDb.sqlite.prepare(
      "SELECT id, source, external_id, mailbox, subject, sender_name, received_at, raw_r2_key, status FROM messages"
    ).get() as Record<string, string>;
    expect(row).toMatchObject({
      source: "creative_west",
      mailbox: "New Mexico · Artist/Organization",
      subject: "Southwest Moving Image Open Call",
      sender_name: "Example Arts Council",
      received_at: "2026-08-10T13:00:00.000Z",
      status: "queued"
    });
    expect(row.external_id).toMatch(/^CAFE:12345:[a-f0-9]{64}$/);
    const raw = new TextDecoder().decode(objects.get(row.raw_r2_key!)!);
    expect(raw).toContain("Official source URL: https://example.org/opportunities/moving-image");
    expect(raw).toContain("Application URL: https://example.org/apply/moving-image");
    expect(raw).toContain("Submit a completed moving-image work for jury selection.");
    expect(raw).not.toContain("<p>");
    const stored = await getMessage(env.DB, row.id!);
    const parsed = await parseStoredMessage(env.MAIL_BUCKET, stored!, 20_971_520);
    expect(parsed).toMatchObject({
      source: "creative_west",
      subject: "Southwest Moving Image Open Call",
      senderName: "Example Arts Council"
    });
    expect(parsed.urls).toEqual(expect.arrayContaining([
      "https://example.org/opportunities/moving-image",
      "https://example.org/apply/moving-image"
    ]));

    await expect(syncCreativeWest(env, runtimeConfig(), runAt)).resolves.toMatchObject({
      fetched: 1,
      ingested: 0,
      unchanged: 1,
      failed: 0
    });
    expect(bucket.put).toHaveBeenCalledTimes(1);

    current = opportunity({ shortDescription: "<p>Updated application details.</p>" });
    await expect(syncCreativeWest(env, runtimeConfig(), runAt)).resolves.toMatchObject({
      fetched: 1,
      ingested: 1,
      unchanged: 0,
      failed: 0
    });
    expect(testDb.sqlite.prepare("SELECT COUNT(*) AS count FROM messages").get()).toEqual({ count: 2 });
    expect(bucket.put).toHaveBeenCalledTimes(2);
  });

  it("can inspect the filtered result count without ingesting", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => searchResponse([opportunity()], 6)));
    await expect(inspectCreativeWestConnection(runtimeConfig(), new Date("2026-08-10T13:00:00.000Z")))
      .resolves.toEqual({
        deadlineFrom: "2026-08-10",
        deadlineTo: "2026-09-10",
        matchingOpportunities: 6,
        skipped: false
      });
  });

  it("does no network or storage work when disabled", async () => {
    const { env, bucket } = setup();
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    await expect(syncCreativeWest(
      env,
      runtimeConfig({ creativeWestEnabled: false }),
      new Date("2026-08-10T13:00:00.000Z")
    )).resolves.toEqual({
      deadlineFrom: "2026-08-10",
      deadlineTo: "2026-09-10",
      fetched: 0,
      ingested: 0,
      unchanged: 0,
      failed: 0,
      sampleErrors: [],
      skipped: true
    });
    await expect(inspectCreativeWestConnection(
      runtimeConfig({ creativeWestEnabled: false }),
      new Date("2026-08-10T13:00:00.000Z")
    )).resolves.toMatchObject({ matchingOpportunities: 0, skipped: true });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(bucket.put).not.toHaveBeenCalled();
  });

  it("isolates malformed opportunities and fails explicitly on GraphQL errors", async () => {
    const { env } = setup();
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(searchResponse([{ ...opportunity(), id: "invalid id" }]))
      .mockResolvedValueOnce(Response.json({ errors: [{ message: "synthetic error" }] }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(syncCreativeWest(env, runtimeConfig(), new Date("2026-08-10T13:00:00.000Z")))
      .resolves.toMatchObject({ fetched: 1, ingested: 0, failed: 1, sampleErrors: [expect.stringContaining("id was invalid")] });
    await expect(inspectCreativeWestConnection(runtimeConfig(), new Date("2026-08-10T13:00:00.000Z")))
      .rejects.toThrow("GraphQL error");
  });
});
