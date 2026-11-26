# BUI-936 setup/resume verification

The current CLI passed the bounded setup/resume checks. No current-code defect
reproduced. Seven passing TLA+ configurations, 61 offline real-code tests and seven
source-mutation controls support that result. Product code is unchanged. The fixtures use synthetic funding and read services.

Checked main source: `a55d0a0006da6a743b6452796435afa6ed177dd8`. The runner records the exact source blobs.

## What holds

| Promise                                                                                              | Invariant                 | Owning implementation                                                                                                              |
| ---------------------------------------------------------------------------------------------------- | ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| Save recovery identity before either POST.                                                           | `DurableBeforePost`       | `src/cli/app/request.ts`: frozen `intent`, `requests.saveIntent`, then `runConsentIntent`.                                         |
| An uncertain funding POST recovers one operation using its original key.                             | `OneFundingOperation`     | `src/cli/app/test-credit.ts`: saved funding UUID; `src/core/test-credit.ts`: POST body.                                            |
| An uncertain consent POST replays the exact original request.                                        | `OneConsentRequest`       | `src/cli/app/request.ts`: `createAccessRequest(intent.input)`.                                                                     |
| Pending funding or a claim link does not authorize consent creation.                                 | `ConsentNeedsReadyCredit` | `prepareTestCredit`, authoritative `updateFunding` result, early `fundingOutcome` return.                                          |
| Changed app, network, environment, endpoint or supplied payload is rejected before resume transport. | `ChangedResumeRejected`   | `runAppRequest`: saved context and `REQUEST_PAYLOAD_OPTIONS` comparison.                                                           |
| Once a funding operation ID is saved, inspect it with GET.                                           | `KnownFundingIsGetOnly`   | `prepareTestCredit` forwards saved ID; `requestTestCredit` selects GET and omits body.                                             |
| A delayed pending response cannot overwrite funded/failed progress.                                  | `TerminalFundingRetained` | `src/core/requests-store.ts`: terminal check within the complete writer-locked read/modify/write; caller adopts returned progress. |

`NoDeadlock` also holds. Stopped/pending/human-action states can stutter; this is
a safety check, not a promise of eventual completion.

## Model bounds and source mapping

The model represents one admitted setup, app, network, environment and opaque
frozen request payload. Funding and consent have separate immutable identities.
There are separate actions for writer acquisition, current-state read, temporary
setup write, atomic publication and release. Atomic rename is the visible commit
point. A process crash can happen between actions, including before/after a
remote acceptance or journal publication. Restart reloads saved context.

| Configuration      | Bound/scenario                                                  | Reachable states | Result |
| ------------------ | --------------------------------------------------------------- | ---------------: | ------ |
| `overview`         | One command, one resume, no process crash                       |              128 | Pass   |
| `single`           | One command, two resumes, one crash                             |              606 | Pass   |
| `concurrent`       | Two commands, one resume each, no crash                         |           13,738 | Pass   |
| `concurrent-crash` | Two commands, one resume each, one crash                        |           33,873 | Pass   |
| `claim`            | Claim required; two resumes, one crash                          |              659 | Pass   |
| `existing-credit`  | Pending existing deposit becomes usable; two resumes, one crash |              553 | Pass   |
| `changed-context`  | Changed context rejected on resume; two resumes, one crash      |               90 | Pass   |

Response loss is separately allowed at either remote acceptance; it does not
consume the process-crash bound. Remote funding can become confirmed or failed.
Consent can remain pending, be approved, denied or expire. A second fresh command
either observes the unfinished setup or loses the admission race under the
journal writer lock. It must explicitly resume the admitted setup.

The TLA+ model stops at the approval-result boundary. It does not model current
grant verification, signed claim construction, exact payload serialization or
schema validation. Existing real-code tests cover those, including refusal to
call an approved grant current when its gateway lookup fails.

The writer-lock primitive is abstracted as exclusion with eventual recovery of
a demonstrably dead owner. Existing real-code tests also exercise interrupted
writers, a stale pre-lock read, a live owner, and preservation of a newer lock
owner. This is not a new proof of the lock algorithm itself.

## Run

Use Python 3.12+, the CLI's installed Node dependencies, Java and TLC 1.7.4.
Set `TLA2TOOLS` and `JAVA` for locally installed tools.

```sh
python3 verification/setup-resume/check.py --out /tmp/vana-cli-setup-resume-proof
```

Use a fresh evidence path. The runner checks the main source at `a55d0a0006da6a743b6452796435afa6ed177dd8`.
It checks current and deliberately broken models, exercises the real code with
synthetic transport, restores the scratch source and repeats the replay.
The output directory contains the individual verdicts and replay logs.

Use Pstack `/statechart` with the configs and view in `models/`.
The [CLI statecharts](../../docs/STATECHARTS.md) show the shorter scenarios.
