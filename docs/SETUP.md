# Setup

This runbook provisions a new environment. The checked-in production configuration currently enables Zoho, Creative West, and Notion; for a fresh deployment, set `ZOHO_ENABLED`, `CREATIVE_WEST_ENABLED`, and `NOTION_ENABLED` to `false` until the relevant setup and read-only integration checks pass. See [Configuration](CONFIGURATION.md) for the complete binding/variable inventory.

## Prerequisites

- Node.js 24 or newer and npm
- a Cloudflare account with `dustwave.xyz`
- access to `alonso@hey.com` and `alonso@dustwave.xyz`
- the Dust Wave Notion workspace and Opportunities data source
- repository-admin access for GitHub secrets/variables

From the repository root, run `npm ci` and `npm run check` before provisioning anything.

## 1. Cloudflare resources

The Wrangler configuration defines one Worker, one Workflow, D1, R2, Workers AI, an Email Sending binding, the inbound address `hey@ingest.dustwave.xyz`, and the public Creative West source switch.

```bash
npm ci
npx wrangler login
npx wrangler d1 create dustwave-opportunity-radar --location wnam
npx wrangler r2 bucket create dustwave-opportunity-radar-mail --location wnam
npm run migrate:remote
npm run deploy:email-routing
```

For a new Cloudflare account, copy the D1 database ID returned by `wrangler d1 create` into `wrangler.jsonc` before migrating. The initial `deploy:email-routing` provisions the reviewed inbound address as well as the Worker. Later routine deployments use `npm run deploy`, which leaves the route untouched. Remote migration and either deployment command change production state; run them only for the intended account/environment.

If Wrangler reports that the inbound subdomain is not onboarded, open Cloudflare → `dustwave.xyz` → Compute → Email Service → Email Routing → Settings → Subdomains and add `ingest.dustwave.xyz`. This keeps the apex MX records on Zoho. Do **not** enable Email Routing at the `dustwave.xyz` apex.

Email Sending is separately onboarded for `digest.dustwave.xyz`. The binding is locked to sender `opportunities@digest.dustwave.xyz` and recipient `alonso@hey.com`.

Set an admin token with at least 256 bits of entropy:

```bash
openssl rand -hex 32 | npx wrangler secret put ADMIN_TOKEN
```

## 2. HEY ongoing forwarding

In HEY, open Accounts & settings → `alonso@hey.com` → Forwarding & Sending → **Forward email out of HEY…** and enter:

```text
hey@ingest.dustwave.xyz
```

HEY’s official forwarding sends all non-spam mail, including material surfaced in Imbox, Feed, and Paper Trail. This is intentional; the classifier performs the filtering. HEY documents that Screener status is ignored and spam is not forwarded.

## 3. HEY seven-day backfill

Ongoing forwarding does not backfill existing mail. The manual GitHub Action runs the pinned `Sealjay/mcp-hey` revision on a disposable GitHub runner, applies the repository's reviewed pagination compatibility patch, runs the upstream pagination regression test, imports Imbox/Feed/Paper Trail, then the runner is destroyed. The patch accepts both root and folder-scoped opaque cursor links; without it, HEY can silently repeat the newest page.

Because HEY has no public read API, this one-time path needs a valid `data/hey-cookies.json` captured by upstream `mcp-hey` on an authenticated machine. Add its complete JSON value as the private repository secret `HEY_COOKIES_JSON`. Also add:

- repository secret `ADMIN_TOKEN` — same value installed in the Worker
- repository variable `WORKER_URL` — deployed `https://…workers.dev` URL

Run Actions → **HEY seven-day backfill** → Run workflow. The importer is idempotent by the stable HEY external ID and imports Imbox, Feed, and Paper Trail over the selected window. For a proven pagination gap, an operator may temporarily set `HEY_BACKFILL_TARGETS_JSON` to a bounded array of `{id,folder}` objects so the runner reads only those known threads. Delete `HEY_COOKIES_JSON` and `HEY_BACKFILL_TARGETS_JSON` after the backfill succeeds. Ongoing official forwarding does not require either secret.

## 4. Zoho OAuth

Create a Zoho OAuth client for `alonso@dustwave.xyz` with offline access and the minimum read scopes:

```text
ZohoMail.accounts.READ,ZohoMail.folders.READ,ZohoMail.messages.READ
```

Store the resulting values without printing them:

```bash
npx wrangler secret put ZOHO_CLIENT_ID
npx wrangler secret put ZOHO_CLIENT_SECRET
npx wrangler secret put ZOHO_REFRESH_TOKEN
```

Change `ZOHO_ENABLED` to `true` in `wrangler.jsonc`, deploy, and run the read-only integration check before starting a batch. Connection setup validates the account and requires the folder names `Inbox`, `Dust Wave`, `Newsletter`, and `Notification`; matching is case-insensitive, and a missing folder fails loudly instead of silently scanning the wrong place. The first successful sync imports seven days and later runs use a one-hour overlap checkpoint.

Zoho’s OAuth authorization-code process is documented at [Zoho Mail OAuth 2.0](https://www.zoho.com/mail/help/api/using-oauth-2.html).

## 5. Creative West public source

Creative West requires no secret. `CREATIVE_WEST_ENABLED=true` activates the reviewed public GraphQL query during each batch. The adapter keeps the source filters fixed to New Mexico, open listings, artist/organization eligibility, and open-date sorting; it computes the deadline bounds from the Mountain-time run date through 31 days later. Before enabling classification, use the authenticated `/admin/integrations` check and `/admin/sync/creative-west` source-only route to verify the returned bounds and counts.

## 6. Notion

When integration access is ready, share the Opportunities data source with the integration and install its token:

```bash
npx wrangler secret put NOTION_TOKEN
```

The configured data source ID is `248a67e1-4d47-48f8-bc84-a9602ca91b78`. Change `NOTION_ENABLED` to `true` and deploy. On the next run the adapter verifies access, adds only missing automation properties (`Automation Key`, `Source`, `Last Checked`), and drains `pending_notion` records. It queries existing pages before every create and stores its prior generated Markdown in D1 rather than adding visible automation markers to a page.

Before enabling, confirm the existing property names used by the adapter: `Name`, `Website`, `Tags`, `Type`, `Due Date`, and `Application open`. Property matching is exact.

See [Notion integration](NOTION.md) before modifying properties or duplicate/entity matching.

## 7. GitHub deployment credentials

The manual deployment workflow expects repository secret `CLOUDFLARE_API_TOKEN` and repository variable `CLOUDFLARE_ACCOUNT_ID`. Create a user API token restricted to the intended Cloudflare account with exactly `Workers Scripts: Edit` and `D1: Edit`. Routine CI deliberately omits Email Routing reconciliation; do not add user-profile, membership, cross-account, zone, R2, or Email Routing access to this token. Also set repository variable `WORKER_URL` and repository secret `ADMIN_TOKEN` for the manual operations workflows. Protect `main`, require `CI / check`, require full action SHA pins, and restrict the `production` environment to protected branches. Keep production deployment manual until every enabled source has completed a test batch.

## Colossal optional source

Colossal is implemented with `COLOSSAL_ENABLED=false` and needs no new secret or binding. Apply migration 0006 before deploying this code. Enablement, live inspection/import, and scheduled acceptance are separate production steps; follow the [Colossal runbook](COLOSSAL.md#deployment-and-acceptance).

## 8. Activation verification

1. Call public `/health`; verify timezone, batch hours, and reviewed feature flags.
2. Run **Check source integrations**; Notion, Zoho, and Creative West must be `ok`.
3. Confirm one forwarded HEY test message produces `hey_email_ingested` and a D1 `queued` row.
4. Run **Sync Zoho source only**; verify the four folders and bounded counts without classification.
5. Run **Sync Creative West source only**; verify the local date through +31-day bounds and bounded counts without classification.
6. Start one manual batch.
7. Review `/admin/runs`, the first five Notion changes, and any non-empty digest.
8. Confirm no visible automation markers/history were added to Notion bodies and no duplicate page was created for an existing equivalent opportunity.

The route and command shapes are in [Admin API](API.md); normal monitoring is in [Operations](OPERATIONS.md).
