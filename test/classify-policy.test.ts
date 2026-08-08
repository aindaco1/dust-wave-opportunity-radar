import { describe, expect, it, vi } from "vitest";
import {
  buildEvidencePacket,
  buildManualReviewClassification,
  classifyMessage,
  enforceClassificationPolicy,
  mapRecoveryClassification,
  parseClassificationResponse,
  parseRecoveryClassification
} from "../src/ai/classify";
import type { Classification } from "../src/types";
import { parsedMessage, runtimeConfig } from "./support/fixtures";

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

  it("demotes a call without an official source URL", () => {
    const result = enforceClassificationPolicy(baseClassification({ primaryUrl: null }), 0.82);
    expect(result).toMatchObject({ decision: "digest", digestCategory: "Possible Opportunities", primaryUrl: null });
  });

  it("canonicalizes links and retains only known tags case-insensitively", () => {
    const result = enforceClassificationPolicy(baseClassification({
      primaryUrl: "https://www.Example.org/grant/?utm_source=email#top",
      applicationUrl: "https://EXAMPLE.org/apply/?ref=newsletter",
      tags: ["film", "PHOTOGRAPHY", "Not in the database", "Film"]
    }), 0.82);
    expect(result.primaryUrl).toBe("https://example.org/grant");
    expect(result.applicationUrl).toBe("https://example.org/apply");
    expect(result.tags).toEqual(["Film", "Photography"]);
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

  it("parses fenced JSON and output_text envelopes", () => {
    const expected = baseClassification();
    expect(parseClassificationResponse({ output_text: `\`\`\`json\n${JSON.stringify(expected)}\n\`\`\`` })).toEqual(expected);
  });

  it("rejects empty, invalid, and excessively nested content", () => {
    expect(() => parseClassificationResponse({ response: "" })).toThrow("empty classification content");
    expect(() => parseClassificationResponse({ decision: "notion" })).toThrow("invalid classification");
    const nested = { response: { response: { response: { response: { response: { response: { response: {} } } } } } } };
    expect(() => parseClassificationResponse(nested)).toThrow("nested too deeply");
  });

  it("parses the recovery schema independently", () => {
    expect(parseRecoveryClassification({ response: JSON.stringify({
      decision: "digest",
      confidence: 0.8,
      title: "Film workshop",
      organization: null,
      summary: "A practical workshop.",
      primaryUrl: null,
      digestCategory: "Workshops & Training",
      rationale: "Relevant training."
    }) })).toMatchObject({ decision: "digest", title: "Film workshop" });
  });
});

describe("Workers AI execution", () => {
  it("returns the policy-enforced primary structured result", async () => {
    const run = vi.fn().mockResolvedValue({ response: JSON.stringify(baseClassification({
      primaryUrl: "https://example.org/grant/?utm_source=email",
      tags: ["film", "unknown"]
    })) });
    const result = await classifyMessage({ run } as unknown as Ai, runtimeConfig(), parsedMessage(), []);
    expect(result).toMatchObject({ decision: "notion", primaryUrl: "https://example.org/grant", tags: ["Film"] });
    expect(run).toHaveBeenCalledOnce();
    expect(run.mock.calls[0]?.[2]).toEqual({ tags: ["dustwave", "opportunity-classifier"] });
  });

  it("uses the smaller recovery classifier after a malformed primary result", async () => {
    const run = vi.fn()
      .mockResolvedValueOnce({ response: "not-json" })
      .mockResolvedValueOnce({ response: JSON.stringify({
        decision: "digest",
        confidence: 0.9,
        title: "Film workshop",
        organization: "Example Arts",
        summary: "A workshop for independent filmmakers.",
        primaryUrl: "https://example.org/workshop",
        digestCategory: "Workshops & Training",
        rationale: "Relevant skills training."
      }) });
    const result = await classifyMessage({ run } as unknown as Ai, runtimeConfig(), parsedMessage(), []);
    expect(result).toMatchObject({ decision: "digest", title: "Film workshop", digestCategory: "Workshops & Training" });
    expect(run).toHaveBeenCalledTimes(2);
    expect(run.mock.calls[1]?.[2]).toEqual({ tags: ["dustwave", "opportunity-classifier-recovery"] });
  });

  it("surfaces both failures when primary and recovery classification fail", async () => {
    const run = vi.fn()
      .mockRejectedValueOnce(new Error("primary unavailable"))
      .mockResolvedValueOnce({ response: "{}" });
    const promise = classifyMessage({ run } as unknown as Ai, runtimeConfig(), parsedMessage(), []);
    await expect(promise).rejects.toThrow("primary and recovery classification both failed");
    await expect(promise).rejects.toBeInstanceOf(AggregateError);
  });

  it("fails closed when configured with an unreviewed model", async () => {
    const run = vi.fn();
    await expect(classifyMessage(
      { run } as unknown as Ai,
      runtimeConfig({ aiModel: "@cf/some/other-model" }),
      parsedMessage(),
      []
    )).rejects.toThrow("is not supported");
    expect(run).not.toHaveBeenCalled();
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
