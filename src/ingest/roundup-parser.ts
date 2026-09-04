import { DomUtils, parseDocument } from "htmlparser2";
import { SaxesParser } from "saxes";
import { localBatchSlot } from "../util/dates";

const MONTHS = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];
export interface Roundup {
  url: string;
  month: string;
  publishedAt: string;
  html?: string;
}
export interface RoundupEntry {
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
  if (Number.isNaN(runAt.valueOf())) throw new Error("roundup_invalid_run_date");
  const local = localBatchSlot(runAt, timezone).dateLabel;
  const date = new Date(`${local.slice(0, 7)}-01T12:00:00Z`);
  return [-1, 0, 1].map((offset) => {
    const month = new Date(date); month.setUTCMonth(month.getUTCMonth() + offset);
    return month.toISOString().slice(0, 7);
  });
}

export function parseRoundupFeed(xml: string, options: {
  source: string; articleUrl: (value: string) => string | null; acceptTitle?: (title: string) => boolean;
}): { roundups: Roundup[]; invalid: number } {
  if (xml.length > 1_500_000) throw new Error(`${options.source}_xml_size_limit`);
  const parser = new SaxesParser();
  const stack: string[] = [];
  const items: Record<string, string>[] = [];
  let item: Record<string, string> | null = null;
  let nodes = 0;
  parser.on("doctype", () => { throw new Error(`${options.source}_xml_doctype`); });
  parser.on("error", () => { throw new Error(`${options.source}_invalid_xml`); });
  parser.on("opentag", (tag) => {
    stack.push(tag.name);
    if (++nodes > 20_000 || stack.length > 32) throw new Error(`${options.source}_xml_structure_limit`);
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
  if (!items.length) throw new Error(`${options.source}_empty_feed`);
  let invalid = 0;
  const roundups: Roundup[] = [];
  for (const item of items) {
    if (options.acceptTitle && !options.acceptTitle(item.title ?? "")) continue;
    const month = roundupMonth(item.title ?? "");
    const url = options.articleUrl(item.link ?? "");
    const published = new Date(item.pubDate ?? "");
    if (!month || !url || Number.isNaN(published.valueOf())) { invalid++; continue; }
    roundups.push({ url, month, publishedAt: published.toISOString(), html: item["content:encoded"] });
  }
  return { roundups, invalid };
}

export function roundupDom(html: string, source = "roundup") {
  if (html.length > 1_500_000) throw new Error(`${source}_html_size_limit`);
  const document = parseDocument(html);
  const queue = document.children.map((node) => ({ node, depth: 0 }));
  let count = 0;
  while (queue.length) {
    const { node, depth } = queue.pop()!;
    if (++count > 20_000 || depth > 64) throw new Error(`${source}_html_structure_limit`);
    if ("children" in node) queue.push(...node.children.map((child) => ({ node: child, depth: depth + 1 })));
  }
  for (const node of DomUtils.findAll((node) => ["script", "style", "nav", "footer", "aside"].includes(node.name), document)) {
    DomUtils.removeElement(node);
  }
  return document;
}
export const normalizedRoundupText = (text: string) => text.normalize("NFKC").replace(/\s+/g, " ").trim();

export function parseRoundupArchive(html: string, articleUrl: (value: string) => string | null): Roundup[] {
  const document = roundupDom(html);
  const result = new Map<string, Roundup>();
  for (const link of DomUtils.getElementsByTagName("a", document)) {
    const month = roundupMonth(DomUtils.innerText(link));
    const url = articleUrl(link.attribs.href ?? "");
    // An archive title establishes the roundup month, not the article's publication date.
    if (month && url) result.set(url, { url, month, publishedAt: "" });
  }
  return [...result.values()];
}

export function markAmbiguousEntries(entries: RoundupEntry[]): RoundupEntry[] {
  for (const entry of entries) {
    entry.ambiguousUrls = entry.urls.filter((url) => entries.some((other) => other !== entry
      && other.title.toLowerCase() !== entry.title.toLowerCase() && other.urls.includes(url)));
    entry.urls.sort(); entry.ambiguousUrls.sort();
  }
  return entries;
}
