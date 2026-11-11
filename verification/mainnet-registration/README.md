# Mainnet registration recovery

This check covers `vana app register --network mainnet` after a builder has a
Moksha app owned by their Account. The CLI saves the exact promotion context,
reuses a visible registration after an interrupted response, and waits for a
confirmed proof of the same app before asking Account to associate it.

## Source and model

The runner pins the checked source and replays at main `a55d0a0006da6a743b6452796435afa6ed177dd8`.

| Step                 | Source boundary                                                                                                                                                                                                                         |
| -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Admit existing app   | `runAppRegister` resolves an existing key. `runMainnetRegistration` checks the saved app, account origin, gateway, network, environment, and production metadata. It checks current Account subject and Moksha ownership before saving. |
| Save context         | `createAppRegistrationStore.saveRegistration` compares the existing identity under a writer lock and writes through a temporary file, atomic rename, and directory sync. The model steps at successful return.                          |
| Read then submit     | `runMainnetRegistration` calls `getBuilder` and invokes `registerBuilder` only on an absent result. The model separates a gateway acceptance from whether its response reaches the CLI.                                                 |
| Wait and match proof | `waitForMainnetConfirmation` polls the gateway with GET. It requires a confirmed response and compares its owner, grantee address, key, and app URL before returning.                                                                   |
| Associate and finish | The CLI submits the association proof, checks mainnet ownership for the original Account subject, saves the production profile and clears the matching journal.                                                                         |

The model covers one app, one Account, one frozen production URL and name,
and at most two sequential invocations. It abstracts filesystem publication
as a completed store call. It assumes the gateway lookup sees an accepted
registration when a later invocation starts. If the gateway still reports
absence, the source can submit again. The invariant covers visible records.
The check does not cover overlapping invocations, clock accuracy, the chain's
registration idempotency, signature correctness or delivery by live services.
The owner replays independently check the signed association wire payload,
context mismatch, and no replacement key behavior.

## Run

Use Python 3.12+, Node and the repo's installed Vitest. The checker uses
TLC 1.7.4 and Java, with `TLA2TOOLS` and `JAVA` available as overrides.

```sh
python3 verification/mainnet-registration/check.py
```

The checker verifies the source blobs, runs TLC, and replays the production CLI
command against synthetic gateway and Account responses. It removes each guard
in a temporary source snapshot, checks the selected test fails at its expected
assertion, restores the snapshot, and runs the tests again. The replay uses
fixture state and rejects external fetch. The reported evidence directory
contains raw logs and `summary.json`.

| Control                       | Named violation                  | Observable replay failure                                                                                        |
| ----------------------------- | -------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `no-save-context`             | `ContextSavedBeforeRegistration` | Gateway returns pending until timeout and the expected recovery journal is absent.                               |
| `no-proof-wait`               | `MatchingProofBeforeAssociation` | The command asks Account while the proof is pending. The synthetic Account rejects the association.              |
| `no-proof-identity`           | `MatchingProofBeforeAssociation` | A confirmed proof for a different owner reaches Account. The command reports success instead of refusing it.     |
| `repeat-visible-registration` | `NoPostForVisibleRegistration`   | The first registration reply is lost. A later invocation submits again instead of recovering the visible record. |

Use Pstack `/statechart` on a scratch copy with `models/view.mjs`. The chart
folds polling and proof settlement that leave the person waiting into the
same displayed state. Reconcile the model and tests when the covered code
changes, then update the source record and rerun all controls.
