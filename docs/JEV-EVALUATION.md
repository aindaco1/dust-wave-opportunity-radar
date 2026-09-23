# Jev regression evaluation

## Scope and implementation

The September 23, 2026 integration adds live semantic evaluation to the default
development check, following CutNotes. It targets incorrect Notion/digest/ignore
decisions, missed calls, eligibility/deadline errors, and unsupported or missing
details. It uses only twelve committed fictional cases. There is no production
mail reader, arbitrary file input, Notion writer or scheduled job in the evaluator.

The implementation reuses `@dustwave/test-core/jev` 0.3.0 at Platform commit
`816da7b52ed346025f5bbe3a7a420e9ad7c4a815`. The previous pin was
`8609b10348da42f20e51b5a9048e074a3a3ae5e2`; Worker Core remains 0.15.0 and
Digest Core remains 0.1.0, with their runtime source unchanged between these pins.
Radar owns the [fixtures](../test/fixtures/jev-radar.json),
[evaluation adapter](../scripts/jev-evaluation.ts), and
[Cloudflare classifier transport](../scripts/jev-cloudflare.ts). Platform owns
Jev request construction, bounded transport, validation, review routing and raw
evidence collection. No shared source was copied or modified.

## Commands and credentials

```bash
npm run check              # offline gates, then live classifier + Jev
npm run check:offline      # docs, types, coverage, local runtime, dry bundle
npm run test:jev           # live evaluation alone
npm run test:jev:preview   # preview synthetic judge controls; zero inference
```

Missing authentication is an error, not a skip. Locally, set
`CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_API_TOKEN` in the environment or the
ignored `.dev.vars`. The token needs Workers AI inference permission; deployment
credentials may not have that permission. With no token set, the runner captures
the existing locked Wrangler login in memory. It selects an account automatically
only when Wrangler reports exactly one; otherwise set the account ID explicitly.
It never prints credential values, starts an interactive login, or saves tokens
to reports. The preview does not read `.dev.vars` or acquire credentials.

Existing PR CI and deployment/HEY qualification workflows explicitly run
`check:offline`, preserving their credential and production-operation boundaries.
They do not claim live semantic acceptance. Live hosted evaluation is not
provisioned by this change. In CI, both account and inference token must be
supplied explicitly; local-login fallback is disabled. Before a release, retain
a complete live report in addition to the offline CI result.

## What the gate checks

1. Twenty-four labeled judge controls pair faithful and deliberately flawed text
   against the same source and one atomic requirement. An always-pass judge fails.
2. The twelve synthetic source packets run through the actual `classifyMessage`
   function, current production prompts/schema, recovery pass and deterministic
   policy. Model and confidence threshold come from `wrangler.jsonc` through the
   existing configuration loader. Source pages are fictional in-memory evidence;
   URLs are not fetched.
3. Exact assertions check the applicable decisions, digest categories, final
   deadlines, eligible states and official URLs. Eleven sources omit an opening
   date, so `applicationOpenStart` must remain null; one explicitly states an
   opening date that must be preserved. The batch date is not opening evidence.
   A personal acceptance/delivery notice must not become a new open call.
4. Jev checks source-grounded fee/material details, residency versus venue
   location, non-cash benefits, unknown facts, separate programs, updated official
   evidence and embedded-instruction rejection.

Both exact and semantic results must pass. Calibration label mismatches, semantic
failures, uncertainty, unrecognized model versions, incomplete responses and
transport failures exit nonzero. A completed request is not a passing result.
Semantic disagreements retain all candidate evidence for diagnosis; transport
failure stops the run. The classifier's existing smaller recovery pass remains
available for schema-invalid successful responses and low-confidence ignores,
never as a network retry.

The initial policy recognizes `jev-1.13.0` and requires a 0.10 probability margin.
This is a provisional conservative policy borrowed from CutNotes, **not a
Radar-calibrated accuracy claim**. The labeled controls are engineering judgments,
not independent human ratings or a held-out study. Do not lower the margin or
rewrite labels merely to obtain green results. Review disagreements against the
source, retain regressions, and use fresh validation examples before tuning the
judge. Keep policy, requirements and fixtures frozen while comparing classifier
changes. The questions follow [TypeSafe's atomic-question guidance](https://docs.typesafe.ai/introduction)
and use the [returned probability distribution](https://docs.typesafe.ai/confidence).

## Limits, privacy and reports

Each run permits at most 36 Jev calls and 24 classifier calls (including recovery),
100 judge questions per evaluation batch, 32,000 input bytes per request,
1 MB response bodies and 45 seconds per request. Calls are sequential with no
automatic network retries or top-ups. These are request/size limits, not a dollar
spending guarantee. Live inference is billable; check current account pricing
for [Jev](https://developers.cloudflare.com/ai/models/typesafe/jev/) and the
classifier before expanding the corpus. Reports retain available token usage.

Every run gets a new ignored `.jev-results/run-*/report.json` with private file
permissions. It records corpus/classifier hashes, the immutable Platform pin,
fixed batch date, actual synthetic candidates, exact failures, raw Jev responses,
probabilities, resolved models and timings. Progress is saved after each result,
so partial runs remain distinguishable. Output is never copied from real email,
attachments or Notion. Cache/logging suppression headers are sent to Cloudflare;
they do not establish provider retention policy. Errors omit provider bodies and
credentials. All reports retain `releaseAccepted: false`.

An offline pass establishes deterministic behavior, not model quality. A live
pass establishes behavior on this small synthetic corpus, not whole-mailbox
recall, Cloudflare Workflow durability, Notion safety, digest delivery or release
acceptance. Existing [tests](TESTING.md) remain authoritative for those contracts.

## Rollback

Revert the evaluator, fixtures, commands, documentation, workflow command changes,
Platform gitlink, exact pin assertion and Test Core lockfile version together.
Initialize the restored submodule and run `npm ci` and the prior offline check.
No schema, production secret, deployment, or other consumer is changed.

## Initial verification — September 23, 2026

The offline gate passed 395 tests across 34 files, generated types, TypeScript,
documentation and the dry Worker bundle. Coverage was 90.28% statements, 81.15%
branches, 94.72% functions and 92.62% lines. This establishes local compatibility,
not CI, production deployment or live operational acceptance.

Live inference used the existing Cloudflare login, the configured classifier and
Jev 1.13.0. Early runs passed all 20 labeled controls but exposed two classifier
problems on manual inspection and repetition:

- `final-deadline` sometimes invents the batch date as the application opening
  date. A new exact assertion and an offline regression test now catch this even
  when the semantic questions pass.
- `missing-official-link` sometimes ignores an unverified but relevant fellowship
  instead of routing it to `Possible Opportunities`. Existing exact expectations
  caught this without lowering any threshold.

One judge rejection also treated a faithful California-only eligibility summary
as incomplete because it did not name each excluded state. The requirement and
positive control now explicitly accept that equivalent concise wording. This
was a rubric correction, not a classifier change or an independently validated
judge calibration. The controls remain development regressions.

The stricter pre-correction run completed with 20/20 controls and 10/10 semantic
cases passing, but only 8/10 combined cases passing due to the two classifier
issues above. Its saved report is `.jev-results/run-t3aMGe/report.json`.
`npm run check` correctly exited nonzero. Passing a subsequent sample does not
erase these observed failures. That initial integration did not change production classifier behavior.

The final run after the rubric correction, `.jev-results/run-pDj8zQ/report.json`,
also completed with 20/20 controls, 10/10 semantic cases and 8/10 combined cases.
It independently reproduced the same two classifier defects and exited nonzero.
It used 10 classifier requests and 30 Jev requests, with the production 0.82
confidence threshold. The concise California-only positive control passed.


## Classifier and formatting fixes — September 23, 2026

The follow-up fixes retain the original ten case expectations, judge requirements
and 0.10 margin. Two new fictional cases require preservation of an explicitly
stated opening date and correct routing of a personal film-acceptance follow-up.
The latter uses ordinary screening-delivery language rather than telling the
classifier the desired routing decision.

- The primary extraction now requests a source quote for an opening date. The
  date is cleared unless the quote matches actual source text; processing dates
  are excluded. Genuine quoted dates remain valid, including an opening date
  that happens to equal the batch date. See [Classification](CLASSIFICATION.md).
- A low-confidence `ignore` uses the existing recovery classifier. Both prompts
  distinguish incomplete publication evidence from irrelevant content, retaining
  possible calls for human review. Confident irrelevant messages stay ignored.
- Personal acceptance and delivery instructions for already-selected work are
  distinguished from new application calls.
- The existing Notion body builder repairs collapsed template headings and HTML
  breaks before create or guarded update. Its template labels are shared with
  the prompt. It preserves exact matching of previous managed text and manual
  notes; see [Notion integration](NOTION.md). Prompt instructions alone were
  insufficient: the live model still emitted HTML breaks during validation.

The original behavior failed the new formatting, invented-date and uncertain-ignore
regressions before the fixes. The first post-fix live report,
`.jev-results/run-QqfCtm/report.json`, passed 24/24 controls and 12/12 combined
cases with 16 classifier calls and 36 Jev calls. That run used the earlier,
more explicit acceptance-email fixture; final validation uses the realistic
wording described above. No production deployment or existing-page repair is
included in this local verification.


Final `npm run check` passed with the current corpus. The offline suite passed
403 tests across 34 files; coverage was 90.50% statements, 81.65% branches,
95.38% functions and 92.82% lines. Generated types, TypeScript, documentation and
the dry Worker bundle also passed. The live report
`.jev-results/run-5B4aE9/report.json` passed 24/24 controls and all 12 exact/semantic
cases using 15 classifier calls and 36 Jev calls. It preserved the explicit
opening date, retained the unverified fellowship for review, and ignored the
realistic personal-acceptance notice. These are bounded synthetic regression
results, not production or existing-Notion-page acceptance.


## Toolchain revalidation — September 23, 2026

Revalidation on Wrangler 4.135.0 and Vitest 5.0.1 passed the offline gates but
`.jev-results/run-wM4THY/report.json` caught a recovery-summary omission: the
California-only grant was correctly ignored, but the summary named only the
excluded target states and omitted the original residency rule. The existing
semantic requirement rejected that incomplete description. The recovery prompt
now asks for the source's actual applicant eligibility restriction when geographic
exclusion drives an ignore. Judge policy, labels and expectations are unchanged.

The follow-up full check passed 403 offline tests and all 24 controls / 12 combined
live cases in `.jev-results/run-PBbOIG/report.json` (15 classifier and 36 Jev
requests). The corrected recovery description retains the original residency
rule. This remains synthetic evidence, not scheduled production acceptance.
