import { describe, expect, it } from "vitest";
import { ARTWORK_ARCHIVE_GUIDE, artworkArchiveGuideUrl, parseArtworkArchiveEntries } from "../src/ingest/artwork-archive-parser";
import { entryHtml, guideHtml } from "./support/artwork-archive";

describe("Artwork Archive filtered guide", () => {
  it("keeps separate listings, their full evidence and actual links without UI furniture", () => {
    const entries = parseArtworkArchiveEntries(guideHtml(entryHtml() + entryHtml("Rolling Residency", "https://example.org/rolling", "Ongoing")));
    expect(entries).toHaveLength(2);
    expect(entries[0]).toMatchObject({ title: "Fictional Film Residency", section: "Residency", urls: ["https://example.org/residency"], requiresReview: false });
    expect(entries[0]!.text).toContain("Submission Deadline: November 3, 2026");
    for (const text of ["Entry Fee: $40", "Award Info: $600", "Location: Colorado", "Housing and studio included", "US and Canadian residents aged 18"])
      expect(entries[0]!.text).toContain(text);
    expect(entries[1]!.text).toContain("Submission Deadline: Ongoing");
    for (const text of ["days left", "Add To Schedule", "Join now", "free trial"]) expect(JSON.stringify(entries)).not.toContain(text);
  });
  it("does not change evidence when the countdown, whitespace, or inline formatting changes", () => {
    expect(parseArtworkArchiveEntries(guideHtml().replace("56 days left", "55 days left").replace("Submit a film", "Submit   a <em>film</em>")))
      .toEqual(parseArtworkArchiveEntries(guideHtml()));
  });
  it("keeps only safe external targets, never trusting a link label or an account action", () => {
    const html = guideHtml(entryHtml("Unverified Call", "https://www.artworkarchive.com/call-for-entry/example")
      .replace("Housing and studio included.", `<script>untrusted script</script><a href="http://127.0.0.1/secret">https://example.org/official</a>
        <a href="javascript:alert(1)">bad</a><a href="mailto:someone@example.org">email</a><a href="//example.org/details">Details</a>
        <a href="http://[invalid">invalid</a><a href="">empty</a><a href="#x">section</a><a href="https://bit.ly/fictional">Official Institution</a>`));
    const [entry] = parseArtworkArchiveEntries(html);
    expect(entry!.urls).toEqual(["https://bit.ly/fictional", "https://example.org/details"]);
    expect(entry!.text).not.toContain("untrusted script");
  });
  it("marks different programs sharing a landing page for the existing evidence guard", () => {
    const entries = parseArtworkArchiveEntries(guideHtml(entryHtml("First Residency") + entryHtml("Second Residency")));
    expect(entries.every((entry) => entry.ambiguousUrls.includes("https://example.org/residency"))).toBe(true);
  });
  it("holds grouped programs within one card for human review", () => {
    for (const title of ["Two Film Residencies", "Film Grant and Writing Fellowship"]) {
      expect(parseArtworkArchiveEntries(guideHtml(entryHtml(title)))[0]!.requiresReview).toBe(true);
    }
  });
  it.each([
    ["challenge", "<h1>Verifying your browser</h1>"],
    ["wrong filter", guideHtml().replace('value="5" selected', 'value="3" selected')],
    ["missing guide", guideHtml().replace('id="guide-anchor"', 'id="other"')],
    ["empty guide", guideHtml("")],
    ["unknown card layout", guideHtml().replaceAll("opportunity-guide-entry", "new-card")],
    ["pagination", guideHtml() + '<a rel="next" href="?page=2">Next</a>'],
    ["missing details", guideHtml().replace("Submission Deadline:", "Changed layout:")],
    ["missing title", guideHtml().replace('<h2 class="bold">', '<h3 class="bold">').replace('Residency</div></h2>', 'Residency</div></h3>')],
    ["oversized title", guideHtml(entryHtml("x".repeat(241)))],
    ["oversized entry", guideHtml().replace("Housing and studio included.", "x".repeat(60_001))],
    ["too many links", guideHtml().replace("Housing and studio included.", Array.from({ length: 31 }, (_, i) => `<a href="https://example.org/${i}">Link</a>`).join(""))],
    ["oversized response", "x".repeat(1_500_001)],
    ["deep structure", guideHtml() + "<div>".repeat(70) + "</div>".repeat(70)]
  ])("fails visibly on %s", (_name, html) => {
    expect(() => parseArtworkArchiveEntries(html)).toThrow(/artwork_archive_/);
  });
  it("accepts only the exact guide and film category after redirects", () => {
    expect(artworkArchiveGuideUrl(ARTWORK_ARCHIVE_GUIDE)).toBe(ARTWORK_ARCHIVE_GUIDE);
    expect(artworkArchiveGuideUrl(ARTWORK_ARCHIVE_GUIDE.replace("www.", "").replace("opportunity_search=&", "") + "#guide-anchor")).toBe(ARTWORK_ARCHIVE_GUIDE);
    for (const url of ["invalid", "https://example.org/", ARTWORK_ARCHIVE_GUIDE.replace("https:", "http:"),
      ARTWORK_ARCHIVE_GUIDE.split("?")[0]!, ARTWORK_ARCHIVE_GUIDE.replace("=5", "=3"), ARTWORK_ARCHIVE_GUIDE + "&page=2",
      ARTWORK_ARCHIVE_GUIDE + "&opportunity_category_filter%5B%5D=6", ARTWORK_ARCHIVE_GUIDE.replace("opportunity_search=", "opportunity_search=painting")]) {
      expect(artworkArchiveGuideUrl(url)).toBeNull();
    }
  });
});
