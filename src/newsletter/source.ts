import { Parser } from "htmlparser2";
import { z } from "zod";
import { notionJson, type NotionPage } from "../notion/client";
import { readBoundedText } from "../util/http";
import { addDays, businessIntro, plainText, safeUrl, selectOpportunities, type Contact, type Opportunity, type RichText } from "./model";
import { localBatchSlot } from "../util/dates";

export const settingsSchema = z.object({
  databaseId: z.string().uuid(), peopleDataSourceId: z.string().uuid(), helpContactPageId: z.string().uuid(),
  helpEmail: z.email(),
  views: z.object({ byType: z.string().uuid(), byTag: z.string().uuid() }).optional(),
  aliases: z.record(z.string(), z.string()).default({})
});
export type NewsletterSettings = z.infer<typeof settingsSchema>;
export function loadNewsletterSettings(env: Env): NewsletterSettings {
  return settingsSchema.parse(JSON.parse(env.NEWSLETTER_SETTINGS || "{}"));
}
type Property = { type?: string; title?: RichText[]; rich_text?: RichText[]; email?: string; phone_number?: string; url?: string; date?: { start?: string }; select?: { name: string; color?: string }; multi_select?: { name: string; color?: string }[] };
export function property(page: NotionPage, name: string): Property { return (page.properties?.[name] ?? {}) as Property; }
export function propertyText(page: NotionPage, name: string): string {
  const p = property(page, name);
  return plainText(p.title ?? p.rich_text ?? []) || p.email || p.phone_number || p.url || "";
}
export async function queryPages(token: string, dataSourceId: string, filter: unknown): Promise<NotionPage[]> {
  const pages: NotionPage[] = []; const seen = new Set<string>(); let cursor: string | undefined;
  do {
    const response = await notionJson<{ results: NotionPage[]; has_more: boolean; next_cursor?: string }>(token, `/data_sources/${dataSourceId}/query`, {
      method: "POST", body: JSON.stringify({ filter, page_size: 100, ...(cursor ? { start_cursor: cursor } : {}) })
    });
    pages.push(...response.results);
    if (pages.length > 10000) throw new Error("newsletter_query_too_large");
    if (!response.has_more) break;
    if (!response.next_cursor || seen.has(response.next_cursor)) throw new Error("newsletter_incomplete_pagination");
    seen.add(response.next_cursor); cursor = response.next_cursor;
  } while (cursor);
  return pages.filter(page => !page.archived && !page.in_trash);
}
export function opportunityFromPage(page: NotionPage): Opportunity {
  const web = property(page, "Website");
  const richUrl = (web.rich_text ?? []).map(item => item.href ?? item.text?.link?.url).find(Boolean);
  const website = safeUrl(propertyText(page, "Website")) ?? safeUrl(richUrl);
  const type = property(page, "Type").select;
  const tags = property(page, "Tags").multi_select ?? [];
  return { id: page.id, name: propertyText(page, "Name"), website,
    notionUrl: page.url ?? `https://www.notion.so/${page.id.replaceAll("-", "")}`,
    type: type?.name ?? "", typeColor: type?.color, tags: tags.map(tag => tag.name),
    tagColors: Object.fromEntries(tags.map(tag => [tag.name, tag.color ?? "default"])),
    due: property(page, "Due Date").date?.start ?? null, opens: property(page, "Application open").date?.start ?? null,
    archived: page.archived || page.in_trash };
}
export async function readOpportunities(env: Env, now: Date) {
  const day = localBatchSlot(now, env.TIMEZONE).dateLabel;
  const pages = await queryPages(env.NOTION_TOKEN, env.NOTION_DATA_SOURCE_ID, { and: [
    { property: "Due Date", date: { on_or_after: addDays(day, -1) } },
    { property: "Due Date", date: { on_or_before: addDays(day, 32) } }
  ] });
  return selectOpportunities(pages.map(opportunityFromPage), now, env.TIMEZONE);
}
export function parseMemberNames(html: string): string[] {
  const names: string[] = []; let inCard = false; let inHeading = false; let foundHeading = false; let value = "";
  new Parser({
    onopentag(name, attrs) {
      if (name === "article" && attrs.class?.split(/\s+/).includes("member-card")) { inCard = true; foundHeading = false; }
      if (inCard && name === "h3" && !foundHeading) { inHeading = true; value = ""; }
    },
    ontext(text) { if (inHeading) value += text; },
    onclosetag(name) {
      if (name === "h3" && inHeading) { names.push(value.trim()); inHeading = false; foundHeading = true; }
      if (name === "article") inCard = false;
    }
  }, { decodeEntities: true }).end(html);
  if (!names.length || names.some(name => !name) || new Set(names).size !== names.length) throw new Error("newsletter_member_roster_invalid");
  return names;
}
export function resolveRecipients(names: string[], people: NotionPage[], aliases: Record<string, string>): Contact[] {
  const recipients = names.map(name => {
    const matches = people.filter(page => propertyText(page, "Name").trim().toLowerCase() === (aliases[name] ?? name).trim().toLowerCase());
    if (matches.length !== 1) throw new Error("newsletter_member_match_missing_or_ambiguous");
    const email = propertyText(matches[0]!, "Email").trim() || propertyText(matches[0]!, "Email 2").trim();
    if (!z.email().safeParse(email).success) throw new Error("newsletter_member_email_invalid");
    return { name, email: email.toLowerCase() };
  });
  return [...new Map(recipients.map(person => [person.email, person])).values()];
}
export async function readAudience(env: Env, settings: NewsletterSettings) {
  const response = await fetch("https://dustwave.xyz/about.html", { signal: AbortSignal.timeout(30000), redirect: "error" });
  if (!response.ok) throw new Error("newsletter_roster_unavailable");
  const names = parseMemberNames(await readBoundedText(response, 2_000_000));
  const people = await queryPages(env.NOTION_TOKEN, settings.peopleDataSourceId, {
    or: names.map(name => ({ property: "Name", title: { equals: settings.aliases[name] ?? name } }))
  });
  return resolveRecipients(names, people, settings.aliases);
}
export async function readIntroAndContact(env: Env, settings: NewsletterSettings) {
  const database = await notionJson<{ description: RichText[] }>(env.NOTION_TOKEN, `/databases/${settings.databaseId}`);
  const page = await notionJson<NotionPage>(env.NOTION_TOKEN, `/pages/${settings.helpContactPageId}`);
  const contact = { name: propertyText(page, "Name"), email: settings.helpEmail, phone: propertyText(page, "Phone #").trim() };
  if (!z.email().safeParse(contact.email).success || !/^[+\d ()-]{7,30}$/.test(contact.phone)) throw new Error("newsletter_help_contact_invalid");
  return { intro: businessIntro(database.description ?? []), contact };
}
export async function readOpportunityBody(env: Env, pageId: string) {
  const body = await notionJson<{ markdown: string; truncated: boolean; unknown_block_ids?: string[] }>(env.NOTION_TOKEN, `/pages/${pageId}/markdown`);
  if (body.truncated || body.unknown_block_ids?.length) throw new Error("newsletter_body_incomplete");
  return body.markdown;
}
