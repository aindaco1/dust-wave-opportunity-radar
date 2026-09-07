import { renderDigestHtml, formatReceived } from "@dustwave/digest-core";
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
  const subject = `Dust Wave Opportunity Radar — ${dateLabel}`;
  const html = renderDigestHtml({
    subject, title: "Dust Wave Opportunity Radar",
    eyebrow: `${dateLabel} · ${items.length} item${items.length === 1 ? "" : "s"}`,
    introduction: "Relevant creative-industry calls that need a human look.",
    footer: "Compiled from enabled mail and public opportunity sources on the 12-hour Dust Wave schedule. Links return to the original public source when available.",
    sections: grouped.map(([category, categoryItems]) => ({ title: category, items: categoryItems.map(item => ({
      title: item.title, url: item.url, eyebrow: item.category, summary: item.summary,
      metadata: [item.deadline ? `Deadline ${item.deadline}` : "", item.sender ?? "", formatReceived(item.received_at)].filter(Boolean).join(" · ")
    })) }))
  });
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
