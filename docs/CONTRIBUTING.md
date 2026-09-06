# Contributing

## Development workflow

1. Create a focused branch from `main`.
2. Install the locked dependencies with `npm ci`.
3. Make the smallest change that preserves the invariants in [AGENTS.md](../AGENTS.md).
4. Add or update tests. Bug fixes require a regression example that fails before the fix.
5. Update documentation when behavior, configuration, operations, data shape, or external access changes.
6. Run `npm run check` and, for core pipeline changes, `npm run test:coverage`.
7. Review `git diff` for credentials, real email data, generated coverage output, and unrelated edits before commit.

## Tests and migrations

Follow [Testing](TESTING.md) for test layers, privacy-safe fixtures, quality gates, and the regression-test procedure. Follow the [migration procedure](DATA-MODEL.md#migration-procedure) for append-only schema changes and local validation. Production authorization boundaries are defined in [AGENTS.md](../AGENTS.md).

## Documentation changes

Use the [documentation index](README.md) to find the document that owns the behavior or procedure being changed. Update that document and link to it from summaries instead of copying its instructions.

Keep project guides and references in `docs/`. The root retains `README.md`, repository-wide `AGENTS.md`, and the attribution `NOTICE.md`. Keep completed plans in `docs/archive/`, with a dated status and a link to the current reference; dated acceptance evidence must remain identifiable as historical.

When moving or adding a document, update incoming links, the index, and the required current-document list in [the documentation checker](../scripts/check-docs.mjs). Use ATX headings (`#` through `######`) and inline Markdown links, the syntax checked by `npm run docs:check`, including local heading anchors. Run that check before the full project gate.

## Toolchain updates

Keep Vitest and `@vitest/coverage-v8` on the same locked version; Dependabot groups these updates. When updating Wrangler, review the new locked `workerd` version and replace its exact version entry in `allowScripts` without broadening the installer allowlist. Run `npm ci`, regenerate runtime types with `npm run cf-typegen`, and run `npm run check`. The generated-type check and local email-runtime test must pass with the updated runtime.

## Pull-request checklist

- [ ] Behavior is covered by tests and documented.
- [ ] `npm run check` passes.
- [ ] `npm run test:coverage` passes for pipeline changes.
- [ ] No secrets, private mail, or local environment files are included.
- [ ] No applied migration was edited.
- [ ] Notion matching remains conservative and manual content remains protected.
- [ ] Production changes and any recovery steps are stated in the handoff.
