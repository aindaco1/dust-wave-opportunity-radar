import { describe, expect, it, vi } from "vitest";
import { renderOpportunityDigest, sendOpportunityDigest } from "../src/email/digest";
import type { DigestItemRecord } from "../src/storage/database";
import { runtimeConfig } from "./support/fixtures";

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
    expect(digest.html).toContain("Scanned HEY, Zoho, and Creative West on the 12-hour Dust Wave schedule.");
    expect(digest.html).not.toContain("Empty digests are suppressed.");
  });

  it("orders categories by editorial priority and balances cards into columns", () => {
    const items = [
      item({ message_id: "other", category: "Other Useful Finds", title: "Other" }),
      item({ message_id: "event", category: "Events & Conferences", title: "Event" }),
      item({ message_id: "possible", category: "Possible Opportunities", title: "Possible" }),
      item({ message_id: "job", category: "Jobs & Commissions", title: "Job" }),
      item({ message_id: "job-2", category: "Jobs & Commissions", title: "Second job" })
    ];
    const digest = renderOpportunityDigest(items, new Date("2026-08-04T13:00:00Z"), "America/Denver");
    expect(digest.html.indexOf("Possible Opportunities")).toBeLessThan(digest.html.indexOf("Jobs &amp; Commissions"));
    expect(digest.html.indexOf("Jobs &amp; Commissions")).toBeLessThan(digest.html.indexOf("Events &amp; Conferences"));
    expect(digest.html).toContain("radar-column");
    expect(digest.html).toContain("Second job");
  });

  it("escapes titles, URLs, senders, and summaries in attributes and text", () => {
    const digest = renderOpportunityDigest([item({
      title: '\"<Call>&',
      summary: "Apply <now> & be selected.",
      url: 'https://example.org/call?x=\"quoted\"&y=1',
      sender: "Arts <Group>"
    })], new Date("2026-08-04T13:00:00Z"), "America/Denver");
    expect(digest.html).toContain("&quot;&lt;Call&gt;&amp;");
    expect(digest.html).toContain("x=&quot;quoted&quot;&amp;y=1");
    expect(digest.html).toContain("Arts &lt;Group&gt;");
    expect(digest.html).toContain("Apply &lt;now&gt; &amp; be selected.");
  });

  it("compacts long summaries without breaking the plain-text version", () => {
    const summary = `${"word ".repeat(100)}ending`;
    const digest = renderOpportunityDigest([item({ summary, received_at: "invalid-date" })], new Date("2026-08-04T13:00:00Z"), "America/Denver");
    expect(digest.html).toContain("…");
    expect(digest.html).not.toContain("invalid-date");
    expect(digest.text).toContain(summary);
  });

  it("sends the rendered multipart digest through the configured binding", async () => {
    const send = vi.fn().mockResolvedValue({ messageId: "email-123" });
    const rendered = renderOpportunityDigest([item()], new Date("2026-08-04T13:00:00Z"), "America/Denver");
    await expect(sendOpportunityDigest({ send } as unknown as SendEmail, runtimeConfig(), rendered)).resolves.toBe("email-123");
    expect(send).toHaveBeenCalledWith(expect.objectContaining({
      to: "alonso@hey.com",
      from: { email: "opportunities@digest.dustwave.xyz", name: "Dust Wave Opportunity Radar" },
      subject: rendered.subject,
      html: rendered.html,
      text: rendered.text,
      headers: { "X-Dustwave-Automation": "opportunity-radar" }
    }));
  });
});

function item(overrides: Partial<DigestItemRecord> = {}): DigestItemRecord {
  return {
    message_id: "1",
    category: "Jobs & Commissions",
    title: "Artist commission",
    summary: "A useful commission.",
    url: "https://example.org/job",
    deadline: "2026-09-01",
    sender: "Arts Group",
    received_at: "2026-08-04T12:00:00Z",
    ...overrides
  };
}
