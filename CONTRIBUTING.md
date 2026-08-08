# Contributing

## Development workflow

1. Create a focused branch from `main`.
2. Install the locked dependencies with `npm ci`.
3. Make the smallest change that preserves the invariants in [AGENTS.md](AGENTS.md).
4. Add or update tests. Bug fixes require a regression example that fails before the fix.
5. Update documentation when behavior, configuration, operations, data shape, or external access changes.
6. Run `npm run check` and, for core pipeline changes, `npm run test:coverage`.
7. Review `git diff` for credentials, real email data, generated coverage output, and unrelated edits before commit.

## Test expectations

Use the lowest useful layer, then add an orchestration test when boundaries interact:

- Pure policy/formatting helpers: direct unit test.
- D1 behavior: the SQLite-backed D1 adapter in `test/support/d1.ts`, applying the real migrations.
- External API adapters: stub `fetch` at the HTTP boundary and verify URL, method, headers, bounded failure behavior, and resulting state.
- Worker routes and Workflow control flow: use the Cloudflare test shim in `test/support/cloudflare-workers.ts`.

Fixtures must be invented and privacy-safe. Do not paste real message bodies, session cookies, OAuth responses, Notion tokens, or private URLs into tests or snapshots.

## Database migrations

Create the next numbered SQL file in `migrations/`. Migrations are append-only. Update the schema version seed, data-model documentation, D1 test harness migration list, and migration tests in the same change.

Apply locally first:

```bash
npm run migrate:local
npm run check
```

Remote migration and deployment are separate, explicitly authorized production actions.

## Pull-request checklist

- [ ] Behavior is covered by tests and documented.
- [ ] `npm run check` passes.
- [ ] `npm run test:coverage` passes for pipeline changes.
- [ ] No secrets, private mail, or local environment files are included.
- [ ] No applied migration was edited.
- [ ] Notion matching remains conservative and manual content remains protected.
- [ ] Production changes and any recovery steps are stated in the handoff.
