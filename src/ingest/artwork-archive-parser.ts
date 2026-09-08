import { DomUtils } from "htmlparser2";
import { canonicalizeUrl } from "../email/parse";
import { isSafePublicUrl } from "./public-fetch";
import { markAmbiguousEntries, normalizedRoundupText as normalized, roundupDom, type RoundupEntry } from "./roundup-parser";

const GUIDE_PATH = "/call-for-entry/west/guide-to-artist-grants-opportunities";
export const ARTWORK_ARCHIVE_GUIDE = `https://www.artworkarchive.com${GUIDE_PATH}?opportunity_search=&opportunity_category_filter%5B%5D=5`;
type HtmlNode = ReturnType<typeof roundupDom>["children"][number];
const hasClass = (node: HtmlNode, name: string) => "attribs" in node && (node.attribs.class ?? "").split(/\s+/).includes(name);

/** A redirect may normalize the URL, but must retain the exact requested source scope. */
export function artworkArchiveGuideUrl(value: string): string | null {
  try {
    const url = new URL(value);
    if (!isSafePublicUrl(value) || url.protocol !== "https:" || !/^(www\.)?artworkarchive\.com$/.test(url.hostname)
      || url.pathname !== GUIDE_PATH || url.searchParams.getAll("opportunity_category_filter[]").join(",") !== "5"
      || [...url.searchParams].some(([key, val]) => key !== "opportunity_category_filter[]" && (key !== "opportunity_search" || val !== ""))) return null;
    return ARTWORK_ARCHIVE_GUIDE;
  } catch { return null; }
}

function blockText(node: HtmlNode): string {
  if ("data" in node && node.type === "text") return node.data;
  if (!("children" in node)) return "";
  const text = node.children.map(blockText).join("");
  return "name" in node && /^(?:div|section|fieldset|legend|p|li|ul|ol|br|h[1-6])$/.test(node.name) ? ` ${text} ` : text;
}

export function parseArtworkArchiveEntries(html: string): RoundupEntry[] {
  const document = roundupDom(html, "artwork_archive");
  const heading = DomUtils.findAll((node) => node.attribs.id === "guide-anchor", document)[0];
  const filter = DomUtils.findAll((node) => node.name === "select" && node.attribs.name === "opportunity_category_filter[]", document);
  const selected = filter.flatMap((node) => DomUtils.getElementsByTagName("option", node)
    .filter((option) => "selected" in option.attribs).map((option) => option.attribs.value));
  if (!heading || !/Western U\.S\./i.test(normalized(DomUtils.innerText(heading))) || selected.join(",") !== "5") {
    throw new Error("artwork_archive_scope_unverified");
  }
  // The observed guide is complete on one page. Do not silently accept a future paginated layout.
  if (DomUtils.findAll((node) => hasClass(node, "pagination") || node.name === "a"
    && ((node.attribs.rel ?? "").split(/\s+/).includes("next") || /^next\b/i.test(normalized(DomUtils.innerText(node)))), document).length) {
    throw new Error("artwork_archive_pagination_unsupported");
  }
  const cards = DomUtils.findAll((node) => hasClass(node, "opportunity-guide-entry"), document);
  // "More coming soon" is present even alongside listings, so it cannot prove an empty result.
  if (!cards.length) throw new Error("artwork_archive_empty_guide");
  const entries = cards.map((card): RoundupEntry => {
    const titles = DomUtils.getElementsByTagName("h2", card);
    if (titles.length !== 1) throw new Error("artwork_archive_entry_title");
    const titleNode = titles[0]!;
    const badges = DomUtils.findAll((node) => hasClass(node, "label"), titleNode);
    const section = normalized(badges.map((node) => DomUtils.innerText(node)).join(" "));
    badges.forEach(DomUtils.removeElement);
    const title = normalized(blockText(titleNode));
    if (!title || title.length > 240) throw new Error("artwork_archive_entry_title");
    const info = DomUtils.findAll((node) => hasClass(node, "opportunity-info-list"), card);
    if (!info.length || !info.some((node) => /Submission Deadline:/i.test(blockText(node)))) {
      throw new Error("artwork_archive_entry_details");
    }
    const urls = [...new Set(DomUtils.getElementsByTagName("a", card).flatMap((link) => {
      if (hasClass(link, "js-opportunity-add-to-schedule")) return [];
      const href = link.attribs.href ?? "";
      if (!href || href.startsWith("#")) return [];
      try {
        const url = canonicalizeUrl(new URL(href, ARTWORK_ARCHIVE_GUIDE).toString());
        return url && isSafePublicUrl(url) && !/(^|\.)artworkarchive\.com$/.test(new URL(url).hostname) ? [url] : [];
      } catch { return []; }
    }))];
    // Keep absolute deadline metadata, excluding the changing countdown and account actions from identity.
    for (const node of DomUtils.findAll((node) => hasClass(node, "opportunity-date")
      || hasClass(node, "external-opportunity-links") || hasClass(node, "js-opportunity-add-to-schedule"), card)) {
      DomUtils.removeElement(node);
    }
    const text = normalized(`${blockText(card)} Type: ${section || "(unspecified)"}`);
    if (text.length > 60_000 || urls.length > 30) throw new Error("artwork_archive_entry_size_limit");
    const requiresReview = /\b(?:residencies|fellowships|grants|programs)\b/i.test(title)
      || /\b(?:residency|grant|fellowship|prize|award|program)\b.*(?:\+|\band\b|&).*\b(?:residency|grant|fellowship|prize|award|program)\b/i.test(title);
    return { title, section, text, urls, ambiguousUrls: [], requiresReview };
  });
  return markAmbiguousEntries(entries);
}
