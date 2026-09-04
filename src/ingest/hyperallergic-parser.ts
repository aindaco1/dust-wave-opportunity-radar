import { DomUtils } from "htmlparser2";
import { canonicalizeUrl } from "../email/parse";
import { isSafePublicUrl } from "./public-fetch";
import {
  markAmbiguousEntries, normalizedRoundupText as normalized, parseRoundupArchive, parseRoundupFeed,
  roundupDom, type RoundupEntry
} from "./roundup-parser";

export const HYPERALLERGIC_ARCHIVE = "https://hyperallergic.com/tag/opportunities/";
export const HYPERALLERGIC_FEED = `${HYPERALLERGIC_ARCHIVE}rss/`;
const MONTH = "(?:january|february|march|april|may|june|july|august|september|october|november|december)";

export function hyperallergicArticleUrl(value: string): string | null {
  try {
    const url = new URL(value, HYPERALLERGIC_ARCHIVE);
    if (!isSafePublicUrl(url.toString()) || url.protocol !== "https:"
      || !/^(www\.)?hyperallergic\.com$/.test(url.hostname)
      || !new RegExp(`^/(?:\\d+/)?opportunities-(?:in-)?${MONTH}-20\\d{2}/?$`).test(url.pathname)) return null;
    return `https://hyperallergic.com${url.pathname.replace(/\/$/, "")}/`;
  } catch { return null; }
}

// The tag feed also carries standalone announcements. They are outside the monthly-roundup scope.
export const parseHyperallergicFeed = (xml: string) => parseRoundupFeed(xml, {
  source: "hyperallergic", articleUrl: hyperallergicArticleUrl,
  acceptTitle: (title) => /^Opportunities in\b/i.test(title.trim())
});
export const parseHyperallergicArchive = (html: string) => parseRoundupArchive(html, hyperallergicArticleUrl);

type HtmlNode = ReturnType<typeof roundupDom>["children"][number];
const paragraphText = (nodes: HtmlNode[]) => nodes.map((node) =>
  "name" in node && node.name === "br" ? "\n" : DomUtils.innerText(node)).join("");

function isSection(text: string): boolean {
  if (/^Open Calls(?: for Art (?:&|and) Writing)?$/i.test(text)) return true;
  const parts = text.split(/\s*(?:,|&|\band\b)\s*/i).filter(Boolean);
  return parts.length > 0 && parts.every((part) => /^(Awards?|Grants?|Residencies|Fellowships|Workshops)$/i.test(part));
}

// Ghost sometimes puts two separate listings in one paragraph, separated by line breaks.
// Split at an emphasized title at the beginning of a line, not at every bold fee/deadline.
function paragraphSegments(nodes: HtmlNode[]) {
  const segments: Array<{ title?: string; nodes: HtmlNode[] }> = [];
  let current: { title?: string; nodes: HtmlNode[] } = { nodes: [] };
  let lineStart = true;
  for (const node of nodes) {
    const text = normalized(DomUtils.innerText(node));
    const title = lineStart ? DomUtils.findAll((n) => n.name === "strong" || n.name === "b", [node])
      .map((n) => normalized(DomUtils.innerText(n)))
      .find((value) => value.length > 2 && value === text
        && !/^(?:deadlines?|fees?|application fee|apply|rolling|tuition)\b/i.test(value)) : undefined;
    if (title) {
      if (current.title || normalized(paragraphText(current.nodes))) segments.push(current);
      current = { title, nodes: [] };
    }
    current.nodes.push(node);
    if ("name" in node && node.name === "br") lineStart = true;
    else if (text) lineStart = false;
  }
  if (current.nodes.length) segments.push(current);
  return segments;
}

export function parseHyperallergicEntries(html: string): RoundupEntry[] {
  const document = roundupDom(html, "hyperallergic");
  for (const node of DomUtils.findAll((node) => (node.attribs.class ?? "").split(/\s+/).includes("kg-cta-card"), document)) {
    DomUtils.removeElement(node);
  }
  // Ghost full pages use gh-content; RSS carries just the article fragment.
  const content = DomUtils.findAll((node) => (node.attribs.class ?? "").split(/\s+/).includes("gh-content"), document)[0]
    ?? DomUtils.getElementsByTagName("article", document)[0] ?? document;
  const blocks = DomUtils.findAll((node) => /^(p|h[1-6])$/.test(node.name), content);
  const entries: RoundupEntry[] = [];
  let section: string | null = null;
  let current: RoundupEntry | undefined;
  for (const block of blocks) {
    const text = normalized(DomUtils.innerText(block));
    if (/^h[1-6]$/.test(block.name)) {
      section = isSection(text) ? text : null;
      if (text && !section && /^h[2-6]$/.test(block.name)) throw new Error("hyperallergic_unrecognized_section");
      current = undefined;
      continue;
    }
    if (!section || !text) continue;
    for (const segment of paragraphSegments(block.children)) {
      const segmentText = normalized(paragraphText(segment.nodes));
      if (!segmentText) continue;
      const urls = [...new Set(DomUtils.getElementsByTagName("a", segment.nodes)
        .map((link) => canonicalizeUrl(link.attribs.href ?? ""))
        .filter((url): url is string => Boolean(url && isSafePublicUrl(url)
          && !/(^|\.)hyperallergic\.com$/.test(new URL(url).hostname))))];
      if (segment.title) {
        const title = segment.title;
        if (title.length > 240) throw new Error("hyperallergic_entry_title_limit");
        current = {
          title, section, text: segmentText, urls, ambiguousUrls: [],
          requiresReview: /(?:,|\band\b|&|\+)/i.test(title) && /\b(residencies|fellowships|grants|programs)\b/i.test(title)
            || /\b(residency|grant|fellowship|prize)\b.*(?:\+|\band\b|&).*\b(residency|grant|fellowship|prize)\b/i.test(title)
            || /\bgrants\b/i.test(title)
        };
        entries.push(current);
      } else if (current) {
        current.text += `\n${segmentText}`;
        current.urls = [...new Set([...current.urls, ...urls])];
      } else {
        throw new Error("hyperallergic_unrecognized_entry");
      }
      if (current && (current.text.length > 60_000 || current.urls.length > 30)) throw new Error("hyperallergic_entry_size_limit");
    }
  }
  if (!entries.length) throw new Error("hyperallergic_empty_article");
  return markAmbiguousEntries(entries);
}
