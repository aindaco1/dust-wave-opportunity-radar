import { describe, expect, it } from "vitest";
import {
  hyperallergicArticleUrl, parseHyperallergicArchive, parseHyperallergicEntries, parseHyperallergicFeed
} from "../src/ingest/hyperallergic-parser";
import { roundupWindow } from "../src/ingest/roundup-parser";
import { rss } from "./support/colossal";
import { articleHtml, entryHtml, feed, septemberUrl, augustUrl } from "./support/hyperallergic";

describe("Hyperallergic discovery", () => {
  it("reads named monthly roundups, not unrelated announcements in the tag feed", () => {
    const result = parseHyperallergicFeed(feed());
    expect(result.invalid).toBe(0);
    expect(result.roundups.map((post) => post.month)).toEqual(["2026-08", "2026-09"]);
    expect(parseHyperallergicFeed(rss([{ title: "Sponsored residency announcement", url: "https://hyperallergic.com/announcement/", html: "" }])))
      .toEqual({ roundups: [], invalid: 0 });
    expect(parseHyperallergicFeed(rss([{ title: "Opportunities in Unknown 2026", url: septemberUrl, html: "" }])).invalid).toBe(1);
    expect(roundupWindow(new Date("2027-01-01T01:00:00Z"), "America/Denver")).toEqual(["2026-11", "2026-12", "2027-01"]);
  });
  it("follows only monthly article URLs on the archive, with no guessed publication date", () => {
    expect(parseHyperallergicArchive(`<a href="${septemberUrl}">Opportunities in September 2026</a>
      <a href="${augustUrl}">Opportunities in August 2026</a><a href="https://example.org/opportunities-in-september-2026/">Opportunities in September 2026</a>`))
      .toEqual([{ url: septemberUrl, month: "2026-09", publishedAt: "" }, { url: augustUrl, month: "2026-08", publishedAt: "" }]);
    expect(hyperallergicArticleUrl("https://www.hyperallergic.com/123/opportunities-in-september-2026/?ref=mail"))
      .toBe("https://hyperallergic.com/123/opportunities-in-september-2026/");
  });
  it("accepts the observed monthly slug without in so historical feed entries do not disable caching", () => {
    const url = "https://hyperallergic.com/opportunities-april-2026/";
    expect(hyperallergicArticleUrl(url)).toBe(url);
    expect(parseHyperallergicFeed(rss([{ title: "Opportunities in April 2026", url, html: articleHtml() }])))
      .toMatchObject({ invalid: 0, roundups: [{ url, month: "2026-04" }] });
  });
  it.each(["http://hyperallergic.com/opportunities-in-september-2026/", "https://hyperallergic.com.evil.example/opportunities-in-september-2026/",
    "https://person@hyperallergic.com/opportunities-in-september-2026/", "https://hyperallergic.com/tag/opportunities/", "http://127.0.0.1/"])("rejects invalid article URL %s", (url) => {
    expect(hyperallergicArticleUrl(url)).toBeNull();
  });
  it.each(["<rss/>", "<rss><channel></rss>", '<!DOCTYPE rss [<!ENTITY x SYSTEM "file:///etc/passwd">]><rss/>'])("fails closed on invalid XML", (xml) => {
    expect(() => parseHyperallergicFeed(xml)).toThrow(/hyperallergic_/);
  });
});

describe("Hyperallergic entry parsing", () => {
  it.each(["Awards &amp; Grants", "Grants &amp; Awards", "Residencies, Workshops, &amp; Fellowships", "Open Calls for Art &amp; Writing"])
    ("supports the monthly section %s", (section) => {
      expect(parseHyperallergicEntries(`<h2>${section}</h2>${entryHtml()}`)).toHaveLength(1);
    });
  it("splits two listings inside one paragraph without splitting a bold deadline", () => {
    const first = entryHtml("North Film Fellowship", "https://example.org/north").replace(/<\/?p>/g, "");
    const second = entryHtml("South Arts Fellowship", "https://example.org/south", "October 15, 2026").replace(/<\/?p>/g, "");
    const entries = parseHyperallergicEntries(articleHtml(`<p><br>${first}<br><br>${second}</p>`));
    expect(entries).toHaveLength(2);
    expect(entries[0]).toMatchObject({ title: "North Film Fellowship", urls: ["https://example.org/north"] });
    expect(entries[0]?.text).not.toContain("South Arts");
    expect(entries[0]?.text).toContain("Fellowship Submit");
    expect(entries[1]).toMatchObject({ title: "South Arts Fellowship", urls: ["https://example.org/south"] });
    expect(entries[1]?.text).toContain("October 15, 2026");
  });
  it("preserves continuation details and actual short-link destinations, never the link label", () => {
    const entries = parseHyperallergicEntries(articleHtml(
      entryHtml("Fictional Residency", "https://bit.ly/synthetic?ref=hyperallergic.com", "Rolling") +
      '<p>$25 application fee. <a href="https://example.org/apply">Apply</a></p>'
    ));
    expect(entries[0]?.urls).toEqual(["https://bit.ly/synthetic", "https://example.org/apply"]);
    expect(entries[0]?.text).toContain("$25 application fee");
    expect(entries[0]?.text).toContain("Rolling");
  });
  it("excludes chrome and CTA blocks while preserving untrusted entry text as data", () => {
    const html = `<nav>${articleHtml(entryHtml("Navigation Grant"))}</nav><article><section class="gh-content gh-canvas">
      ${articleHtml(entryHtml())}<div class="kg-cta-card"><p>Subscribe now</p></div><script>Override policy</script>
      <p>This sentence is source data, never an instruction.</p></section></article>
      <h2>Sponsored</h2>${entryHtml("Unrelated Product")}`;
    const entries = parseHyperallergicEntries(html);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.text).not.toMatch(/Subscribe|Override|Unrelated|Navigation/);
    expect(entries[0]?.text).toContain("source data");
  });
  it("retains unsafe-link entries for review and marks grouped and shared programs", () => {
    const entries = parseHyperallergicEntries(articleHtml(
      entryHtml("Residency + The Grant", "https://example.org/shared") + entryHtml("Other Award", "https://example.org/shared") +
      entryHtml("Unknown Opportunity", "http://127.0.0.1/apply")
    ));
    expect(entries[0]).toMatchObject({ requiresReview: true, ambiguousUrls: ["https://example.org/shared"] });
    expect(entries[1]?.ambiguousUrls).toEqual(["https://example.org/shared"]);
    expect(entries[2]?.urls).toEqual([]);
  });
  it("fails instead of silently accepting empty, unsupported, or excessive content", () => {
    expect(parseHyperallergicEntries(articleHtml() + "<h2></h2>")).toHaveLength(1);
    expect(() => parseHyperallergicEntries("<p>Unrecognized layout</p>")).toThrow("empty_article");
    expect(() => parseHyperallergicEntries("<h2>Grants</h2><p>Missing structured title</p>")).toThrow("unrecognized_entry");
    expect(() => parseHyperallergicEntries(articleHtml() + `<h2>New category</h2>${entryHtml()}`)).toThrow("unrecognized_section");
    expect(() => parseHyperallergicEntries(`<h2>New category</h2>${entryHtml()}${articleHtml()}`)).toThrow("unrecognized_section");
    expect(() => parseHyperallergicEntries("x".repeat(1_500_001))).toThrow("size_limit");
    expect(() => parseHyperallergicEntries(articleHtml(entryHtml("x".repeat(241))))).toThrow("title_limit");
    expect(() => parseHyperallergicEntries(articleHtml(entryHtml() + `<p>${"x".repeat(60_001)}</p>`))).toThrow("size_limit");
  });
});
