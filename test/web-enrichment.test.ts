import { describe, expect, it } from "vitest";
import { isSafePublicUrl, rankCandidateUrls } from "../src/ingest/web-enrichment";

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
});
