import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, extname, join, normalize, relative, resolve } from "node:path";

const root = process.cwd();
const required = [
  "AGENTS.md",
  "README.md",
  "CONTRIBUTING.md",
  "docs/API.md",
  "docs/README.md",
  "docs/ARCHITECTURE.md",
  "docs/CLASSIFICATION.md",
  "docs/CODEX-HANDOFF.md",
  "docs/CONFIGURATION.md",
  "docs/DATA-MODEL.md",
  "docs/DECISIONS.md",
  "docs/NOTION.md",
  "docs/OPERATIONS.md",
  "docs/SECURITY.md",
  "docs/SETUP.md",
  "docs/TESTING.md",
  "docs/TROUBLESHOOTING.md"
];
const ignoredDirectories = new Set([".git", "coverage", "node_modules"]);
const errors = [];

for (const file of required) {
  if (!existsSync(join(root, file))) errors.push(`Missing required documentation: ${file}`);
}

const markdownFiles = walk(root).filter((file) => extname(file).toLowerCase() === ".md");
for (const file of markdownFiles) {
  const source = readFileSync(file, "utf8");
  const label = relative(root, file);
  if (source.includes("retain a short automation history")) {
    errors.push(`${label}: describes the removed visible automation history`);
  }
  for (const match of source.matchAll(/!?\[[^\]]*\]\(([^)]+)\)/g)) {
    const raw = match[1]?.trim() ?? "";
    const target = raw.startsWith("<")
      ? raw.slice(1, raw.indexOf(">"))
      : raw.split(/\s+["']/)[0] ?? "";
    if (!target || /^(?:https?:|mailto:|#)/i.test(target)) continue;
    const decoded = decodeURIComponent(target.split("#")[0] ?? "");
    if (!decoded) continue;
    const destination = resolve(dirname(file), decoded);
    if (!existsSync(destination)) errors.push(`${label}: broken local link ${target}`);
  }
}

if (errors.length) {
  for (const error of errors) console.error(`- ${error}`);
  process.exitCode = 1;
} else {
  console.log(`Documentation check passed (${markdownFiles.length} Markdown files).`);
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
