import { escapeHtml } from "@dustwave/digest-core";
import { localBatchSlot } from "../util/dates";

export const MEMBER_NOTICE = "For active Dust Wave members only. This includes our internal business info, so please don’t forward it or share it outside the collective.";
export interface RichText { plain_text?: string; text?: { content: string; link?: { url: string } | null }; href?: string | null }
export interface Opportunity {
  id: string; name: string; website: string | null; notionUrl: string;
  type: string; tags: string[]; due: string | null; opens: string | null;
  archived?: boolean; summary?: string; note?: string;
}
export interface Contact { name: string; email: string; phone?: string }
export interface Newsletter {
  day: string; timezone: string; intro: RichText[]; contact: Contact;
  opportunities: Opportunity[];
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
export function renderNewsletter(newsletter: Newsletter) {
  const e = escapeHtml;
  const link = (label: string, url: string | null) => url ? `<a href="${e(url)}">${e(label)}</a>` : e(label);
  const introHtml = newsletter.intro.map(item => link(plainText([item]), safeUrl(item.href ?? item.text?.link?.url))).join("").replaceAll("\n", "<br>");
  const introText = newsletter.intro.map(item => {
    const value = plainText([item]); const url = safeUrl(item.href ?? item.text?.link?.url);
    return url && !value.includes(url) ? `${value} (${url})` : value;
  }).join("");
  const contact = newsletter.contact;
  const helpText = `Want a hand applying? Email me at ${contact.email}${contact.phone ? ` or text me at ${contact.phone}` : ""}. Happy to help. — Alonso`;
  const helpHtml = `Want a hand applying? Email me at <a href="mailto:${e(contact.email)}">${e(contact.email)}</a>${contact.phone ? ` or text me at <a href="sms:${e(contact.phone.replace(/[^+\d]/g, ""))}">${e(contact.phone)}</a>` : ""}. Happy to help. — Alonso`;
  const count = newsletter.opportunities.length;
  const subject = `Dust Wave Opportunities — ${newsletter.day}`;
  const date = dateLabel(newsletter.day, newsletter.timezone);
  const items = newsletter.opportunities.map(item => {
    const dates = `Applications open: ${dateLabel(item.opens, newsletter.timezone)} · Due: ${dateLabel(item.due, newsletter.timezone)}`;
    const tags = item.tags.join(", ") || "None listed";
    const summary = item.summary || "No description is saved in Notion yet. Check the website for details.";
    return {
      html: `<li><h3>${link(item.name, safeUrl(item.website))}</h3><p><strong>${e(item.type || "Type not listed")}</strong><br>${e(dates)}<br>Tags: ${e(tags)}<br>${item.website ? link("Website", safeUrl(item.website)) + " · " : "Website not listed · "}${link("Notion details", safeUrl(item.notionUrl))}</p><p>${e(summary)}</p>${item.note ? `<p><strong>Check before applying:</strong> ${e(item.note)}</p>` : ""}</li>`,
      text: `${item.name}\nType: ${item.type || "Not listed"}\nWebsite: ${item.website || "Not listed"}\n${dates}\nTags: ${tags}\n${summary}${item.note ? `\nCheck before applying: ${item.note}` : ""}\nNotion details: ${item.notionUrl}`
    };
  });
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${e(subject)}</title><style>a{color:#185abc;text-decoration:underline}h3{font-size:18px;margin:0}li{margin:0 0 26px}p{margin:8px 0}ul{padding-left:24px}</style></head><body style="margin:0;background:#fff;color:#202124;font-family:Arial,Helvetica,sans-serif;font-size:16px;line-height:1.6"><main style="max-width:720px;margin:0 auto;padding:28px 22px;overflow-wrap:anywhere"><h1 style="font-size:28px;line-height:1.2;margin:0 0 8px">Dust Wave Opportunities</h1><p style="color:#5f6368">${e(date)} · ${count} opportunit${count === 1 ? "y" : "ies"}</p><p><strong>${e(MEMBER_NOTICE)}</strong></p><p>${helpHtml}</p><section style="margin:24px 0"><p>${introHtml}</p></section><h2 style="font-size:21px">Upcoming deadlines</h2><p>Open calls due within 31 days, soonest first.</p>${count ? `<ul>${items.map(item => item.html).join("")}</ul>` : "<p>No opportunities meet the deadline window today.</p>"}<p style="font-size:14px;color:#5f6368">Dates and details come from the Opportunities database. Check the application website before submitting.</p></main></body></html>`;
  const text = [subject, MEMBER_NOTICE, helpText, introText, "UPCOMING DEADLINES", ...items.map(item => item.text)].join("\n\n");
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
