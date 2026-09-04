import { rss } from "./colossal";

export const septemberUrl = "https://hyperallergic.com/opportunities-in-september-2026/";
export const augustUrl = "https://hyperallergic.com/opportunities-in-august-2026/";
export function entryHtml(title = "Fictional Film Grant", url = "https://example.org/apply/film", deadline = "September 30, 2026") {
  return `<p><strong>${title}</strong><br>Submit a film for selection. Worldwide eligibility.<br><strong>Deadline:</strong> ${deadline} | <a href="${url}">Official details</a></p>`;
}
export function articleHtml(entries = entryHtml()) { return `<h2>Awards &amp; Grants</h2>${entries}`; }
export function feed(html = articleHtml()) {
  return rss([
    { title: "Opportunities in August 2026", url: augustUrl, html },
    { title: "Opportunities in September 2026", url: septemberUrl, html }
  ]);
}
