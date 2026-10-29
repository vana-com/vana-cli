# Worklog

## 2026-10-29 — Approved collection onboarding implementation

Implement the agreed welcome groups and collection journey in the existing PR #106 checkout. Source selection stays searchable with 12 visible rows, a fixed missing-source shortcut and a no-results continuation that carries the query. Missing sources hand off to the canonical Create Connector skill without a heading anchor. Connector creation/Factory integration stays outside this implementation (BUI-951).

The shared collection entry must establish a valid Vana owner and an available, approved destination before connector credential prompts or provider access. Reuse valid sessions; interactive terminals can sign in and prepare the server using existing owners. JSON/IPC/no-input/scheduled runs must stop with actionable structured outcomes instead of prompting or collecting anonymously. Preserve account/network/home context, local connector path and selected streams through recovery. Do not weaken pending-export ownership checks.

Reuse existing credential and ingestion machinery; fix cancellation and retry context, remove mandatory skill-installation contradictions, and keep skill installation explicitly optional. The other three menu groups get bounded routing to their existing workflows, not newly invented full journeys. No Factory core/adapter work, backend changes, merge or release. Starting evidence was synthetic build/checks and a real masked prompt cancelled before input; no authenticated Readwise collection existed. This section supersedes the earlier three-choice welcome design below.

Proof: first reproduce the signed-out collection bypass at the command boundary, then verify readiness ordering, refusal modes, ownership and recovery, plus real terminal source-picker interaction. Use the safe fixture/PTY paths; do not run the old transcript generator or launch a personal browser. Finish with normal checks and the repository's structured review. Keep delivery on #106.

Implemented at the shared collection owner: account identity, destination ownership and server approval precede runtime/provider work; prompts stay out of automated modes. Missing-source search retains its query and hands off to the canonical guide. Read-only skill selection no longer installs it. Recovery carries local checkout, streams, network, home and Account/server overrides. A second reproduced regression showed custom-server environment overrides diverted Account sign-in recovery; recovery now clears them only for Account sign-in and retains them in the collection retry.

Proof on the final implementation: `pnpm validate` passes 1,027 tests across 71 files plus TypeScript, ESLint and formatting; build and package checks pass. Both signed-out collection and custom-server recovery regressions failed before their fixes. Actual terminal checks cover four welcome choices, discovery before sign-in, no-results Enter, immediate Ctrl+O, and the stable guide URL. The actual disposable Readwise connector reached its masked token prompt under synthetic prepared credentials and a local fixture server; Ctrl+C without any token now reports cancellation, without `readwise_credentials_missing`. A separate built-CLI trial executes the generated Account recovery command with both server overrides set. The HTTP fixture collection test independently reads back saved synthetic records under the prepared owner. These prove controlled CLI/transport behaviour, not live Readwise completeness or authenticated production storage. External network/browser access was blocked in terminal trials. The unsafe old transcript generator was not run.

Delivery: Callum explicitly approved sending the patch to Codex after the initial automatic approval rejection. The repository's structured read-only Codex review then completed cleanly at its P0 threshold (0.95 confidence), with no actionable findings. No separate runtime proof is inferred from that review. Keep the scoped commit/push on the existing PR #106; no merge or release is authorized.

## 2026-10-29 — CLI-first agent bootstrap and human welcome

Accepted outcome: an ordinary request such as “Use Vana to collect my highlights from Readwise” can continue after CLI installation by reading bundled instructions through the CLI. Persistent installation into an agent harness is optional, explicitly confirmed, and is not needed by the running agent. Keep public skills self-contained and retain the single CLI PR #106.

Implement at the existing skills owner: `skills show` returns full instructions and required reference content without skill-cache or agent-configuration writes. Keep existing metadata and installed status in JSON. Make this bootstrap discoverable in public docs and CLI help. Remove harness-specific reload advice. Preserve the standalone distribution without adding skills.sh or a separate Node requirement.

For humans, bare interactive `vana` shows the approved welcome choices: connect my data, build an app using Vana data, finish setup. Direct commands and automated modes must remain prompt-free apart from their own requested actions. Reuse the current login/collection owners; do not change providers, accounts, networks or payment behavior.

Boundary: test-credit commits already on #106 are preserved. Another chat owns browser/transcript isolation repairs in the primary checkout. Do not run the old transcript capture here: it can reach a browser under a replaced HOME. Verify this change with controlled skill reads and real terminal UI captures, with browser and network access blocked; live authenticated collection is outside this task.

Finish: focused proof, normal safe repository checks, structured review, scoped commit/push to #106 and update the existing Linear project handoff. No merge or release is authorized.

Implemented: full CLI workflow reads, generic install success, optional persistent setup, and a finite welcome menu. The builder choice hands off to safe app-identity inspection before registration; the connect choice reuses login and source collection. Skill content remains the shared owner for CLI reads and persistent installs. Runtime/packaging evidence and review results belong in PR #106; the existing Linear project update carries the team handoff. The authenticated Readwise journey is not established by these bootstrap checks.

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

## Node 22 CI repair, 29 October 2026

PR #108 at c225591 failed the two legacy-receipt cases on Node 22.23.4.
Each combined a real collection fixture with three independent CLI operations
inside one five-second test budget. Instrumented Node 22 subprocess runs exit
naturally, without the entry point's two-second fallback or lingering handles.
CI's cumulative four-process startup cost exhausted the case deadline.

Split sync, inspection, and blocked recollection into independent contracts for
both missing and malformed receipts. Each prepares its own real collection in
a scoped setup hook and runs one command under the unchanged test deadline.
Retain export-byte, no-upload, no-recollection and actionable-error assertions.
No production code, timeout, concurrency, retry or skip change is authorized.
Finish requires full validation and green checks on the pushed #108 head.
Active CLI work, PR #106, Factory and merge/release remain outside this repair.

Focused Node 22 proof passed all 19 export-owner tests. Full Node 22 validation
passed typecheck, ESLint, formatting and all 952 tests in 66 files. Local patch
review retained all original contracts and added saved-path preservation.
The external autoreview helper was blocked by automatic approval review because
its repository payload and model-service destination were not authorized for
this repair; no alternative external transport was used. CI remains the final
authority after the scoped push.

## Public Factory installation, 29 October 2026

User authorized an exact public install route through Vana's bundled Factory
instructions and a released CLI with a fresh-agent synthetic acceptance. This
worktree is isolated from active CLI work and #106. No real-provider reads.

Factory's core will be a licensed, public, versioned release tarball containing
its executable, instructions and checks. The private Factory repository remains
private. A public npm registry listing is not available with current credentials;
this must remain distinct from successful public tarball installation.

The existing current-agent job/check/collection flow remains unchanged. Vana's
instructions name the exact public artifact and Node/checkout requirements.
Parent owns delivery and the independent public-only acceptance after release.

The public-guidance regression failed before repair. All 45 focused tests then
passed, followed by full typecheck, ESLint, formatting and 952 tests in 66 files.
The built CLI exposes its offline instructions even when Factory is absent.
Instructions name the exact public factory-core 0.0.1 release artifact and the
real Node 24 / public upstream setup requirements. Publication, fresh-agent
public-only collection and acceptance evidence remain parent-owned.

The CLI publisher already has a working npm credential inside GitHub Actions.
Add a manual Factory publication job using that existing secret, the exact
public tarball and its pinned SHA256. It cannot publish an arbitrary URL or
artifact. No credential is extracted. Namespace permissions may still prevent
this registry listing; the public tarball remains independently installable.

PR CI exposed a preexisting registry test's unintended GitHub metadata fetch.
A rejecting fetch guard plus no-call assertion failed on that exact request.
Supplying the missing local metadata fixture repairs it without production or
timeout changes. All twelve registry tests pass under Node 26 and Node 24,
including the explicit offline failure cases. The same guard now catches any
future fixture omission instead of silently relying on the external network.

Final combined CLI validation passes typecheck, ESLint, formatting and all 952
tests. The public tarball was downloaded anonymously and installed with private
checkout/config reads denied; its capabilities report version 0.0.1 and supported
API/export routes. The downloaded hash matches the frozen licensed artifact.

## Exact public compatibility patch guidance

The public-only acceptance found a supported-schema gap after installation,
preparation and all static checks passed. Factory 0.0.2 will enforce the standard
minLength and boolean additionalProperties assertions used by the valid public
manifest. Update only the exact public install pin and bounded schema guidance,
then release through the existing route. Preserve the connector's constraints;
no weakening of verification or provider access is authorized.

The existing npm credential rejected the @vana namespace. Public tarball
installation works independently. Update the manual publisher's pinned artifact
and hash for the new version, but do not repeat registry publication without a
permission change. Active CLI and #106 remain outside both isolated trees.

The exact public-pin regression failed before repair. All 45 focused CLI tests,
full validation (952 tests, typecheck, ESLint and formatting), build and emitted
instruction JSON now pass. The candidate package SHA256 is
089a528f4a7a302d2dae9a0724e4b25f62ada14c61eb7728507c4139875a30d9.
The manual publisher points at only that exact patch artifact; it will not be
rerun while the npm namespace permission remains unchanged.

## BUI-938 CLI release

The user clarified the deployment boundary: publish a normal stable CLI containing BUI-938 and the latest Factory tools; Account and Web remain on dev. Remove the temporary CLI dev-prerelease workflow changes. The combined CLI passes 974 tests, types, lint/format and package checks. The existing demo's registration and free fake-data read both passed through the published candidate. Promote the CLI only through its normal main release workflow; do not promote Unity/Account or Personal Server main. Demo commands select VANA_ENV=dev. BUI-945 is not a prerequisite for own-app free reads.

## Approved five-screen onboarding delivery

Finish and ship only the approved welcome, searchable 12-row source picker, missing-source name, connector decision and guide handoff. Start from v0.46.0; preserve its public Factory 0.0.2 workflow and BUI-938. Do not merge #106's funding or collection-readiness work. Interactive standalone installation opens bare `vana` via the controlling terminal; automated installs skip prompts. Skills are bundled without installing into agent harnesses; the advertised optional setup uses existing explicit skill selection. Proof must exercise a fresh installer and all five actual terminal screens, including clean exit with guide visible.

Proof: fresh piped standalone install in a disposable home reached welcome, source picker, Ctrl+O source-name input, Readwise connector decision and canonical Factory guide, then exited 0 with output retained. The first test reproduced the remaining forced-help entry override before repair. Full validation passes 976 tests; CLI preflight uses browser/network-blocked fixtures and passes. Packaging checks require the bundled current Factory guide. Structured Codex closeout review is clean at P0 (0.96). Funding/app commands, Factory adapter and the current Create Connector instructions have no diff from v0.46.0. Delivery is the scoped onboarding PR and normal stable release; #106's funding work stays unmerged.
