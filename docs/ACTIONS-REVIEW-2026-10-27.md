# Actions and dependency repair — October 27, 2026

## Scope and findings

Consolidate dependency PRs [#77](https://github.com/aindaco1/dust-wave-opportunity-radar/pull/77),
[#78](https://github.com/aindaco1/dust-wave-opportunity-radar/pull/78),
[#79](https://github.com/aindaco1/dust-wave-opportunity-radar/pull/79),
[#80](https://github.com/aindaco1/dust-wave-opportunity-radar/pull/80), and
[#81](https://github.com/aindaco1/dust-wave-opportunity-radar/pull/81) into one
tested manifest and lockfile. These changes do not deploy the Worker.

The October 27 Vitest CI run passed its offline checks but failed the full
dependency audit with seven affected packages. A fresh audit of unchanged main
`616e6bc343f4672831ae952a89973e6954867190` found eight affected packages
(three high and five moderate), including a newer `qs` advisory.
`postal-mime` is a production dependency; the other affected packages belong
to development tooling. Historical green checks do not establish current
security acceptance.

## Repair

- Adopt Vitest/coverage 5.0.5, Zod 4.6.7, Wrangler 4.151.1, unpdf 1.9.0,
  and postal-mime 4.0.8 from the five PRs.
- Refresh compatible transitive locks to body-parser 2.4.0, fast-uri 3.1.9,
  ip-address 10.7.5, qs 6.17.0, and undici 7.30.1. Raise the existing compatible
  undici override floor to `^7.30.1`; retain the smol-toml override and Platform pin.
- Replace the exact workerd installer allowance with `1.20261012.1` and
  regenerate `worker-configuration.d.ts`. Keep the existing esbuild allowance.
- Add positive and negative MIME regressions for short header lines and the
  cumulative header budget of inline forwarded messages. An isolated baseline
  check confirmed postal-mime 4.0.5 accepts both over-budget synthetic inputs;
  4.0.8 rejects them through Radar's parser. Valid smaller inputs still parse.

The [upstream MIME advisory](https://github.com/postalsys/postal-mime/security/advisories/GHSA-f2hq-32vh-53cc)
identifies 4.0.8 as the patched release for quadratic encoded-header decoding;
that release also makes inline messages share parsing budgets. The regression
tests use deterministic size limits, avoiding fragile timing assertions.
The existing toolchain tests detect stale runtime declarations and installer
allowances. Audit scope, coverage floors, classifier policy and production
configuration are unchanged.

## Failed-run disposition

Earlier failures through October 6 are covered by the
[October 4 review](ACTIONS-REVIEW-2026-10-04.md) and
[October 13 repair](ACTIONS-REVIEW-2026-10-13.md).
The remaining failed runs visible on October 27 are accounted for below.

| Failed runs | Cause and resolution evidence |
|---|---|
| [40474474664](https://github.com/aindaco1/dust-wave-opportunity-radar/actions/runs/40474474664) | Vitest PR passed offline checks, then failed the dependency audit. The combined lockfile repairs the findings. |
| [39506941785](https://github.com/aindaco1/dust-wave-opportunity-radar/actions/runs/39506941785), [39394374233](https://github.com/aindaco1/dust-wave-opportunity-radar/actions/runs/39394374233) | Wrangler PR left generated types stale and the new workerd installer uncovered. This repair updates both. |
| [39514245611](https://github.com/aindaco1/dust-wave-opportunity-radar/actions/runs/39514245611) | Notion reconciliation returned HTTP 500. [The subsequent run](https://github.com/aindaco1/dust-wave-opportunity-radar/actions/runs/39514396460) selected the same message, succeeded with `preserve_manual`, and reconciled one record to `notion`. The original log does not establish the cause of the 500. |
| [39513791524](https://github.com/aindaco1/dust-wave-opportunity-radar/actions/runs/39513791524) | Targeted Zoho recovery returned HTTP 500. [The next recovery](https://github.com/aindaco1/dust-wave-opportunity-radar/actions/runs/39513891745) queued the same provider message for review; [the repeat](https://github.com/aindaco1/dust-wave-opportunity-radar/actions/runs/39514142343) found it in `digest` with `ingested: false`. The original log does not establish the cause of the 500. |
| [39509485474](https://github.com/aindaco1/dust-wave-opportunity-radar/actions/runs/39509485474) | Review inspection returned HTTP 500 before PR #83 isolated missing pages. [Inspection after that fix](https://github.com/aindaco1/dust-wave-opportunity-radar/actions/runs/39510923033) succeeded. |
| [39196780605](https://github.com/aindaco1/dust-wave-opportunity-radar/actions/runs/39196780605), [39190865835](https://github.com/aindaco1/dust-wave-opportunity-radar/actions/runs/39190865835) | Artwork Archive direct HTTP retrieval returned 403. The source was paused, then replaced with the hosted-browser transport in PR #82. [Subsequent integration inspection](https://github.com/aindaco1/dust-wave-opportunity-radar/actions/runs/39506786789) and [source-only sync](https://github.com/aindaco1/dust-wave-opportunity-radar/actions/runs/39507377721) succeeded. |

Old runs remain as historical failure records. They were not replayed or deleted.
The operational receipts above were inspected without rerunning production
actions; they establish the recorded recovery, not today's scheduled ingestion
or delivery health.

## Validation

`npm ci` and the full `npm run check` pass on Node 24.22.1: 472 tests in
36 files, documentation links, generated runtime types, TypeScript, the local
Email Worker integration, dry bundling, and zero audit findings. Coverage includes
all 31 source files: 92.11% statements, 82.98% branches, 97.13% functions, and
94.13% lines. `git diff --check` passes.

Live classifier/Jev evaluation completed all twelve synthetic cases and all
calibration controls with no exact, semantic, or calibration failures. The local
evidence is `.jev-results/run-8bJbw5/report.json` (`complete: true`, `passed: true`).
This is the development gate; its separate release-acceptance field remains false.
Hosted CI results are attached to the consolidation PR.

No remote migration, deployment, manual batch, source import, Notion write,
or email send is included.
