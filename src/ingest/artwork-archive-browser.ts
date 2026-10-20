import { z } from "zod";
import { readBoundedJson } from "../util/http";
import { ARTWORK_ARCHIVE_GUIDE, artworkArchiveGuideUrl } from "./artwork-archive-parser";
import { PublicFetchError, type PublicTextResponse } from "./public-fetch";

const headersSchema = z.record(z.string(), z.string());
const renderedGuideSchema = z.object({
  success: z.literal(true),
  result: z.string().min(1),
  meta: z.object({
    status: z.number().int().min(200).max(599),
    finalUrl: z.string(),
    headers: headersSchema,
    redirectChain: z.array(z.object({ url: z.string(), status: z.number().int(), headers: headersSchema })).optional()
  })
});

/** One fresh, Cloudflare-hosted render of the fixed guide; no cookies, credentials, or local browser. */
export async function fetchArtworkArchiveGuide(env: Pick<Env, "BROWSER">): Promise<PublicTextResponse> {
  let response: Response;
  try {
    response = await env.BROWSER.quickAction("content", {
      url: ARTWORK_ARCHIVE_GUIDE,
      gotoOptions: { waitUntil: "networkidle2", timeout: 30_000 },
      actionTimeout: 10_000,
      cacheTTL: 0,
      // Keep navigation and subresources on the publisher's public HTTPS host.
      allowRequestPattern: ["^https://(www\\.)?artworkarchive\\.com/"]
    });
  } catch {
    // Provider exceptions can contain page content or request details.
    throw new Error("artwork_archive_browser_unavailable");
  }
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(`artwork_archive_browser_http_${response.status}`);
  }
  let raw: unknown;
  try { raw = await readBoundedJson<unknown>(response, 2_000_000); }
  catch { throw new Error("artwork_archive_browser_response"); }
  const parsed = renderedGuideSchema.safeParse(raw);
  if (!parsed.success) throw new Error("artwork_archive_browser_response");
  const { result: html, meta } = parsed.data;
  // Browser Run returns lowercase origin header names. Copy only validated diagnostic values.
  const headers = new Headers();
  const ray = meta.headers["cf-ray"];
  if (ray && /^[a-f0-9]{16,32}-[A-Z]{3}$/i.test(ray)) headers.set("cf-ray", ray);
  // Browser API success is separate from the upstream page status. Reject challenges at any status.
  if (meta.headers["cf-mitigated"] === "challenge" || /\/cdn-cgi\/challenge-platform\/|id=["']challenge-form["']|<title>\s*(?:Just a moment|Attention Required)/i.test(html)) {
    headers.set("cf-mitigated", "challenge");
  }
  if (headers.get("cf-mitigated") === "challenge" || meta.status >= 400) {
    throw new PublicFetchError(new Response(null, { status: meta.status, headers }));
  }
  const redirects = meta.redirectChain;
  if (meta.status !== 200 || !artworkArchiveGuideUrl(meta.finalUrl) || (redirects && (
    redirects.length === 0 || redirects.length > 5 || redirects.some((hop) => {
      const location = hop.headers.location;
      if (!artworkArchiveGuideUrl(hop.url) || hop.status < 300 || hop.status >= 400 || !location) return true;
      try { return !artworkArchiveGuideUrl(new URL(location, hop.url).href); }
      catch { return true; }
    })
  ))) throw new Error("artwork_archive_unverified_response");
  if (meta.headers["content-type"]?.split(";")[0]?.trim().toLowerCase() !== "text/html") {
    throw new Error("public_fetch_content_type");
  }
  if (new TextEncoder().encode(html).byteLength > 1_500_000) throw new Error("artwork_archive_browser_content_too_large");
  // Rendered DOMs are not HTTP entity bodies: never reuse origin validators for them.
  return { status: 200, finalUrl: meta.finalUrl, text: html, etag: null, lastModified: null };
}
