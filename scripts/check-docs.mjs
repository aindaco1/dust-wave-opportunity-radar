import { checkDocumentation as checkMarkdown } from "@dustwave/test-core/documentation";
import { readdirSync, statSync } from "node:fs";
import { extname, join, normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const required = [
  "AGENTS.md",
  "README.md",
  "NOTICE.md",
  "docs/API.md",
  "docs/README.md",
  "docs/ARCHITECTURE.md",
  "docs/ARTWORK-ARCHIVE.md",
  "docs/CLASSIFICATION.md",
  "docs/CODEX-HANDOFF.md",
  "docs/COLOSSAL.md",
  "docs/CONFIGURATION.md",
  "docs/CONTRIBUTING.md",
  "docs/DATA-MODEL.md",
  "docs/DECISIONS.md",
  "docs/HEY-CLI.md",
  "docs/HYPERALLERGIC.md",
  "docs/NOTION.md",
  "docs/JEV-EVALUATION.md",
  "docs/OPERATIONS.md",
  "docs/SECURITY.md",
  "docs/SETUP.md",
  "docs/TESTING.md",
  "docs/TROUBLESHOOTING.md"
];
const ignoredDirectories = new Set([".git", "coverage", "node_modules", ".jev-results"]);

export function checkDocumentation(root, requiredFiles = required) {
  const files = walk(root).filter(file => extname(file).toLowerCase() === ".md");
  const { errors, markdownFileCount } = checkMarkdown({ root, files, requiredFiles,
    validateSource: (source, label) => source.includes("retain a short automation history")
      ? [`${label}: describes the removed visible automation history`] : []
  });
  return { errors, markdownFileCount };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { errors, markdownFileCount } = checkDocumentation(process.cwd());
  if (errors.length) {
    for (const error of errors) console.error(`- ${error}`);
    process.exitCode = 1;
  } else {
    console.log(`Documentation check passed (${markdownFileCount} Markdown files).`);
  }
}

function walk(directory) {
  const files = [];
  for (const entry of readdirSync(directory)) {
    if (ignoredDirectories.has(entry)) continue;
    const path = normalize(join(directory, entry));
    if (statSync(path).isDirectory()) files.push(...walk(path));
    else files.push(path);
  }
  return files;
}
