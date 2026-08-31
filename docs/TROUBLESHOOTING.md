# Troubleshooting

Start with the least invasive evidence:

1. `GET /health` for deployed flags and schedule values.
2. `GET /admin/integrations` for live Notion/Zoho/Creative West access.
3. `GET /admin/runs` for batch outcome counts and failure text.
4. Cloudflare structured logs for the run/message ID.
5. D1 metadata only when the first four do not explain the state.

Do not retrieve or print raw R2 MIME unless the investigation explicitly requires private content and the user has authorized that handling.

## Schedule and run

### No batch at the expected time

- Confirm `/health.timezone` is `America/Denver` and `batchHours` is `[7,19]`.
- The cron runs hourly in UTC; local-slot code chooses the two Mountain-time ticks.
- Check Workflow instances and logs for `scheduled_tick_skipped` versus `batch_workflow_started`.
- Start one recovery batch with the manual GitHub Action or `POST /admin/run`. A manual run is forced and uses a unique ID.

### Run remains `running`

Inspect Cloudflare Workflow step status. Message claims become reclaimable after 15 minutes, but the durable Workflow may still be retrying an external step. Do not start repeated manual batches until the current execution state is understood.

### Empty digest

No email is expected when `digest_items` has no unsent rows. A successful run with `digestSent: false` is normal. Check notion/digest/ignored/failed counts before treating it as delivery failure.

## HEY

### New HEY messages are absent

- Confirm official forwarding still targets `hey@ingest.dustwave.xyz`.
- Check Cloudflare Email Routing for the `ingest.dustwave.xyz` subdomain; do not move the apex MX records away from Zoho.
- Look for `hey_email_ingested` or `hey_email_ingest_failed`.
- A message over 25 MiB is rejected at the email boundary.

For `hey_email_ingest_failed`, use the logged phase without retrieving the MIME:

- `r2_upload`: verify the incoming stream is passed through `FixedLengthStream(message.rawSize)` before `MAIL_BUCKET.put`; R2 rejects arbitrary streams whose length is unknown. A byte-count mismatch also fails here and removes any partial object.
- `d1_upsert`: the MIME reached R2 but the metadata row failed. Inspect D1 availability/schema and confirm the cleanup event did not fail.

Run `npx vitest run test/email-runtime.test.ts` before any production canary. This uses a real local Email Worker event and local bindings, and should create one queued D1 row plus an equal-sized R2 object without logging sender, subject, or body.

For a historical gap, use the HEY backfill workflow only after supplying a fresh temporary `HEY_COOKIES_JSON`; delete it after the import. Imports are idempotent by stable external ID. Compare the oldest imported timestamp and failed/missing-raw aggregates before and after the run. If only the newest 30 Paper Trail rows appear, verify the audited pagination patch applied and its regression test passed; HEY may emit folder-scoped `/paper_trail?page=...` cursors rather than root `/?page=...` cursors. For rows already proven failed with expired raw data, use the bounded temporary `HEY_BACKFILL_TARGETS_JSON` recovery list rather than scanning unrelated mail, then delete that secret with the cookie secret.

## Zoho

### Folder not found

The configured names must resolve case-insensitively to all four folders: `Inbox`, `Dust Wave`, `Newsletter`, and `Notification`. `/admin/integrations` reports every missing name. Correct the Zoho folder or reviewed configuration; do not silently remove a folder to make the check green.

### OAuth refresh failed

Confirm the client/refresh token belong to the configured data center and include the minimum mail-read scopes. Replace the expired/revoked `ZOHO_REFRESH_TOKEN` with `wrangler secret put`, then use `/admin/integrations` before a batch.

### Messages fetched but not ingested

Inspect `sampleErrors` from `/admin/sync/zoho` and `zoho_message_ingest_failed` logs. The sync stores the original MIME when available and builds bounded fallback MIME from the content endpoint otherwise. A failed item moves the checkpoint back to the oldest failed receive time so a later sync retries it.

### Creative West sync fails or returns unexpected counts

Use `/admin/integrations` to confirm the public GraphQL query is reachable, then `/admin/sync/creative-west` to inspect only the requested `deadlineFrom`, `deadlineTo`, and counts. The window starts on the current `America/Denver` calendar date and ends 31 calendar days later. Expected filters are New Mexico, open status, artist or organization (including the portal's combined applicant values), and newest open date first. Do not log or paste listing descriptions while diagnosing. A malformed individual listing increments `failed`; an invalid page-level response fails the durable sync step so Workflow retry policy applies.

## Classification

### Automatic classification could not produce a reliable structured result

This sentence appears only after both the full JSON-schema pass and smaller recovery pass fail. The item is deliberately held in `Possible Opportunities`.

Investigate:

- Workers AI service/model errors in logs;
- evidence size or a malformed/opaque newsletter body;
- an unexpected response envelope/schema issue;
- attachment parsing warnings; and
- repeated failures from the same template/sender.

The system already compacts oversized tracking URLs, bounds evidence sections, parses common response envelopes, and retries with a reduced schema. If a reproducible template still fails, create a synthetic fixture and improve response parsing/evidence construction or the recovery prompt. Do not bypass schema validation or auto-publish the fallback result.

### Wrong Notion/digest decision

Capture the generalizable evidence pattern without private data, add a classification regression test, then adjust deterministic policy or prompt wording. Check whether the issue is actually missing official-URL evidence or confidence demotion before changing the threshold.

## Notion

### `pending_notion`

The structured classification is safe in D1. Verify `NOTION_ENABLED=true`, token/data-source access, and exact properties through `/admin/integrations`. The next batch retries `pending_notion` without needing raw MIME.

### Duplicate opportunity

Compare title year, canonical Website, Automation Key, and D1 ownership. Add positive and negative title-matching regression cases before extending entity resolution. Automated reconciliation prefers a manual page and trashes only proven automation-owned duplicates.

### Managed opportunity text was edited

The adapter found D1’s prior generated Markdown but not that exact text in the page. It moves the message to `notion_review` and refuses to overwrite possible manual edits. Use **Inspect Notion review queue**. Choose `refresh_managed` only when the report says the content is exact or formatting-equivalent; otherwise use `preserve_manual`, which leaves the body untouched and limits future automation to properties.

### Truncated Notion Markdown

The API did not return the complete page, so replacement is unsafe and the item moves to `notion_review`. Preserve the body as manual or shorten/archive it deliberately; never proceed with partial replacement.

### Need to remove a bad automated page

Use Notion UI trash or the exact-page authenticated workflow described in [Admin API](API.md#post-adminnotiontrash). Verify the target page ID first. Trashing is recoverable in Notion.

## Retention and failed messages

R2 cleanup intentionally leaves D1 classifications and errors. A failed message stops automatic queue selection at four attempts. Fix the cause and deliberately re-import/requeue it; if its raw key was expired and cleared, source re-import resets attempts and returns it to `queued`.

See [Operations](OPERATIONS.md) for normal state meanings and [Security](SECURITY.md) for incident response.
