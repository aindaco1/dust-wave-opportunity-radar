import { escapeHtml } from "@dustwave/digest-core";
import { localBatchSlot } from "../util/dates";

export const MEMBER_NOTICE = "For active Dust Wave members only. This includes our internal business info, so please don’t forward it or share it outside the collective.";
export interface RichText { plain_text?: string; text?: { content: string; link?: { url: string } | null }; href?: string | null }
export interface Opportunity {
  id: string; name: string; website: string | null; notionUrl: string;
  type: string; tags: string[]; due: string | null; opens: string | null;
  typeColor?: string; tagColors?: Record<string, string>;
  archived?: boolean; summary?: string; note?: string;
}
export interface Contact { name: string; email: string; phone?: string }
export interface Newsletter {
  day: string; timezone: string; intro: RichText[]; contact: Contact;
  opportunities: Opportunity[];
  browseViews?: { types: string; tags: string };
}
export const plainText = (items: RichText[]) => items.map(item => item.plain_text ?? item.text?.content ?? "").join("");
export function safeUrl(value: string | null | undefined): string | null {
  if (!value) return null;
  try { const url = new URL(value); return ["https:", "http:"].includes(url.protocol) && !url.username && !url.password ? url.href : null; }
  catch { return null; }
}
export function dayOf(value: string, timezone: string): string {
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    if (new Date(value).toISOString().slice(0, 10) !== value) throw new Error("invalid_date");
    return value;
  }
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) throw new Error("invalid_date");
  return localBatchSlot(date, timezone).dateLabel;
}
export function addDays(day: string, count: number): string {
  return new Date(Date.parse(day + "T12:00:00Z") + count * 86400000).toISOString().slice(0, 10);
}
export function selectOpportunities(items: Opportunity[], now: Date, timezone: string): Opportunity[] {
  const today = localBatchSlot(now, timezone).dateLabel;
  const lastDay = addDays(today, 31);
  const selected = items.filter(item => {
    if (item.archived || !item.due || item.tags.some(tag => tag.trim().toLowerCase() === "rolling")) return false;
    const due = dayOf(item.due, timezone);
    if (due < today || due > lastDay) return false;
    if (item.due.length > 10 && Date.parse(item.due) < now.getTime()) return false;
    if (item.opens && (dayOf(item.opens, timezone) > today || (item.opens.length > 10 && Date.parse(item.opens) > now.getTime()))) return false;
    return true; // Done deliberately has no effect on newsletter eligibility.
  });
  return [...new Map(selected.map(item => [item.id, item])).values()].sort((a, b) =>
    dayOf(a.due!, timezone).localeCompare(dayOf(b.due!, timezone)) || filmRelevance(b) - filmRelevance(a) || a.due!.localeCompare(b.due!) || a.name.localeCompare(b.name));
}
export function filmRelevance(item: Opportunity): number {
  const tags = item.tags.map(tag => tag.toLowerCase());
  const title = item.name.toLowerCase();
  if (tags.includes("film") || /\b(film|filmmaker|filmmaking|cinema|cinematography)\b/.test(title)) return 3;
  if (tags.some(tag => ["feature", "short", "documentary", "animation", "screenplay", "finishing funds", "post-production"].includes(tag)) || ["Screening", "Completion Funds"].includes(item.type)) return 2;
  if (tags.includes("tv") || /\b(screenwriting|screenwriter|directing)\b/.test(title)) return 1;
  return 0;
}
function dateLabel(value: string | null, timezone: string): string {
  if (!value) return "Not listed";
  const timed = value.length > 10;
  return new Intl.DateTimeFormat("en-US", {
    timeZone: timed ? timezone : "UTC", month: "short", day: "numeric", year: "numeric",
    ...(timed ? { hour: "numeric", minute: "2-digit", timeZoneName: "short" } as const : {})
  }).format(new Date(timed ? value : value + "T12:00:00Z"));
}
export function businessIntro(description: RichText[]): RichText[] {
  const text = plainText(description);
  const start = text.indexOf("Dust Wave Biz Info");
  if (start < 0) throw new Error("newsletter_business_intro_missing");
  let offset = 0;
  return description.flatMap(item => {
    const content = plainText([item]); const end = offset + content.length;
    const kept = content.slice(Math.max(0, start - offset)); offset = end;
    return end > start ? [{ ...item, plain_text: kept, text: { content: kept, link: item.text?.link } }] : [];
  });
}

function renderBusinessInfo(description: RichText[]): { html: string; text: string } {
  // Rich-text runs can split a label or place its URL on the following line.
  const lines: RichText[][] = [[]];
  for (const run of description) {
    plainText([run]).split(/\r?\n/).forEach((content, index) => {
      if (index) lines.push([]);
      lines.at(-1)!.push({ ...run, plain_text: content });
    });
  }
  const visible = lines.filter(line => {
    const text = plainText(line).trim();
    return text && text !== "Dust Wave Biz Info" && !/^(?:biz|business)\s+licen[cs]e\b/i.test(text);
  });
  const paragraphs: string[] = [];
  const fields: Array<{ label: string; value: string }> = [];
  const resources: Array<{ label: string; url: string }> = [];
  const textLines = ["Dust Wave Biz Info"];
  const resourceLabels: Record<string, string> = {
    "dust wave reel": "Dust Wave reel", "biz tour video": "Business tour video", "grants": "Grants folder"
  };
  for (let index = 0; index < visible.length; index++) {
    const line = visible[index]!;
    const text = plainText(line).trim();
    const field = text.match(/^([^:]+):\s*(.*)$/);
    const resourceLabel = field && resourceLabels[field[1]!.toLowerCase()];
    const findUrl = (runs: RichText[]) => runs.map(run => safeUrl(run.href ?? run.text?.link?.url) ?? safeUrl(plainText([run]).trim())).find(Boolean) ?? null;
    if (resourceLabel) {
      let url = findUrl(line) ?? safeUrl(field![2]);
      if (!url && !field![2] && visible[index + 1]) {
        url = findUrl(visible[index + 1]!);
        if (url) index++;
      }
      if (url) {
        resources.push({ label: resourceLabel, url });
        textLines.push(`${resourceLabel}: ${url}`);
        continue;
      }
    }
    if (field && !/^https?$/i.test(field[1]!)) {
      fields.push({ label: field[1]!, value: field[2]! });
      textLines.push(text);
    } else {
      const html = line.map(run => {
        const value = escapeHtml(plainText([run]));
        const url = safeUrl(run.href ?? run.text?.link?.url);
        return url ? `<a href="${escapeHtml(url)}" style="color:#185abc;text-decoration:underline">${value}</a>` : value;
      }).join("");
      paragraphs.push(`<p style="margin:0 0 14px">${html}</p>`);
      textLines.push(line.map(run => {
        const value = plainText([run]);
        const url = safeUrl(run.href ?? run.text?.link?.url);
        return url && !value.includes(url) ? `${value} (${url})` : value;
      }).join("").trim());
    }
  }
  const rows = fields.map(field => `<tr><th scope="row" style="padding:3px 18px 3px 0;text-align:left;vertical-align:top;font-weight:600;white-space:nowrap">${escapeHtml(field.label)}</th><td style="padding:3px 0;vertical-align:top">${escapeHtml(field.value)}</td></tr>`).join("");
  const links = resources.map(resource => `<a href="${escapeHtml(resource.url)}" style="color:#185abc;text-decoration:underline">${escapeHtml(resource.label)}</a>`).join(' <span style="color:#777">&nbsp;·&nbsp;</span> ');
  return {
    html: `<h2 style="font-size:21px;margin:0 0 12px">Dust Wave Biz Info</h2>${paragraphs.join("")}${rows ? `<table style="border-collapse:collapse;font-size:15px;line-height:1.5;margin:0 0 16px">${rows}</table>` : ""}${links ? `<p style="margin:0;line-height:1.8">${links}</p>` : ""}`,
    text: textLines.join("\n")
  };
}

// Follow Notion's option color names, with darker text for readable email labels.
const optionPalette: Record<string, { background: string; color: string }> = {
  default: { background: "#f1f1ef", color: "#454541" },
  gray: { background: "#eae9e7", color: "#50504c" },
  brown: { background: "#eee0da", color: "#704b39" },
  orange: { background: "#fae3cd", color: "#874416" },
  yellow: { background: "#f8edc9", color: "#735b16" },
  green: { background: "#dcebdd", color: "#315f43" },
  blue: { background: "#dceaf5", color: "#265779" },
  purple: { background: "#e9e0f1", color: "#654284" },
  pink: { background: "#f3dfe8", color: "#873a60" },
  red: { background: "#f7dfdc", color: "#963e36" }
};
function optionBadge(label: string, colorName: string | undefined, view: string | undefined, property: string): string {
  const colors = optionPalette[colorName && Object.hasOwn(optionPalette, colorName) ? colorName : "default"]!;
  const url = safeUrl(view);
  const style = `display:inline-block;padding:2px 8px;margin:2px 5px 2px 0;border-radius:4px;background:${colors.background};color:${colors.color};font-size:14px;line-height:1.5;${url ? "text-decoration:underline;text-underline-offset:2px" : ""}`;
  return url
    ? `<a href="${escapeHtml(url)}" title="Browse opportunities grouped by ${escapeHtml(property)}" style="${style}">${escapeHtml(label)}</a>`
    : `<span style="${style}">${escapeHtml(label)}</span>`;
}

export function renderNewsletter(newsletter: Newsletter) {
  const e = escapeHtml;
  const link = (label: string, url: string | null) => url ? `<a href="${e(url)}">${e(label)}</a>` : e(label);
  const intro = renderBusinessInfo(newsletter.intro);
  const contact = newsletter.contact;
  const helpText = `Email (${contact.email})${contact.phone ? ` or text (${contact.phone})` : ""} Alonso for assistance.`;
  const helpHtml = `Email (<a href="mailto:${e(contact.email)}">${e(contact.email)}</a>)${contact.phone ? ` or text (<a href="sms:${e(contact.phone.replace(/[^+\d]/g, ""))}">${e(contact.phone)}</a>)` : ""} Alonso for assistance.`;
  const count = newsletter.opportunities.length;
  const subject = `Dust Wave Opportunities — ${newsletter.day}`;
  const date = dateLabel(newsletter.day, newsletter.timezone);
  const items = newsletter.opportunities.map(item => {
    const due = dateLabel(item.due, newsletter.timezone);
    const opens = dateLabel(item.opens, newsletter.timezone);
    const dates = `Due: ${due}\nApplications open: ${opens}`;
    const tags = item.tags.join(", ") || "None listed";
    const summary = item.summary || "No description is saved in Notion yet. Check the website for details.";
    const typeBadge = item.type ? optionBadge(item.type, item.typeColor, newsletter.browseViews?.types, "type") : "Not listed";
    const tagBadges = item.tags.map(tag => optionBadge(tag, item.tagColors?.[tag], newsletter.browseViews?.tags, "tag")).join(" ") || "None listed";
    const row = (label: string, value: string) => `<tr><th scope="row" style="width:126px;padding:3px 12px 3px 0;vertical-align:top;text-align:left;font-size:14px;font-weight:400;color:#5f6368">${label}</th><td style="padding:3px 0;vertical-align:top">${value}</td></tr>`;
    const metadata = `<table style="border-collapse:collapse;width:100%;margin:8px 0;font-size:15px;line-height:1.6">${row("Due", `<strong style="display:inline-block;padding:2px 8px;border-radius:4px;background:#f7dfdc;color:#963e36">${e(due)}</strong>`)}${row("Applications open", e(opens))}${row("Type", typeBadge)}${row("Tags", tagBadges)}</table>`;
    return {
      html: `<li><h3>${link(item.name, safeUrl(item.website))}</h3>${metadata}<p>${item.website ? link("Website", safeUrl(item.website)) + " · " : "Website not listed · "}${link("Notion details", safeUrl(item.notionUrl))}</p><p>${e(summary)}</p>${item.note ? `<p><strong>Check before applying:</strong> ${e(item.note)}</p>` : ""}</li>`,
      text: `${item.name}\nType: ${item.type || "Not listed"}\nWebsite: ${item.website || "Not listed"}\n${dates}\nTags: ${tags}\n${summary}${item.note ? `\nCheck before applying: ${item.note}` : ""}\nNotion details: ${item.notionUrl}`
    };
  });
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${e(subject)}</title><style>a{color:#185abc;text-decoration:underline}h3{font-size:18px;margin:0}li{margin:0 0 26px}p{margin:8px 0}ul{padding-left:24px}</style></head><body style="margin:0;background:#fff;color:#202124;font-family:Arial,Helvetica,sans-serif;font-size:16px;line-height:1.6"><main style="max-width:720px;margin:0 auto;padding:28px 22px;overflow-wrap:anywhere"><h1 style="font-size:28px;line-height:1.2;margin:0 0 8px">Dust Wave Opportunities</h1><p style="color:#5f6368">${e(date)} · ${count} opportunit${count === 1 ? "y" : "ies"}</p><p><strong>${e(MEMBER_NOTICE)}</strong></p><p>${helpHtml}</p><section style="margin:24px 0 30px;padding:22px 0;border-top:1px solid #dadce0;border-bottom:1px solid #dadce0">${intro.html}</section><h2 style="font-size:21px">Upcoming deadlines</h2><p>Open calls due within 31 days, soonest first.</p>${count ? `<ul>${items.map(item => item.html).join("")}</ul>` : "<p>No opportunities meet the deadline window today.</p>"}<p style="font-size:14px;color:#5f6368">Dates and details come from the Opportunities database. Check the application website before submitting.</p></main></body></html>`;
  const browseText = newsletter.browseViews ? [safeUrl(newsletter.browseViews.types) ? `Browse by type: ${newsletter.browseViews.types}` : "", safeUrl(newsletter.browseViews.tags) ? `Browse by tag: ${newsletter.browseViews.tags}` : ""].filter(Boolean).join("\n") : "";
  const text = [subject, MEMBER_NOTICE, helpText, intro.text, "UPCOMING DEADLINES", ...items.map(item => item.text), browseText].filter(Boolean).join("\n\n");
  if (new TextEncoder().encode(html + text).length > 4_000_000) throw new Error("newsletter_email_too_large");
  return { subject, html, text };
}

export function shouldStartNewsletter(now: Date, timezone: string, hour: string, days: string): boolean {
  const parsedHour = Number(hour);
  const parsedDays = days.split(",").map(Number);
  if (!Number.isInteger(parsedHour) || parsedHour < 0 || parsedHour > 23 || !days.trim() || parsedDays.some(day => !Number.isInteger(day) || day < 0 || day > 6)) throw new Error("newsletter_schedule_invalid");
  const slot = localBatchSlot(now, timezone);
  const weekday = new Date(slot.dateLabel + "T12:00:00Z").getUTCDay();
  return slot.hour === parsedHour && parsedDays.includes(weekday);
}
