# Artwork Archive opportunities

The optional adapter reads the [Western U.S. guide filtered to Film/Video/New Media](https://www.artworkarchive.com/call-for-entry/west/guide-to-artist-grants-opportunities?opportunity_search=&opportunity_category_filter%5B%5D=5#guide-anchor). `ARTWORK_ARCHIVE_ENABLED=true` is configured for the explicitly authorized Cloudflare access check. An absent or non-true value disables the source; disable it again if access fails. No new secret, binding, scheduler, or personal-machine service is required by this adapter. Migration 0008 adds the message source; activation still requires verified automated access and an explicitly authorized production rollout.

## Scope and access

The category parameter `opportunity_category_filter[]=5` means **Film/Video/New Media**, not grants. The adapter reads all call types returned by that exact filtered Western guide. It does not widen to the national directory or restrict to grants, free calls, New Mexico venues, or a 31-day deadline window. Every extracted listing enters the existing batch policy, including rolling, distant-deadline, paid, and geographically uncertain calls.

On September 8, 2026, the browser showed two entries: Lucid Art Residency Program 2027 and Breck Create Artist in Residence Program. Both included organizer and application links. This is a dated browser observation, not a production import or confirmation that either passes classification.

An unauthenticated direct HTTP request using Radar's actual User-Agent returned **403, browser verification required**. Ordinary browser access succeeded. Cloudflare Worker access has not been verified. Do not leave the source enabled for scheduled ingestion until the read-only integration check succeeds from Cloudflare. That check requires an explicitly authorized deployment with the flag enabled, inspection before the next batch slot, and disabling it again if access fails. If that access is also challenged, obtain a publisher-supported feed/API or permission for an approved retrieval method before activation. This adapter does not transfer browser cookies, solve challenges, or run a local watcher.

## Parsing and publication

The structural parser checks the guide heading and selected category, then extracts individual `opportunity-guide-entry` cards. It retains title, type, organization when present, full description and eligibility notes, deadlines, fees, award information, location, and actual external link targets. Relative links resolve against the guide; unsafe URLs and Artwork Archive/account links cannot supply official evidence. Dynamic day counts, schedule buttons, navigation, scripts, and trial promotions are excluded from snapshot identity.

Redirects must retain the exact guide and category. Unknown layouts, unverified filters, pagination, missing card titles/details, oversized entries, and empty guides fail visibly. The observed “More coming soon” heading appears even alongside results, so it is not reliable proof of a legitimately empty guide. A future empty result is held for inspection rather than accepted as a successful empty import.

The shared discovery-context policy requires a distinct evidenced official URL and the existing confidence, selection-mechanism, geography, and final-deadline checks. The Artwork Archive discovery page cannot authorize publication. Grouped programs within one card, shared program URLs, missing official links, unresolved shorteners, and otherwise uncertain calls go to human review. Notion uses the existing find-before-create, manual-page preference, and managed-body protection. Its source label is `Artwork Archive`. Cross-source matching occurs in Notion; this source does not introduce cross-source digest deduplication.

## Persistence and recovery

`public-document.ts` shares document processing, normalized content identity, bounded synthetic MIME, collision guards, and resumable progress with Colossal and Hyperallergic. `public-snapshot.ts` remains the sole public snapshot writer. The evergreen guide uses one `source_documents` row with an empty `roundup_month` and unknown publication date. No guide HTML is retained in D1.

Unchanged listings do not requeue successful terminal records. Substantive changes produce a new snapshot. Pending imports and expired queued/failed payloads request a fresh body without validators, retaining snapshot IDs on restoration. Pending state is persisted before any entry writes, so interruption or a failed collision guard cannot be hidden by a later 304. Shared-URL guard persistence failures stop the source step before batch publication.

Limits are one fixed guide per sync, 200 entries per pass with a durable cursor, 12 seconds/five safe redirects/1.5 MB per response, bounded HTML depth/node counts, 60,000 text characters and 30 links per entry, and 1 MB encoded MIME per snapshot. R2 uses the existing 24-hour retention. The next batch revisits deferred work. Listings removed upstream cannot be reconstructed after payload expiry.

## Operations and rollout

- `GET /health` includes `artworkArchiveEnabled`.
- `GET /admin/integrations` includes read-only `artworkArchive` inspection: `matchingEntries` and `skipped`. A 403 or parser error fails the inspection without importing anything.
- `POST /admin/sync/artwork-archive` and **Sync Artwork Archive source only** queue source data without starting AI, Notion, a manual batch, digest delivery, or cleanup.
- Sync returns only `extracted`, `ingested`, `unchanged`, `cached`, `unresolved`, `failed`, `deferred`, and `skipped`. Check the counters even on HTTP 200; document errors increment `failed` and remain pending with `document_sync_failed` in D1. Other queued sources may still proceed through the scheduled batch. An HTTP success alone is not source acceptance.
- A disabled adapter performs no network or storage I/O.

Run the full local gate and apply all migrations to an isolated local D1 database first. For an explicitly authorized rollout, apply `0008_add_artwork_archive_source.sql`, deploy, and verify automated access before leaving the flag enabled for the next 07:00/19:00 `America/Denver` batch. If inspection fails, keep the source disabled and resolve access. No production action is implied by local preparation; see [AGENTS.md](../AGENTS.md).

After access is verified, an authorized first source-only sync must show nonzero extracted entries and zero failures/deferred work. Confirm a repeat adds zero unchanged snapshots. Then separately verify the normal scheduled classification, Notion matching/manual-content preservation, and digest outcomes. A source-only import can be consumed by the next normal batch; it is not a publishing sandbox.

## Verification

Synthetic fixtures reproduce the observed guide/card markup without retaining live content. Tests cover the exact filter, full evidence, rolling calls, changing countdowns, unsafe/shared URLs and grouped programs, layout/access failures, limits, snapshots, terminal preservation, expired-payload recovery, interrupted/capped work, collision-safety failures, migration preservation, authenticated routes, disabled no-I/O behavior, and shared Notion/digest/ignore outcomes with empty-repeat suppression. Local tests and dry bundling do not establish Cloudflare access or production delivery.

Local validation on September 8, 2026 passed `npm run check`: 363 tests in 30 files, enforced coverage floors (90.22% statements, 80.81% branches), generated types, documentation checks, and the dry Worker bundle. All eight migrations applied to an isolated local Wrangler database. Actionlint and `git diff --check` also passed. No remote migration, deployment, source import, Notion write, or digest send was performed.
