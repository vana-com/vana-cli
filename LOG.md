# BUI-951 implementation record

## Scope and ownership

The CLI adapter keeps the requesting agent in charge of connector code. It uses
a separately installed Factory executable for build, prepare, check, resume, and
same-run verification. Vana remains the only collection and ingestion runner.

Implementation uses an isolated worktree on `callum/bui-951-cli-adapter`. The
active CLI work and PR #106 were not edited by this task.

## Implemented

- Added bundled instructions and explicit build/prepare/check/resume commands,
  strict capability/result validation, safe progress, and exact collection argv.
- Added opt-in Factory-bound collection with private original wire capture and
  verification before result/checkpoint writes. Failed verification preserves
  prior good data and returns the job, attempt, and bounded safe rule findings.
- Added source/account-deployment writer exclusion and terminal cancellation
  that awaits provider cleanup before releasing the collection lock.
- Preserved verification on accepted export receipts. Fresh and delayed uploads
  validate the same bytes, collecting identity, destination, and selected scopes.
- Kept failed and partial ingestion nonzero for Factory-bound runs. Existing
  server sync retries only accepted bytes and failed scopes without recollection.

## Verification on 29 October 2026

Full validation passed typecheck, ESLint, repository formatting, and 946 tests.
Factory's full check passed 548 tests with one skipped test.

Installed tarball and actual SEA/Node 22 tests used synthetic collectors and
controlled HTTP storage. They covered successful collection/ingestion, failed
precommit verification preserving previous data, actionable private-safe
findings, stale source rejection, terminal cancellation, offline recovery,
accepted-byte tamper, and API multi-stream partial retries.

## Boundaries

The Factory package remains private and unpublished. The adapter does not add a
mandatory private dependency, start a model session, or publish a connector.
Browser preparation and authenticated provider acceptance are outside this PR.
Protocol verification, local persistence, upload acknowledgement, and independent
server readback remain distinct. No real-provider collection or real Personal
Server readback was performed. No merge or release is authorized.

## Review fix, 29 October 2026

Every PDPP run holding the collection lock now uses the same graceful signal
and abort lifecycle, including ordinary runs without a Factory job. Provider
cleanup and lock release finish before signal handlers are removed. Manual
recovery for uncatchable crashes remains unchanged.

Real subprocess regressions for SIGINT and SIGTERM failed on the stale lock
before repair. They now prove accepted result/checkpoint bytes stay unchanged,
the provider is reaped, the lock is removed, and the next collection succeeds.
The test builds into its own temporary output so it does not race existing
built-CLI tests. No production build or storage mechanism was added.

All 46 focused runtime/protocol/store tests passed. Final full validation passes
typecheck, ESLint, formatting, and 948 tests. The original runtime reproduction
also confirms cancellation followed by a successful collection and no stale
lock. Changes remain limited to this finding and its regression. Delivery
updates existing PR #108 from this isolated worktree; no active CLI/#106 edits,
new features, merge, release or real-provider runs are authorized.
