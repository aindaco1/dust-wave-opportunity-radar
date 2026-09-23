export const OPPORTUNITY_SECTIONS = [
  "Overview", "Eligibility", "Deadline / application window", "How to apply",
  "Materials / requirements", "Notes / watch-outs"
] as const;

const sections = OPPORTUNITY_SECTIONS.join("|");
const markedSection = new RegExp(`(^|\\s)#{1,6}[ \\t]+(${sections})(?:[ \\t]*:[ \\t]*|(?=[ \\t]*(?:\\n|$)))`, "gi");
const plainSection = new RegExp(`(^|\\n)(${sections})[ \\t]*:[ \\t]*`, "gi");

/** Repair only the generated opportunity template, never a fetched/manual page body. */
export function normalizeOpportunityMarkdown(markdown: string): string {
  return markdown
    .replace(/\r\n?/g, "\n")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(markedSection, (_match, _space, heading: string) => `\n\n## ${heading}\n\n`)
    .replace(plainSection, (_match, _space, heading: string) => `\n\n## ${heading}\n\n`)
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
