# Operations

## Schedule and flow

Cloudflare invokes an hourly cron. The Worker starts a batch only when Mountain time is 07:00 or 19:00, which handles daylight-saving changes without changing UTC cron expressions. Workflow instance IDs contain the local time slot, so duplicate cron delivery is harmless.

Each batch:

1. pulls new Zoho messages when enabled;
2. verifies Notion access/schema when enabled;
3. claims queued or retryable records from D1;
4. parses MIME and permitted PDF/DOCX attachments;
5. enriches up to three safe public URLs;
6. classifies with Workers AI and applies deterministic policy checks;
7. creates/updates Notion records or queues digest items;
8. sends one non-empty digest;
9. deletes R2 payloads older than 24 hours; and
10. records run counts and status.

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
```

`/health` is public and exposes flags only, never credentials or message data. All `/admin/*` routes require the bearer token. `/admin/integrations` performs read-only credential, Notion schema, Zoho account, and configured-folder checks without returning message content or tokens. `/admin/sync/zoho` pulls only the configured Zoho folders without starting classification or digest delivery.

Use Cloudflare Workers logs for structured events such as `hey_email_ingested`, `zoho_sync_completed`, `message_processing_failed`, `digest_sent`, and `batch_completed`.

## Expected states

| Message status | Meaning | Operator action |
|---|---|---|
| `queued` | Waiting for the next batch | None |
| `processing` | Claimed by a running batch | Inspect only if stale after a failed run |
| `pending_notion` | Qualifying call retained while Notion is disabled/unavailable | Enable/fix Notion; next batch retries |
| `notion` | Published or updated | None |
| `digest` | Added to digest queue/sent | None |
| `ignored` | Deterministically or semantically irrelevant | None |
| `failed` | Parsing/classification/publishing failed | Check `last_error` and logs; retry after correcting cause |

## Failure behavior

- External APIs retry rate limits and server errors with bounded exponential backoff.
- A message failure does not abort the entire digest.
- Notion-disabled calls are retained as structured classifications; 24-hour raw-mail deletion does not lose the classification.
- Empty digests are not sent.
- Missing Zoho folders, credentials, or Notion access fail explicitly and leave source flags visible in `/health`.

## Data retention

- Raw MIME and parsed payloads: R2, purged 24 hours after ingestion by every batch (historical message dates do not shorten this window).
- D1: identifiers, extracted classifications, dedupe keys, digest metadata, checkpoints, and run history; no attachment binaries.
- Workers logs: governed by the Cloudflare account’s observability retention.
- GitHub HEY runner: ephemeral; delete `HEY_COOKIES_JSON` after backfill.

## Recovery

- Missed regular run: use `/admin/run`; source checkpoints overlap by one hour.
- Duplicate source delivery: D1 unique source/external-ID keys and Notion automation keys make reprocessing idempotent.
- Expired Zoho refresh token: install a new `ZOHO_REFRESH_TOKEN`, then manually run.
- Notion outage: leave `NOTION_ENABLED=true`, correct access, then manually run; `pending_notion` drains.
- HEY forwarding interruption: restore forwarding. For a gap longer than retained messages, rerun the HEY backfill Action with the required day count (maximum 31).

## Safe rollout

1. Deploy with Zoho and Notion disabled.
2. Verify `/health`, inbound HEY delivery, D1 queueing, and an empty/manual batch.
3. Enable Zoho, run once, and inspect counts/logs.
4. Enable Notion only after confirming the property names and integration access.
5. Inspect the first digest and first five Notion records; tune the AI threshold or prompt only with examples retained as tests.
