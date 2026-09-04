# Colossal opportunities

The Colossal adapter is implemented behind `COLOSSAL_ENABLED=false`. It has not been activated in production. It runs only in the existing Cloudflare batch, at 07:00 and 19:00 `America/Denver`, when enabled.

## Discovery and scope

The fixed source is Colossal's [Opportunities RSS feed](https://www.thisiscolossal.com/category/opportunities/feed/). The initial and ongoing discovery window includes the current and previous **named roundup month**, plus the next month as soon as its roundup appears. On September 4, 2026, the required months are August and September; their articles were published in July and August. Publication dates do not control inclusion.

RSS includes full article HTML. Missing or recognizably truncated content falls back to the linked article. If either required month is absent, the adapter checks the category's first archive page. It follows only discovered Colossal article URLs and reports `missingMonths` if the required coverage remains incomplete. It does not guess slugs, crawl the site, or silently extend the historical scope.

Archive-only discovery leaves the article publication date unknown; the named month is not treated as a publication date. A later feed observation supplies the publication metadata without changing snapshot identity.

The parser includes featured opportunities above the main sections and individual entries in Open Calls, Grants, and Residencies/Fellowships. It preserves continuation paragraphs, final/rolling deadlines, fees, and organizer/application links. Ingestion does not filter by geography, deadline, fee, or medium. The shared batch decides which entries qualify, need review, or are closed/irrelevant.

## Shared processing and publication

Each entry becomes bounded synthetic MIME in R2 and a `colossal` message in D1. Source text remains untrusted; the XML parser rejects DTDs/external entities, and article parsing is structural. No model is asked to split a whole roundup into a single classification.

The existing parsing, enrichment, Workers AI, classification policy, serialized Notion reconciliation, digest, and retention paths process these messages. Enrichment uses organizer/application links rather than spending its three-page budget on the roundup. D1 records discovery context separately from MIME, so embedded source instructions cannot change the evidence guard.

Automatic publication requires the existing confidence/geography/mechanism rules and a distinct official URL present in the entry's links or their safely fetched redirect destinations. The Colossal discovery domain cannot qualify as the official source. Unrecognized URLs, unresolved grouped programs, and shared program landing pages go to Possible Opportunities. Shared URLs are detected within articles and against previously ingested Colossal entries; queued records are marked before classification. A unique evidenced application URL can still distinguish programs. Existing Notion entity matching, manual-page preference, and manual-body protection remain in force.

The shared classifier now receives the batch's Mountain calendar date. A high-confidence call whose final due date is before that date is ignored. Deadline-day and rolling calls remain eligible. This date check applies to all sources; uncertain low-confidence calls still go to review. It does not infer an hour from a date-only deadline.

## Identity and recovery

A normalized candidate content hash controls message identity. Roundup URL/month, article timestamp, section, HTML formatting, and whitespace do not create another snapshot. Repeated entries across monthly posts deduplicate; changed deadlines, eligibility, URLs, descriptions, or explicit program cycles create new snapshots. Distinct programs retain separate source records even if their URLs collide.

D1 `source_documents` stores article URLs, roundup month, publication date, HTTP validators, a content hash, a next-entry cursor, pending state, checked time, and content-free error codes. `source_document_messages` links each article to its message snapshots. `source_http_cache` holds the feed validators. No full feed or article body is stored in these tables.

The adapter saves pending article work before advancing the feed cache. A 304 therefore cannot hide unfinished imports or expired source data. Pending articles and articles linked to expired queued/failed messages remain eligible after their month leaves the discovery window. Restoring a snapshot preserves its ID; successful terminal states are not reset. Queued snapshots whose raw MIME expired behind a backlog are also restored by the shared public-source helper.

Limits per sync are four articles and 200 candidate entries, with explicit `deferred` counts and resumable article cursors. Requests use the shared 12-second timeout, five-redirect ceiling, and 1.5 MB response cap; every redirect is revalidated. XML/HTML depth and node counts are bounded. Individual entry text is capped at 60,000 characters and 30 links, with a 1 MB encoded MIME cap. Raw/parsed entry content uses the existing 24-hour R2 retention; publication time does not shorten that period.

Whole-feed failures fail the durable source step for retry. Article/entry failures remain pending and are counted while other work proceeds. Failure to persist the shared-URL safety metadata fails the source step, preventing the batch from publishing with incomplete guards. Unparseable feed metadata is counted and does not advance feed validators.

## Operations

- `GET /health`: includes `colossalEnabled`.
- `GET /admin/integrations`: includes a read-only Colossal feed inspection, with `matchingRoundups`, `invalid`, and `skipped`. It does not ingest or publish.
- `POST /admin/sync/colossal`: authenticated source-only import. It does not start classification, Notion writes, digest sending, or cleanup.
- **Sync Colossal source only**: manually dispatched GitHub workflow reusing the existing admin-request workflow.

The sync response and `colossal_sync_completed` log contain only counts/booleans: `discovered`, `extracted`, `ingested`, `unchanged`, `cached`, `unresolved`, `failed`, `deferred`, `missingMonths`, and `skipped`. `unresolved` counts entries with source-level review concerns encountered on this sync; it is not the eventual classifier digest count. `cached` counts articles skipped on unchanged HTTP evidence. Batch run counts continue to describe processed messages, not source-discovery errors.

Check `failed`, `deferred`, and `missingMonths` when diagnosing an import. A parser/layout failure must not be treated as a successful empty source. Inspect bounded error codes and pending counts; do not log or paste feed HTML, entry MIME, parsed text, or AI output. Source-only imports can be processed by the next scheduled batch, so coordinate any live acceptance close to that batch and the 24-hour retention window.

## Deployment and acceptance

No new secret or Cloudflare binding is needed. Migration `0006_add_colossal_source.sql` is required before deploying this code, even with the source disabled, because shared message persistence uses the new context column.

Production actions require explicit authorization under [AGENTS.md](../AGENTS.md): remote migration, deployment, source-only import, and any manual batch are separate actions. The intended sequence is to apply migration 0006, deploy with the source disabled, enable it through reviewed configuration/deployment, inspect access, and run a source-only import. Verify both requested roundup months, then verify a second sync queues no unchanged entries. Finally check scheduled Notion/digest/ignore outcomes, cross-source matching, and manual-content preservation.

Local regression tests use invented RSS, HTML, and organizer responses. See [Testing](TESTING.md). Public parser smoke checks inspect only counts; they are not evidence of a successful live D1 import or Notion publication.
