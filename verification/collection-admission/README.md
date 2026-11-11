# Collection admission

`prepareCollection` must leave a foreign server unprobed until a person
confirms it. Otherwise the CLI can use a credential for a destination the
person did not authorize. A successful access reply must also still belong to
the bound account when collection is admitted. Otherwise collection can start
under an obsolete owner.

## Source map

The checker pins the owner and replay at main `a55d0a0006da6a743b6452796435afa6ed177dd8`.

| Model action                         | Implementation in [collection-readiness.ts](../../src/cli/collection-readiness.ts)                                                                                                  |
| ------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ReadSession`, `SignIn`              | Read the session, distinguish missing and unknown ownership, and bind the known owner. An interactive run may await one sign-in.                                                    |
| `DetectServer`, `PrepareServer`      | Await destination discovery. An interactive run may prepare a missing server and detect it again. Refuse a missing destination or one that cannot identify its owner.               |
| `DecideForeignConsent`, `StartProbe` | Compare server ownership against the bound account. Only an interactive confirmation allows a foreign target through to `checkAccess`.                                              |
| `ProbeReturns`, `ApproveServer`      | Observe ready, unauthorized or unavailable access. An interactive run may approve once and probe again.                                                                             |
| `AccountChanges`, `VerifyOwner`      | The bounded change occurs while an access check or approval is pending. After successful access, the final session read and owner comparison synchronously choose ready or refusal. |

The model covers one invocation, one bound account, at most one change of
account or session validity during access or approval, one sign-in, one destination preparation and
one approval retry. Session validity and account identity collapse to
"still matches the bound owner" at the final check. A target's reported
owner is stable once detected. The model does not cover exceptions, identity
changes during discovery or after admission, subsequent provider calls, or whether the credentials
used by a live Personal Server actually work.

## Rerun

Use Python 3.12 or later, the installed CLI's Node and Vitest, and TLC 1.7.4
with Java. Set `JAVA` and `TLA2TOOLS` to installed tool paths if mise cannot
resolve them. Run from the CLI repository root.

```sh
python3 verification/collection-admission/check.py --out "$(mktemp -d)/proof"
```

The checker requires the current model to pass and the two broken variants to
fail on their specific invariants. It archives the pinned source into a temporary
directory. It reuses [the seven existing readiness replays](../../test/cli/collection-readiness.test.ts),
substitutes dependencies, blocks external fetches, and runs each source mutation
against its targeted test. It restores the source and reruns all seven replays.

| Deliberate control | Model counterexample and code replay                                                                                                                                                                   |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `no-foreign-guard` | A run finds a foreign server, proceeds without permission and probes it. Removing the foreign refusal causes the automated replay to return ready instead of refusing before access.                   |
| `no-owner-recheck` | A run binds an account, starts an access check, the account changes and the check returns ready. Removing the final session guard makes the existing replay admit collection for the previous account. |

Read the current result and both control paths with Pstack `/statechart`.
The view groups the access check and its single retry, and omits terminal
stuttering. It keeps the two forbidden outcomes distinct. Update the source
pin only after comparing the model actions, guards and restored replay to
the revised owner.
