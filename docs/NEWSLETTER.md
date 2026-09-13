# Opportunities newsletter

A separate internal newsletter reads the current Notion Opportunities database on Monday and Thursday at 08:00 America/Denver. The feature is implemented but disabled pending the reviewed production setup below. It shares the existing Worker, Notion HTTP client, date helpers, Workers AI model, D1, Cloudflare email transport and Platform HTML escaping. It does not ingest sources or modify Notion pages.

## Selection and order

- Include a concrete Due Date from the current local calendar day through 31 calendar days later, inclusive. Exclude deadlines whose explicit time has already passed.
- If Application open is present, wait until that day, or its exact timestamp if provided. A missing opening date does not prevent inclusion.
- Require Due Date; do not substitute the end of Application open. Exclude archived/trashed pages and the Rolling tag even when a date exists.
- Include entries marked Done. Repeat eligible entries in each edition until they leave the window.
- Sort by local due date ascending. Within a date, favor explicitly film-focused entries: Film tags or film/cinema language in the title, followed by documentary/short/feature/animation/screenplay/post-production tags, then TV or screenwriting/directing titles. Retain all other types. Remaining ties use the stored date/time and title.
- Skip empty editions. A read, membership, pagination, or summary failure stops that edition rather than emailing an incomplete list.

## Content and privacy

Each entry includes name, linked website, type, opening date, deadline, all tags, Notion details, and a short paragraph based only on the page body. Missing descriptions are identified. Workers AI is instructed to identify contradictions between body dates and database properties in a separate note; this is a best-effort content check, not independent deadline verification. The structured properties always determine eligibility. Summaries cache by page ID and content hash (including dates and model/prompt version); changing source content invalidates the cache.

The beginning includes the database description starting at `Dust Wave Biz Info`, with a heading, company name, labeled business details, and concise resource links, followed by the opportunities list. The Biz License line and link are omitted from both HTML and plain text; the source database remains unchanged. Business identifiers, contact details and private resource links must never appear in source fixtures, public previews, logs, or commits. The introductory database-view instruction about rolling submissions is omitted. Linked resources are linked, not fetched or copied into the email.

The notice reads: “For active Dust Wave members only. This includes our internal business info, so please don’t forward it or share it outside the collective.” The help line reads “Email (address) or text (number) Alonso for assistance.” The approved help email comes from private newsletter settings; the phone is read from his Point People page. The same help email is the reply-to address.

## Recipient source

Fetch `https://dustwave.xyz/about.html` each run and extract only the first heading of each `article.member-card`. Resolve each member by an exact Point People Name (with explicitly reviewed name aliases). Use Email, falling back to Email 2 only when Email is empty. Missing or ambiguous people or invalid email addresses stop the send. Do not infer addresses or silently drop members. Deduplicate addresses. Recheck membership and email addresses immediately before delivery. A changed audience stops the frozen edition for review.

Delivery puts one member in To and the others in BCC, keeping addresses private. The current provider limit is 50 recipients in total; a larger audience stops visibly rather than being truncated. The separate newsletter binding retains sender restrictions and must receive the approved recipient allowlist through private deployment configuration. The original human-review digest binding stays unchanged.

## Configuration and activation

| Setting | Meaning |
|---|---|
| NEWSLETTER_ENABLED | `false` until production setup and activation are authorized |
| NEWSLETTER_HOUR | `8`, in the existing TIMEZONE |
| NEWSLETTER_DAYS | `1,4`, Sunday=0 through Saturday=6 |
| NEWSLETTER_SETTINGS | Secret JSON: databaseId, peopleDataSourceId, helpContactPageId, helpEmail, optional aliases object |
| NEWSLETTER_WORKFLOW | Separate durable newsletter workflow |
| NEWSLETTER_EMAIL | Separate sender/recipient-restricted Cloudflare email binding |

Example settings use placeholders only:

```json
{
  "databaseId": "11111111-1111-4111-8111-111111111111",
  "peopleDataSourceId": "22222222-2222-4222-8222-222222222222",
  "helpContactPageId": "33333333-3333-4333-8333-333333333333",
  "helpEmail": "help@example.org",
  "aliases": { "Public Member Name": "Notion Member Name" }
}
```

After authorization: confirm the existing Notion integration can read Opportunities (including its database description) and Point People; supply the private settings and approved recipient binding configuration; apply migration 0009; deploy and inspect an authenticated preview; enable Monday/Thursday delivery. The checked-in newsletter binding is limited to the existing owner recipient until the reviewed allowlist is supplied privately. Never publish real recipient addresses or the newsletter settings in the repository. Keep provider recipient setup, API access, deployment, first provider acceptance, and actual mailbox arrival as separate evidence.

## Preview and operations

- Authenticated `GET /admin/newsletter/preview`: build HTML from current sources; may refresh the private summary cache, but never freezes an edition or sends mail. Response uses `Cache-Control: no-store`.
- Authenticated `GET /admin/newsletter/status`: recent edition dates, state, timestamps and provider IDs, with no email bodies or recipient addresses.
- The hourly cron selects only the configured weekdays and local hour, including DST changes. Workflow IDs and edition keys use the local date.
- Migration `0009_add_newsletter.sql` adds editions and cached summaries. D1 stores private frozen content for at most the next scheduled cleanup after 24 hours; cache entries unused for 62 days are removed by scheduled cleanup. No source content is returned from durable steps.
- A frozen edition is inserted once. Atomic `prepared -> attempting` permits one provider request per date. Accepted means the provider accepted it, not mailbox delivery. Timeout, crash, missing provider ID or other uncertainty leaves `attempting`/`ambiguous`; never retry a provider attempt blindly. A Workflow failure signals required review. Inspect the provider activity logs before any recovery. There is intentionally no force-resend endpoint.
- Replayed editions cannot send after their local day. An empty edition stays suppressed for that date.
- Rollback: disable NEWSLETTER_ENABLED. The original 07:00/19:00 source batch and review digest continue. The migration is additive; do not drop receipt history to retry sends.

## Validation

`test/newsletter.test.ts` covers the 31-day boundaries, opening dates/times, expired timestamps, Rolling and Done, film preference on deadline ties, date-only time zone handling, Monday/Thursday DST scheduling, faithful links, escaping, missing descriptions, roster parsing and exact matching, pagination failures, summary caching, private addressing, immutable editions, duplicate/ambiguous delivery prevention, retention and durable replay. Run the repository's full `npm run check` before commit.
