# HEY CLI qualification

## Current decision

The attachment omission is resolved in the tested v1.4.1 build with upstream [PR #346](https://github.com/basecamp/hey-cli/pull/346) applied. The ordinary installed v1.4.1 release still omits these files and has not been replaced. Local qualification used an isolated checkout; the hosted workflows build the same explicitly pinned candidate for each approved run.

Official forwarding remains the ongoing production ingestion path. The pinned candidate's [manual historical-recovery adapter](../scripts/hey-cli-recovery.mjs) and [disposable GitHub workflow](../.github/workflows/hey-cli-recover.yml) are merged and passed the first source-only production recovery below. This is limited to one explicitly selected existing failed record with an expired payload; it is not a broad backfill or mailbox watcher. Deduplication against forwarded Message-IDs and unattended renewable OAuth remain unverified and outside this recovery scope.

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

A bare `HEY_TOKEN` is suitable for a supervised one-off runner test, but does not carry refresh state. Reusable hosted OAuth requires an approved secure store for rotated credentials and installation state; copying an immutable credential snapshot on each job is not a verified lifecycle. Before the hosted test below, GitHub repository and `production` environment secret inventories contained no HEY credential for this candidate, and nothing had been transferred from the operator login to GitHub.

These are local simulations of headless behavior, not Linux/GitHub-hosted acceptance. The wrapper's [process tests](../test/hey-cli-verify.test.ts) also verify redacted command failures and cache cleanup. The wrapper no longer treats an empty search or zero attachment evidence as a qualified sample, and checks the doctor's authentication result rather than its top-level execution-success envelope.

The local continuation's final `npm run check` passed: 275 tests in 26 files, coverage floors (89.35% statements, 78.12% branches, 93.93% functions, 91.90% lines), documentation, type checks, and the Worker dry bundle. `git diff --check` and Node syntax checks also passed. At that stage all changes were local; the later hosted run below used a dedicated verification branch.

## Boundaries for any future expansion

The approved single-record recovery is accepted below; there is no outstanding deployment requirement for that scope.

1. Broader overlapping imports require original-message identity or another independently verified non-overlap boundary; matching by title/body is insufficient. They are deliberately outside this adapter.
2. Keep CLI use supervised and one-off. An unattended renewable OAuth lifecycle and an unpatched maintained release are future work, not requirements for this bounded pinned recovery.
3. The normal batch's eventual classification/Notion/digest result is distinct from source-only recovery. No batch was forced for this acceptance.

No production import, migration, deployment, mailbox edit, GitHub secret change, or upstream comment was performed during the local testing stages above.

## Disposable GitHub qualification

The original [read-only workflow](../.github/workflows/hey-cli-verify.yml) bootstrapped from `codex/hey-cli-hosted-verification` using a temporary branch-restricted environment. After that successful bootstrap it is manual-only on protected `main`, with a temporary `HEY_CLI_VERIFY_TOKEN` in the existing `production` environment and no Worker admin credential. Remove the secret after completion or failure; the workflow token deliberately has no permission to administer secrets. Do not delete the existing production environment.

The job validates Radar, checks out the exact v1.4.1 source commit, applies the [reviewed PR #346 patch](../patches/hey-cli-pr346-attachments.patch), runs upstream component tests, and builds the distinctly named `1.4.1-radar-pr346` candidate. It reruns synthetic authentication checks on Linux before giving the actual token to the final bounded Paper Trail PDF check. Dependency and Go caches are disabled, no mail artifacts are uploaded, and an `always()` step removes the isolated live config/state/cache directories. The operator must separately verify secret removal. This qualification does not authorize an import or production deployment.

### Hosted acceptance — September 4, 2026 (America/Denver)

[GitHub run 33940128171](https://github.com/aindaco1/dust-wave-opportunity-radar/actions/runs/33940128171) passed on verification commit `0338c7c35425904ec843a6eb8fdcb911f9f6fd78`. The Linux job ran from 20:48:50 to 20:50:14 Mountain time (84 seconds; September 5 in UTC).

- Radar's complete gate passed with 276 tests in 26 files and enforced coverage floors. Actionlint passed locally.
- The pinned upstream HTML, authentication, and thread-loading tests passed. The Linux candidate binary SHA-256 was `a00eacf32d7e09b6e83c9a7aa7c53f3007c346adce91dcf4ac015ef2f9b7541b`.
- All six synthetic authentication scenarios passed on the actual runner, including rotation and restart. Real-token expiry/revocation was not deliberately induced.
- The live seven-day Paper Trail PDF sample matched and completely checked three threads: five attachment evidence items, five listed attachments, zero missing/unsafe/malformed evidence, zero command failures. This hosted run did not download attachments.
- The verifier confirmed its temporary cache was removed; the final job step confirmed all isolated live state was removed. GitHub reported zero uploaded artifacts.
- With explicit user approval, the operator token was piped directly into the encrypted environment secret without displaying it or writing a local token file. After completion, the secret was deleted and its absence checked, then the temporary environment was deleted. An independent environment listing contained only `production`; repository secret names remained `ADMIN_TOKEN` and `CLOUDFLARE_API_TOKEN`. The operator's HEY login was not revoked.

This clears one-off authenticated hosted verification for the pinned candidate and sample. It is not a production HEY rollout, broad mailbox completeness proof, forwarding-overlap deduplication proof, or authorization to import the failed historical record. No merge to `main`, production import, migration, batch, mailbox mutation, or Worker deployment occurred.

## Scoped historical recovery

The [recovery command](../scripts/hey-cli-recover.mjs) (`npm run recover:hey-cli -- --help`) defaults to preview. Its workflow accepts a D1 SHA-256 message ID, not a new HEY topic, and runs only on protected `main`. The shared [build action](../.github/actions/setup-hey-cli/action.yml) pins the same base and reviewed patch as the hosted qualification, labels it `1.4.1-radar-pr346`, and tests the read-only MCP gateway as well as HTML, auth, and thread loading.

- Require the exact existing `hey` / `mcp-hey:<topic>` identity, one D1 row, `failed` status, and an empty raw reference. Successful or retained-failed records are refused. An already queued restored row is a no-write skip.
- Read only that topic. Require complete hydrated messages and attachment inventory. The CLI JSON timestamps omit zone/seconds, so `hey mcp --read-only --domains threads` supplies original API timestamps and HTML via `hey_threads/get_message`.
- Include only messages created by the original D1 insertion time. Exclude later replies and their attachments. Refuse older messages edited since that cutoff; historical content cannot be reconstructed reliably in that case.
- Reconcile attachment-shaped HTML evidence per message, then download every selected file under generated filenames. Require exact owner/ID/size, private regular files, PDF signatures, a 20 MiB aggregate attachment budget and 25 MiB MIME budget. Any incomplete file blocks the entire import.
- Share MIME construction with the legacy backfill. Preserve the `mcp-hey:` topic key, stored metadata, and synthetic Message-ID; encode Unicode headers, bodies, and filenames safely.
- Re-read D1 immediately before the sole POST to the existing `/admin/import/hey` endpoint. Verify the same row is queued with attempts reset, exact raw size/key, and preserved classification/metadata. Repeat the guard and require zero additional writes. There is no forced batch or Notion operation.
- The pre-write check is not a server-side compare-and-swap. Do not concurrently edit/delete the target or run another importer. A scheduled batch may claim a restored row immediately; if verification stops after the POST, reconcile D1 before any retry. Network ambiguity never triggers an automatic POST retry.
- Real credentials are restricted to the final workflow step and separated between HEY and Wrangler child environments. No token is persisted by this runner. Source output stays in memory, Wrangler disk logging is disabled, attachments/cache use private disposable directories, and no artifacts or persistent caches are uploaded. Delete the temporary environment secret after success or failure; this does not revoke the operator login.

The September 4 read-only preflight found one eligible failed record. Its thread had four messages: three historical messages with three attachments and one newer message. Original API timestamps confirmed none of the three historical messages had been edited since the original import. No production write occurred in that preflight.

Synthetic [regression tests](../test/hey-cli-recovery.test.ts) cover fail-closed identity/content/download checks, cutoff and timezone handling, Unicode MIME round trips, a real migrated D1/R2 importer round trip with DOCX parsing, preserved classification, unchanged downstream tables, no-write repeats, and content-free command failures. [Parser regressions](../test/parse.test.ts) also verify recovered PDFs with either explicit PDF or generic binary MIME metadata. The live recovery below contains DOCX files, not the PDFs from the earlier qualification sample.

## Production recovery acceptance — September 4, 2026 (America/Denver)

[PR #36](https://github.com/aindaco1/dust-wave-opportunity-radar/pull/36) merged the reviewed adapter after required CI passed. Both approved hosted runs used merge commit `54881707706716eb94233cad2ba89ba888fc261f` and the pinned candidate build.

| Check | Result |
|---|---|
| [Hosted preview](https://github.com/aindaco1/dust-wave-opportunity-radar/actions/runs/33943014092) | Passed; zero imports, three historical messages, three attachments, one newer message excluded; production record/counts unchanged |
| [Source-only import](https://github.com/aindaco1/dust-wave-opportunity-radar/actions/runs/33943096412) | Passed; one existing identity restored to `queued`, attempts reset to zero, no error; no additional row |
| Immediate repeat guard | `already_queued`, zero additional imports or payload writes |
| Saved MIME | 143,722 bytes; same synthetic Message-ID and three historical body sections |
| Attachments | Three DOCX files, 99,373 bytes total; all downloaded privately with exact size/identity checks |
| Independent R2 read and production parser | Matching stored raw size/identity; all three DOCX files yielded nonempty text, zero parsing warnings; no production write |
| Retained state | Original subject, mailbox, sender, received/created times, classification, canonical URL and parsed reference preserved |
| Database preservation | 524 messages / 78 HEY rows / 86 opportunities / 124 digest items / 77 runs before and after; zero duplicate rows, forced batches, or downstream-table changes |
| Cleanup | Both runner cleanup steps passed; zero uploaded artifacts; temporary recovery token deleted and absence independently checked; existing `production` environment preserved |

The import job ran from 21:53:42 to 21:55:10 Mountain time (September 5 in UTC). Its full project check passed with 322 tests in 27 files, enforced coverage floors, docs/types and dry bundling; upstream HTML/auth/thread/MCP tests and all six synthetic authentication scenarios passed. Two subsequent synthetic PDF-parser cases bring the final project suite to 324 tests. No private MIME, attachment names, source text, private URLs or credential values were retained in the repository or acceptance logs.

No Worker deployment, schema migration, mailbox mutation, broad backfill, forced classification, Notion publication or digest delivery was performed. The restored source waits for the normal 07:00/19:00 Mountain-time batch. A future one-off recovery requires a fresh explicitly approved temporary credential; no unattended HEY token is left configured on GitHub.
