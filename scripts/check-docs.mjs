import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, extname, join, normalize, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const required = [
  "AGENTS.md",
  "README.md",
  "NOTICE.md",
  "docs/API.md",
  "docs/README.md",
  "docs/ARCHITECTURE.md",
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
  "docs/OPERATIONS.md",
  "docs/SECURITY.md",
  "docs/SETUP.md",
  "docs/TESTING.md",
  "docs/TROUBLESHOOTING.md"
];
const ignoredDirectories = new Set([".git", "coverage", "node_modules"]);

export function checkDocumentation(root, requiredFiles = required) {
  const errors = [];
  const anchorsByFile = new Map();
  for (const file of requiredFiles) {
    if (!existsSync(join(root, file))) errors.push(`Missing required documentation: ${file}`);
  }

  const markdownFiles = walk(root).filter((file) => extname(file).toLowerCase() === ".md");
  for (const file of markdownFiles) {
    const source = readFileSync(file, "utf8");
    const label = relative(root, file);
    if (source.includes("retain a short automation history")) {
      errors.push(`${label}: describes the removed visible automation history`);
    }
    for (const match of withoutFencedCode(source).matchAll(/!?\[[^\]]*\]\(([^)]+)\)/g)) {
      const raw = match[1]?.trim() ?? "";
      const target = raw.startsWith("<")
        ? raw.slice(1, raw.indexOf(">"))
        : raw.split(/\s+["']/)[0] ?? "";
      if (!target || /^(?:[a-z][a-z\d+.-]*:|\/\/)/i.test(target)) continue;
      const fragmentStart = target.indexOf("#");
      const path = fragmentStart < 0 ? target : target.slice(0, fragmentStart);
      const anchor = fragmentStart < 0 ? "" : decodeURIComponent(target.slice(fragmentStart + 1));
      const destination = path ? resolve(dirname(file), decodeURIComponent(path)) : file;
      if (!existsSync(destination)) {
        errors.push(`${label}: broken local link ${target}`);
        continue;
      }
      if (!anchor || extname(destination).toLowerCase() !== ".md") continue;
      if (!anchorsByFile.has(destination)) {
        anchorsByFile.set(destination, headingAnchors(readFileSync(destination, "utf8")));
      }
      if (!anchorsByFile.get(destination).has(anchor)) {
        errors.push(`${label}: broken local heading anchor ${target}`);
      }
    }
  }
  return { errors, markdownFileCount: markdownFiles.length };
}

function withoutFencedCode(source) {
  let fence = null;
  return source.split(/\r?\n/).map((line) => {
    const marker = line.match(/^ {0,3}(`{3,}|~{3,})(.*)$/);
    if (fence) {
      if (marker && marker[1][0] === fence[0] && marker[1].length >= fence.length && !marker[2].trim()) {
        fence = null;
      }
      return "";
    }
    if (marker) {
      fence = marker[1];
      return "";
    }
    return line;
  }).join("\n");
}

function headingAnchors(source) {
  const anchors = new Set();
  // Repository docs use ATX headings. Keep Unicode letters and underscores,
  // remove punctuation/inline-code markers, and reserve repeated slugs in order.
  for (const line of withoutFencedCode(source).split("\n")) {
    const heading = line.match(/^ {0,3}#{1,6}[ \t]+(.+?)\s*$/);
    if (!heading) continue;
    const slug = heading[1].replace(/[ \t]+#+$/, "")
      .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
      .replace(/<[^>]+>/g, "")
      .toLowerCase()
      .replace(/[^\p{L}\p{M}\p{N}\p{Pc}\s-]/gu, "")
      .replace(/\s/g, "-");
    let anchor = slug;
    for (let suffix = 1; anchors.has(anchor); suffix += 1) anchor = `${slug}-${suffix}`;
    anchors.add(anchor);
  }
  return anchors;
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
