# Colossal opportunities integration plan

Status: proposed implementation; no Colossal ingestion or production changes have been made. Scope confirmed September 4, 2026: initially import the **current and previous roundup month**, then discover new and updated roundups through the existing Cloudflare batches.

## Source findings

- Colossal has a dedicated [Opportunities category](https://www.thisiscolossal.com/category/opportunities/) and a working [category RSS feed](https://www.thisiscolossal.com/category/opportunities/feed/). The feed returned ten posts with full `content:encoded` HTML, stable GUIDs, ETag, and Last-Modified when inspected on September 4, 2026.
- Roundups appear monthly, often before the named month starts. The [September roundup](https://www.thisiscolossal.com/2026/08/september-2026-open-calls-residencies-artist-grants/) was published August 28; the [August roundup](https://www.thisiscolossal.com/2026/07/august-2026-open-calls-grants-residencies/) was published July 29. A publication-date cutoff would miss part of the agreed scope.
- Listings use paragraphs, emphasized linked titles, continuation paragraphs, and deadline lines; category labels are not necessarily HTML headings. There are also unrelated navigation/promotion links. Both inspected posts had thirty emphasized title links; this is a parser investigation baseline, not a hard-coded expected item count.
- Listings include fixed and rolling deadlines, application fees, geographically limited calls, and useful jobs/training. One block can describe several programs; different blocks can link to the same organizer page.

## Target behavior

1. At the existing 07:00 and 19:00 `America/Denver` batches, discover matching posts from the Opportunities feed. No new scheduler or personal-machine service.
2. Split each roundup into independently actionable candidates before classification. A roundup must never become one combined Notion opportunity.
3. Queue each new or substantively changed candidate through the existing R2 synthetic-MIME and D1 message path. Use ingestion time for retention and processing order; retain article publication time separately as evidence.
4. Reuse existing parsing, safe web enrichment, Workers AI classification/recovery, deterministic policy, serialized Notion reconciliation, digest delivery, retries, and cleanup.
5. Keep the publication rules: concrete apply/submit mechanism, configured confidence threshold, official source evidence, and rejection only when all three target states are explicitly excluded. Retain worldwide calls, rolling calls, and fee-based calls for normal policy evaluation. Do not copy Creative West's New Mexico-only/31-day source filters.
6. Jobs, training, unresolved groups of programs, and insufficient official evidence follow the existing human-review route. Confirmed closed calls follow the current ignore policy during the batch, rather than being discarded during source discovery.

## Implementation sequence

### 1. Extract two narrow shared ingestion helpers

Start from `src/ingest/creative-west.ts` and `src/ingest/web-enrichment.ts`:

- Extract public snapshot persistence: deterministic message identity, unchanged check, bounded synthetic MIME storage, D1 upsert, R2 cleanup if the upsert fails, and restoration of failed rows whose raw content expired.
- Extract the existing safe redirect/fetch transport so both enrichment and RSS/HTML discovery share URL checks, per-hop validation, timeout, content-type validation, and bounded reads. Add options for RSS/XML and conditional request headers without weakening the current enrichment defaults.
- Keep source queries, source field normalization, and presentation source-specific. Preserve Creative West's existing IDs, MIME content, filters, and retry behavior through regression tests. Do not introduce a general crawler, plugin framework, second classifier, or separate publication queue.

### 2. Add a bounded Colossal source adapter

Implement `src/ingest/colossal.ts` with independently testable discovery, entry extraction, and synchronization functions.

- Fixed feed URL: `https://www.thisiscolossal.com/category/opportunities/feed/`. Use a maintained XML parser with external entities/DTD disabled and a structural HTML parser; select the smallest dependencies compatible with Workers. Do not split the article with a single regex or ask the classifier to discover every entry from the full roundup.
- Match the named roundup month/year from its title. On first import, September 4 means **August and September 2026**, even though their publication dates are July and August. Include an upcoming month's roundup as soon as published. If a title cannot be dated reliably, surface a source diagnostic rather than silently discarding it.
- Use full RSS content first. If it is absent/truncated, retrieve only that article through the shared safe fetcher. Allow bounded category archive discovery as a fallback when the feed cannot supply the requested months; never crawl arbitrary category links or construct guessed monthly slugs.
- Parse the Open Calls, Grants, and Residencies/Fellowships sections structurally. Start a candidate at a linked title within those sections, carry following description/deadline paragraphs until the next candidate or section, and preserve all its relevant application links. Ignore site navigation, sharing, subscription, and general support links.
- A multi-program block may fan out only when evidence identifies distinct programs and submission mechanisms. Otherwise retain it as one human-review candidate with the source link. Never fabricate subcalls or quietly drop ambiguous blocks.
- Proposed limits: 1.5 MB per response, the existing 12-second request timeout and five-redirect ceiling, at most four roundup fetches and 200 candidate entries per sync, with bounded MIME/evidence. Validate these constants against the feed and synthetic fixtures. Report cap exhaustion explicitly and resume with a stored checkpoint if the cap prevented completion.
- Keep a persistent pending-article worklist so a failed article is retried even after its month rolls out of the normal discovery window. An outage must not advance its completion checkpoint.

### 3. Handle updates, identities, and official evidence

- Source identity must not depend on paragraph index or feed order. Use normalized program name, application cycle where explicit, and canonical destination URL; keep roundup GUID/URL as provenance, not the sole candidate identity.
- Hash normalized, substantive candidate fields. Ignore layout/whitespace, tracking parameters, and article timestamps. Repeated unchanged entries across the two monthly posts should not create another message or resend a digest; real deadline, fee, eligibility, or description changes should queue a new snapshot.
- Reuse the shared snapshot helper's expired-failure recovery. Do not let an HTTP 304 or stored article hash suppress restoration of failed messages whose raw MIME is gone. Re-fetch affected articles when restoration is required; otherwise keep successful duplicate snapshots terminal.
- Store discovery and per-article progress in D1, including validators, last successful sync, pending retry state, and opaque candidate/message associations. Save validators only after durable progress is recorded. Never store full RSS/HTML in D1 or return it from a Workflow step.
- Label Colossal as the discovery source. Put organizer/application links ahead of the roundup URL in the enrichment evidence budget. The roundup URL must not qualify as the official primary URL merely because it is a valid public URL.
- Extend the **shared** evidence/policy seam with an optional discovery-source context for this distinction; demote an unevidenced/invented/aggregator primary URL to the existing Possible Opportunities path. Do not create a Colossal-specific publisher. A broken organizer page can still be reviewed from the discovered entry.
- Shared organizer URLs are an explicit acceptance risk: the current Notion automation key and matching accept identical primary URLs. Resolve a program-specific official/application URL before publication. Where programs still share one URL and cannot be distinguished safely, hold them for review rather than changing the global matching heuristic or allowing one program to overwrite another.
- Keep manual-page preference, find-before-create, stored managed Markdown, and duplicate-ownership rules unchanged. Cross-source duplicates from HEY, Zoho, or Creative West must still reconcile through that same path.

### 4. Wire state, operations, and documentation

- Add `colossal` to `sourceSchema`, source labels, and the Notion Source property mapping. Add `COLOSSAL_ENABLED=false` initially to the reviewed Worker config, runtime config, fixture bindings, generated types, and health response. No new secret is needed.
- Add the next ordered migration (currently `0006_add_colossal_source.sql`) to extend the messages source constraint and add the minimal source-sync/article metadata above. Preserve foreign keys, all message states, existing rows/indexes, and the schema-version contract. Update `test/support/d1.ts` and data-model tests; never edit migrations 0001–0005.
- Add a retryable Colossal sync step before loading queued messages in `src/workflow/batch.ts`, using the existing source-sync failure contract. Whole-feed failure must be explicit and retryable; individual malformed entries must be counted and retained for investigation/retry. Step outputs and logs contain only opaque IDs, statuses, counts, and bounded diagnostic codes.
- Add read-only inspection to `/admin/integrations` and a source-only `/admin/sync/colossal` endpoint. Reuse the current authenticated admin and reusable GitHub workflow seams. Distinguish discovered posts, extracted entries, queued snapshots, unchanged snapshots, unresolved entries, and failures in the response.
- Update README, architecture, classification/evidence, data model, configuration, setup, API, operations, troubleshooting, security, testing, Notion source vocabulary, and Codex handoff when the corresponding behavior is implemented. This plan alone does not change the documented live production profile.

## Acceptance tests

Use invented RSS/HTML and organizer pages; do not commit the live roundups as fixtures.

| Area | Required cases |
|---|---|
| Discovery | Current/previous named month despite prior-month publication; year rollover; early next-month post; missing full content; archive fallback; unknown title; disabled flag |
| Extraction | Emphasized titles without headings; continuation paragraphs; several categories; nested inline markup/entities; fixed/rolling deadlines; ignored promotion links; grouped programs; malformed or unexpectedly empty article |
| Deduplication | Unchanged rerun; reordered/whitespace-only HTML; same entry repeated next month; real deadline/eligibility change; conflicting cycle years; two programs sharing a URL |
| Storage/recovery | R2/D1 partial failure cleanup; preserved terminal state; restoration after raw retention; conditional 304 with pending failed items; retries across month rollover; cap exhaustion without lost entries |
| Network | Oversized XML/HTML, invalid content type, timeout, unsafe redirect, blocked/private destination, malformed XML and external-entity payload |
| Shared policy | High-confidence official call; aggregator or invented URL held for review; worldwide/Illinois/Pennsylvania eligibility; explicit all-three exclusion; closed, rolling, paid, job, and training examples |
| End to end | Several extracted entries become separate queued messages; every item reaches the existing Notion/digest/ignore path; cross-source duplicates reuse a page; manual text conflict remains `notion_review`; content-free Workflow outputs; empty digest remains suppressed |

Run focused tests, `npm run migrate:local`, and `npm run check` (including enforced `test:coverage` and dry-run bundle). Run `npm ci` after dependency/lockfile changes. Confirm the generated Cloudflare types and required GitHub CI check before merging.

## Rollout and completion

Deliver the implementation in two reviewable PRs: first the behavior-preserving shared helper extraction, then the Colossal adapter, state migration, pipeline wiring, tests, and documentation. Keep this source disabled until production activation is explicitly requested.

The eventual production sequence is: apply the new migration, deploy the disabled source, enable it through a reviewed deployment, inspect source access, run an explicitly requested source-only import, and verify August/September discovery plus unchanged second-sync behavior. Then verify the first scheduled batch's Notion/digest/ignore outcomes and cross-source reconciliation. Coordinate source-only validation close to the batch because R2 retention is 24 hours and the next scheduled batch can process queued items.

Deployment, remote migration, source sync, manual batch execution, and Notion actions remain distinct production authorizations under AGENTS.md. Local tests and merged code are not evidence of a successful live import. No recurring task needs to be created in Codex: Cloudflare owns the recurring work.
