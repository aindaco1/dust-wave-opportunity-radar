export const septemberUrl = "https://www.thisiscolossal.com/2026/08/september-2026-fictional-opportunities/";
export const augustUrl = "https://www.thisiscolossal.com/2026/07/august-2026-fictional-opportunities/";
export function entryHtml(title = "Fictional Film Grant", url = "https://example.org/apply/film", deadline = "September 30, 2026") {
  return `<p><strong><a href="${url}">${title}</a></strong><br/>Submit a film for selection. Worldwide eligibility.<br/><strong>Deadline:</strong> ${deadline}.</p>`;
}
export function articleHtml(entries = entryHtml()) { return `<p><strong>Open Calls</strong></p>${entries}`; }
export function rss(posts = [
  { title: "August 2026 Opportunities", url: augustUrl, html: articleHtml() },
  { title: "September 2026 Opportunities", url: septemberUrl, html: articleHtml() }
]) {
  return `<?xml version="1.0"?><rss version="2.0" xmlns:content="http://purl.org/rss/1.0/modules/content/"><channel>${posts.map((post) =>
    `<item><title>${post.title}</title><link>${post.url}</link><pubDate>Wed, 29 Jul 2026 12:00:00 GMT</pubDate><content:encoded><![CDATA[${post.html}]]></content:encoded></item>`
  ).join("")}</channel></rss>`;
}
export function responseAt(url: string, body: string | null, status = 200, type = "text/html", etag = '"v1"') {
  const response = new Response(body, { status, headers: { "content-type": type, etag } });
  Object.defineProperty(response, "url", { value: url });
  return response;
}
