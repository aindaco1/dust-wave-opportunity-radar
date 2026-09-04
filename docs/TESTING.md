# Testing

The test suite is fast, privacy-safe, and layered around production risks. It uses Vitest in Node plus Wrangler's local integration harness and does not contact Cloudflare, HEY, Zoho, Creative West, Notion, or public websites.

## Commands

```bash
npm test                 # all tests once
npm run test:watch       # focused local iteration
npm run test:coverage    # tests plus enforced coverage floors
npm run docs:check       # required docs and local Markdown links
npm run typecheck        # Cloudflare generated-type check + TypeScript
npm run deploy:dry       # production bundle without upload
npm run check            # complete required quality gate
```

Coverage floors apply to `src/**/*.ts`: 75% statements, 65% branches, 75% functions, and 75% lines. The thresholds are a regression floor, not a substitute for risk-based assertions.

## Test layers

| Area | Files | What is verified |
|---|---|---|
| Policy and schemas | `classify-policy.test.ts`, `config.test.ts` | decision rules, recovery, tags/URLs, model pin, invalid config |
| Parsing and boundaries | `parse.test.ts`, `util.test.ts` | MIME, PDF/DOCX, URL hygiene, bounded bodies, crypto/date utilities |
| Shared public sources | `public-source-helpers.test.ts` | Snapshot identity, terminal preservation, expired-failure recovery, partial-write cleanup, bounded MIME and conditional RSS fetch |
| Network safety | `web-enrichment.test.ts` | SSRF guard, safe redirects, content types, rank/cap |
| Toolchain | `toolchain.test.ts` | Exact locked workerd installer allowance and matching Vitest/coverage versions |
| Ingestion adapters | `email-worker.test.ts`, `email-runtime.test.ts`, `zoho.test.ts`, `creative-west.test.ts` | HEY limits/cleanup, production-shaped Email Worker streams with local R2/D1, OAuth/account/folders, MIME/fallback, checkpoints, exact public-feed filters/window, and snapshot dedupe |
| Persistence | `database.test.ts` | real migrations, uniqueness, state machine, stale claims, retention, runs |
| Notion | `notion.test.ts` | schema, find-before-create, manual-page preference, safe body update, explicit body ownership, guarded newest-message page-group reconciliation, duplicate trash ownership |
| Rendering/delivery | `digest.test.ts` | copy, escaping, category order, compaction, binding request |
| Entrypoints/orchestration | `index.test.ts`, `workflow.test.ts` | auth/routes, scheduling, empty suppression, content-free durable step outputs, complete outcome accounting, bounded message-preparation concurrency |

## D1 test adapter

`test/support/d1.ts` wraps Node’s built-in SQLite engine in the subset of the D1 interface the application uses. Every test database applies the real migration files in order. This validates SQL constraints, conflict behavior, SQLite date expressions, atomic batches, and state queries without needing a remote database.

When adding a migration, add its filename to the adapter’s migration list and add a migration/state assertion. The adapter is intentionally small; extend it only when production code begins using another D1 method.

## Cloudflare runtime shim

Vitest aliases `cloudflare:workers` to `test/support/cloudflare-workers.ts`. The shim supplies enough `WorkflowEntrypoint` behavior to instantiate the real Workflow class under Node. It does not claim to emulate Cloudflare durability or scheduler infrastructure. `npm run deploy:dry` is the complementary bundle/runtime compatibility gate; production integration checks remain explicit operator actions.

`email-runtime.test.ts` closes the most important gap in that shim. Wrangler's local integration harness dispatches a real `email()` event to the production ingestion function with local R2 and D1 bindings. The test verifies fixed-length streaming, durable object size, D1 queue state, idempotent redelivery, privacy-safe logs, and a five-second local responsiveness budget. Its dedicated `test/wrangler.email.jsonc` intentionally omits remote AI, Workflow, email-sending, and production credentials.

## External API tests

Stub global `fetch` and respond at the HTTP boundary. Assert the meaningful contract:

- exact host/path and method;
- authorization/version headers without real values;
- bounded/error behavior;
- write payload shape;
- state written after success; and
- cleanup or retry state after failure.

Always restore global mocks in `afterEach`. Avoid implementation-only call counts when a state/result assertion is stronger.

## Fixtures and privacy

Use invented domains such as `example.org`, fictional organizations, and synthetic MIME/PDF/DOCX content. Do not copy a production email, sender list, private opportunity URL, Notion response, HEY cookie, or OAuth payload into the repository. Keep fixtures small and inline unless reuse materially improves clarity.

`creative-west.test.ts` verifies the exact effective portal filters, Mountain-time 31-day range, bounded synthetic MIME, snapshot dedupe/update behavior, disabled switch, inspection count, and malformed/upstream failure paths using only fictional responses.

## Adding a regression test

1. Reproduce the smallest general behavior at the lowest appropriate layer.
2. Assert both the desired positive case and a nearby negative case when matching, security, or dedupe is involved.
3. Confirm the test fails for the old behavior when practical.
4. Make the implementation change.
5. Run the focused test, then `npm run check` and `npm run test:coverage`.
6. Update the relevant reference/runbook if operator-visible behavior changes.

Production investigation may use redacted characteristics to design a fixture, but raw content must remain outside Git.
