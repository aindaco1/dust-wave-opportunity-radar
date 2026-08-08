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
  "zohoEnabled": true
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

Returns the 25 most recently started D1 run records.

```bash
curl --fail-with-body "$WORKER_URL/admin/runs" \
  -H "Authorization: Bearer $ADMIN_TOKEN"
```

## `GET /admin/integrations`

Performs live, read-only Notion and Zoho access/schema/folder checks. Returns `200` only when both checks succeed and `502` with per-integration error text otherwise. It does not return tokens or message content.

```json
{
  "ok": true,
  "notion": { "ok": true, "value": { "dataSourceId": "…", "properties": [] } },
  "zoho": { "ok": true, "value": { "accountEmail": "…", "configuredFolders": [], "matchedFolders": [] } }
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

## Errors

| Status | Meaning |
|---|---|
| `400` | Invalid bounded JSON/body/page ID/import metadata |
| `401` | Missing or incorrect bearer token |
| `404` | Unknown public or admin route |
| `502` | One or more integration inspections failed |
| `500` | Unhandled route failure; response omits internal details |

External API adapters include their endpoint and status in bounded internal error messages, which appear in structured logs or relevant D1 error fields.
