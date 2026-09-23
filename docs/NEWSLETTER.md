# Opportunities newsletter ownership

The active member newsletter belongs to the separate [dust-wave-opportunity-internal-email project](https://github.com/aindaco1/dust-wave-opportunity-internal-email). That service owns its Worker, Workflow, D1 database, Resend delivery, private settings, recipients, and Monday/Thursday 08:00 America/Denver schedule. Use its handoff and operations runbook to inspect or change newsletter delivery.

Opportunity Radar owns source ingestion, Notion publication, and the non-empty human-review digest at 07:00 and 19:00 America/Denver. Its deployment must not configure or start the member newsletter. See [Architecture](ARCHITECTURE.md) and [Operations](OPERATIONS.md) for Radar's responsibilities.

## Retired draft

The old `codex/opportunities-newsletter` branch was a superseded prototype. It was mistakenly merged in PR #57 on September 23, 2026 after the standalone service was already delivering. The prototype's `NEWSLETTER_ENABLED=false` described only that draft, not the live newsletter. Read-only production checks on September 23 confirmed the standalone service remained enabled and had delivery receipts for September 14, 17, and 21.

Radar no longer contains the draft's newsletter implementation, Workflow/email bindings, settings, or admin preview/status routes. Do not reactivate the draft. The standalone service is the canonical implementation; its files and deployment were not changed by this correction.

Migration `0009_add_newsletter.sql` had already been applied to Radar and remains unchanged in the migration history and test adapter. Its two unused tables are retained; removing a retired runtime feature does not justify rewriting applied migrations. They are unrelated to the standalone service's database.

## Regression coverage

`test/index.test.ts` verifies that Radar ignores the old newsletter enable flag at Monday/Thursday 08:00 in both daylight and standard time, and that the retired admin routes return 404. `test/deploy.test.ts` verifies that Radar's deployment config contains only its batch Workflow and human-review email binding, with no newsletter variables.

These source checks prevent accidental reintroduction of the prototype. They do not establish ongoing delivery in the standalone service; verify that service's deployed configuration and delivery receipts separately.
