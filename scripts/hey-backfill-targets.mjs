const ALLOWED_FOLDERS = new Set(["imbox", "feed", "paper_trail"]);
const MAX_TARGETS = 500;

export function parseBackfillTargets(value) {
  if (value === undefined || value.trim() === "") return [];

  let parsed;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error("HEY_BACKFILL_TARGETS_JSON must be valid JSON");
  }
  if (!Array.isArray(parsed) || parsed.length < 1 || parsed.length > MAX_TARGETS) {
    throw new Error(`HEY_BACKFILL_TARGETS_JSON must contain 1-${MAX_TARGETS} targets`);
  }

  const targets = [];
  const seen = new Set();
  for (const target of parsed) {
    if (!target || typeof target !== "object" || Array.isArray(target)) {
      throw new Error("Each HEY backfill target must be an object");
    }
    const id = typeof target.id === "string" ? target.id.trim() : "";
    const folder = typeof target.folder === "string" ? target.folder.trim() : "";
    if (!id || id.length > 200 || /[\r\n\0]/.test(id)) {
      throw new Error("Each HEY backfill target requires a safe 1-200 character id");
    }
    if (!ALLOWED_FOLDERS.has(folder)) {
      throw new Error("Each HEY backfill target folder must be imbox, feed, or paper_trail");
    }

    const key = `${folder}:${id}`;
    if (!seen.has(key)) {
      seen.add(key);
      targets.push({ id, folder });
    }
  }
  return targets;
}
