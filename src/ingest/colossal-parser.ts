import { DomUtils, parseDocument } from "htmlparser2";
import { SaxesParser } from "saxes";
import { canonicalizeUrl } from "../email/parse";
import { localBatchSlot } from "../util/dates";
import { isSafePublicUrl } from "./public-fetch";

export const COLOSSAL_FEED = "https://www.thisiscolossal.com/category/opportunities/feed/";
export const COLOSSAL_ARCHIVE = "https://www.thisiscolossal.com/category/opportunities/";
const MONTHS = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];
export interface Roundup {
  url: string;
  month: string;
  publishedAt: string;
  html?: string;
}
export interface ColossalEntry {
  title: string;
  section: string;
  text: string;
  urls: string[];
  ambiguousUrls: string[];
  requiresReview: boolean;
}

export function roundupMonth(title: string): string | null {
  const match = title.toLowerCase().match(/\b(january|february|march|april|may|june|july|august|september|october|november|december)\s+(20\d{2})\b/);
  return match ? `${match[2]}-${String(MONTHS.indexOf(match[1]!) + 1).padStart(2, "0")}` : null;
}

export function roundupWindow(runAt: Date, timezone: string): string[] {
  if (Number.isNaN(runAt.valueOf())) throw new Error("colossal_invalid_run_date");
  const local = localBatchSlot(runAt, timezone).dateLabel;
  const date = new Date(`${local.slice(0, 7)}-01T12:00:00Z`);
  return [-1, 0, 1].map((offset) => {
    const month = new Date(date); month.setUTCMonth(month.getUTCMonth() + offset);
    return month.toISOString().slice(0, 7);
  });
}

export function colossalArticleUrl(value: string): string | null {
  try {
    const url = new URL(value, COLOSSAL_ARCHIVE);
    if (!isSafePublicUrl(url.toString()) || !/^https:$/.test(url.protocol)
      || !/^(www\.)?thisiscolossal\.com$/.test(url.hostname)
      || !/^\/20\d{2}\/\d{2}\/[^/]+\/?$/.test(url.pathname)) return null;
    return `https://www.thisiscolossal.com${url.pathname.replace(/\/$/, "")}/`;
  } catch { return null; }
}

export function parseColossalFeed(xml: string): { roundups: Roundup[]; invalid: number } {
  if (xml.length > 1_500_000) throw new Error("colossal_xml_size_limit");
  const parser = new SaxesParser();
  const stack: string[] = [];
  const items: Record<string, string>[] = [];
  let item: Record<string, string> | null = null;
  let nodes = 0;
  parser.on("doctype", () => { throw new Error("colossal_xml_doctype"); });
  parser.on("error", () => { throw new Error("colossal_invalid_xml"); });
  parser.on("opentag", (tag) => {
    stack.push(tag.name);
    if (++nodes > 20_000 || stack.length > 32) throw new Error("colossal_xml_structure_limit");
    if (tag.name === "item" && stack.at(-2) === "channel") item = {};
  });
  const append = (text: string) => {
    const name = stack.at(-1)!;
    if (item && stack.at(-2) === "item" && ["title", "link", "pubDate", "content:encoded"].includes(name)) {
      item[name] = (item[name] ?? "") + text;
    }
  };
  parser.on("text", append); parser.on("cdata", append);
  parser.on("closetag", (tag) => {
    if (tag.name === "item" && item) { items.push(item); item = null; }
    stack.pop();
  });
  parser.write(xml).close();
  if (!items.length) throw new Error("colossal_empty_feed");
  let invalid = 0;
  const roundups: Roundup[] = [];
  for (const item of items) {
    const month = roundupMonth(item.title ?? "");
    const url = colossalArticleUrl(item.link ?? "");
    const published = new Date(item.pubDate ?? "");
    if (!month || !url || Number.isNaN(published.valueOf())) { invalid++; continue; }
    roundups.push({ url, month, publishedAt: published.toISOString(), html: item["content:encoded"] });
  }
  return { roundups, invalid };
}

function dom(html: string) {
  if (html.length > 1_500_000) throw new Error("colossal_html_size_limit");
  const document = parseDocument(html);
  const queue = document.children.map((node) => ({ node, depth: 0 }));
  let count = 0;
  while (queue.length) {
    const { node, depth } = queue.pop()!;
    if (++count > 20_000 || depth > 64) throw new Error("colossal_html_structure_limit");
    if ("children" in node) queue.push(...node.children.map((child) => ({ node: child, depth: depth + 1 })));
  }
  for (const node of DomUtils.findAll((node) => ["script", "style", "nav", "footer", "aside"].includes(node.name), document)) {
    DomUtils.removeElement(node);
  }
  return document;
}
const normalized = (text: string) => text.normalize("NFKC").replace(/\s+/g, " ").trim();

export function parseColossalArchive(html: string): Roundup[] {
  const document = dom(html);
  const result = new Map<string, Roundup>();
  for (const link of DomUtils.getElementsByTagName("a", document)) {
    const month = roundupMonth(DomUtils.innerText(link));
    const url = colossalArticleUrl(link.attribs.href ?? "");
    // An archive title establishes the roundup month, not the article's publication date.
    if (month && url) result.set(url, { url, month, publishedAt: "" });
  }
  return [...result.values()];
}

export function parseColossalEntries(html: string): ColossalEntry[] {
  const document = dom(html);
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
  // Preserve separate programs even when the publisher links them to one landing page.
  for (const entry of entries) {
    entry.ambiguousUrls = entry.urls.filter((url) => entries.some((other) => other !== entry
      && other.title.toLowerCase() !== entry.title.toLowerCase() && other.urls.includes(url)));
    entry.urls.sort(); entry.ambiguousUrls.sort();
  }
  return entries;
}
