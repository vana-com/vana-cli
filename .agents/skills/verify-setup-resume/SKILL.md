---
name: verify-setup-resume
description: Verify BUI-936 setup/resume identities, funding readiness and overlapping resumes. Use when changing app request, test-credit transport or the request journal. Runs bounded TLA+ checks and offline real-code replays without live funding or paid reads.
---

# Verify setup/resume

An interrupted or overlapping setup must recover its saved funding and consent
identities, and must not create consent before credit is usable. Losing an
identity can allocate another operation or leave the original consent stranded.

## Source record

Last confirmed source commit: `a55d0a0006da6a743b6452796435afa6ed177dd8`. The runner records the exact source blobs and rejects drift.

| Owner                                                               | Model and real-code coverage                                                                                                                                                 |
| ------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/cli/app/request.ts`, `runAppRequest`, `runConsentIntent`       | Save frozen setup before transport; reject changed resume context; recover consent using the exact saved payload/key; known requests use status lookup.                      |
| `src/cli/app/test-credit.ts`, `prepareTestCredit`                   | Reuse funding key until operation ID is known; gate consent on usable credit; adopt authoritative journal progress after overlapping responses.                              |
| `src/core/test-credit.ts`, `requestTestCredit`                      | Unknown funding identity uses POST with the saved key; known identity uses GET. Validate returned identity; pending deposits are not spendable credit.                       |
| `src/core/requests-store.ts`, `saveIntent`, `updateFunding`, `save` | Serialize the complete read/modify/write, reject conflicting identities and duplicate unfinished setups, keep terminal funding progress, atomically publish journal updates. |
| `src/cli/app/requests.ts`, `checkGrant`                             | Existing owner tests additionally check resumed approval against the current grant; this stage is outside the TLA+ model.                                                    |

## Run

From the repository root with installed dependencies, Python 3.12+, Node, TLC
1.7.4 and Java installed through mise:

```sh
python3 verification/setup-resume/check.py
```

`TLA2TOOLS` and `JAVA` can select already-installed tools. The TLC jar SHA256 is
pinned; nothing is downloaded. Java may require permission for its local
management socket. `--out` selects a new evidence directory. `--ref` checks a
committed revision with matching source blobs.

The runner exports the pinned commit into a disposable directory, overlays only
the checked working-tree source owners and owner tests, then runs seven positive
models, seven deliberately broken models, real-code replays, seven source
mutations, byte-exact restoration, and the baseline again. It does not change
product files or the Git index. Unexpected global fetches are rejected; the
owner tests inject synthetic Account/gateway transport and use a public test key.
Exit 0 means all expected results hold; exit 2 means execution or proof failed.

## Read every result with /statechart

Use the installed pstack **`/statechart`** skill and the Codex adapter when
applicable. Follow its current runtime instructions in a scratch directory
outside the repository. Copy `verification/setup-resume/models/` there.

- `overview.cfg`: one command, one resume, no process crash; readable chart.
- `single.cfg`: one command, two resumes, one process crash.
- `concurrent.cfg`: two commands, one resume each, no process crash.
- `concurrent-crash.cfg`: two commands, one resume each, one process crash.
- `claim.cfg`, `existing-credit.cfg`, `changed-context.cfg`: claim handoff,
  existing usable/pending credit, and changed context, with two resumes and one
  crash each.
- The other seven configurations deliberately remove one protection each.

Use `overview.mjs` for passing configurations and `details.mjs` for negative
controls. The detailed view keeps both concurrent commands and the individual
journal phases visible. Never suppress a counterexample or merge away the stale
write. Passing graphs above the tool's 500-state budget have reports without
charts. Keep their full bounds; the smaller overview does not replace them.

## Oracles and sensitivity

Keep the existing owner tests in `test/cli/app-test-credit.test.ts` and
`test/cli/app-request-recovery.test.ts`; avoid copying their contracts into a
second suite. The verification-local fixture adds actual write-failure and
overlapping-resume schedules: unknown/known operation, confirmed/failed result,
then a stale pending response. It checks the durable result, transmitted keys,
GET/POST counts, consent count and subsequent recovery.

Each modeled removed protection must also cause a behavioral assertion failure
when removed from real source in the disposable snapshot. The runner checks the
specific invariant for each model, checks test failure rather than a tool error,
restores every source byte, and reruns all 61 tests. A passing replay does not
replace a passing model check. Replay any new model finding against the real
code before reporting it as a defect; first suspect a modeling error when it
does not reproduce. Do not edit product code without authorization.

## Bounds and maintenance

The model covers one app/network/environment/payload and one admitted setup.
Writer lock acquisition, reads, publication and release are separate actions;
atomic journal rename is the publication step. Process death releases the
writer through eventual dead-owner recovery. Individual fsync syscalls, PID
reuse, lock reaper races and power loss are not modeled; existing owner tests
cover interrupted writers and successor-lock preservation.

Account funding and gateway consent deduplicate the same key/body and retain
that mapping for recovery. Returned funding readiness and operation identity are
assumed truthful. These are external service assumptions, not locally proved
facts. Arbitrary client counts, multiple independent contexts, provider rollout,
chain settlement, real escrow, live authentication, paid reads and liveness are
outside this proof. Pending, failed, claim-required, denied and expired outcomes
can remain stopped; the checker does not promise eventual human/service action.

See `verification/setup-resume/README.md` for source mapping, evidence and
counterexample paths. When source changes, inspect the changed path before
updating the model and blob identities. Use `/maintain-formal-verification-skill`
if verification has drifted, then follow this skill once with negative controls
and restoration. No commit, funding, collection or publication is implied.
