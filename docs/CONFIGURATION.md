# Configuration reference

`wrangler.jsonc` is the reviewed production configuration. `.env.example` lists secret names for local development; copy it to the untracked `.dev.vars` and fill values only when a local operation needs them.

The GitHub repository and local project folder are named `dust-wave-opportunity-radar`. Existing deployed Cloudflare resources intentionally retain their stable `dustwave-opportunity-radar` identifiers; renaming the repository does not rename or recreate production infrastructure.

## Cloudflare bindings

| Binding | Resource | Purpose |
|---|---|---|
| `AI` | Workers AI remote binding | Structured classification and recovery |
| `DB` | D1 `dustwave-opportunity-radar` | Queue and operational state |
| `MAIL_BUCKET` | R2 `dustwave-opportunity-radar-mail` | Temporary raw/parsed mail |
| `BATCH_WORKFLOW` | Workflow `dustwave-opportunity-radar-batch` | Durable batch execution |
| `EMAIL` | Email Sending | Allowlisted digest delivery |

The inbound Worker address is `hey@ingest.dustwave.xyz`. Email Sending is allowlisted from `opportunities@digest.dustwave.xyz` to `alonso@hey.com`.

`wrangler.jsonc` retains the inbound `addresses` declaration as the reviewed Email Routing source of truth. Routine `npm run deploy` derives a mode-`0600` temporary config that omits only `addresses`, so Wrangler leaves the already-provisioned route untouched and the CI credential does not need permission to change mail routing. The temporary file is removed after Wrangler exits. Use `npm run deploy:email-routing` only for an explicitly authorized route change with an interactive operator credential, after reviewing Wrangler's Email Routing plan.

## Plain Worker variables

| Variable | Production value | Meaning |
|---|---|---|
| `ENVIRONMENT` | `production` | Environment label |
| `TIMEZONE` | `America/Denver` | Local schedule and digest date zone |
| `BATCH_HOURS` | `7,19` | Comma-separated local hours selected from hourly cron |
| `AI_MODEL` | `@cf/meta/llama-3.3-70b-instruct-fp8-fast` | Only model reviewed by this release |
| `AI_CONFIDENCE_THRESHOLD` | `0.82` | Minimum automatic Notion confidence |
| `DIGEST_TO_EMAIL` | `alonso@hey.com` | Human-review recipient |
| `DIGEST_FROM_EMAIL` | `opportunities@digest.dustwave.xyz` | Verified sender |
| `DIGEST_FROM_NAME` | `Dust Wave Opportunity Radar` | Display name |
| `NOTION_ENABLED` | `true` | Schema check, pending drain, and publication switch |
| `NOTION_DATA_SOURCE_ID` | `248a67e1-4d47-48f8-bc84-a9602ca91b78` | Opportunities data source |
| `ZOHO_ENABLED` | `true` | Zoho batch synchronization switch |
| `CREATIVE_WEST_ENABLED` | `true` | Creative West filtered-feed synchronization switch |
| `COLOSSAL_ENABLED` | `true` | Colossal monthly-roundup synchronization switch |
| `HYPERALLERGIC_ENABLED` | `true` | Hyperallergic monthly-roundup synchronization switch |
| `ZOHO_ACCOUNT_EMAIL` | `alonso@dustwave.xyz` | Required account/alias |
| `ZOHO_DATACENTER` | `us` | API endpoint family |
| `ZOHO_FOLDERS` | `Inbox,Dust Wave,Newsletter,Notification` | Exact folders required at startup |
| `INITIAL_BACKFILL_DAYS` | `7` | Initial Zoho lookback |
| `ATTACHMENT_MAX_BYTES` | `20971520` | Per-attachment parse cap (20 MiB) |
| `R2_RETENTION_HOURS` | `24` | Raw/parsed object retention |

Feature switches parse as enabled only for the exact string `true`. `BATCH_HOURS` must contain integers from 0–23. Confidence must be 0–1; the three size/retention values must be positive integers. Creative West's endpoint and source scope are code-reviewed constants: New Mexico, open status, artist/organization eligibility, open-date sorting, and a deadline range from the local run date through 31 calendar days later.

Colossal uses fixed public RSS/article endpoints and no secret. Its source window, parser limits, progress state, and safe rollout are documented in [Colossal](COLOSSAL.md). Migration 0006 must precede deployment of this code.

Hyperallergic reuses the shared roundup machinery with its own fixed feed/archive and parser. Migration 0007 extends the message-source constraint; apply it before enabling `HYPERALLERGIC_ENABLED=true` and deploying the new source. No new secret or binding is required. See [Hyperallergic](HYPERALLERGIC.md).

## Cloudflare secrets

| Secret | Used for |
|---|---|
| `ADMIN_TOKEN` | Bearer authorization for every `/admin/*` route |
| `NOTION_TOKEN` | Workspace-scoped static Notion API token |
| `ZOHO_CLIENT_ID` | Zoho OAuth refresh |
| `ZOHO_CLIENT_SECRET` | Zoho OAuth refresh |
| `ZOHO_REFRESH_TOKEN` | Offline Zoho Mail access |

Install with `npx wrangler secret put NAME`. Use a random admin token with at least 256 bits of entropy. Never store a secret in `wrangler.jsonc`, D1, R2 metadata, logs, generated types, documentation, or issue/PR text.

## GitHub repository configuration

| Kind | Name | Purpose |
|---|---|---|
| Secret | `CLOUDFLARE_API_TOKEN` | Manual deploy/migration workflow; one-account `Workers Scripts: Edit` and `D1: Edit` only |
| Secret | `ADMIN_TOKEN` | Manual admin workflows and HEY import |
| Secret | `HEY_COOKIES_JSON` | Temporary HEY historical import only; delete afterward |
| Secret | `HEY_BACKFILL_TARGETS_JSON` | Optional temporary recovery list of `{id,folder}` objects; delete afterward |
| Variable | `CLOUDFLARE_ACCOUNT_ID` | Wrangler deployment target |
| Variable | `WORKER_URL` | Manual admin workflow target |

GitHub Actions reads Node from `.nvmrc`, installs through one local composite action, and routes authenticated operator requests through one reusable workflow. The separate dispatch workflows remain the user-visible authorization boundaries. The `production` environment accepts only protected branches, and repository settings require the pinned `CI / check` result before `main` changes.

## Supported Zoho data centers

`us`, `eu`, `in`, `au`, `jp`, `ca`, `sa`, and `uk` are mapped to explicit account/mail hosts. Any other value fails before OAuth traffic.

## Configuration change checklist

1. Update `wrangler.jsonc` and this reference together.
2. Add validation/behavior tests in `test/config.test.ts` when semantics change.
3. Run `npm run cf-typegen` only if binding/type output changes, then `npm run check`.
4. Confirm Email Sending allowlists and external-resource IDs before deployment.
5. Treat enabling a source, changing retention, or changing the AI threshold as a production behavior change requiring an explicit deployment.
6. Treat `npm run deploy:email-routing` as a separate privileged production action; routine deployment must not require Email Routing access.
