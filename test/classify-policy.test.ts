import { describe, expect, it } from "vitest";
import {
  buildEvidencePacket,
  buildManualReviewClassification,
  enforceClassificationPolicy,
  mapRecoveryClassification,
  parseClassificationResponse
} from "../src/ai/classify";
import type { Classification } from "../src/types";

describe("classification policy", () => {
  it("holds low-confidence calls in the digest", () => {
    const result = enforceClassificationPolicy(baseClassification({ confidence: 0.7 }), 0.82);
    expect(result.decision).toBe("digest");
    expect(result.digestCategory).toBe("Possible Opportunities");
  });

  it("rejects only when all three target states are explicitly excluded", () => {
    const result = enforceClassificationPolicy(
      baseClassification({
        explicitlyExcludedStates: ["New Mexico", "Illinois", "Pennsylvania"]
      }),
      0.82
    );
    expect(result.decision).toBe("ignore");
  });

  it("keeps a call when at least one target state remains eligible", () => {
    const result = enforceClassificationPolicy(
      baseClassification({ explicitlyExcludedStates: ["Pennsylvania"] }),
      0.82
    );
    expect(result.decision).toBe("notion");
  });
});

describe("Workers AI classification response parsing", () => {
  it("parses Chat Completions content", () => {
    const expected = baseClassification();
    const result = parseClassificationResponse({
      choices: [{ message: { content: JSON.stringify(expected) } }]
    });
    expect(result).toEqual(expected);
  });

  it("unwraps the Workers AI JSON response envelope", () => {
    const expected = baseClassification();
    const result = parseClassificationResponse({
      choices: [{ message: { content: JSON.stringify({ response: expected }) } }]
    });
    expect(result).toEqual(expected);
  });

  it("parses legacy binding response strings", () => {
    const expected = baseClassification();
    expect(parseClassificationResponse({ response: JSON.stringify(expected) })).toEqual(expected);
  });
});

describe("exhausted AI classification", () => {
  it("sends the email to the human-review digest", () => {
    const result = buildManualReviewClassification({
      source: "zoho",
      mailbox: "Newsletter",
      externalId: "123",
      subject: "Community opportunities roundup",
      senderName: "American Film Association",
      senderEmail: "news@example.org",
      receivedAt: "2026-08-05T12:00:00Z",
      text: "Roundup content",
      urls: ["https://example.org/roundup"],
      attachments: [],
      warnings: []
    }, new Error("Workers AI returned empty classification content"));

    expect(result.decision).toBe("digest");
    expect(result.digestCategory).toBe("Possible Opportunities");
    expect(result.primaryUrl).toBe("https://example.org/roundup");
    expect(result.summary).toContain("Review the original ZOHO email");
  });
});

describe("classification recovery", () => {
  const message = {
    source: "zoho" as const,
    mailbox: "Newsletter",
    externalId: "123",
    subject: "Community digest",
    senderName: "American Film Association",
    senderEmail: "news@example.org",
    receivedAt: "2026-08-05T12:00:00Z",
    text: "A useful film masterclass roundup.",
    urls: [],
    attachments: [],
    warnings: []
  };

  it("turns a recovered non-call into a useful digest item", () => {
    const result = mapRecoveryClassification({
      decision: "digest",
      confidence: 0.9,
      title: "American Film Association Community Digest",
      organization: "American Film Association",
      summary: "A roundup of film masterclasses and community posts.",
      primaryUrl: "https://example.org/community",
      digestCategory: "Workshops & Training",
      rationale: "Useful film-industry training content."
    }, message);

    expect(result.decision).toBe("digest");
    expect(result.summary).toContain("film masterclasses");
    expect(result.summary).not.toContain("Automatic classification");
  });

  it("holds a recovered possible call for human review", () => {
    const result = mapRecoveryClassification({
      decision: "call",
      confidence: 0.7,
      title: "Possible film fellowship",
      organization: null,
      summary: "A possible application-based film fellowship.",
      primaryUrl: "https://example.org/fellowship",
      digestCategory: null,
      rationale: "The email mentions applications."
    }, message);

    expect(result.decision).toBe("digest");
    expect(result.digestCategory).toBe("Possible Opportunities");
  });

  it("compacts oversized tracking URLs before sending evidence to Workers AI", () => {
    const opaqueUrl = `https://email.example.org/c/${"x".repeat(1_200)}`;
    const packet = buildEvidencePacket({
      ...message,
      text: `Masterclass details [${opaqueUrl}]`,
      urls: [opaqueUrl, "https://example.org/community"]
    }, []);

    expect(packet).toContain("Masterclass details");
    expect(packet).toContain("https://example.org/community");
    expect(packet).not.toContain("x".repeat(1_200));
    expect(packet.length).toBeLessThan(10_000);
  });
});

function baseClassification(overrides: Partial<Classification> = {}): Classification {
  return {
    decision: "notion",
    confidence: 0.95,
    title: "Dustwave Film Grant",
    organization: "Example Foundation",
    summary: "A film grant.",
    bodyMarkdown: "## Overview\n\nA film grant.",
    primaryUrl: "https://example.org/grant?utm_source=email",
    applicationUrl: "https://example.org/apply",
    dueDate: "2026-10-01",
    applicationOpenStart: "2026-09-01",
    applicationOpenEnd: "2026-10-01",
    type: "Grant",
    tags: ["Film"],
    digestCategory: null,
    eligibleStates: ["New Mexico", "Illinois", "Pennsylvania"],
    explicitlyExcludedStates: [],
    evidence: ["Applications are open."],
    rationale: "A concrete application-based funding opportunity.",
    ...overrides
  };
}
