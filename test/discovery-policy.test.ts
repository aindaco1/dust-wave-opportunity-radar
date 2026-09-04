import { describe, expect, it } from "vitest";
import { enforceClassificationPolicy } from "../src/ai/classify";
import { classification } from "./support/fixtures";
import type { DiscoveryContext } from "../src/types";
const context: DiscoveryContext = {
  sourceUrl: "https://www.thisiscolossal.com/2026/08/september-calls/",
  officialUrls: ["https://example.org/apply/film"], ambiguousUrls: [], requiresReview: false
};
const call = () => classification({ primaryUrl: "https://example.org/apply/film" });

describe("shared discovery evidence policy", () => {
  it("allows a distinct evidenced official call, including a safe redirect destination", () => {
    expect(enforceClassificationPolicy(call(), 0.82, context).decision).toBe("notion");
    expect(enforceClassificationPolicy(classification({ primaryUrl: "https://apply.example.org/film" }), 0.82, context,
      [{ requestedUrl: context.officialUrls[0]!, finalUrl: "https://apply.example.org/film", text: "Apply now" }]).decision).toBe("notion");
  });
  it.each([
    context.sourceUrl, "https://thisiscolossal.com/other/", "https://invented.example.org/apply"
  ])("holds aggregator and invented primary URL %s for review", (primaryUrl) => {
    expect(enforceClassificationPolicy(classification({ primaryUrl }), 0.82, context)).toMatchObject({ decision: "digest", digestCategory: "Possible Opportunities" });
  });
  it("holds grouped calls and shared program URLs, including redirect aliases", () => {
    expect(enforceClassificationPolicy(call(), 0.82, { ...context, requiresReview: true }).decision).toBe("digest");
    expect(enforceClassificationPolicy(call(), 0.82, { ...context, ambiguousUrls: context.officialUrls }).decision).toBe("digest");
    expect(enforceClassificationPolicy(classification({ primaryUrl: "https://apply.example.org/shared" }), 0.82,
      { ...context, ambiguousUrls: context.officialUrls },
      [{ requestedUrl: context.officialUrls[0]!, finalUrl: "https://apply.example.org/shared", text: "Programs" }]).decision).toBe("digest");
  });
  it("does not publish expired calls from a historical roundup, and keeps deadline-day and rolling calls", () => {
    const expired = classification({ ...call(), dueDate: "2026-09-03" });
    expect(enforceClassificationPolicy(expired, 0.82, context, [], "2026-09-04").decision).toBe("ignore");
    expect(enforceClassificationPolicy(expired, 0.82, undefined, [], "2026-09-04").decision).toBe("ignore");
    expect(enforceClassificationPolicy(classification({ ...call(), dueDate: "2026-09-04" }), 0.82, context, [], "2026-09-04").decision).toBe("notion");
    expect(enforceClassificationPolicy(classification({ ...call(), dueDate: null }), 0.82, context, [], "2026-09-04").decision).toBe("notion");
  });
  it("retains geography, confidence, rolling-call, and non-call rules", () => {
    expect(enforceClassificationPolicy(classification({ ...call(), dueDate: null, tags: ["Rolling", "Pay-to-Play"] }), 0.82, context).decision).toBe("notion");
    expect(enforceClassificationPolicy(classification({ ...call(), confidence: 0.5 }), 0.82, context).decision).toBe("digest");
    expect(enforceClassificationPolicy(classification({ ...call(), eligibleStates: ["Illinois"], explicitlyExcludedStates: ["New Mexico", "Pennsylvania"] }), 0.82, context).decision).toBe("notion");
    expect(enforceClassificationPolicy(classification({ ...call(), explicitlyExcludedStates: ["New Mexico", "Illinois", "Pennsylvania"] }), 0.82, context).decision).toBe("ignore");
    expect(enforceClassificationPolicy(classification({ ...call(), decision: "digest", digestCategory: "Jobs & Commissions" }), 0.82, context).digestCategory).toBe("Jobs & Commissions");
    expect(enforceClassificationPolicy(classification({ ...call(), decision: "ignore" }), 0.82, context).decision).toBe("ignore");
  });
});
