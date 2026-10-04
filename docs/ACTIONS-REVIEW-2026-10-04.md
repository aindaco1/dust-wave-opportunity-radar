# Actions and dependency review — October 4, 2026

## Scope and findings

Reviewed all 233 available workflow runs, including all 26 failures, and all five open pull requests (#59–#63). The inventory below records the pre-fix snapshot. Historical failures remain historical records; production jobs were not rerun. No production deployment, migration, source import, batch, Notion operation or secret change is included.

## Current repairs

- Integrate the five dependency PR heads together: `ip-address` 10.7.2, Vitest/coverage 5.0.2, MCP SDK 1.30.1, Wrangler 4.141.0 and Node types 26.6.3. Resolve overlapping manifest/lockfile changes while preserving each PR commit.
- Replace the vulnerable exact `undici` override with `^7.29.1`; the reviewed lockfile resolves 7.30.0. All six recent Dependabot failures reported the same blocked security-update path through Wrangler/Miniflare.
- Update `fast-uri` 3.1.7 to 3.1.8 after the audit exposed a separate moderate advisory.
- Allow only the exact locked `workerd@1.20260925.1` installer and regenerate `worker-configuration.d.ts`. The old generated types fail with the new Wrangler, as reproduced locally before the fix.
- Add a required online dependency audit beside offline CI. Reuse Platform Release Core 0.4.0 at the existing immutable gitlink. Platform already has the required report-validation/retry primitive; no shared source changes or other-consumer upgrades are necessary. See [Testing](TESTING.md#dependency-audit).

The combined PR dependencies initially reported four audit findings (one high, three moderate). The final repaired lockfile reports zero. The new audit also rejected the intermediate lockfile containing the remaining `fast-uri` advisory. No threshold was lowered.

## Failed-run inventory

Dates below use GitHub UTC timestamps. Links point to the original failed records.

| Run | Workflow / date | Cause and disposition |
|---|---|---|
| [37096885198](https://github.com/aindaco1/dust-wave-opportunity-radar/actions/runs/37096885198) | Dependabot Updates, 2026-10-03 | Blocked `undici` security update; repaired compatible override and lockfile. |
| [37094922641](https://github.com/aindaco1/dust-wave-opportunity-radar/actions/runs/37094922641) | Dependabot Updates, 2026-10-03 | Blocked `undici` security update; repaired compatible override and lockfile. |
| [37094333846](https://github.com/aindaco1/dust-wave-opportunity-radar/actions/runs/37094333846) | Dependabot Updates, 2026-10-03 | Blocked `undici` security update; repaired compatible override and lockfile. |
| [37094094146](https://github.com/aindaco1/dust-wave-opportunity-radar/actions/runs/37094094146) | Dependabot Updates, 2026-10-03 | Blocked `undici` security update; repaired compatible override and lockfile. |
| [37090561899](https://github.com/aindaco1/dust-wave-opportunity-radar/actions/runs/37090561899) | Dependabot Updates, 2026-10-03 | Blocked `undici` security update; repaired compatible override and lockfile. |
| [36990367146](https://github.com/aindaco1/dust-wave-opportunity-radar/actions/runs/36990367146) | Dependabot Updates, 2026-10-02 | Blocked `undici` security update; repaired compatible override and lockfile. |
| [36543717178](https://github.com/aindaco1/dust-wave-opportunity-radar/actions/runs/36543717178) | CI, 2026-09-29 | Stale generated workerd types after Wrangler update. #62 repaired here; earlier branches were superseded by successful updates already on main. |
| [35891952771](https://github.com/aindaco1/dust-wave-opportunity-radar/actions/runs/35891952771) | CI, 2026-09-23 | Stale generated workerd types after Wrangler update. #62 repaired here; earlier branches were superseded by successful updates already on main. |
| [35891434040](https://github.com/aindaco1/dust-wave-opportunity-radar/actions/runs/35891434040) | CI, 2026-09-23 | Stale generated workerd types after Wrangler update. #62 repaired here; earlier branches were superseded by successful updates already on main. |
| [35705638605](https://github.com/aindaco1/dust-wave-opportunity-radar/actions/runs/35705638605) | CI, 2026-09-22 | Stale generated workerd types after Wrangler update. #62 repaired here; earlier branches were superseded by successful updates already on main. |
| [34947725872](https://github.com/aindaco1/dust-wave-opportunity-radar/actions/runs/34947725872) | CI, 2026-09-15 | Stale generated workerd types after Wrangler update. #62 repaired here; earlier branches were superseded by successful updates already on main. |
| [34561817919](https://github.com/aindaco1/dust-wave-opportunity-radar/actions/runs/34561817919) | CI, 2026-09-11 | Stale generated workerd types after Wrangler update. #62 repaired here; earlier branches were superseded by successful updates already on main. |
| [34205450496](https://github.com/aindaco1/dust-wave-opportunity-radar/actions/runs/34205450496) | CI, 2026-09-08 | Stale generated workerd types after Wrangler update. #62 repaired here; earlier branches were superseded by successful updates already on main. |
| [33488246600](https://github.com/aindaco1/dust-wave-opportunity-radar/actions/runs/33488246600) | CI, 2026-09-01 | Stale generated workerd types after Wrangler update. #62 repaired here; earlier branches were superseded by successful updates already on main. |
| [33410942548](https://github.com/aindaco1/dust-wave-opportunity-radar/actions/runs/33410942548) | Reconcile one Notion review item, 2026-08-31 | Reconciliation failure (latest diagnostic: `publish_page`); already fixed by PR #21, with successful follow-up reconciliation runs. |
| [33410440236](https://github.com/aindaco1/dust-wave-opportunity-radar/actions/runs/33410440236) | Reconcile one Notion review item, 2026-08-31 | Reconciliation failure (latest diagnostic: `publish_page`); already fixed by PR #21, with successful follow-up reconciliation runs. |
| [33410293627](https://github.com/aindaco1/dust-wave-opportunity-radar/actions/runs/33410293627) | Reconcile one Notion review item, 2026-08-31 | Reconciliation failure (latest diagnostic: `publish_page`); already fixed by PR #21, with successful follow-up reconciliation runs. |
| [32855479555](https://github.com/aindaco1/dust-wave-opportunity-radar/actions/runs/32855479555) | CI, 2026-08-25 | Job never started: GitHub billing/spending-limit annotation. Later CI succeeds; no code defect or current billing change required. |
| [32852582678](https://github.com/aindaco1/dust-wave-opportunity-radar/actions/runs/32852582678) | CI, 2026-08-25 | Job never started: GitHub billing/spending-limit annotation. Later CI succeeds; no code defect or current billing change required. |
| [32852442839](https://github.com/aindaco1/dust-wave-opportunity-radar/actions/runs/32852442839) | CI, 2026-08-25 | Job never started: GitHub billing/spending-limit annotation. Later CI succeeds; no code defect or current billing change required. |
| [32117201628](https://github.com/aindaco1/dust-wave-opportunity-radar/actions/runs/32117201628) | CI, 2026-08-18 | Stale generated workerd types after Wrangler update. #62 repaired here; earlier branches were superseded by successful updates already on main. |
| [31473938702](https://github.com/aindaco1/dust-wave-opportunity-radar/actions/runs/31473938702) | CI, 2026-08-11 | Stale generated workerd types after Wrangler update. #62 repaired here; earlier branches were superseded by successful updates already on main. |
| [31245972610](https://github.com/aindaco1/dust-wave-opportunity-radar/actions/runs/31245972610) | Deploy to Cloudflare, 2026-08-08 | Deployment authentication error 10000. Existing credential/deployment fix and subsequent successful deploys supersede this failure. |
| [31242773092](https://github.com/aindaco1/dust-wave-opportunity-radar/actions/runs/31242773092) | Deploy to Cloudflare, 2026-08-08 | D1 authorization error 7403. Existing credential/deployment fix and subsequent successful deploys supersede this failure. |
| [31242722858](https://github.com/aindaco1/dust-wave-opportunity-radar/actions/runs/31242722858) | Deploy to Cloudflare, 2026-08-08 | Missing deployment token. Existing credential/deployment fix and subsequent successful deploys supersede this failure. |
| [30979209934](https://github.com/aindaco1/dust-wave-opportunity-radar/actions/runs/30979209934) | Check source integrations, 2026-08-05 | Structured Zoho email address treated as a string; fixed by `1fb0b79`, followed by successful integration inspection. |

## Historical resolution evidence

- Zoho structured-address fix: commit `1fb0b79`; [next integration check](https://github.com/aindaco1/dust-wave-opportunity-radar/actions/runs/30979344127) succeeded.
- Deployment boundary: PR #7 (`8184a92`) removed routine Email Routing reconciliation; the [latest recorded deployment](https://github.com/aindaco1/dust-wave-opportunity-radar/actions/runs/35925495461) succeeded. Credentials were neither inspected nor changed in this review.
- Notion finalization: PR #21 (`89abd5d`) limits reconciliation to the reviewed page, with a regression in `test/notion.test.ts`; [subsequent reconciliation](https://github.com/aindaco1/dust-wave-opportunity-radar/actions/runs/33411605953) succeeded.
- Billing failures have no job logs because no runner started. Their check-run annotations identify the account payment/spending limit. [Latest pre-review main CI](https://github.com/aindaco1/dust-wave-opportunity-radar/actions/runs/35925485906) succeeded, as did four of the five open dependency PR checks.

These successful historical jobs establish that the old failures were addressed at the time; they do not verify today's production delivery or authorize replaying state-changing workflows.

## Validation

`npm ci`, `npm run check:offline`, `npm run security:audit`, actionlint and
`git diff --check` pass. The suite passes 412 tests across 35 files; coverage is
90.50% statements, 81.65% branches, 95.38% functions and 92.82% lines. Generated
types, TypeScript, the real local email-runtime test and dry Worker build pass.
The audit reports zero vulnerabilities across the complete locked graph.

`npm run check` was run and reached live Jev evaluation after those gates passed.
It exited nonzero because Cloudflare rejected the first synthetic judge request
with HTTP 401 / code 10000. The existing Wrangler OAuth login is valid for its
current permissions, which do not include Workers AI inference. No explicit
inference token is configured. A content-free diagnostic confirmed the same
rejection; no secret values were printed or inspected. The retained local report
is `.jev-results/run-ztfxaf/report.json`: incomplete, one judge attempt, zero
classifier attempts, `releaseAccepted: false`.

Live semantic acceptance remains unverified until an inference-capable local
credential is supplied and `npm run test:jev` passes. No production classifier,
fixture, rubric or margin changed. The failed live gate was preserved; the
credential-free hosted gate does not claim to replace it. These dependency and
CI repairs do not deploy or authorize a production release. Hosted results are
available on the consolidation pull request.
