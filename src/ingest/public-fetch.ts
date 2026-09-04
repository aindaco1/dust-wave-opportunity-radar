import { readBoundedText } from "../util/http";

export async function fetchFollowingSafeRedirects(
  initialUrl: string,
  options: { accept?: string; etag?: string; lastModified?: string } = {}
): Promise<Response | null> {
  let currentUrl = initialUrl;
  const signal = AbortSignal.timeout(12_000);
  for (let redirectCount = 0; redirectCount <= 5; redirectCount += 1) {
    if (!isSafePublicUrl(currentUrl)) return null;
    const response = await fetch(currentUrl, {
      redirect: "manual",
      headers: {
        Accept: options.accept ?? "text/html,text/plain;q=0.9,*/*;q=0.1",
        ...(currentUrl === initialUrl && options.etag ? { "If-None-Match": options.etag } : {}),
        ...(currentUrl === initialUrl && options.lastModified ? { "If-Modified-Since": options.lastModified } : {}),
        "User-Agent": "DustwaveOpportunityRadar/0.1 (+https://dustwave.xyz)"
      },
      signal
    });
    if (response.status === 304 || response.status < 300 || response.status >= 400) return response;

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

export interface PublicTextResponse {
  status: number;
  finalUrl: string;
  text: string;
  etag: string | null;
  lastModified: string | null;
}

export async function fetchPublicText(
  url: string,
  options: { contentTypes: readonly string[]; etag?: string; lastModified?: string; maxBytes?: number }
): Promise<PublicTextResponse> {
  const response = await fetchFollowingSafeRedirects(url, {
    accept: options.contentTypes.join(","), etag: options.etag, lastModified: options.lastModified
  });
  if (!response) throw new Error("public_fetch_unsafe_redirect");
  if (!isSafePublicUrl(response.url)) {
    await response.body?.cancel();
    throw new Error("public_fetch_unsafe_url");
  }
  const metadata = {
    status: response.status, finalUrl: response.url,
    etag: response.headers.get("etag"), lastModified: response.headers.get("last-modified")
  };
  if (response.status === 304) {
    await response.body?.cancel();
    return { ...metadata, text: "" };
  }
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(`public_fetch_http_${response.status}`);
  }
  const contentType = response.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase();
  if (!contentType || !options.contentTypes.includes(contentType)) {
    await response.body?.cancel();
    throw new Error("public_fetch_content_type");
  }
  return { ...metadata, text: await readBoundedText(response, options.maxBytes ?? 1_500_000) };
}
