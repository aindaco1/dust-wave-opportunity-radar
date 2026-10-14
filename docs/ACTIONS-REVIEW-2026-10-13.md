# Actions and dependency repair — October 13, 2026

## Scope

Consolidate dependency PRs [#66](https://github.com/aindaco1/dust-wave-opportunity-radar/pull/66),
[#67](https://github.com/aindaco1/dust-wave-opportunity-radar/pull/67),
[#68](https://github.com/aindaco1/dust-wave-opportunity-radar/pull/68),
[#69](https://github.com/aindaco1/dust-wave-opportunity-radar/pull/69) and
[#70](https://github.com/aindaco1/dust-wave-opportunity-radar/pull/70), retaining
their original commits as merge parents. Their overlapping manifests and
lockfiles are resolved together. Deployment is excluded.

The October 6 CI runs for #66, #67, #69 and #70 passed 418 tests and the dry
Worker build, then failed the dependency audit on `proxy-addr`, `smol-toml` and
`source-map-js`. #68 failed earlier on stale generated runtime declarations and
also left its new workerd installer unapproved. Historical failed runs are not
rerun; the [October 4 review](ACTIONS-REVIEW-2026-10-04.md) covers earlier failures.

A fresh audit of unchanged main (`eabcd653fc0511ff5d68baa09f83f1326f82b117`)
found seven affected packages: one critical, five high and one moderate. New
findings included MCP SDK and Sharp; Sharp propagated to Miniflare and Wrangler.
All seven were development dependencies. The production-only audit was clean;
this does not establish deployed batch or delivery health.

## Repair

- Adopt Vitest/coverage 5.0.3, Node types 26.6.4, postal-mime 4.0.2 and MCP SDK 1.32.0.
- Advance the Wrangler PR to 4.149.0, whose Miniflare dependency supplies Sharp
  0.35.5. Its original 4.147.0 still retained vulnerable Sharp 0.35.4.
- Refresh compatible transitive locks to `proxy-addr` 2.0.8 and `source-map-js` 1.2.2.
- Override `smol-toml` to `^1.9.1` (locked at 1.9.1) because the immutable Platform
  Release Core package pins 1.7.1. Keep the Platform gitlink and shared audit
  implementation unchanged; [Testing](TESTING.md#dependency-audit) owns removal guidance.
- Allow only the matching `workerd@1.20261006.1` and `esbuild@0.28.2` installers,
  remove their stale entries, and regenerate `worker-configuration.d.ts`.
- Extend the existing parameterized installer regression to esbuild, and include
  critical severity in the existing audit rejection cases. No audit threshold,
  coverage floor, classifier, fixture or Jev policy is weakened.

Before repairing the installer entries and generated declarations, the focused
toolchain suite failed five assertions covering stale runtime types and both
missing/stale installer allowances. These assertions exercise the exact mismatch
that an unchanged Dependabot PR cannot repair by rerunning CI.

## Validation

On Node 24.21.0, `npm ci` and `npm run check` pass. The full gate includes docs,
generated-type freshness, TypeScript, 421 tests across 35 files, the real local
email-runtime test, coverage floors, dry Worker build, the full locked dependency
audit and live classifier/Jev evaluation. The audit reports zero vulnerabilities.
Coverage remains 90.50% statements, 81.65% branches, 95.38% functions and 92.82%
lines across the same unchanged production source and coverage configuration.

The complete local report `.jev-results/run-sUVNT2/report.json` passes all 24
judge controls and all 12 exact/semantic cases, using 14 classifier requests and
36 judge requests. The report is ignored and remains local; no credentials or
source mail are committed. It retains `releaseAccepted: false`, as all synthetic
evaluation reports do.

Hosted CI on the consolidation PR separately runs the offline gate and online
audit. Its result is recorded on the PR; it does not run live Jev. No production
migration, deployment, batch, source import, Notion operation or secret change
is part of this repair.
