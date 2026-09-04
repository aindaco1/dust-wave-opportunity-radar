import { DomUtils } from "htmlparser2";
import { canonicalizeUrl } from "../email/parse";
import { isSafePublicUrl } from "./public-fetch";
import { parseRoundupFeed, parseRoundupArchive, roundupDom, normalizedRoundupText as normalized, markAmbiguousEntries, type RoundupEntry } from "./roundup-parser";
export { roundupMonth, roundupWindow, type Roundup } from "./roundup-parser";
export type ColossalEntry = RoundupEntry;

export const COLOSSAL_FEED = "https://www.thisiscolossal.com/category/opportunities/feed/";
export const COLOSSAL_ARCHIVE = "https://www.thisiscolossal.com/category/opportunities/";
export function colossalArticleUrl(value: string): string | null {
  try {
    const url = new URL(value, COLOSSAL_ARCHIVE);
    if (!isSafePublicUrl(url.toString()) || !/^https:$/.test(url.protocol)
      || !/^(www\.)?thisiscolossal\.com$/.test(url.hostname)
      || !/^\/20\d{2}\/\d{2}\/[^/]+\/?$/.test(url.pathname)) return null;
    return `https://www.thisiscolossal.com${url.pathname.replace(/\/$/, "")}/`;
  } catch { return null; }
}

export const parseColossalFeed = (xml: string) => parseRoundupFeed(xml, { source: "colossal", articleUrl: colossalArticleUrl });
export const parseColossalArchive = (html: string) => parseRoundupArchive(html, colossalArticleUrl);

export function parseColossalEntries(html: string): ColossalEntry[] {
  const document = roundupDom(html, "colossal");
  const content = DomUtils.findAll((node) => (node.attribs.class ?? "").split(/\s+/).includes("entry-content"), document)[0]
    ?? DomUtils.getElementsByTagName("article", document)[0] ?? document;
  const blocks = DomUtils.findAll((node) => /^(p|h[1-6]|li)$/.test(node.name), content);
  const entries: ColossalEntry[] = [];
  let section: string | null = null;
  let current: ColossalEntry | undefined;
  for (const block of blocks) {
    const text = normalized(DomUtils.innerText(block));
    if (!text || /^The post .* appeared first on /i.test(text)) continue;
    if (/^(Open Calls|Grants|Residencies(?:,? Fellowships)?(?:,? (?:&|and) More)?|Residencies, Fellowships, & More)$/i.test(text)) {
      section = text; current = undefined; continue;
    }
    if (/^h[1-6]$/.test(block.name)) { current = undefined; continue; }
    const links = DomUtils.getElementsByTagName("a", block);
    const titleLink = links.find((link) => {
      const title = normalized(DomUtils.innerText(link));
      const emphasized = DomUtils.getElementsByTagName((name) => name === "strong" || name === "b", link).length > 0
        || (link.parent && "name" in link.parent && ["strong", "b"].includes(link.parent.name));
      return title.length > 2 && emphasized && text.startsWith(title);
    });
    const urls = [...new Set(links.map((link) => canonicalizeUrl(link.attribs.href ?? ""))
      .filter((url): url is string => Boolean(url && isSafePublicUrl(url)
        && !/(^|\.)thisiscolossal\.com$/.test(new URL(url).hostname))))];
    if (titleLink && (section || text.slice(normalized(DomUtils.innerText(titleLink)).length).startsWith("Featured"))) {
      const title = normalized(DomUtils.innerText(titleLink));
      if (title.length > 240) throw new Error("colossal_entry_title_limit");
      const entryText = text.slice(title.length).startsWith("Featured")
        ? normalized(`${title} ${text.slice(title.length + "Featured".length)}`) : text;
      current = {
        title, section: section ?? "Featured", text: entryText, urls, ambiguousUrls: [],
        requiresReview: /(?:,|\band\b|&)/i.test(title) && /\b(residencies|fellowships|programs)\b/i.test(title)
      };
      entries.push(current);
    } else if (current) {
      current.text += `\n${text}`;
      current.urls = [...new Set([...current.urls, ...urls])];
    }
    if (current && (current.text.length > 60_000 || current.urls.length > 30)) throw new Error("colossal_entry_size_limit");
  }
  if (!entries.length) throw new Error("colossal_empty_article");
  return markAmbiguousEntries(entries);
}
