# HEY CLI qualification

## Current decision

The attachment omission is resolved in the tested v1.4.1 build with upstream [PR #346](https://github.com/basecamp/hey-cli/pull/346) applied. The ordinary installed v1.4.1 release still omits these files. The candidate was built and exercised in an isolated temporary checkout; it was not installed or deployed.

Official forwarding remains the production ingestion path. Legacy topic-key compatibility now passes the bounded live check below, and synthetic headless-authentication checks pass. Deduplication against forwarded Message-IDs and a real authenticated hosted run remain unverified. The candidate is suitable for further qualification of explicitly selected historical recovery, not broad overlapping imports or an ongoing mailbox watcher.

## September 4, 2026 comparison

The same three Paper Trail threads matched the last-seven-days PDF search for both binaries. Original HTML was read in memory and compared with each binary's attachment inventory. Threads were read without allowing partial results.

| Sample | Expected files | Released v1.4.1 | v1.4.1 plus PR #346 | PDFs downloaded and checked |
|---|---:|---:|---:|---:|
| 1 | 2 | 0 | 2 | 2 |
| 2 | 1 | 0 | 1 | 1 |
| 3 | 2 | 0 | 2 | 1 |
| Total | 5 | 0 | 5 | 4 |

All four PDF downloads matched declared sizes, had PDF headers, and had owner-only permissions. The fifth listed file was not downloaded. No command failures occurred. This verifies discovery and basic PDF download integrity in this targeted sample; it does not prove full document parsing, live DOCX downloads, or whole-mailbox completeness.

The earlier local verifier reported eleven references because it included six distinct externally referenced inline images. HEY represents these as unnamed `action-text-attachment` elements with `content-type="image"`; they remain part of the HTML body and are not downloadable mail attachments. The verifier now excludes that specific remote-image shape while retaining named image files, HEY blob links, and document URLs. Regression tests reproduce the previous false warning and preserve the real missing-PDF failure.

## Tested source and checks

- Base: official [v1.4.1](https://github.com/basecamp/hey-cli/releases/tag/v1.4.1), commit `d5d5a9360266c74c95165939d478132bc2752344`.
- Applied change: [PR commit `3447d76c93d1b2da564d7d196c95a03b24e870d7`](https://github.com/basecamp/hey-cli/commit/3447d76c93d1b2da564d7d196c95a03b24e870d7), the reviewed changes to `internal/htmlutil/htmlutil.go` and its test file. No SDK or authentication implementation changes.
- Candidate: `make build` with the default `dev` version. Binary SHA-256: `e0325555954869b480566216ae8fe3e9d20c0851e7ca20907acf8d35b50b04da`. Build timestamps mean subsequent local builds need not have the same checksum.
- The upstream embedded-file regression failed on the unmodified base and passed with the patch.
- Upstream `make test` passed across all internal packages (1,951 top-level passing tests). Additional synthetic tests passed for PDF/DOCX file ordering and sizes, embedded images, and valid nested HTML immediately below and above the recursion limit.
- The project's [fidelity tests](../test/hey-cli-fidelity.test.ts) verify the local counter correction. Run `npm run check` for the project gates and `npm run verify:hey-cli` for the installed binary's bounded, read-only check. A failure on the unpatched installed v1.4.1 remains expected.
- The attachment-stage project `npm run check` passed: 254 tests in 25 files, coverage floors (89.35% statements, 78.12% branches, 93.93% functions, 91.90% lines), documentation, type checks, and the Worker dry bundle. The continuation below adds identity and process tests.

All unit tests used isolated config/cache/state directories and disabled keyring access. Live reads used the existing login with a disposable cache; PDF downloads were also temporary. Caches and downloaded copies were deleted after each live check. No source mail, attachment filenames, private URLs, or credentials were saved in project files or diagnostic logs.

## Identity verification continuation

A read-only production D1 check on September 4 found 78 HEY rows: 73 with legacy `mcp-hey:` keys and five with other keys. The legacy records comprise 66 ignored, four digest, two Notion, and one failed record. All 78 rows have expired payload references. No payload was restored or classification rerun. The first D1 request returned Cloudflare code 7403; account/scope checks succeeded and the bounded retry succeeded, so that transient error is not an outstanding access blocker.

Three legacy records were selected, prioritizing the failed row and then recent historical records. All three external IDs reproduced their existing SHA-256 D1 IDs. All three topic IDs opened with the candidate CLI without partial results, returning six entries in total. This verifies a small real legacy-key sample, including the failed record; it does not verify every historical topic or complete attachment recovery for these records.

[Ingestion regression tests](../test/email-worker.test.ts) now exercise the real importer and forwarding code with synthetic MIME and the migrated local database:

- Reusing `mcp-hey:<topic_id>` across posting IDs and mailbox moves preserves one row and terminal classification state.
- Re-importing a failed row whose raw payload expired restores that same row to `queued` and resets attempts; failed rows that still retain their raw payload are not silently reset.
- Identical MIME, sender, date, and subject under a forwarded RFC Message-ID and a historical topic key produce two distinct rows. Content resemblance is not an identity mapping.
- Adding a reply to a terminal topic snapshot does not requeue it. This identity is for historical snapshots, not watching new mail.

The reviewed SDK `Entry` and `Message` models contain HEY numeric identities but no original RFC Message-ID field. No supported mapping from a whole topic to forwarded mail has been established. An importer must retain the legacy prefix and topic identity for explicitly verified existing records; it must not substitute posting/entry IDs or a new `hey-cli:` prefix. Overlapping fresh imports remain unqualified. The local topic extractor now rejects numeric IDs that cannot be represented exactly in JavaScript.

## Headless authentication continuation

The [authentication smoke harness](../scripts/hey-cli-auth-smoke.mjs) executes the real CLI against a loopback-only mock service. It supplies only invented credentials, disables keyring access, uses isolated config/state/cache directories, tests mode-`0600` stored credentials, suppresses raw subprocess diagnostics, and deletes all temporary state. It requires no HEY login and does not contact the production Worker.

```sh
npm run verify:hey-cli-auth
```

`HEY_CLI_TEST_BINARY` can select the explicit candidate binary. All six scenarios passed on the previously tested v1.4.1-plus-PR-346 candidate:

| Scenario | Verified behavior |
|---|---|
| Valid environment token | Authenticated read succeeds |
| Missing credentials | Fails before a mail request |
| Rejected environment token | Fails after one rejected read, with no refresh credentials available |
| Expired stored OAuth token | Refreshes once, persists rotation privately, succeeds after process restart |
| Rejected refresh | Fails before mail read and preserves the prior synthetic credentials |
| Mid-request HTTP 401 | Refreshes once, retries successfully, and uses the rotated credential on restart |

A bare `HEY_TOKEN` is suitable for a supervised one-off runner test, but does not carry refresh state. Reusable hosted OAuth requires an approved secure store for rotated credentials and installation state; copying an immutable credential snapshot on each job is not a verified lifecycle. GitHub repository and `production` environment secret inventories contain no HEY credential for this candidate. Nothing has been transferred from the operator login to GitHub.

These are local simulations of headless behavior, not Linux/GitHub-hosted acceptance. The wrapper's [process tests](../test/hey-cli-verify.test.ts) also verify redacted command failures and cache cleanup. The wrapper no longer treats an empty search or zero attachment evidence as a qualified sample, and checks the doctor's authentication result rather than its top-level execution-success envelope.

The continuation's final `npm run check` passed: 275 tests in 26 files, coverage floors (89.35% statements, 78.12% branches, 93.93% functions, 91.90% lines), documentation, type checks, and the Worker dry bundle. `git diff --check` and Node syntax checks also passed. All repository changes remain local; no commit, push, or workflow dispatch was performed.

## Remaining acceptance

1. Select the maintained release or explicitly pinned patch to use for a future importer; PR #346 was still open and unmerged at the time of this test.
2. Limit the first import to explicitly verified existing historical IDs. Before allowing new overlapping imports, establish original-message identity or another independently verified non-overlap boundary; matching by title/body is insufficient.
3. Provision an explicitly approved temporary HEY credential and verify one disposable hosted runner's authenticated reads, failures, and cleanup. Do not treat the local login or synthetic auth tests as hosted acceptance.
4. With explicit production-import authorization, exercise selected historical recovery through the existing private ingestion boundary, preserving `mcp-hey:` keys, then verify source-only counts and rerun deduplication before treating the candidate as deployed.

No production import, migration, deployment, mailbox edit, GitHub secret change, or upstream comment was performed during this test.

## Disposable GitHub qualification

The [read-only workflow](../.github/workflows/hey-cli-verify.yml) bootstraps only from `codex/hey-cli-hosted-verification` when that workflow file changes. It has no schedule or production credentials. A temporary `hey-cli-verification` environment must restrict access to that branch and contain `HEY_CLI_VERIFY_TOKEN` only for the approved run. Remove the secret after completion or failure; the workflow token deliberately has no permission to administer secrets.

The job validates Radar, checks out the exact v1.4.1 source commit, applies the [reviewed PR #346 patch](../patches/hey-cli-pr346-attachments.patch), runs upstream component tests, and builds the distinctly named `1.4.1-radar-pr346` candidate. It reruns synthetic authentication checks on Linux before giving the actual token to the final bounded Paper Trail PDF check. Dependency and Go caches are disabled, no mail artifacts are uploaded, and an `always()` step removes the isolated live config/state/cache directories. The operator must separately verify secret removal. This qualification does not authorize an import or production deployment.
