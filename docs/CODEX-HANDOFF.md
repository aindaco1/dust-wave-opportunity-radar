# Codex handoff

## Open as its own project

Use the repository root—not its parent—as the Codex project folder:

```text
/Users/aindaco1/Library/Mobile Documents/com~apple~CloudDocs/dust-wave-opportunity-radar
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

## Current state and authoritative references

The reviewed [Worker configuration](../wrangler.jsonc) enables Zoho, Creative West, Colossal, Hyperallergic, and Notion. HEY forwarding remains the ongoing inbound path; the official CLI is limited to supervised historical recovery. Use these documents for details:

- [Configuration](CONFIGURATION.md) owns bindings, runtime values, source flags, and secret locations. Production secrets are outside the repository; local quality gates do not need them.
- [Operations](OPERATIONS.md) owns the schedule, monitoring, recovery, and rollout procedures. Deployed state must be checked separately from reviewed configuration.
- [Data model](DATA-MODEL.md) owns the current schema and migration sequence.
- [Colossal](COLOSSAL.md) and [Hyperallergic](HYPERALLERGIC.md) own source scope and acceptance. Both use the shared roundup helpers described in [Architecture](ARCHITECTURE.md#code-map); preserve existing snapshot identity and recovery when changing them.
- [HEY CLI recovery](HEY-CLI.md#scoped-historical-recovery) owns the guarded one-record recovery procedure and pinned candidate requirements.

## Recorded acceptance and outstanding verification

The dated records below describe September 4, 2026 results. They do not establish subsequent scheduled outcomes or today's deployed state.

- [Hyperallergic production acceptance](HYPERALLERGIC.md#production-acceptance--september-4-2026) records migration 0007, deployment, a source-only import of 22 unique queued entries, and a repeat with zero imports. Scheduled classification, Notion publication, and digest delivery were not verified by that acceptance.
- [HEY production recovery acceptance](HEY-CLI.md#production-recovery-acceptance--september-4-2026-americadenver) records restoration of one existing identity, no-write repeat verification, independent DOCX parsing, and temporary-credential cleanup. No downstream batch was forced or accepted.
- [Colossal deployment and acceptance](COLOSSAL.md#deployment-and-acceptance) defines the required live checks. The [archived implementation plan](archive/COLOSSAL-INTEGRATION-PLAN.md) records original scope, not live acceptance evidence.

A future production investigation should verify scheduled outcomes independently and update the relevant source acceptance record with dated evidence.

## Required behavior

[AGENTS.md](../AGENTS.md) owns repository-wide invariants and production authorization boundaries. Follow [Classification](CLASSIFICATION.md) for publication and recovery policy, [Notion integration](NOTION.md) for entity matching and manual-body protection, [Architecture](ARCHITECTURE.md#failure-isolation) for durable orchestration and outcome accounting, and [Security](SECURITY.md) for parsing and network limits. Keep these references authoritative instead of copying their rules into this handoff.

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
