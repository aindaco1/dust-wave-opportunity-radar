# Documentation

Start with the entry points below, then use the document that owns the subject. Keep detailed rules and procedures in their owner document; other pages should summarize and link to it.

## New project or new contributor

1. [Codex handoff](CODEX-HANDOFF.md) — current state, first commands, and safe task prompts.
2. [Architecture](ARCHITECTURE.md) — components, trust boundaries, and batch sequence.
3. [Classification](CLASSIFICATION.md) — product rules and AI recovery behavior.
4. [Contributing](CONTRIBUTING.md) — development workflow, documentation maintenance, toolchain updates, and PR checklist.

## Authoritative references

| Subject | Owner |
|---|---|
| Components, batch sequence, shared helpers, and code map | [Architecture](ARCHITECTURE.md) |
| Publication eligibility, geography, evidence, and AI recovery | [Classification](CLASSIFICATION.md) |
| Account provisioning and initial activation | [Setup](SETUP.md) |
| Bindings, runtime values, secret locations, and feature flags | [Configuration](CONFIGURATION.md) |
| Trust boundaries, security controls, and incident response | [Security](SECURITY.md) |
| Design rationale and tradeoffs | [Decisions](DECISIONS.md) |
| Schedule, monitoring, run lifecycle, recovery, and rollout | [Operations](OPERATIONS.md) |
| Symptom-driven diagnosis | [Troubleshooting](TROUBLESHOOTING.md) |
| Authenticated routes and request/response contracts | [Admin API](API.md) |
| Tables, status transitions, retention, and migration procedure | [Data model](DATA-MODEL.md) |
| Notion schema, entity matching, body ownership, and reconciliation | [Notion integration](NOTION.md) |
| Test layers, fixtures, regression procedure, and quality gates | [Testing](TESTING.md) |

## Source runbooks

- [HEY CLI recovery and qualification](HEY-CLI.md) — current guarded single-record recovery and read-only qualification procedures, followed by dated evidence. Official forwarding remains the ongoing HEY path.
- [Colossal](COLOSSAL.md) — discovery scope, source-specific evidence, recovery, counters, and deployment acceptance.
- [Hyperallergic](HYPERALLERGIC.md) — monthly roundup scope, short-link safety, recovery, and dated rollout acceptance.

Source runbooks own publisher-specific details and acceptance records. Shared policy, state, and publication rules belong in the references above.

## History and repository guidance

- [Archived Colossal implementation plan](archive/COLOSSAL-INTEGRATION-PLAN.md) — completed plan and original September 4, 2026 investigation; use the source runbook for current instructions.
- [HEY qualification and acceptance history](HEY-CLI.md#qualification-and-acceptance-history) and [Hyperallergic production acceptance](HYPERALLERGIC.md#production-acceptance--september-4-2026) — dated evidence, separate from current deployed state or later scheduled outcomes.
- [AGENTS.md](../AGENTS.md) — repository-wide Codex instructions, product invariants, and production authorization boundaries; kept at root.
- [Notices](../NOTICE.md) — attribution for adapted material; kept at root.

Run `npm run docs:check` after changing Markdown. It verifies required current documents, inline local links, and ATX heading anchors, including archived documents. See [Contributing](CONTRIBUTING.md#documentation-changes) for placement and maintenance rules.
