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
  const ranked = [...urls].filter(isSafePublicUrl).sort((left, right) => scoreUrl(right) - scoreUrl(left));
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

async function fetchFollowingSafeRedirects(initialUrl: string): Promise<Response | null> {
  let currentUrl = initialUrl;
  const signal = AbortSignal.timeout(12_000);
  for (let redirectCount = 0; redirectCount <= 5; redirectCount += 1) {
    if (!isSafePublicUrl(currentUrl)) return null;
    const response = await fetch(currentUrl, {
      redirect: "manual",
      headers: {
        Accept: "text/html,text/plain;q=0.9,*/*;q=0.1",
        "User-Agent": "DustwaveOpportunityRadar/0.1 (+https://dustwave.xyz)"
      },
      signal
    });
    if (response.status < 300 || response.status >= 400) return response;

    const location = response.headers.get("location");
    await response.body?.cancel();
    if (!location || redirectCount === 5) return null;
    currentUrl = new URL(location, currentUrl).toString();
  }
  return null;
}

export function isSafePublicUrl(value: string): boolean {
  try {
    const url = new URL(value);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) return false;
    if (url.port && !["80", "443"].includes(url.port)) return false;
    const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
    if (
      host === "localhost" ||
      host === "0.0.0.0" ||
      host === "169.254.169.254" ||
      host.endsWith(".local") ||
      host.endsWith(".internal")
    ) {
      return false;
    }
    if (/^127\./.test(host) || /^10\./.test(host) || /^192\.168\./.test(host)) return false;
    const private172 = host.match(/^172\.(\d+)\./);
    if (private172 && Number(private172[1]) >= 16 && Number(private172[1]) <= 31) return false;
    if (
      host === "::1" ||
      host.startsWith("fc") ||
      host.startsWith("fd") ||
      host.startsWith("fe80:") ||
      /^::ffff:(127\.|10\.|192\.168\.|172\.(?:1[6-9]|2\d|3[01])\.)/.test(host)
    ) return false;
    return true;
  } catch {
    return false;
  }
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
