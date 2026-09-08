# Design decisions

## Colossal uses named months and individual candidates

Monthly roundups can be published before their named month, so a publication-date cutoff would miss part of the requested current/previous-month scope. Discovery therefore uses the named month and includes an early next-month roundup when found. Structural parsing separates individual candidates before they enter the shared queue; classifying a whole roundup as one opportunity could combine unrelated programs into one Notion page.

The adapter extends the existing public snapshot and safe-fetch helpers, preserving Creative West's identity and recovery behavior. Source-specific parsing and shared batch policy keep broad roundup ingestion separate from automatic publication. Ambiguous grouped programs and shared organizer URLs need human review because a common URL alone cannot distinguish the programs safely. See the current [Colossal runbook](COLOSSAL.md) and the [archived implementation plan](archive/COLOSSAL-INTEGRATION-PLAN.md) for the original scope and investigation.

## Hyperallergic shares the public-roundup pipeline

The initial Hyperallergic scope is monthly Opportunities roundups, matching the requested example. Standalone sponsored announcements are excluded. Publisher-specific layout/URL parsers share Colossal's bounded transport, month discovery, resumable progress, snapshot identity, and existing batch/Notion/digest machinery. This keeps one recovery and policy path instead of a second scraper service. Unresolved short links cannot qualify as official primary URLs. The reviewed configuration enables the source for the explicitly authorized rollout; migration 0007 must precede deployment. See [Hyperallergic](HYPERALLERGIC.md).

## Artwork Archive uses the exact filtered evergreen guide

The requested category is Film/Video/New Media within the Western U.S. guide. Individual cards share document processing and public snapshot storage with the roundup adapters, without imposing a named-month window. Countdown text and account buttons do not create changed snapshots. Automated HTTP access returned a browser-verification 403, so the authorized Cloudflare access check must succeed before the source is left enabled for scheduled ingestion. See [Artwork Archive](ARTWORK-ARCHIVE.md).

## Cloudflare is the execution boundary

Workers, Workflows, D1, R2, Workers AI, Email Routing, and Email Sending keep ingestion, state, scheduling, inference, and delivery off a personal machine. The tradeoff is provider-specific bindings and the need for a small Node test shim; dry-run bundling and Cloudflare-generated types guard that boundary.

## Batch publication instead of immediate writes

Inbound HEY mail is queued immediately and Zoho is pulled inside the same 12-hour Workflow. Classification, Notion publication, and digest delivery share a deterministic batch boundary. This makes digests coherent, avoids noisy immediate writes, and provides one run record for recovery.

## Official APIs in steady state

HEY official forwarding and the Zoho Mail API are the ongoing paths. The legacy `Sealjay/mcp-hey` backfill remains isolated to a manually dispatched disposable runner with a temporary cookie secret. The official CLI's attachment-patched candidate passed local and GitHub qualification and now has a single-record historical-recovery adapter. It reuses the existing Worker importer and MIME builder, preserves legacy topic keys, excludes later replies, and refuses incomplete or edited historical content. This gives supervised recovery without adding a Worker endpoint, deployment, recurring watcher, or parallel classification path. Forwarded-message overlap remains unverified; new overlapping imports are refused. See [HEY CLI qualification](HEY-CLI.md).

## D1 plus short-lived R2

D1 retains compact structured operational state and identity mappings. R2 holds raw MIME and parsed content only long enough for batch processing/retry. This separation supports idempotency and troubleshooting without indefinitely retaining private attachments.

## AI proposes; deterministic code authorizes

Workers AI extracts semantics into a strict schema. Code—not the model—enforces URL canonicalization, confidence, geography, tag vocabulary, response validity, and Notion write eligibility. A smaller recovery model output can inform human review but cannot auto-publish.

## Conservative Notion entity resolution

URL/key matches are strongest, but opportunity emails often change title wording. Token/year comparison handles known submission/application variants. Manual pages win canonical selection and only proven automation-owned duplicates are trashed. The prior generated body is stored invisibly in D1 so useful page text can remain free of automation housekeeping while manual edits remain protected.

When a person edits generated body text, the conflict becomes an explicit `notion_review` item. Formatting-only differences may be refreshed; substantive edits can switch the page body to permanent manual ownership while automation continues managing structured properties.

## Content-free durable orchestration

Cloudflare persists Workflow step return values as execution metadata. Steps therefore return only opaque IDs, statuses, counts, and booleans. D1 remains the owner of message records and classifications, and each durable step reloads the state it needs.

## Real SQLite semantics in fast tests

The persistence suite applies production migrations to Node’s SQLite engine behind a minimal D1-shaped adapter. This catches constraints, `ON CONFLICT`, transactions, and date-query behavior without remote state. It does not emulate Cloudflare durability; Workflow orchestration tests and `wrangler deploy --dry-run` cover the adjacent boundaries.
