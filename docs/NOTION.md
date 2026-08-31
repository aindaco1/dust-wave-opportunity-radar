# Notion integration

## Scope and schema

The production connection is scoped to the Dust Wave workspace and shared with the Opportunities data source. The configured data source ID is `248a67e1-4d47-48f8-bc84-a9602ca91b78`.

The adapter expects these existing property names and types:

| Property | Write shape | Meaning |
|---|---|---|
| `Name` | title | Opportunity title |
| `Website` | rich text | Canonical official URL |
| `Tags` | multi-select | Existing controlled creative vocabulary |
| `Type` | select | Opportunity mechanism |
| `Due Date` | date | Final valid submission deadline |
| `Application open` | date range | Application window |

At batch startup, the adapter adds only missing automation properties:

| Property | Type | Meaning |
|---|---|---|
| `Automation Key` | rich text | Stable internal entity key |
| `Source` | select | `HEY`, `Zoho`, or `Creative West` |
| `Last Checked` | date | Latest automated observation |

Property-name matching is exact. Schema validation never deletes or changes an existing property.

## Find before create

Every automatic publication queries the data source first. Candidate filters include:

- exact `Automation Key`;
- canonical Website variants with/without `www` and a trailing slash;
- exact title; and
- combinations of meaningful title tokens.

Candidates are accepted only when code independently confirms a matching key, matching Website variant, or a likely-equivalent title.

Title comparison removes application/submission/call/deadline noise, ordinal numbers, and year tokens before comparing distinctive words. Conflicting explicit years are a hard non-match. Examples:

- `2026-2027 Short Animation Fellowship Application` = `Titmouse Foundation — Short Animation Fellowship`
- `2027 Taos Film Festival` = `Taos Film Festival Submission`
- `2026 Taos Film Festival` ≠ `2027 Taos Film Festival`
- `IMGN Short Film Fund` ≠ `Other Short Film Fund`

This heuristic is intentionally conservative. Add both positive and negative regression cases when extending it.

## Canonical page and duplicates

If equivalent pages exist, a page without automation ownership is preferred as canonical even when an automation-owned page is older. This preserves a manually created record.

A duplicate is moved to Notion trash only when ownership is proven by either:

- a non-empty `Automation Key` property; or
- an existing D1 `opportunities.notion_page_id` mapping.

Manual duplicates are never automatically trashed. Notion trash is recoverable, and the authenticated single-page trash route exists for deliberate operator recovery.

## Page body updates

New pages receive only useful opportunity Markdown: the classified overview/details, key dates and application links, and short classification evidence. Visible automation banners, last-checked sentences, end markers, and automation change histories are not written.

For an existing page, the adapter reads its Markdown and follows this order:

1. If the exact new generated body already exists, do nothing.
2. If a legacy visible managed block exists, replace that exact block for backward compatibility.
3. Otherwise, load the previous generated Markdown stored in D1 and replace that exact string.
4. If no prior generated text exists and the page is empty, replace the empty body.
5. If no prior generated text exists and the page contains manual notes, append the generated body.
6. If D1 says a prior generated body exists but it cannot be found, fail safely because a person may have edited it.
7. If Notion reports truncated Markdown, fail rather than risk an incomplete replacement.

Body conflicts move the message to `notion_review`, which is a terminal human-review state rather than an every-batch retry. An operator may refresh only formatting-equivalent content or preserve the current page body as manually owned. Manual ownership keeps property updates active while permanently disabling automated body replacement for that page.

After a successful write, the new generated Markdown, body-ownership mode, and page mapping are stored in D1.

## Review and reconciliation

`GET /admin/notion/review` returns privacy-safe comparison metadata for every `notion_review` item: opaque message ID and page fingerprint, same-page group size, newest-message flag, reason, comparison class, and content lengths. It never returns a raw page ID, page Markdown, title, URL, or classification text.

`POST /admin/notion/reconcile` accepts one exact message ID and one action:

- `refresh_managed` is accepted only for exact or formatting-equivalent managed content;
- `preserve_manual` leaves the current Notion body untouched and records manual ownership.

The message ID selects its resolved page group, not an independent write. Reconciliation applies only the newest received message in that group, marks the same-page review messages terminal together, and therefore cannot let an older message overwrite a newer page state.

The corresponding manual GitHub workflows use the same authenticated routes. Reconciliation never uses a force-overwrite action.

## Operational checks

Use the authenticated integration inspection route before enabling writes:

```bash
curl "$WORKER_URL/admin/integrations" \
  -H "Authorization: Bearer $ADMIN_TOKEN"
```

See [Setup](SETUP.md#5-notion), [Admin API](API.md), and [Troubleshooting](TROUBLESHOOTING.md#notion) for provisioning and recovery.
