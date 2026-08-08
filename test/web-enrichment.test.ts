import { afterEach, describe, expect, it, vi } from "vitest";
import { enrichCandidateUrls, isSafePublicUrl, rankCandidateUrls } from "../src/ingest/web-enrichment";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function responseAt(url: string, body: BodyInit | null, init: ResponseInit = {}): Response {
  const response = new Response(body, init);
  Object.defineProperty(response, "url", { value: url });
  return response;
}

describe("web enrichment SSRF guard", () => {
  it("accepts ordinary public HTTPS URLs", () => {
    expect(isSafePublicUrl("https://example.org/open-call")).toBe(true);
  });

  it.each([
    "http://127.0.0.1/admin",
    "http://10.0.0.1/",
    "http://192.168.1.2/",
    "http://172.16.0.1/",
    "http://169.254.169.254/latest/meta-data",
    "http://localhost:8787/",
    "http://example.org:8787/",
    "http://anything.local/",
    "https://service.internal/",
    "http://[::1]/",
    "http://[fe80::1]/",
    "file:///etc/passwd",
    "https://user:password@example.org/"
  ])("rejects unsafe URL %s", (url) => {
    expect(isSafePublicUrl(url)).toBe(false);
  });
});

describe("web enrichment ranking", () => {
  it("prefers a redirecting email link over image-host assets", () => {
    const ranked = rankCandidateUrls([
      "https://storage.googleapis.com/community/logo.png",
      "https://email.example.org/c/opaque-tracking-link"
    ]);

    expect(ranked[0]).toContain("email.example.org");
  });

  it("deduplicates candidate URLs", () => {
    expect(rankCandidateUrls(["https://example.org/call", "https://example.org/call"])).toEqual(["https://example.org/call"]);
  });
});

describe("web enrichment fetching", () => {
  it("follows a safe redirect and extracts title and visible text", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(null, { status: 302, headers: { location: "/open-call" } }))
      .mockResolvedValueOnce(responseAt(
        "https://example.org/open-call",
        "<title>Film &amp; Art Call</title><script>ignore()</script><h1>Applications open</h1>",
        { status: 200, headers: { "content-type": "text/html; charset=utf-8" } }
      ));
    vi.stubGlobal("fetch", fetchMock);
    await expect(enrichCandidateUrls(["https://example.org/redirect"])).resolves.toEqual([{
      requestedUrl: "https://example.org/redirect",
      finalUrl: "https://example.org/open-call",
      title: "Film & Art Call",
      text: expect.stringContaining("Applications open")
    }]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({ redirect: "manual" });
  });

  it("stops when a redirect targets a private address", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, {
      status: 302,
      headers: { location: "http://127.0.0.1/admin" }
    }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(enrichCandidateUrls(["https://example.org/redirect"])).resolves.toEqual([]);
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("ignores non-text and failed responses", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(responseAt("https://example.org/file.pdf", "PDF", {
        status: 200,
        headers: { "content-type": "application/pdf" }
      }))
      .mockResolvedValueOnce(responseAt("https://example.org/missing", "missing", {
        status: 404,
        headers: { "content-type": "text/plain" }
      }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(enrichCandidateUrls(["https://example.org/file.pdf", "https://example.org/missing"])).resolves.toEqual([]);
  });

  it("fetches at most the three highest-ranked public pages", async () => {
    const fetchMock = vi.fn(async (url: string) => responseAt(url, "Call details", {
      status: 200,
      headers: { "content-type": "text/plain" }
    }));
    vi.stubGlobal("fetch", fetchMock);
    const pages = await enrichCandidateUrls([
      "https://example.org/news",
      "https://example.org/open-call",
      "https://example.org/grant",
      "https://example.org/fellowship"
    ]);
    expect(pages).toHaveLength(3);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(pages.map((page) => page.requestedUrl)).not.toContain("https://example.org/news");
  });
});
