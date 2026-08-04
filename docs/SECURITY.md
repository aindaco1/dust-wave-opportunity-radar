# Security model

## Trust boundaries

Email bodies, attachments, linked pages, sender identities, and AI output are untrusted. Secrets are stored only as Cloudflare or GitHub Actions secrets. No secret is placed in D1, R2 metadata, logs, source code, or generated types.

## Controls

- Inbound messages and HTTP import bodies have strict size caps before buffering.
- PDF extraction is limited by file size, page count, pixel count, and wall time; DOCX decompression limits uncompressed XML size and accepted ZIP paths.
- Web enrichment accepts only HTTP(S), standard ports, and public-looking hosts. Redirects are followed manually and each hop is revalidated. Responses have time and byte limits.
- The classifier uses structured schema output. Prompt text explicitly treats embedded instructions as data, and deterministic code re-checks confidence, URL presence, geography, and category.
- The AI cannot invoke Notion, email, storage, or network tools.
- Notion writes are idempotent and confined to one configured data source. Updates replace only the automation-managed page section and managed properties.
- Digest HTML is escaped; links must already pass URL validation.
- Admin authorization uses a long random bearer token and constant-time digest comparison.
- Email Sending is allowlisted to one sender and one recipient.
- R2 message content is purged after 24 hours.

## Known boundary

HEY’s official forwarding is the production path. The one-time historical import uses the unofficial `Sealjay/mcp-hey` reverse-engineered API because HEY offers no public read API. It runs on a disposable GitHub runner at a pinned revision, needs a temporary session-cookie secret, performs read-only MCP calls, and should be disabled by deleting `HEY_COOKIES_JSON` immediately after use.

## Incident response

1. Disable the Worker or set both source flags false.
2. Rotate `ADMIN_TOKEN` and any affected source token.
3. Delete `HEY_COOKIES_JSON` and revoke the HEY session if involved.
4. Inspect Cloudflare logs, D1 run/message errors, and GitHub Action history.
5. Purge R2 objects if the normal 24-hour job cannot run.
6. Redeploy only after adding a regression test for the failure mode.
