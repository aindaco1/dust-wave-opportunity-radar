# Hyperallergic opportunities

Hyperallergic monthly Opportunities roundups use Radar's existing Cloudflare public-source pipeline. `HYPERALLERGIC_ENABLED=true` enables the source in the reviewed configuration for the explicitly authorized rollout. Migration 0007 must precede deployment; live verification is separate from local validation. No new secret or binding is required.

## Discovery scope

The fixed sources are the [Opportunities RSS feed](https://hyperallergic.com/tag/opportunities/rss/) and its [first archive page](https://hyperallergic.com/tag/opportunities/). The current and previous named roundup months are required; an early next-month roundup is included when discovered. Publication timestamps do not define the month window. Pending articles and expired queued/failed payloads remain recoverable beyond that window.

This integration covers monthly posts such as [Opportunities in September 2026](https://hyperallergic.com/opportunities-in-september-2026/), not every article in the tag. Standalone sponsored opportunity announcements are outside this initial scope. Only discovered HTTPS Hyperallergic monthly article URLs are accepted, including numeric prefixes and the observed April slug without `in`; no guessed slugs, arbitrary URL input, or site-wide crawl is used.

RSS bodies are preferred. Missing, truncated, or unparseable fragments fall back to the full article. Unrecognized section headings fail the article for review instead of silently dropping just that category. Missing required months trigger one bounded archive lookup and remain visible in `missingMonths` if not found.

## Entry fidelity and policy

The structural parser supports Ghost article bodies, the observed Awards/Grants, Residencies/Workshops/Fellowships, and Open Calls sections, and emphasized listing titles that need not be links. Two listings within one paragraph are separated at their line-start titles. Bold deadline/fee labels remain attached to their listing. Continuation paragraphs, fees, rolling/final dates, and actual link targets are retained; navigation, subscription cards, scripts, and unrelated sponsored page furniture are excluded.

Every extracted listing enters the shared queue. Ingestion does not reject based on geography, discipline, fee, or deadline. The normal batch applies eligibility, confidence, official-source, and closed-call rules. Unresolved grouped programs and shared landing-page URLs are marked for human review. Plural grant listings are conservatively treated as grouped until clarified.

Link labels are not destinations: a label naming an institution cannot establish its URL. Known shortened links, including `bit.ly` and `s.si.edu`, cannot themselves qualify as an official primary URL. Normal bounded enrichment follows redirects with the existing public-URL checks; only an evidenced official destination can authorize automatic publication. Unresolved shortcuts, Hyperallergic URLs, invented URLs, and ambiguous programs go to Possible Opportunities instead. The shortener guard applies to all candidates carrying discovery context, including Colossal.

Notion keeps its existing find-before-create, equivalent-entity matching, manual-page preference, and managed-body protection. The source label is `Hyperallergic`. Source snapshots are deduplicated within Hyperallergic; cross-source opportunity matching still occurs in Notion. This does not claim cross-source digest deduplication.

## Shared implementation and recovery

`src/ingest/roundup-source.ts` owns the existing Colossal and new Hyperallergic synchronization lifecycle. `roundup-parser.ts` shares bounded XML/DOM parsing and month handling; each publisher keeps its own URL and entry-layout parser. No second queue, classifier, scheduler, or Notion writer was added.

Each candidate produces bounded synthetic MIME and a D1 `hyperallergic` message. Content changes create new snapshots; article provenance, month, formatting, and whitespace do not. Existing successful snapshots remain terminal. D1 stores article progress/validators and snapshot links, not feed/article bodies. Pending work becomes durable before feed validators advance, so 304 responses cannot lose partial imports or expired payload restoration.

Limits remain four documents and 200 entries per source sync; excess work is deferred with durable cursors. Transport remains bounded to 12 seconds, five redirects, and 1.5 MB per response. XML/DOM structure is bounded; each entry permits 60,000 text characters, 30 links, and at most 1 MB encoded MIME. R2 payloads use the existing 24-hour retention. Results, logs, and Workflow step outputs contain counts/booleans or content-free diagnostic codes, never article bodies.

## Operations and rollout

- `GET /health`: includes `hyperallergicEnabled`.
- `GET /admin/integrations`: includes a read-only `hyperallergic` feed check returning `matchingRoundups`, `invalid`, and `skipped`.
- `POST /admin/sync/hyperallergic`: authenticated source-only synchronization.
- **Sync Hyperallergic source only**: manual GitHub workflow reusing the existing admin-request boundary.

Sync returns `discovered`, `extracted`, `ingested`, `unchanged`, `cached`, `unresolved`, `failed`, `deferred`, `missingMonths`, and `skipped`. These are source counters, not classifier outcomes. A disabled source does no network or storage I/O. Parser failures remain pending, not successful empty imports.

Before deployment, apply migration `0007_add_hyperallergic_source.sql`, which extends the message-source constraint while preserving message IDs, discovery context, article links/cursors, digest references, and Notion ownership. Run migrations locally and the full quality gate first. Remote migration and deployment require explicit authorization. Enable the reviewed flag only as part of that rollout; no source data has been imported merely by adding the code.

After authorized deployment, verify the flag and feed access, authorize a source-only import, inspect month/failure/deferred counts, and confirm a second sync adds no unchanged entries. Then separately verify scheduled Notion/digest outcomes at 07:00 or 19:00 America/Denver. Source-only import can be consumed by the next normal batch, so it is not an isolated production publishing sandbox.

## Verification

Synthetic tests cover both observed heading families, multiple listings per paragraph, shortener evidence, grouped/shared URLs, unsafe links, migration preservation, repeated imports, changed deadlines, cached recovery, partial work, authenticated source-only routing, shared batch outcomes, and manual Notion ownership. Public parser smoke checks found 14 September and eight August entries on September 4, 2026; these counts prove parsing only, not live D1 ingestion or publication.

Local verification passed on September 4, 2026: `npm run check` completed all 240 tests in 24 files, enforced coverage floors, generated-type/type checks, documentation checks, and a dry production-bundle build. All seven migrations applied successfully to an isolated local Wrangler database. September RSS and full-page entries were identical; the live-feed snapshot had zero invalid monthly items after supporting the April URL variant. No remote migration, deployment, live import, Notion write, or digest send was performed.

## Production acceptance — September 4, 2026

After explicit authorization, [PR 34](https://github.com/aindaco1/dust-wave-opportunity-radar/pull/34) merged the enabled source as `2422ec98938055898d948616fa58f82f47cea239`. [Production deployment](https://github.com/aindaco1/dust-wave-opportunity-radar/actions/runs/33866513638) passed all 240 tests, applied migration 0007 at 11:11:34 UTC, and deployed Worker version `ac013efd-4190-42c3-a702-3b9ca2fe30df` at 100% traffic. Live health confirmed the flag and unchanged 07:00/19:00 America/Denver schedule. Remote schema-version and migration-table checks confirmed version 7. Existing table counts, managed-body counts, and Colossal discovery-context coverage were preserved; the foreign-key check remained clean.

[Live integration inspection](https://github.com/aindaco1/dust-wave-opportunity-radar/actions/runs/33866862363) passed for all integrations. Hyperallergic returned two matching roundups, zero invalid items, and `skipped: false`.

| Source-only verification | Discovered | Extracted | Ingested | Cached | Failed | Deferred | Missing months |
|---|---:|---:|---:|---:|---:|---:|---:|
| [First import](https://github.com/aindaco1/dust-wave-opportunity-radar/actions/runs/33866937586) | 2 | 22 | 22 | 0 | 0 | 0 | 0 |
| [Repeat](https://github.com/aindaco1/dust-wave-opportunity-radar/actions/runs/33867018660) | 0 | 0 | 0 | 2 | 0 | 0 | 0 |

D1 independently held 22 unique queued snapshots: eight August entries and 14 September entries. All had raw-payload metadata and discovery context; neither document had pending work or an error code. The first sync's incremental `unresolved` counter was four. After shared-URL checks also marked earlier entries, five persisted snapshots carried review flags; this is the final queue safety state, not five new digest items.

At acceptance, all 22 classifications were still empty. Run, Notion-mapping, and digest-item counts were unchanged. No manual batch, Notion edit, or digest send was triggered. Scheduled classification/publication remains a separate acceptance claim. No HEY importer prototype, secret change, or Email Routing change was included.

Deployment dependency installation reported one moderate advisory in the unchanged lockfile. Follow-up online advisory requests timed out and GitHub reported no open Dependabot alerts; this release does not claim that warning was resolved or that a fresh security audit passed.
