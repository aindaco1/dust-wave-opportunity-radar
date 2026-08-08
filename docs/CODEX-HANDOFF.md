# Codex handoff

## Open as its own project

Use the repository root—not its parent—as the Codex project folder:

```text
/Users/aindaco1/Library/Mobile Documents/com~apple~CloudDocs/dustwave-opportunity-radar
```

The folder is already a complete Git repository. No copy or move is required; opening it directly avoids splitting the worktree or losing history. `AGENTS.md` gives a fresh Codex task the project invariants automatically.

## First five minutes

```bash
git status --short --branch
npm ci
npm run check
```

Then read:

1. [AGENTS.md](../AGENTS.md)
2. [Architecture](ARCHITECTURE.md)
3. [Classification](CLASSIFICATION.md)
4. the document matching the task in the [documentation index](README.md)

`npm run check` is offline with respect to production services. It validates docs/types/tests and builds a dry-run Worker bundle but does not deploy.

## Current production profile

- Worker: `dustwave-opportunity-radar`
- Public URL: `https://dustwave-opportunity-radar.jogo.workers.dev`
- Schedule: 07:00 and 19:00 `America/Denver`
- Notion and Zoho runtime flags: enabled in `wrangler.jsonc`
- Zoho folders: `Inbox`, `Dust Wave`, `Newsletter`, `Notification`
- Notion data source ID: `248a67e1-4d47-48f8-bc84-a9602ca91b78`
- Digest: `opportunities@digest.dustwave.xyz` → `alonso@hey.com`; empty suppressed
- Raw/parsed R2 retention: 24 hours
- HEY steady state: official forwarding; reverse-engineered MCP is historical import only

Production secrets are not in this repository. A clean local test run does not need them.

## Behavior that must not regress

- Check existing Notion records before creating a page.
- Treat alternate submission/application titles for the same named/year opportunity as equivalent while rejecting conflicting years and generic token collisions.
- Prefer manual Notion pages; trash only automation-owned duplicates.
- Keep Notion bodies free of visible automation markers/history.
- Store prior generated Markdown in D1 and fail if it appears manually edited.
- Demote uncertain/no-official-URL calls to human review.
- Recovery classification never auto-publishes.
- Reject geographically only when all three target states are explicitly excluded.
- Parse PDF and DOCX within the documented byte/page/decompression/time limits.
- Revalidate every web redirect against SSRF controls.

## Safe prompt starters

- “Diagnose this failed run using the Operations and Troubleshooting runbooks; do not mutate production.”
- “Add a regression test for these two equivalent opportunity titles, then make the smallest matching change and run the full check.”
- “Add a D1 field using a new migration, update the data-model docs/test adapter, and verify locally; do not migrate remote.”
- “Review this PR against AGENTS.md and the security/Notion invariants.”

For a production action, state it explicitly: deploy, migrate remote, start a batch, sync Zoho, or trash a page are separate authorizations.

## Handoff checklist after future work

- Summarize the user-visible behavior and production impact.
- Report `npm run check` and coverage results.
- Link changed reference/runbook files.
- State whether a migration, secret, flag change, deployment, or manual batch remains.
- Do not include secret values or raw email content.
