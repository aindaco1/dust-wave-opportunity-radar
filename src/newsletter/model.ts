import { escapeHtml } from "@dustwave/digest-core";
import { localBatchSlot } from "../util/dates";

export const MEMBER_NOTICE = "For active Dust Wave members only. This includes our internal business info, so please don’t forward it or share it outside the collective.";
const CLOSING_QUOTE = {
  lines: ["Our doubts are traitors", "And makes us lose the good we oft might win", "By fearing to attempt."],
  author: "William Shakespeare", work: "Measure for Measure", scene: "act 1, scene 4",
  url: "https://www.folger.edu/explore/shakespeares-works/measure-for-measure/read/1/4/"
};
const BODY_FONT = "'Inter',Helvetica,Arial,sans-serif";
const HEADING_FONT = "'Gambado Sans Forte','Gambado Sans'," + BODY_FONT;
const LINK_STYLE = "color:#ffffff;text-decoration:underline;text-decoration-thickness:1px;text-underline-offset:2px";
const LOGO_URL = "https://dustwave.xyz/img/favicon/dust-wave-square.png";
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
  businessAddress?: string;
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

function renderBusinessInfo(description: RichText[], businessAddress?: string): { html: string; text: string } {
  // Rich-text runs can split a label or place its URL on the following line.
  const lines: RichText[][] = [[]];
  for (const run of description) {
    plainText([run]).split(/\r?\n/).forEach((content, index) => {
      if (index) lines.push([]);
      lines.at(-1)!.push({ ...run, plain_text: content });
    });
  }
  const visible: RichText[][] = [];
  let omitLicenseResource = false;
  for (const line of lines) {
    const text = plainText(line).trim();
    if (!text) continue;
    if (/^(?:biz|business)\s+licen[cs]e\b/i.test(text)) {
      omitLicenseResource = /^(?:biz|business)\s+licen[cs]e\s*:?$/i.test(text)
        && !line.some(run => safeUrl(run.href ?? run.text?.link?.url));
      continue;
    }
    if (omitLicenseResource) {
      omitLicenseResource = false;
      // A standalone label may put its linked resource on the following line.
      if (line.every(run => !plainText([run]).trim() || safeUrl(run.href ?? run.text?.link?.url) || safeUrl(plainText([run]).trim()))) continue;
    }
    if (text !== "Dust Wave Biz Info") visible.push(line);
  }
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
      const value = field[1]!.trim().toLowerCase() === "address" && businessAddress ? businessAddress : field[2]!;
      fields.push({ label: field[1]!, value });
      textLines.push(`${field[1]}: ${value}`);
    } else {
      const html = line.map(run => {
        const value = escapeHtml(plainText([run]));
        const url = safeUrl(run.href ?? run.text?.link?.url);
        return url ? `<a href="${escapeHtml(url)}" style="${LINK_STYLE}">${value}</a>` : value;
      }).join("");
      paragraphs.push(`<p style="margin:0 0 14px;color:#ffffff">${html}</p>`);
      textLines.push(line.map(run => {
        const value = plainText([run]);
        const url = safeUrl(run.href ?? run.text?.link?.url);
        return url && !value.includes(url) ? `${value} (${url})` : value;
      }).join("").trim());
    }
  }
  const rows = fields.map(field => `<tr><th scope="row" style="padding:4px 18px 4px 0;text-align:left;vertical-align:top;font-weight:600;white-space:nowrap;color:#ffffff">${escapeHtml(field.label)}</th><td style="padding:4px 0;vertical-align:top;color:#cccccc">${escapeHtml(field.value)}</td></tr>`).join("");
  const links = resources.map(resource => `<a href="${escapeHtml(resource.url)}" style="${LINK_STYLE}">${escapeHtml(resource.label)}</a>`).join(' <span style="color:#999999">&nbsp;·&nbsp;</span> ');
  return {
    html: `<h2 style="font-family:${HEADING_FONT};font-size:22px;line-height:1.2;color:#ffffff;margin:0 0 16px">Dust Wave Biz Info</h2>${paragraphs.join("")}${rows ? `<table cellpadding="0" cellspacing="0" style="border-collapse:collapse;font-family:${BODY_FONT};font-size:14px;line-height:1.5;margin:0 0 16px">${rows}</table>` : ""}${links ? `<p style="margin:0;font-size:14px;line-height:1.8">${links}</p>` : ""}`,
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
  const link = (label: string, url: string | null) => url ? `<a href="${e(url)}" style="${LINK_STYLE}">${e(label)}</a>` : e(label);
  const intro = renderBusinessInfo(newsletter.intro, newsletter.businessAddress);
  const contact = newsletter.contact;
  const helpText = `Email (${contact.email})${contact.phone ? ` or text (${contact.phone})` : ""} Alonso for assistance.`;
  const helpHtml = `Email (<a href="mailto:${e(contact.email)}" style="${LINK_STYLE}">${e(contact.email)}</a>)${contact.phone ? ` or text (<a href="sms:${e(contact.phone.replace(/[^+\d]/g, ""))}" style="${LINK_STYLE}">${e(contact.phone)}</a>)` : ""} Alonso for assistance.`;
  const count = newsletter.opportunities.length;
  const subject = `Opportunities — ${newsletter.day}`;
  const date = dateLabel(newsletter.day, newsletter.timezone);
  const items = newsletter.opportunities.map(item => {
    const due = dateLabel(item.due, newsletter.timezone);
    const opens = dateLabel(item.opens, newsletter.timezone);
    const dates = `Due: ${due}\nApplications open: ${opens}`;
    const tags = item.tags.join(", ") || "None listed";
    const summary = item.summary || "No description is saved in Notion yet. Check the website for details.";
    const typeBadge = item.type ? optionBadge(item.type, item.typeColor, newsletter.browseViews?.types, "type") : "Not listed";
    const tagBadges = item.tags.map(tag => optionBadge(tag, item.tagColors?.[tag], newsletter.browseViews?.tags, "tag")).join(" ") || "None listed";
    const row = (label: string, value: string) => `<tr><th scope="row" style="width:126px;padding:3px 12px 3px 0;vertical-align:top;text-align:left;font-size:13px;font-weight:400;color:#aaaaaa">${label}</th><td style="padding:3px 0;vertical-align:top;color:#cccccc">${value}</td></tr>`;
    const metadata = `<table cellpadding="0" cellspacing="0" style="border-collapse:collapse;width:100%;margin:14px 0;font-family:${BODY_FONT};font-size:14px;line-height:1.6">${row("Due", `<strong style="display:inline-block;padding:2px 8px;border-radius:4px;background:#f7dfdc;color:#963e36">${e(due)}</strong>`)}${row("Applications open", e(opens))}${row("Type", typeBadge)}${row("Tags", tagBadges)}</table>`;
    return {
      html: `<li style="margin:0 0 26px;padding:0 0 26px;border-bottom:1px solid #444444"><h3 style="font-family:${HEADING_FONT};font-size:21px;font-weight:800;line-height:1.3;color:#ffffff;margin:0">${link(item.name, safeUrl(item.website))}</h3>${metadata}<p style="margin:0 0 12px;font-size:13px">${item.website ? link("Website", safeUrl(item.website)) + " · " : "Website not listed · "}${link("Notion details", safeUrl(item.notionUrl))}</p><p style="margin:0;line-height:1.65;color:#cccccc">${e(summary)}</p>${item.note ? `<p style="margin:14px 0 0;padding-left:12px;border-left:2px solid #aaaaaa;font-size:14px;line-height:1.6;color:#cccccc"><strong style="color:#ffffff">Check before applying:</strong> ${e(item.note)}</p>` : ""}</li>`,
      text: `${item.name}\nType: ${item.type || "Not listed"}\nWebsite: ${item.website || "Not listed"}\n${dates}\nTags: ${tags}\n${summary}${item.note ? `\nCheck before applying: ${item.note}` : ""}\nNotion details: ${item.notionUrl}`
    };
  });
  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="dark"><meta name="supported-color-schemes" content="dark"><title>${e(subject)}</title>
<style>:root{color-scheme:dark}body,table,td{font-family:${BODY_FONT}}a{${LINK_STYLE}}p{margin:0 0 12px}img{border:0;outline:0}h1,h2,h3{font-family:${HEADING_FONT}}@media only screen and (max-width:480px){.newsletter-title{font-size:30px!important}.brand-cell{width:62px!important}.brand-logo{width:48px!important;height:48px!important}}</style></head>
<body bgcolor="#000000" style="margin:0;padding:0;background:#000000;color:#cccccc;font-family:${BODY_FONT};font-size:15px;line-height:1.6">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="#000000" style="width:100%;border-collapse:collapse;background:#000000"><tr><td align="center" style="padding:28px 18px 36px">
<!--[if mso]><table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0"><tr><td><![endif]-->
<main style="max-width:600px;margin:0 auto;text-align:left;overflow-wrap:anywhere">
<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse;margin:0 0 16px"><tr><td class="brand-cell" width="76" valign="middle" style="width:76px;vertical-align:middle"><a href="https://dustwave.xyz" style="${LINK_STYLE}"><img class="brand-logo" src="${LOGO_URL}" alt="Dust Wave" width="60" height="60" style="display:block;width:60px;height:60px;border:0"></a></td><td valign="middle" style="vertical-align:middle"><h1 class="newsletter-title" style="font-family:${HEADING_FONT};font-size:38px;font-weight:800;line-height:1.1;color:#ffffff;margin:0">Opportunities</h1></td></tr></table>
<p style="margin:0 0 20px;color:#aaaaaa;font-size:13px">${e(date)} · ${count} opportunit${count === 1 ? "y" : "ies"}</p>
<div style="border-top:2px solid #ffffff;padding:18px 0 0"><p style="font-size:14px;line-height:1.6;color:#cccccc">${e(MEMBER_NOTICE)}</p><p style="margin:0;font-size:14px;line-height:1.7;color:#cccccc">${helpHtml}</p></div>
<section style="margin:24px 0 28px;padding:24px 0;border-top:1px solid #444444;border-bottom:1px solid #444444">${intro.html}</section>
<h2 style="font-family:${HEADING_FONT};font-size:26px;font-weight:800;line-height:1.2;color:#ffffff;margin:0 0 8px">Upcoming deadlines</h2><p style="margin:0 0 26px;font-size:14px;color:#aaaaaa">Open calls due within 31 days, soonest first.</p>
${count ? `<ul style="list-style:none;margin:0;padding:0">${items.map(item => item.html).join("")}</ul>` : '<p style="color:#cccccc">No opportunities meet the deadline window today.</p>'}
<p style="margin:0;color:#aaaaaa;font-size:12px;line-height:1.6">Dates and details come from the Opportunities database. Check the application website before submitting.</p>
<footer style="margin:26px 0 0;padding:24px 0 0;border-top:1px solid #444444"><blockquote cite="${e(CLOSING_QUOTE.url)}" style="margin:0;font-family:${BODY_FONT};font-size:18px;font-style:italic;line-height:1.7;color:#dddddd">“${CLOSING_QUOTE.lines.map(line => e(line)).join("<br>")}”</blockquote><p style="margin:14px 0 0;font-size:13px;line-height:1.6;color:#aaaaaa"><strong style="color:#ffffff">${e(CLOSING_QUOTE.author)}</strong><br>— <a href="${e(CLOSING_QUOTE.url)}" style="${LINK_STYLE}"><cite>${e(CLOSING_QUOTE.work)}</cite>, ${e(CLOSING_QUOTE.scene)}</a></p></footer>
</main><!--[if mso]></td></tr></table><![endif]--></td></tr></table></body></html>`;
  const browseText = newsletter.browseViews ? [safeUrl(newsletter.browseViews.types) ? `Browse by type: ${newsletter.browseViews.types}` : "", safeUrl(newsletter.browseViews.tags) ? `Browse by tag: ${newsletter.browseViews.tags}` : ""].filter(Boolean).join("\n") : "";
  const quoteText = `“${CLOSING_QUOTE.lines.join("\n")}”\n— ${CLOSING_QUOTE.author}, ${CLOSING_QUOTE.work}, ${CLOSING_QUOTE.scene}\n${CLOSING_QUOTE.url}`;
  const text = [subject, MEMBER_NOTICE, helpText, intro.text, "UPCOMING DEADLINES", ...items.map(item => item.text), browseText, quoteText].filter(Boolean).join("\n\n");
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
