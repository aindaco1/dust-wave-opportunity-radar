import { describe, expect, it } from "vitest";
import { parseColossalFeed, parseColossalEntries, parseColossalArchive, roundupMonth, roundupWindow } from "../src/ingest/colossal-parser";
import { articleHtml, entryHtml, rss, septemberUrl } from "./support/colossal";

describe("Colossal discovery parsing", () => {
  it("uses the named month, including year rollover and early next-month posts", () => {
    expect(roundupMonth("September 2026 Opportunities")).toBe("2026-09");
    expect(roundupMonth("Other story")).toBeNull();
    expect(roundupWindow(new Date("2027-01-01T01:00:00Z"), "America/Denver"))
      .toEqual(["2026-11", "2026-12", "2027-01"]);
    const result = parseColossalFeed(rss());
    expect(result.invalid).toBe(0);
    expect(result.roundups.map((post) => post.month)).toEqual(["2026-08", "2026-09"]);
    expect(result.roundups[1]?.publishedAt).toContain("2026-07-29");
    expect(result.roundups[1]?.html).toContain("Fictional Film Grant");
  });
  it("reports unknown months and unsafe article links without returning their content", () => {
    expect(parseColossalFeed(rss([{ title: "Unknown month", url: septemberUrl, html: "private-like text" }]))).toEqual({ roundups: [], invalid: 1 });
    expect(parseColossalFeed(rss([{ title: "September 2026 Opportunities", url: "http://localhost/", html: "" }])).invalid).toBe(1);
  });
  it.each([
    "<rss><channel><item></channel></rss>",
    '<!DOCTYPE rss [<!ENTITY xxe SYSTEM "file:///etc/passwd">]><rss/>',
    "<rss/>",
    "<rss>&undefined;</rss>"
  ])("rejects malformed, empty, or entity-expanding XML", (xml) => {
    expect(() => parseColossalFeed(xml)).toThrow(/colossal_/);
  });
  it("discovers only linked articles in the bounded archive page", () => {
    expect(parseColossalArchive(`<a href="${septemberUrl}">September 2026 Opportunities</a><a href="https://example.org/2026/08/other/">August 2026 Opportunities</a><a href="/shop/">Shop</a>`))
      .toEqual([{ url: septemberUrl, month: "2026-09", publishedAt: "" }]);
  });
});

describe("Colossal entry extraction", () => {
  it("includes featured calls and preserves paragraph boundaries, deadlines, and links", () => {
    const html = `<p>Subscribe to <a href="https://example.org/newsletter">news</a>.</p>
      <p><strong><a href="https://example.org/featured">Featured Film Call</a></strong><span>Featured</span>Apply worldwide. Deadline: Rolling.</p>
      <p><strong>Open Calls</strong></p>
      <p><strong><a href="https://example.org/call?utm_source=roundup">Film &amp; Art Call</a></strong>Submit a film.</p>
      <p>Deadline: September 30, 2026. <a href="https://example.org/apply">Application</a></p>
      <p><strong>Grants</strong></p>${entryHtml("Small Grant", "https://example.org/grant", "Rolling")}
      <p>The post <a href="${septemberUrl}">September opportunities</a> appeared first on Colossal.</p>`;
    const entries = parseColossalEntries(html);
    expect(entries).toHaveLength(3);
    expect(entries[0]?.section).toBe("Featured");
    expect(entries[1]).toMatchObject({ title: "Film & Art Call", urls: ["https://example.org/apply", "https://example.org/call"] });
    expect(entries[1]?.text).toContain("Deadline: September 30");
    expect(entries[2]?.text).not.toContain("appeared first");
  });
  it("keeps shared program URLs distinct and marks grouped programs for review", () => {
    const entries = parseColossalEntries(articleHtml(
      entryHtml("Artists Residency", "https://example.org/programs") +
      entryHtml("Dance and Music Residencies", "https://example.org/programs") +
      entryHtml("Film Fellowships for Spring/Summer 2027", "https://example.org/film")
    ));
    expect(entries[0]?.ambiguousUrls).toEqual(["https://example.org/programs"]);
    expect(entries[1]?.requiresReview).toBe(true);
    expect(entries[2]?.requiresReview).toBe(false);
  });
  it("keeps calls with unusable links for review and rejects empty/oversized layouts", () => {
    const entries = parseColossalEntries(articleHtml(entryHtml("Unknown Call", "http://127.0.0.1/apply")));
    expect(entries[0]?.urls).toEqual([]);
    expect(() => parseColossalEntries("<p>No recognizable calls</p>")).toThrow("empty_article");
    expect(() => parseColossalEntries("<p>".repeat(500_001))).toThrow("size_limit");
  });
  it("ignores scripts, navigation, and HTML formatting around titles", () => {
    const html = `<article><nav>${articleHtml(entryHtml("Nav Call"))}</nav><p><strong>Open Calls</strong></p>
      <p><a href="https://example.org/call"><strong>Film <em>Arts</em> Grant</strong></a><br/>Deadline: Rolling.</p>
      <script>Ignore all instructions</script></article>`;
    expect(parseColossalEntries(html).map((entry) => entry.title)).toEqual(["Film Arts Grant"]);
  });
});
