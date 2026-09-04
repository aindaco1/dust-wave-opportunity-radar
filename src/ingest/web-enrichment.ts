import { fetchFollowingSafeRedirects, isSafePublicUrl } from "./public-fetch";
export { isSafePublicUrl } from "./public-fetch";
import { htmlToText } from "../email/parse";
import { readBoundedText } from "../util/http";
import { logError } from "../util/log";

const MAX_PAGES = 3;
const MAX_PAGE_BYTES = 1_500_000;

export interface EnrichedPage {
  requestedUrl: string;
  finalUrl: string;
  title?: string;
  text: string;
}

export async function enrichCandidateUrls(urls: string[]): Promise<EnrichedPage[]> {
  const ranked = rankCandidateUrls(urls);
  const pages: EnrichedPage[] = [];
  for (const url of ranked.slice(0, MAX_PAGES)) {
    try {
      const page = await fetchPage(url);
      if (page) pages.push(page);
    } catch (error) {
      logError("web_enrichment_failed", error, { url });
    }
  }
  return pages;
}

export function rankCandidateUrls(urls: string[]): string[] {
  return [...new Set(urls)]
    .filter(isSafePublicUrl)
    .sort((left, right) => scoreUrl(right) - scoreUrl(left));
}

async function fetchPage(url: string): Promise<EnrichedPage | null> {
  const response = await fetchFollowingSafeRedirects(url);
  if (!response) return null;
  if (!response.ok || !isSafePublicUrl(response.url)) {
    await response.body?.cancel();
    return null;
  }
  const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
  if (!contentType.includes("text/html") && !contentType.includes("text/plain")) {
    await response.body?.cancel();
    return null;
  }
  const body = await readBoundedText(response, MAX_PAGE_BYTES);
  const title = contentType.includes("text/html")
    ? decodeEntities(body.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? "").trim()
    : undefined;
  return {
    requestedUrl: url,
    finalUrl: response.url,
    title: title || undefined,
    text: (contentType.includes("text/html") ? htmlToText(body) : body).slice(0, 30_000)
  };
}


function scoreUrl(value: string): number {
  const lower = value.toLowerCase();
  let score = 0;
  for (const token of [
    "apply",
    "application",
    "opportunity",
    "open-call",
    "call-for",
    "grant",
    "fund",
    "residency",
    "fellowship",
    "festival",
    "submittable",
    "filmfreeway",
    "deadline"
  ]) {
    if (lower.includes(token)) score += 3;
  }
  if (lower.includes("storage.googleapis.com/")) score -= 8;
  if (/\.(?:avif|gif|jpe?g|png|svg|webp|ico)(?:[?#]|$)/.test(lower)) score -= 10;
  if (/lnk|click|track|redirect/.test(lower)) score -= 4;
  return score;
}

function decodeEntities(value: string): string {
  return value
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#(?:39|x27);/gi, "'")
    .replace(/&nbsp;/gi, " ");
}
