# Design decisions

## Hyperallergic shares the public-roundup pipeline

The initial Hyperallergic scope is monthly Opportunities roundups, matching the requested example. Standalone sponsored announcements are excluded. Publisher-specific layout/URL parsers share Colossal's bounded transport, month discovery, resumable progress, snapshot identity, and existing batch/Notion/digest machinery. This keeps one recovery and policy path instead of a second scraper service. Unresolved short links cannot qualify as official primary URLs. The reviewed configuration enables the source for the explicitly authorized rollout; migration 0007 must precede deployment. See [Hyperallergic](HYPERALLERGIC.md).

## Cloudflare is the execution boundary

Workers, Workflows, D1, R2, Workers AI, Email Routing, and Email Sending keep ingestion, state, scheduling, inference, and delivery off a personal machine. The tradeoff is provider-specific bindings and the need for a small Node test shim; dry-run bundling and Cloudflare-generated types guard that boundary.

## Batch publication instead of immediate writes

Inbound HEY mail is queued immediately and Zoho is pulled inside the same 12-hour Workflow. Classification, Notion publication, and digest delivery share a deterministic batch boundary. This makes digests coherent, avoids noisy immediate writes, and provides one run record for recovery.

## Official APIs in steady state

HEY official forwarding and the Zoho Mail API are the ongoing paths. HEY has no public read API, so the pinned `Sealjay/mcp-hey` revision is isolated to a manually dispatched, disposable historical-import runner with a temporary cookie secret.

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
