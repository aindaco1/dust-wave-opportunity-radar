import { describe, expect, it } from "vitest";
import {
  extractHeyAttachmentList,
  extractHeySearchTopicIds,
  inspectHeyAttachmentFidelity
} from "../scripts/hey-cli-fidelity.mjs";

function embeddedHtml(content: string): string {
  const metadata = JSON.stringify({ contentType: "text/html", content, data: "{}" })
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
  return `<figure data-trix-attachment="${metadata}"></figure>`;
}

function blob(filename: string): string {
  return `https://app.hey.com/rails/active_storage/blobs/redirect/signed-value/${filename}`;
}

describe("HEY CLI identity extraction", () => {
  it("uses stable topic IDs instead of posting IDs and deduplicates them", () => {
    expect(extractHeySearchTopicIds({
      ok: true,
      data: [
        { id: 1001, topic_id: 9001 },
        { id: 1002, topic_id: 9001 },
        { id: 1003, topic_id: "9002" }
      ]
    })).toEqual(["9001", "9002"]);
  });

  it("fails closed when a search result has no usable topic ID", () => {
    expect(() => extractHeySearchTopicIds({ ok: true, data: [{ id: 1001 }] })).toThrow("topic_id");
    expect(() => extractHeySearchTopicIds({ ok: false, data: [] })).toThrow("successful data array");
  });

  it("requires a successful attachment-list array", () => {
    expect(extractHeyAttachmentList({ ok: true, data: [{ filename: "call.pdf" }] })).toHaveLength(1);
    expect(() => extractHeyAttachmentList({ ok: true, data: 0 })).toThrow("successful data array");
  });

  it.each([0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, Infinity, {}, "1".repeat(201)])("rejects lossy or invalid topic identity %s", (topic_id) => {
    expect(() => extractHeySearchTopicIds({ ok: true, data: [{ topic_id }] })).toThrow("topic_id");
  });

  it("preserves a large exact decimal ID supplied as a string", () => {
    expect(extractHeySearchTopicIds({ ok: true, data: [{ topic_id: "9007199254740993" }] }))
      .toEqual(["9007199254740993"]);
  });
});

describe("HEY CLI attachment fidelity", () => {
  it("accepts an attachment-free message when neither source nor CLI reports files", () => {
    expect(inspectHeyAttachmentFidelity({ html: "<p>Just text</p>", attachments: [] })).toMatchObject({
      complete: true,
      evidenceCount: 0,
      listedCount: 0
    });
  });

  it("accepts a normal Trix attachment when the CLI lists the same file", () => {
    const metadata = JSON.stringify({ url: blob("prospectus.pdf"), filename: "Prospectus.pdf", contentType: "application/pdf" })
      .replaceAll('"', "&quot;");
    const result = inspectHeyAttachmentFidelity({
      html: `<figure data-trix-attachment="${metadata}"></figure>`,
      attachments: [{ filename: "prospectus.pdf" }]
    });
    expect(result).toMatchObject({ complete: true, evidenceCount: 1, listedCount: 1, missingEvidenceCount: 0 });
  });

  it("blocks a PDF hidden inside an embedded text/html attachment", () => {
    const result = inspectHeyAttachmentFidelity({
      html: embeddedHtml(`<a href="${blob("application.pdf")}">Application</a>`),
      attachments: []
    });
    expect(result).toMatchObject({
      complete: false,
      evidenceCount: 1,
      listedCount: 0,
      missingEvidenceCount: 1,
      reasons: ["attachment_evidence_missing_from_cli"]
    });
  });

  it("keeps proxied inline images separate from downloadable attachments", () => {
    const html = embeddedHtml(`<shadow-content><template>
      <action-text-attachment content-type="image" url="https://gopher.hey.com/signed/logo.png"></action-text-attachment>
      <action-text-attachment content-type="application/pdf" filename="application.pdf" url="${blob("application.pdf")}"></action-text-attachment>
    </template></shadow-content>`);
    expect(inspectHeyAttachmentFidelity({ html, attachments: [{ filename: "application.pdf" }] })).toMatchObject({
      complete: true, evidenceCount: 1, missingEvidenceCount: 0
    });
    expect(inspectHeyAttachmentFidelity({ html, attachments: [] })).toMatchObject({
      complete: false, evidenceCount: 1, missingEvidenceCount: 1
    });
  });

  it.each([
    '<action-text-attachment content-type="image" filename="artwork.png" url="https://gopher.hey.com/signed/artwork.png"></action-text-attachment>',
    `<action-text-attachment content-type="image" url="${blob("artwork.png")}"></action-text-attachment>`,
    '<action-text-attachment content-type="image" url="https://example.org/application.pdf"></action-text-attachment>',
    '<action-text-attachment content-type="application/pdf" url="https://gopher.hey.com/signed/call.pdf"></action-text-attachment>'
  ])("still detects files adjacent to the inline-image exception", (html) => {
    expect(inspectHeyAttachmentFidelity({ html, attachments: [] })).toMatchObject({
      complete: false, evidenceCount: 1, missingEvidenceCount: 1
    });
  });

  it("counts multiple PDF and DOCX files while collapsing duplicate links", () => {
    const pdf = blob("requirements.pdf");
    const docx = blob("application.docx");
    const result = inspectHeyAttachmentFidelity({
      html: embeddedHtml(`<a href="${pdf}">Preview</a><a href="${pdf}">requirements.pdf</a><a href="${docx}">application.docx</a>`),
      attachments: [{ filename: "requirements.pdf" }]
    });
    expect(result).toMatchObject({
      complete: false,
      evidenceCount: 2,
      listedCount: 1,
      missingEvidenceCount: 1
    });
  });

  it("blocks explicit attachment metadata with an unsafe URL", () => {
    const result = inspectHeyAttachmentFidelity({
      html: '<action-text-attachment filename="call.pdf" content-type="application/pdf" url="javascript:alert(1)"></action-text-attachment>',
      attachments: [{ filename: "call.pdf" }]
    });
    expect(result).toMatchObject({
      complete: false,
      unsafeEvidenceCount: 1,
      reasons: ["attachment_evidence_missing_from_cli", "unsafe_attachment_url"]
    });
  });

  it("blocks malformed attachment metadata that still advertises a file", () => {
    const result = inspectHeyAttachmentFidelity({
      html: '<figure data-trix-attachment="application/pdf broken"></figure>',
      attachments: []
    });
    expect(result).toMatchObject({
      complete: false,
      malformedMetadataCount: 1,
      reasons: ["malformed_attachment_metadata"]
    });
  });
});
