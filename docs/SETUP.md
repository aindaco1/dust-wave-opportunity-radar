# Setup

The Worker is designed to be deployed before account credentials are available. Keep Zoho and Notion disabled until their secrets and access checks pass.

## 1. Cloudflare resources

The Wrangler configuration defines one Worker, one Workflow, D1, R2, Workers AI, an Email Sending binding, and the inbound address `hey@ingest.dustwave.xyz`.

```bash
npm ci
npx wrangler login
npx wrangler d1 create dustwave-opportunity-radar --location wnam
npx wrangler r2 bucket create dustwave-opportunity-radar-mail --location wnam
npm run migrate:remote
npm run deploy
```

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

Ongoing forwarding does not backfill existing mail. The manual GitHub Action runs the pinned `Sealjay/mcp-hey` revision on a disposable GitHub runner, imports Imbox/Feed/Paper Trail, then the runner is destroyed.

Because HEY has no public read API, this one-time path needs a valid `data/hey-cookies.json` captured by upstream `mcp-hey` on an authenticated machine. Add its complete JSON value as the private repository secret `HEY_COOKIES_JSON`. Also add:

- repository secret `ADMIN_TOKEN` — same value installed in the Worker
- repository variable `WORKER_URL` — deployed `https://…workers.dev` URL

Run Actions → **HEY seven-day backfill** → Run workflow. The importer is idempotent by HEY topic ID and includes attachments up to the configured limit. Delete `HEY_COOKIES_JSON` after the backfill succeeds.

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

Change `ZOHO_ENABLED` to `true` in `wrangler.jsonc`, deploy, and manually start one run. Startup validates the account and requires exact folder names `Inbox` and `Dustwave`; a missing folder fails loudly instead of silently scanning the wrong place. The first successful sync imports seven days and later runs use an overlap checkpoint.

Zoho’s OAuth authorization-code process is documented at [Zoho Mail OAuth 2.0](https://www.zoho.com/mail/help/api/using-oauth-2.html).

## 5. Notion (deferred)

When integration access is ready, share the Opportunities data source with the integration and install its token:

```bash
npx wrangler secret put NOTION_TOKEN
```

The configured data source ID is `248a67e1-4d47-48f8-bc84-a9602ca91b78`. Change `NOTION_ENABLED` to `true` and deploy. On the next run the adapter verifies access, adds only missing automation properties (`Automation Key`, `Source`, `Last Checked`), and drains `pending_notion` records.

Before enabling, confirm the existing property names used by the adapter: `Name`, `Website`, `Tags`, `Type`, `Due Date`, and `Application open`. Property matching is exact.

## 6. GitHub deployment credentials

The manual deployment workflow expects repository secrets `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`. Create a scoped token with Workers Scripts, Workflows, D1, R2, Workers AI, Email Routing, and Email Sending permissions. Keep production deployment manual until both source integrations have completed a test batch.
