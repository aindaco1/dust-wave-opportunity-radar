# Platform reuse batch 2 — September 14, 2026

## Scope

Worker Core 0.15.0 now owns one bounded Notion request attempt: canonical origin, version/auth headers, full-body timeout, response byte budget and structured HTTP errors. The consumer retains its four-attempt retry loop and retry-after/backoff timing, API version, schemas, queries, write semantics and error presentation.

The shared helper never retries. Redirects are rejected without following them; unsafe paths and caller aborts fail closed. Network failures, invalid JSON and oversized responses still leave the consumer loop immediately. No admin job, provider write or email send is part of validation.

Notion token values, database/page IDs, content and private data remain consumer-owned.

## Immutable source and validation

- Previous consumer release source: `c4780250e71558cb8035ac4e4381cec9d022e35f`.
- Characterization-only commit: `323b8afe437f2eed9069c8c8633ea598a60753a2`.
- Previous Platform pin: `30b1cf9c1154b6f38e3da34fc7b2ed3b6d312088`.
- New Platform v0.38.0 pin: `8609b10348da42f20e51b5a9048e074a3a3ae5e2`.

All 7 transport characterization tests passed against both the original client and the shared helper. Fixtures cover methods/bodies/headers, retry-after timing, exhausted retries, non-retryable errors, uncertain writes and malformed/oversized responses. Run npm run check for documentation, types, coverage and the dry deployment build before merge.

Local consumer validation: all 378 tests, documentation, typecheck, coverage and
dry deployment build passed.

Platform release checks establish the shared contract separately. Consumer CI,
deployment versions and live checks are recorded in this migration's pull request;
a source pin is not a claim of production acceptance.

## Independent rollback

The characterization commit retains the previous implementation and Platform pin.
Reverting the following migration commit restores the old source, gitlink,
package/version expectations and lockfile together while retaining the behavior
tests. Initialize submodules, run npm ci (also in worker for this project's Worker
subdirectory if present), run the complete release gate, and redeploy this consumer's
reviewed prior release. The rollback does not change another consumer.

No storage/schema migration is introduced. Do not roll back only the gitlink:
the adapters and shared script paths must move with it. Retain the previous
production deployment version for immediate rollback while source checks run.
