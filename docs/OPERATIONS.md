# Operations

## Schedule and flow

Cloudflare invokes an hourly cron. The Worker starts a batch only when Mountain time is 07:00 or 19:00, which handles daylight-saving changes without changing UTC cron expressions. Workflow instance IDs contain the local time slot, so duplicate cron delivery is harmless.

Each batch:

1. pulls new Zoho messages when enabled;
2. pulls new or changed Creative West listings using the fixed New Mexico/open/artist-or-organization filters and the local run date through 31 days later;
3. verifies Notion access/schema when enabled;
4. claims queued or retryable records from D1;
5. parses MIME and permitted PDF/DOCX attachments;
6. enriches up to three safe public URLs;
7. classifies with Workers AI and applies deterministic policy checks;
8. creates/updates Notion records or queues digest items;
9. sends one non-empty digest;
10. deletes R2 payloads older than 24 hours; and
11. records run counts and status.

## Health and manual run

```bash
curl https://WORKER_URL/health

curl -X POST https://WORKER_URL/admin/run \
  -H "Authorization: Bearer $ADMIN_TOKEN"

curl https://WORKER_URL/admin/runs \
  -H "Authorization: Bearer $ADMIN_TOKEN"

curl https://WORKER_URL/admin/integrations \
  -H "Authorization: Bearer $ADMIN_TOKEN"

curl -X POST https://WORKER_URL/admin/sync/zoho \
  -H "Authorization: Bearer $ADMIN_TOKEN"

curl -X POST https://WORKER_URL/admin/sync/creative-west \
  -H "Authorization: Bearer $ADMIN_TOKEN"

curl -X POST https://WORKER_URL/admin/notion/trash \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  --data '{"pageId":"NOTION_PAGE_ID"}'
```

`/health` is public and exposes flags only, never credentials or source content. All `/admin/*` routes require the bearer token. `/admin/integrations` performs read-only Notion schema, Zoho account/folder, and Creative West filtered-query checks without returning message/listing content or tokens. The two `/admin/sync/*` routes ingest only their named source without starting classification or digest delivery. `/admin/notion/trash` is an authenticated recovery tool; it moves exactly one supplied page ID to Notion trash and can be reversed in Notion.

Use Cloudflare Workers logs for structured events such as `hey_email_ingested`, `zoho_sync_completed`, `creative_west_sync_completed`, `classification_exhausted_sent_to_digest`, `notion_publish_deferred`, `message_processing_failed`, and `digest_sent`. A `hey_email_ingest_failed` event includes a privacy-safe `phase` (`r2_upload` or `d1_upsert`), the internal hashed message ID, and the declared raw size; it never includes sender, subject, Message-ID, or MIME content. Creative West logs contain only counts, the requested date bounds, and page/item indexes for failures—never listing descriptions. Use `/admin/runs` for authoritative completed/failed run counts.

Batch preparation is intentionally capped at four concurrent messages. This reduces wall time for R2 parsing and Workers AI while keeping Notion find-before-create serialized. Investigate a sustained rate below roughly four classifications per minute with message-status aggregates and Workflow step timings; do not raise concurrency until R2, D1, Workers AI limits, and Notion race safety have been revalidated.

See [Admin API](API.md) for response shapes and boundary errors.

## Expected states

| Message status | Meaning | Operator action |
|---|---|---|
| `queued` | Waiting for the next batch | None |
| `processing` | Claimed by a running batch | Inspect only if stale after a failed run |
| `pending_notion` | Qualifying call retained while Notion is disabled/unavailable | Enable/fix Notion; next batch retries |
| `notion_review` | Notion body was edited or returned truncated | Inspect and explicitly reconcile; automatic retries stop |
| `notion` | Published or updated | None |
| `digest` | Added to digest queue/sent | None |
| `ignored` | Deterministically or semantically irrelevant | None |
| `failed` | Parsing/storage/unhandled processing failed | Check `last_error` and logs; retry after correcting cause |

## Failure behavior

- External APIs retry rate limits and server errors with bounded exponential backoff.
- A message failure does not abort other message processing or a non-empty digest.
- Invalid full AI output receives a smaller recovery classification. If both AI passes fail, the message becomes a generic human-review digest item rather than disappearing.
- Notion-disabled calls are retained as structured classifications; 24-hour raw-mail deletion does not lose the classification.
- Retryable Notion API failures remain `pending_notion` rather than becoming terminal `failed` rows.
- Managed-body edits and truncated Markdown become `notion_review`; they are counted separately and do not retry every batch.
- Empty digests are not sent.
- Missing Zoho folders, credentials, Notion access, or a valid Creative West response fail explicitly and leave source flags visible in `/health`.

## Data retention

- Raw/synthetic MIME and parsed payloads: R2, purged 24 hours after ingestion by every batch (historical source dates do not shorten this window).
- D1: identifiers, extracted classifications, dedupe keys, digest metadata, checkpoints, and run history; no attachment binaries.
- Workers logs: governed by the Cloudflare account’s observability retention.
- GitHub HEY runner: ephemeral; delete `HEY_COOKIES_JSON` after backfill.

## Recovery

- Missed regular run: use `/admin/run`; source checkpoints overlap by one hour.
- Duplicate source delivery: D1 unique source/external-ID keys make ingestion idempotent. Creative West content snapshots requeue changed listings without requeueing unchanged ones. Notion find-before-create combines automation key, Website variants, and conservative title equivalence.
- Expired Zoho refresh token: install a new `ZOHO_REFRESH_TOKEN`, then manually run.
- Notion outage: leave `NOTION_ENABLED=true`, correct access, then manually run; `pending_notion` drains.
- Notion body conflict: run **Inspect Notion review queue**, group entries by opaque page fingerprint, and dispatch once per actual page. Use `refresh_managed` only when the group's newest entry is exact or formatting-equivalent; use `preserve_manual` for substantive edits. The service selects the newest message and closes the same-page group together.
- HEY forwarding interruption: restore forwarding. For a gap longer than retained messages, rerun the HEY backfill Action with the required day count (maximum 31).
- HEY Worker exception: reproduce with `test/email-runtime.test.ts`, fix and deploy, verify one synthetic inbound canary reaches R2 and D1, then backfill the historical gap. Do not backfill while live delivery still fails.

## Safe rollout

1. Deploy with Zoho, Creative West, and Notion disabled.
2. Verify `/health`, inbound HEY delivery, D1 queueing, and an empty/manual batch.
3. Enable Zoho, run once, and inspect counts/logs.
4. Enable Creative West, run its source-only sync, and confirm the deadline bounds and queue counts.
5. Enable Notion only after confirming the property names and integration access.
6. Inspect the first digest and first five Notion records; tune the AI threshold or prompt only with examples retained as tests.

## Change management

- Run `npm run check` for every change; run `npm run test:coverage` for pipeline changes.
- Apply a remote D1 migration before code that requires it, using the manually dispatched deployment path.
- Routine `npm run deploy` does not reconcile the stable inbound Email Routing address. Use `npm run deploy:email-routing` only when an explicitly authorized operator intends to change that route and has reviewed Wrangler's plan.
- Deployment does not itself start a manual batch; the hourly cron continues to select the next local slot.
- Configuration/secrets and deploy/migrate/run/sync/trash operations are distinct production changes. Record which ones were performed in the handoff.
- The manual batch Action waits for the matching D1 run, verifies every queued item is counted, and fails on retryable Notion or message failures. `notion_review` is a counted terminal outcome and does not make an otherwise complete batch fail.
- Use [Troubleshooting](TROUBLESHOOTING.md) for symptom-driven recovery rather than repeatedly forcing batches.
