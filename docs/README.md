# Documentation

Choose the shortest path for the task at hand.

## New project or new contributor

1. [Codex handoff](CODEX-HANDOFF.md) — current state, first commands, and safe task prompts.
2. [Architecture](ARCHITECTURE.md) — components, trust boundaries, and batch sequence.
3. [Classification](CLASSIFICATION.md) — product rules and AI recovery behavior.
4. [Testing](TESTING.md) — suite structure and required quality gates.

## Provision and deploy

- [Setup](SETUP.md) — Cloudflare, HEY, Zoho, Creative West, Notion, and GitHub account steps.
- [Configuration](CONFIGURATION.md) — bindings, plain variables, secrets, and feature flags.
- [Security](SECURITY.md) — trust boundaries, controls, retention, and incident response.
- [Decisions](DECISIONS.md) — why the system uses these services and safety patterns.

## Operate and recover

- [Operations](OPERATIONS.md) — schedule, run lifecycle, monitoring, state meanings, and rollout.
- [HEY CLI qualification and recovery](HEY-CLI.md) — pinned attachment fix, hosted verification, and guarded single-record historical recovery.
- [Admin API](API.md) — authenticated routes, request/response shapes, and examples.
- [Troubleshooting](TROUBLESHOOTING.md) — symptom-driven diagnosis and recovery.
- [Data model](DATA-MODEL.md) — tables, constraints, status transitions, and retained content.
- [Notion integration](NOTION.md) — schema, entity resolution, create/update, and duplicate safety.

## Change the project

- [Colossal source](COLOSSAL.md) — discovery, policy, recovery, and deployment acceptance; enabled in the reviewed configuration.
- [Hyperallergic source](HYPERALLERGIC.md) — monthly roundup scope, short-link safety, recovery, and rollout verification.
- [Colossal integration plan](COLOSSAL-INTEGRATION-PLAN.md) — original agreed scope and implementation sequence.
- [Contributing](../CONTRIBUTING.md) — implementation, test, migration, and review workflow.
- [AGENTS.md](../AGENTS.md) — Codex-specific invariants and production boundaries.
- [Notices](../NOTICE.md) — attribution for adapted material.

Run `npm run docs:check` after changing Markdown. It verifies this required documentation set and every local Markdown link.
