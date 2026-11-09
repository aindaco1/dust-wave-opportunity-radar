# November 8 Actions and dependency review

Base: `42751c8c50d4f8808ed57a1e2d415a5a9da60cff`.

Combine PRs #89–#94 into one compatible lockfile: MCP SDK 1.32.2, postal-mime
4.2.0, unpdf 2.1.0, Node types 26.6.6, Wrangler 4.156.0, and the transitive
Hono Node server security patch 2.1.6. The Hono patch clears the shared audit
failure blocking four otherwise independent updates. Wrangler's generated
runtime declarations and exact workerd installer allowance move together to
1.20261023.1. No broad installer permission or new direct Hono dependency is added.

`npm ci` and full `npm run check` pass: documentation, generated types,
TypeScript, 480 tests across 36 files, coverage, Worker dry bundle, zero audit
vulnerabilities, and live evaluation using the existing dedicated inference
profile. Existing parser regressions exercise actual PDF text extraction and
MIME attachment recovery under the new unpdf major version.

The synthetic Jev report `.jev-results/run-Ir5AmN/report.json` completed with
`passed=true`, no calibration, semantic, or exact failures. It retains
`releaseAccepted=false`; this is bounded development evidence, not whole-mailbox
or production acceptance. No real email was submitted by the evaluation.

Platform pins, classifier policy, production deployment, and scheduled jobs are
unchanged. Revert the manifest, lockfile, generated declarations, and installer
allowance together for rollback; the prior lock restores the known audit failure.
