import { describe, expect, it } from "vitest";
import { renderOpportunityDigest } from "../src/email/digest";
import type { DigestItemRecord } from "../src/storage/database";

describe("opportunity digest", () => {
  it("uses the RSS digest visual language and escapes untrusted content", () => {
    const item: DigestItemRecord = {
      message_id: "1",
      category: "Jobs & Commissions",
      title: "Artist <Commission>",
      summary: "A useful & relevant commission.",
      url: "https://example.org/job",
      deadline: "2026-09-01",
      sender: "Arts Group",
      received_at: "2026-08-04T12:00:00Z"
    };
    const digest = renderOpportunityDigest([item], new Date("2026-08-04T13:00:00Z"), "America/Denver");
    expect(digest.subject).toContain("Dust Wave Opportunity Radar");
    expect(digest.html).toContain("Relevant creative-industry calls that need a human look.");
    expect(digest.html).toContain("background:#0f0f0f");
    expect(digest.html).toContain("background:#f05a28");
    expect(digest.html).toContain("Artist &lt;Commission&gt;");
    expect(digest.html).not.toContain("Artist <Commission>");
    expect(digest.text).toContain("Jobs & Commissions".toUpperCase());
  });
});
