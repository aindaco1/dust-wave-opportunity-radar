import { describe, expect, it, vi } from "vitest";
import { fetchArtworkArchiveGuide } from "../src/ingest/artwork-archive-browser";
import { ARTWORK_ARCHIVE_GUIDE } from "../src/ingest/artwork-archive-parser";
import { browserResponse, guideHtml } from "./support/artwork-archive";

function setup(response = browserResponse()) {
  const quickAction = vi.fn().mockResolvedValue(response);
  return { quickAction, env: { BROWSER: { quickAction } } as unknown as Pick<Env, "BROWSER"> };
}

describe("Artwork Archive hosted browser transport", () => {
  it("renders only the fixed guide with bounded cloud navigation and discards origin validators", async () => {
    const { env, quickAction } = setup(browserResponse(guideHtml(), {
      headers: { "content-type": "text/html", etag: '"origin-v1"', "last-modified": "yesterday" }
    }));
    expect(await fetchArtworkArchiveGuide(env)).toEqual({ status: 200, finalUrl: ARTWORK_ARCHIVE_GUIDE,
      text: guideHtml(), etag: null, lastModified: null });
    const [action, options] = quickAction.mock.calls[0]!;
    expect(action).toBe("content");
    expect(options).toEqual({ url: ARTWORK_ARCHIVE_GUIDE,
      gotoOptions: { waitUntil: "networkidle2", timeout: 30_000 }, actionTimeout: 10_000, cacheTTL: 0,
      allowRequestPattern: [expect.any(String)] });
    const allowed = new RegExp(options.allowRequestPattern[0]);
    expect(allowed.test(ARTWORK_ARCHIVE_GUIDE)).toBe(true);
    for (const url of ["http://www.artworkarchive.com/", "https://artworkarchive.com.evil.test/", "https://127.0.0.1/", "https://artworkarchive.com@evil.test/"]) {
      expect(allowed.test(url)).toBe(false);
    }
  });
  it.each([200, 304, 403])("rejects an origin challenge despite API success (page status %s)", async (status) => {
    const { env } = setup(browserResponse("untrusted content", { status,
      headers: { "cf-mitigated": "challenge", "cf-ray": "0123456789abcdef-DEN" }
    }));
    await expect(fetchArtworkArchiveGuide(env)).rejects.toMatchObject({ message: "public_fetch_access_challenge",
      diagnostics: { httpStatus: status, accessChallenge: true, rayId: "0123456789abcdef-DEN" } });
  });
  it.each(['<title>Just a moment...</title>', '<form id="challenge-form">', '<script src="/cdn-cgi/challenge-platform/test">'])
    ("rejects challenge markup without challenge headers: %s", async (html) => {
      await expect(fetchArtworkArchiveGuide(setup(browserResponse(html)).env)).rejects.toThrow("public_fetch_access_challenge");
    });
  it("distinguishes origin HTTP failure from browser service failure without leaking bodies", async () => {
    await expect(fetchArtworkArchiveGuide(setup(browserResponse("untrusted content", { status: 403 })).env))
      .rejects.toThrow("public_fetch_http_403");
    const response = new Response("untrusted provider error", { status: 429 });
    const cancel = vi.spyOn(response.body!, "cancel");
    await expect(fetchArtworkArchiveGuide(setup(response).env)).rejects.toThrow("artwork_archive_browser_http_429");
    expect(cancel).toHaveBeenCalled();
    const { env, quickAction } = setup();
    quickAction.mockRejectedValueOnce(new Error("untrusted browser timeout detail"));
    await expect(fetchArtworkArchiveGuide(env)).rejects.toThrow(/^artwork_archive_browser_unavailable$/);
    await expect(fetchArtworkArchiveGuide({} as Pick<Env, "BROWSER">)).rejects.toThrow("artwork_archive_browser_unavailable");
  });
  it.each([
    { status: 304 }, { status: 302 }, { finalUrl: "https://www.artworkarchive.com/logins/sign_in" },
    { finalUrl: ARTWORK_ARCHIVE_GUIDE.replace("=5", "=3") }, { finalUrl: "http://127.0.0.1/" },
    { redirectChain: [] },
    { redirectChain: [{ url: "https://other.example/", status: 302, headers: { location: ARTWORK_ARCHIVE_GUIDE } }] },
    { redirectChain: [{ url: ARTWORK_ARCHIVE_GUIDE, status: 200, headers: { location: ARTWORK_ARCHIVE_GUIDE } }] },
    { redirectChain: [{ url: ARTWORK_ARCHIVE_GUIDE, status: 302, headers: {} }] },
    { redirectChain: [{ url: ARTWORK_ARCHIVE_GUIDE, status: 302, headers: { location: "/logins/sign_in" } }] },
    { redirectChain: [{ url: ARTWORK_ARCHIVE_GUIDE, status: 302, headers: { location: "http://[" } }] },
    { redirectChain: Array.from({ length: 6 }, () => ({ url: ARTWORK_ARCHIVE_GUIDE, status: 302, headers: { location: ARTWORK_ARCHIVE_GUIDE } })) }
  ])("fails closed on unverified status, scope, or redirect history: %j", async (meta) => {
    await expect(fetchArtworkArchiveGuide(setup(browserResponse(guideHtml(), meta)).env)).rejects.toThrow("artwork_archive_unverified_response");
  });
  it("accepts verified canonical redirects that retain the same filter", async () => {
    const { env } = setup(browserResponse(guideHtml(), { redirectChain: [{
      url: ARTWORK_ARCHIVE_GUIDE.replace("www.", ""), status: 301, headers: { location: ARTWORK_ARCHIVE_GUIDE }
    }] }));
    expect((await fetchArtworkArchiveGuide(env)).status).toBe(200);
  });
  it.each(["untrusted invalid JSON", JSON.stringify({ success: false, result: "untrusted content" }),
    JSON.stringify({ success: true, result: guideHtml(), meta: { status: 200 } })])
    ("rejects invalid envelopes or missing navigation evidence without surfacing the payload", async (body) => {
      await expect(fetchArtworkArchiveGuide(setup(new Response(body)).env)).rejects.toThrow(/^artwork_archive_browser_response$/);
    });
  it("enforces both response and decoded HTML byte caps and HTML content type", async () => {
    await expect(fetchArtworkArchiveGuide(setup(new Response("x".repeat(2_000_001))).env)).rejects.toThrow("artwork_archive_browser_response");
    await expect(fetchArtworkArchiveGuide(setup(browserResponse("é".repeat(750_001))).env)).rejects.toThrow("artwork_archive_browser_content_too_large");
    await expect(fetchArtworkArchiveGuide(setup(browserResponse(guideHtml(), { headers: {} })).env)).rejects.toThrow("public_fetch_content_type");
    await expect(fetchArtworkArchiveGuide(setup(browserResponse(guideHtml(), { headers: { "content-type": "application/json" } })).env))
      .rejects.toThrow("public_fetch_content_type");
  });
});
