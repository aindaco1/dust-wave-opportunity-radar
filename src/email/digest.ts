import type { RuntimeConfig } from "../config";
import type { DigestItemRecord } from "../storage/database";

const CATEGORY_ORDER = [
  "Possible Opportunities",
  "Jobs & Commissions",
  "Workshops & Training",
  "Events & Conferences",
  "Games & Interactive",
  "Industry News",
  "Other Useful Finds"
];

const styles = {
  page: "margin:0;padding:0;background:#0f0f0f;color:#f6f1e8;font-family:Arial,Helvetica,sans-serif;",
  shell: "width:100%;background:#0f0f0f;padding:22px 0;",
  container: "width:100%;max-width:760px;margin:0 auto;background:#171717;border:1px solid #2a2a2a;",
  header: "padding:28px 28px 22px;border-bottom:1px solid #383838;",
  eyebrow: "margin:0 0 8px;color:#a9a197;font-size:11px;line-height:1.35;text-transform:uppercase;letter-spacing:1.6px;font-weight:700;",
  h1: "margin:0;color:#fff;font-size:36px;line-height:0.98;font-weight:900;",
  deck: "margin:14px 0 0;color:#cfc7bd;font-size:14px;line-height:1.45;",
  topicWrap: "padding:24px 28px 8px;",
  topicTitle: "margin:0;color:#fff;font-size:24px;line-height:1;font-weight:900;",
  topicRule: "height:3px;background:#f05a28;border:0;margin:10px 0 0;width:58px;",
  gridWrap: "padding:0 22px 12px;",
  grid: "width:100%;border-collapse:collapse;border-spacing:0;table-layout:fixed;",
  column: "width:49%;vertical-align:top;padding:0;",
  spacer: "width:2%;font-size:0;line-height:0;padding:0;",
  card: "background:#f4f1ea;color:#141414;border:1px solid #e2ded5;margin:0 0 12px;border-radius:7px;overflow:hidden;word-break:break-word;",
  cardBody: "padding:13px 14px 14px;",
  source: "margin:0 0 6px;color:#675f55;font-size:10px;line-height:1.3;text-transform:uppercase;letter-spacing:1px;font-weight:800;",
  title: "margin:0 0 7px;color:#111;font-size:17px;line-height:1.2;font-weight:900;",
  meta: "margin:0 0 8px;color:#6b2c18;font-size:11px;line-height:1.4;font-weight:800;",
  summary: "margin:0 0 9px;color:#262626;font-size:13px;line-height:1.38;",
  link: "color:#111;text-decoration:underline;text-decoration-thickness:1px;text-underline-offset:2px;",
  footer: "padding:20px 28px 26px;color:#90887f;font-size:12px;line-height:1.45;border-top:1px solid #383838;"
};

export interface RenderedDigest {
  subject: string;
  html: string;
  text: string;
}

export function renderOpportunityDigest(
  items: DigestItemRecord[],
  date: Date,
  timezone: string
): RenderedDigest {
  const dateLabel = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short"
  }).format(date);
  const grouped = groupItems(items);
  const sections = grouped.map(([category, categoryItems]) => renderSection(category, categoryItems)).join("\n");
  const subject = `Dust Wave Opportunity Radar — ${dateLabel}`;
  const html = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>${escapeHtml(subject)}</title>
    <style>
      @media screen and (max-width:420px) {
        .radar-container { width:100% !important;max-width:100% !important; }
        .radar-column { display:block !important;width:100% !important;padding:0 !important; }
        .radar-spacer { display:none !important;width:0 !important;height:0 !important;overflow:hidden !important; }
      }
    </style>
  </head>
  <body style="${styles.page}">
    <div style="${styles.shell}">
      <main class="radar-container" style="${styles.container}">
        <header style="${styles.header}">
          <p style="${styles.eyebrow}">${escapeHtml(dateLabel)} · ${items.length} item${items.length === 1 ? "" : "s"}</p>
          <h1 style="${styles.h1}">Dust Wave Opportunity Radar</h1>
          <p style="${styles.deck}">Relevant creative-industry calls that need a human look.</p>
        </header>
        ${sections}
        <footer style="${styles.footer}">
          Scanned HEY and Zoho on the 12-hour Dust Wave schedule. Links return to the original public source when available.
        </footer>
      </main>
    </div>
  </body>
</html>`;
  const text = [
    `DUST WAVE OPPORTUNITY RADAR — ${dateLabel}`,
    "",
    ...grouped.flatMap(([category, categoryItems]) => [
      category.toUpperCase(),
      ...categoryItems.flatMap((item) => [
        `- ${item.title}`,
        item.deadline ? `  Deadline: ${item.deadline}` : "",
        `  ${item.summary}`,
        item.url ? `  ${item.url}` : ""
      ].filter(Boolean)),
      ""
    ])
  ].join("\n");
  return { subject, html, text };
}

export async function sendOpportunityDigest(
  email: SendEmail,
  config: RuntimeConfig,
  rendered: RenderedDigest
): Promise<string> {
  const result = await email.send({
    to: config.digestToEmail,
    from: { email: config.digestFromEmail, name: config.digestFromName },
    subject: rendered.subject,
    html: rendered.html,
    text: rendered.text,
    headers: { "X-Dustwave-Automation": "opportunity-radar" }
  });
  return result.messageId;
}

function groupItems(items: DigestItemRecord[]): Array<[string, DigestItemRecord[]]> {
  const grouped = new Map<string, DigestItemRecord[]>();
  for (const item of items) {
    const existing = grouped.get(item.category) ?? [];
    existing.push(item);
    grouped.set(item.category, existing);
  }
  return [...grouped.entries()].sort(([left], [right]) => {
    const leftIndex = CATEGORY_ORDER.indexOf(left);
    const rightIndex = CATEGORY_ORDER.indexOf(right);
    return (leftIndex === -1 ? 999 : leftIndex) - (rightIndex === -1 ? 999 : rightIndex);
  });
}

function renderSection(category: string, items: DigestItemRecord[]): string {
  const [left, right] = splitColumns(items);
  return `<section>
    <div style="${styles.topicWrap}">
      <h2 style="${styles.topicTitle}">${escapeHtml(category)}</h2>
      <div style="${styles.topicRule}"></div>
    </div>
    <div style="${styles.gridWrap}">
      <table role="presentation" cellspacing="0" cellpadding="0" border="0" style="${styles.grid}">
        <tr>
          <td class="radar-column" width="49%" valign="top" style="${styles.column}">${left.map(renderCard).join("\n")}</td>
          <td class="radar-spacer" width="2%" style="${styles.spacer}">&nbsp;</td>
          <td class="radar-column" width="49%" valign="top" style="${styles.column}">${right.map(renderCard).join("\n")}</td>
        </tr>
      </table>
    </div>
  </section>`;
}

function renderCard(item: DigestItemRecord): string {
  const title = item.url
    ? `<a href="${escapeHtml(item.url)}" style="${styles.link}">${escapeHtml(item.title)}</a>`
    : escapeHtml(item.title);
  const meta = [item.deadline ? `Deadline ${item.deadline}` : "", item.sender ?? "", formatReceived(item.received_at)]
    .filter(Boolean)
    .join(" · ");
  return `<article style="${styles.card}">
    <div style="${styles.cardBody}">
      <p style="${styles.source}">${escapeHtml(item.category)}</p>
      <h3 style="${styles.title}">${title}</h3>
      ${meta ? `<p style="${styles.meta}">${escapeHtml(meta)}</p>` : ""}
      <p style="${styles.summary}">${escapeHtml(compact(item.summary, 280))}</p>
    </div>
  </article>`;
}

function splitColumns(items: DigestItemRecord[]): [DigestItemRecord[], DigestItemRecord[]] {
  const columns: [DigestItemRecord[], DigestItemRecord[]] = [[], []];
  const heights: [number, number] = [0, 0];
  for (const item of items) {
    const target = heights[0] <= heights[1] ? 0 : 1;
    columns[target].push(item);
    heights[target] += 80 + item.title.length * 0.8 + item.summary.length * 0.45;
  }
  return columns;
}

function compact(value: string, limit: number): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (normalized.length <= limit) return normalized;
  const sliced = normalized.slice(0, limit - 1).replace(/\s+\S*$/, "");
  return `${sliced}…`;
}

function formatReceived(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.valueOf())) return "";
  return date.toISOString().slice(0, 10);
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}
