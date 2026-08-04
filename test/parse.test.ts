import { zipSync, strToU8 } from "fflate";
import { describe, expect, it } from "vitest";
import { canonicalizeUrl, extractUrls, htmlToText, parseDocxText, parsePdfText } from "../src/email/parse";

describe("message parsing", () => {
  it("converts email HTML to compact text", () => {
    expect(htmlToText("<style>x{}</style><h1>Open Call</h1><p>Apply &amp; submit.</p>"))
      .toContain("Open Call");
  });

  it("canonicalizes and deduplicates opportunity URLs", () => {
    const urls = extractUrls(
      "Apply https://Example.com/call/?utm_source=email#deadline and https://example.com/call/ unsubscribe https://x.test/unsubscribe"
    );
    expect(urls).toEqual(["https://example.com/call"]);
    expect(canonicalizeUrl("javascript:alert(1)")).toBeNull();
  });

  it("extracts DOCX document text", async () => {
    const docx = zipSync({
      "[Content_Types].xml": strToU8("<Types/>"),
      "word/document.xml": strToU8(
        "<w:document><w:body><w:p><w:r><w:t>Photography open call</w:t></w:r></w:p><w:p><w:r><w:t>Deadline October 1</w:t></w:r></w:p></w:body></w:document>"
      )
    });
    await expect(parseDocxText(docx)).resolves.toContain("Photography open call");
  });

  it("extracts PDF text with the serverless PDF.js build", async () => {
    const pdf = buildSimplePdf("Film grant applications open September 1");
    await expect(parsePdfText(pdf)).resolves.toContain("Film grant applications open September 1");
  });
});

function buildSimplePdf(text: string): Uint8Array {
  const escaped = text.replaceAll("\\", "\\\\").replaceAll("(", "\\(").replaceAll(")", "\\)");
  const stream = `BT /F1 18 Tf 72 720 Td (${escaped}) Tj ET`;
  const objects = [
    "1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n",
    "2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n",
    "3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>\nendobj\n",
    "4 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\n",
    `5 0 obj\n<< /Length ${stream.length} >>\nstream\n${stream}\nendstream\nendobj\n`
  ];
  let pdf = "%PDF-1.4\n";
  const offsets = [0];
  for (const object of objects) {
    offsets.push(new TextEncoder().encode(pdf).byteLength);
    pdf += object;
  }
  const xref = new TextEncoder().encode(pdf).byteLength;
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets.slice(1)) pdf += `${String(offset).padStart(10, "0")} 00000 n \n`;
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return new TextEncoder().encode(pdf);
}
