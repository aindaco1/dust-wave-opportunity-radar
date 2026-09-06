import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { checkDocumentation } from "../scripts/check-docs.mjs";

const temporaryRoots: string[] = [];

function fixture(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "radar-docs-"));
  temporaryRoots.push(root);
  for (const [file, content] of Object.entries(files)) {
    const path = join(root, file);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content);
  }
  return root;
}

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("documentation validation", () => {
  it("rejects a stale setup heading even when the target Markdown file exists", () => {
    const root = fixture({
      "docs/NOTION.md": "See [Setup](SETUP.md#5-notion).",
      "docs/SETUP.md": "# Setup\n\n## 6. Notion\n"
    });
    expect(checkDocumentation(root, []).errors).toEqual([
      "docs/NOTION.md: broken local heading anchor SETUP.md#5-notion"
    ]);
    writeFileSync(join(root, "docs/NOTION.md"), "See [Setup](SETUP.md#6-notion).");
    expect(checkDocumentation(root, []).errors).toEqual([]);
  });

  it("accepts cross-file and same-page headings with punctuation, inline code, and repeats", () => {
    const root = fixture({
      "README.md": "[Recovery](docs/HEY-CLI.md#production-recovery-acceptance--september-4-2026-americadenver)\n[API](docs/API.md#post-adminnotiontrash)",
      "docs/HEY-CLI.md": "## Production recovery acceptance — September 4, 2026 (America/Denver)\n",
      "docs/API.md": "## `POST /admin/notion/trash`\n## Recovery\n## Recovery\n## Recovery-1\n[First](#recovery) [Second](#recovery-1) [Collision](#recovery-1-1)"
    });
    expect(checkDocumentation(root, [])).toEqual({ errors: [], markdownFileCount: 3 });
    writeFileSync(join(root, "docs/API.md"), "## Recovery\n[Missing](#recovery-2)");
    expect(checkDocumentation(root, []).errors).toContain("docs/API.md: broken local heading anchor #recovery-2");
  });

  it("ignores fenced examples as links and headings, including nested shorter fences", () => {
    const root = fixture({
      "README.md": "# Guide\n````md\n```md\n## Example only\n[Example](absent.md)\n```\n````\n~~~md\n## Another example\n[Example](absent.md)\n~~~\n[Invalid](#example-only)\n[Also invalid](#another-example)"
    });
    expect(checkDocumentation(root, []).errors).toEqual([
      "README.md: broken local heading anchor #example-only",
      "README.md: broken local heading anchor #another-example"
    ]);
  });

  it("preserves file checks, decodes local paths and anchors, and ignores external links", () => {
    const root = fixture({
      "README.md": "[Local](docs/Guide%20Notes.md#caf%C3%A9)\n[Missing](absent.md#section)\n[External](https://example.org/#missing)\n[Mail](mailto:example@example.org)",
      "docs/Guide Notes.md": "## Café\n"
    });
    expect(checkDocumentation(root, []).errors).toEqual(["README.md: broken local link absent.md#section"]);
  });

  it("requires current guides at their canonical paths", () => {
    const root = fixture({ "CONTRIBUTING.md": "# Old location\n" });
    const { errors } = checkDocumentation(root);
    for (const file of ["docs/CONTRIBUTING.md", "docs/COLOSSAL.md", "docs/HEY-CLI.md", "NOTICE.md"]) {
      expect(errors).toContain(`Missing required documentation: ${file}`);
    }
    expect(errors).not.toContain("Missing required documentation: CONTRIBUTING.md");
  });
});
