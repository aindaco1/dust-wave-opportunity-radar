import { describe, expect, it } from "vitest";
import { enforceClassificationPolicy, parseClassificationResponse } from "../src/ai/classify";
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
