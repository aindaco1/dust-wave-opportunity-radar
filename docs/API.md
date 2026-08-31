# Admin API

The Worker exposes one public health route and authenticated operator routes. Every `/admin/*` route requires `Authorization: Bearer $ADMIN_TOKEN`. Requests and responses are JSON unless noted.

Examples assume:

```bash
export WORKER_URL="https://dustwave-opportunity-radar.jogo.workers.dev"
```

Do not place the token directly in shell history; load `ADMIN_TOKEN` from a secure environment.

## `GET /health`

Public liveness/configuration summary. It does not verify credentials or return message data.

```json
{
  "ok": true,
  "service": "dustwave-opportunity-radar",
  "timezone": "America/Denver",
  "batchHours": [7, 19],
  "notionEnabled": true,
  "zohoEnabled": true,
  "creativeWestEnabled": true
}
```

## `POST /admin/run`

Starts a forced manual Workflow instance and returns `202 Accepted`. Source synchronization, classification, Notion publishing, digest delivery, and cleanup execute asynchronously in that Workflow.

```bash
curl --fail-with-body -X POST "$WORKER_URL/admin/run" \
  -H "Authorization: Bearer $ADMIN_TOKEN"
```

```json
{ "accepted": true, "instanceId": "manual-…" }
```

## `GET /admin/runs`

Returns the 25 most recently started D1 run records. Outcome fields include `notion_count`, `pending_notion_count`, `notion_review_count`, `digest_count`, `ignored_count`, and `failed_count`; their sum should equal `queued_count` for a completed run.

```bash
curl --fail-with-body "$WORKER_URL/admin/runs" \
  -H "Authorization: Bearer $ADMIN_TOKEN"
```

## `GET /admin/integrations`

Performs live, read-only Notion, Zoho, and Creative West access/schema/query checks. Returns `200` only when all checks succeed and `502` with per-integration error text otherwise. It does not return tokens or source content.

```json
{
  "ok": true,
  "notion": { "ok": true, "value": { "dataSourceId": "…", "properties": [] } },
  "zoho": { "ok": true, "value": { "accountEmail": "…", "configuredFolders": [], "matchedFolders": [] } },
  "creativeWest": { "ok": true, "value": { "deadlineFrom": "2026-08-10", "deadlineTo": "2026-09-10", "matchingOpportunities": 6, "skipped": false } }
}
```

## `POST /admin/sync/zoho`

Pulls configured Zoho folders into R2/D1 without starting classification, Notion writes, digest delivery, or retention cleanup.

```json
{
  "folders": ["Inbox", "Dust Wave", "Newsletter", "Notification"],
  "fetched": 0,
  "ingested": 0,
  "failed": 0,
  "sampleErrors": [],
  "skipped": false
}
```

## `POST /admin/sync/creative-west`

Pulls new or changed Creative West listings into R2/D1 without starting classification, Notion writes, digest delivery, or retention cleanup. Date bounds use the current date in `America/Denver`, and the response never contains listing content.

```json
{
  "deadlineFrom": "2026-08-10",
  "deadlineTo": "2026-09-10",
  "fetched": 6,
  "ingested": 6,
  "unchanged": 0,
  "failed": 0,
  "sampleErrors": [],
  "skipped": false
}
```

## `POST /admin/import/hey`

Private ingestion boundary used by the pinned HEY historical-import script. The JSON body is capped at 36 MB; decoded MIME is capped at 25 MiB.

```json
{
  "externalId": "stable-HEY-topic-or-message-id",
  "mailbox": "Imbox",
  "subject": "Open call",
  "senderName": "Arts Group",
  "senderEmail": "calls@example.org",
  "receivedAt": "2026-08-05T12:00:00.000Z",
  "rawBase64": "…"
}
```

Success returns `201` with the deterministic internal ID. Invalid dates, base64, metadata lengths, and body sizes return `400` without queueing a row.

## `POST /admin/notion/trash`

Moves exactly one validated Notion page ID to trash. This is recoverable in Notion but is still a deliberate state-changing operation.

```bash
curl --fail-with-body -X POST "$WORKER_URL/admin/notion/trash" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  --data '{"pageId":"11111111-1111-1111-1111-111111111111"}'
```

Use the equivalent manually dispatched GitHub Action when an audited operator path is preferable.

## `GET /admin/notion/review`

Returns bounded, content-free comparison metadata for messages awaiting a Notion body-ownership decision.

```json
{
  "items": [{
    "messageId": "64-character opaque ID",
    "pageKey": "16-character opaque fingerprint",
    "groupSize": 2,
    "isLatest": true,
    "reason": "managed_content_changed",
    "comparison": "manual_changes",
    "currentLength": 1200,
    "previousLength": 1100,
    "nextLength": 1250
  }]
}
```

## `POST /admin/notion/reconcile`

Selects the page group containing one exact `notion_review` message ID and reconciles that actual page once using the group's newest received message. Every review message resolving to the same page becomes terminal together, so an older message cannot overwrite a newer classification. `refresh_managed` is rejected with `409` unless the current body is exact or formatting-equivalent to the stored managed body. `preserve_manual` does not write page Markdown.

```json
{
  "messageId": "64-character opaque ID",
  "action": "preserve_manual"
}
```

The response includes the selected newest message ID, opaque page fingerprint, and reconciled group count; it does not expose page content, title, URL, or raw Notion page ID.

## Errors

| Status | Meaning |
|---|---|
| `400` | Invalid bounded JSON/body/page ID/import metadata |
| `401` | Missing or incorrect bearer token |
| `404` | Unknown public or admin route |
| `502` | Integration inspection failed, or reconciliation failed with a content-free `stage` identifier |
| `500` | Unhandled route failure; response omits internal details |

External API adapters include their endpoint and status in bounded internal error messages, which appear in structured logs or relevant D1 error fields.
