# Security model

## Trust boundaries

Email bodies, Colossal/Hyperallergic RSS/HTML, Creative West API fields, attachments, linked pages, sender/provider identities, and AI output are untrusted. Secrets are stored only as Cloudflare or GitHub Actions secrets. No secret is placed in D1, R2 metadata, logs, source code, or generated types.

## Controls

- Inbound messages and HTTP import bodies have strict size caps before buffering.
- Creative West uses one fixed HTTPS GraphQL endpoint, exact reviewed filters, bounded responses, validated IDs, safe public URL checks, and bounded synthetic MIME. Listing text is never logged.
- PDF extraction is limited by file size, page count, pixel count, and wall time; DOCX decompression limits uncompressed XML size and accepted ZIP paths.
- Web enrichment accepts only HTTP(S), standard ports, and public-looking hosts. Redirects are followed manually and each hop is revalidated. Responses have time and byte limits.
- Colossal and Hyperallergic use shared safe transport, bounded XML/HTML structure parsing, no DTD/external-entity expansion, and bounded per-entry MIME. D1 discovery context is separate from source text; aggregator/unknown/ambiguous primary URLs and unresolved known shorteners cannot authorize publication. Link labels do not prove destinations; redirect evidence must pass existing public-URL checks. Logs and durable step outputs contain only counts, IDs, booleans, and diagnostic codes.
- The classifier uses structured schema output. Prompt text explicitly treats embedded instructions as data, and deterministic code re-checks confidence, URL presence, geography, and category.
- The AI cannot invoke Notion, email, storage, or network tools.
- Notion writes are confined to one configured data source and query for existing entities before creating. Updates replace only the exact prior generated Markdown stored in D1 (or a legacy managed block) plus managed properties; a mismatch fails safely.
- A manually created equivalent Notion page is preferred as canonical. Only pages proven automation-owned by an Automation Key or D1 mapping can be automatically moved to trash.
- Digest HTML is escaped; links must already pass URL validation.
- Admin authorization uses a long random bearer token and constant-time digest comparison.
- Email Sending is allowlisted to one sender and one recipient.
- The GitHub deployment token is restricted to one Cloudflare account and only `Workers Scripts: Edit` plus `D1: Edit`. Routine deployment omits Email Routing reconciliation; route changes require a separate interactive operator action.
- R2 source content is purged after 24 hours.
- Workflow step outputs are restricted to opaque IDs, statuses, counts, and booleans; source records and classifications remain in their documented D1/R2 stores.
- GitHub Actions use SHA-pinned external actions, read-only default tokens, a protected production environment, and a required CI check on `main`.

## Known boundary

HEY’s official forwarding is the production path. The one-time historical import still uses the unofficial `Sealjay/mcp-hey` reverse-engineered API because HEY offers no supported public read API for this service. It runs on a disposable GitHub runner at a pinned revision, needs a temporary session-cookie secret, performs read-only MCP calls, and should be disabled by deleting `HEY_COOKIES_JSON` immediately after use.

The official HEY CLI remains a qualification tool, not a production ingestion path. Its verifier uses the original HTML solely to count and reconcile attachment evidence, never logs content, filenames, IDs, or private URLs, does not download files, and removes its isolated cache. Any missing, malformed, unsafe, truncated, or unreadable attachment evidence blocks qualification. A `HEY_TOKEN` can support a short-lived headless command, but it is a bearer secret and does not by itself establish refresh, rotation, revocation, or hosted-runner acceptance.

An explicitly approved disposable GitHub qualification uses the same verifier with a temporary environment secret restricted to the verification branch. Only the final read-only step receives that secret; setup, dependencies, build, and synthetic tests do not. There are no uploaded mail artifacts or persistent caches. Always remove runner state and separately delete the GitHub secret after the run; deleting a copied secret does not revoke the operator's existing HEY login. See [HEY CLI qualification](HEY-CLI.md).

## Incident response

1. Disable the Worker/Email Routing as appropriate, and set the Zoho, Creative West, and Notion flags false to stop those external reads/writes. These flags do not disable inbound HEY delivery.
2. Rotate `ADMIN_TOKEN` and any affected source token.
3. Delete `HEY_COOKIES_JSON` and revoke the HEY session if involved.
4. Inspect Cloudflare logs, D1 run/message errors, and GitHub Action history.
5. Purge R2 objects if the normal 24-hour job cannot run.
6. Redeploy only after adding a privacy-safe regression test for the failure mode and running the full quality gate.

## Secret and private-data handling

- `.dev.vars`, HEY cookie files, Wrangler state, coverage output, and downloaded mail must remain untracked.
- Logs may include IDs, source/folder labels, counts, titles for successful Notion publication, and bounded error messages. Do not add bodies, extracted attachment text, auth headers, or token-bearing URLs.
- Tests and docs use synthetic content and `example.org`; production messages are not fixtures.
- `/health` is public by design but exposes only service name, timezone, batch hours, and five feature flags. All stateful/read-through routes use the admin bearer token.

See [Configuration](CONFIGURATION.md) for secret locations and [Data model](DATA-MODEL.md) for retained fields.
