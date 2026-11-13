# Hosted server provisioning and deletion

**Bug and tracking issue.** The bug is in the Connect web app (the `connect/`
directory), not in the CLI command code. If a signed API request deletes a
hosted server while it is still being set up, the record is removed but the
virtual machine, disk, tunnel and DNS record are still created. The owner was
told the server was deleted, and those resources existed untracked.
Tracked in [BUI-1010](https://linear.app/vana-team/issue/BUI-1010). The replay
uses a fake provider and an in-memory store. Nothing was checked against the
live deployment.

**Fixed: the create path.** When the create request finds its row gone after
the provider returns, it now deprovisions what it just created and answers 409
`conflict_error`, without storing the control-plane token. If that cleanup
throws, it logs the server, provider, tunnel and DNS ids and answers 500 naming
them, because there is no row left to mark. Before the fix it fell back to its
stale copy of the row and answered 201.

**Fixed: the delete path.** A delete that read a row with no handles used to
call `deleteServer` unconditionally. If the create saved its handles between
that read and the delete, the create answered 201 and the row was removed with
the resources untracked. The delete now removes such a row only if it still has
no provider handles (`deleteServerIfNoProviderHandles`). If it removed nothing
it reads the row once more. A row that is gone answers as a normal delete. A
row that now has handles goes through the existing cleanup: deprovision, mark
`deprovision_failed` on failure, then delete. The two windows end consistently.
Either the delete removed an untracked row and the create cleaned up and
answered 409, or the create saved its handles and answered 201 and the delete
deprovisioned them.

**Still open.** A create killed at its 60-second limit. The row stays
`provisioning` with no provider handles, and whatever the provider had already
created is recorded nowhere. Deleting that row removes the row and leaves the
resources. Neither the model nor the replay covers this. The row must stay
deletable, so the delete does not refuse while provisioning.

The normal [server page](../../connect/src/app/server/page.tsx) hides Remove
Server while provisioning. The authenticated API still allows it. A signed
owner can list the provisioning record and send its ID to DELETE directly.
This is a source and controlled-route finding. Deployment exposure and live
cloud resources were outside the replay.

## Source and model

The runner pins the blob hashes of the checked source and replays the working
tree. `--ref` checks a named revision instead if its blobs match. The create
and delete routes as they were at main
`a55d0a0006da6a743b6452796435afa6ed177dd8` are kept as the legacy witnesses.

| Action                   | Source boundary                                                                                                                                                                                                                                                                                                                                                 |
| ------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Reserve and list         | [Server collection route](../../connect/src/app/api/servers/route.ts) inserts a provisioning row without handles before it awaits the provider. The owner can list this row while the POST waits.                                                                                                                                                               |
| Read for deletion        | [Server item route](../../connect/src/app/api/servers/%5Bid%5D/route.ts) checks the owner and starts provider cleanup only if the row snapshot has a VM, tunnel or DNS handle.                                                                                                                                                                                  |
| Delete the row           | The item route awaits cleanup when it found handles. Otherwise it calls [`deleteServerIfNoProviderHandles`](../../connect/src/lib/db/neon.ts), which removes the row only if it still has no handles, and returns success. If that removed nothing it reads the row once more and either returns success for a missing row or cleans up the handles it now has. |
| Publish provider handles | The collection route writes provider handles. [The store](../../connect/src/lib/db/neon.ts) returns null when the row is missing. On null the route deprovisions the handles it was given and answers 409, or 500 if that fails. Otherwise it stores the control-plane token and returns 201.                                                                   |

TLC checks one owner, one hosted server, one creation, and one deletion.
Reservation, provider reply, handle publication and response are separate steps.
The model assumes successful provider calls and a surviving resource after
provider success. It leaves out retries, partial provider cleanup, database
failures, a second create, a create killed by its time limit, and the network
and chain lifecycle. The replay substitutes an in-memory database and provider.
It holds the reservation response, after the row is visible, or the provider
response, or the delete route's row read.
It uses the actual route handlers and signature recovery with an ephemeral test
wallet. Unexpected external fetch fails.

The `orphaned` variable in the model is history: the create found its row gone
when the provider returned. It separates the window the create route owns from
the one the delete route owns. Two invariants name them:
`CreateNeverSucceedsWithoutRow` for the first and
`CreatedResourceHasTrackingRow`, the whole property, for both.

| Model configuration          | Create path               | Delete path                             | Invariant                       | Expected |
| ---------------------------- | ------------------------- | --------------------------------------- | ------------------------------- | -------- |
| `current`                    | cleans up an orphan       | conditional                             | both                            | passes   |
| `legacy-create`              | answers 201 on a null row | conditional                             | `CreateNeverSucceedsWithoutRow` | violated |
| `stale-delete`               | cleans up an orphan       | unconditional                           | `CreatedResourceHasTrackingRow` | violated |
| `refuse-provisioning-delete` | cleans up an orphan       | conditional, refused while provisioning | `CreatedResourceHasTrackingRow` | passes   |

## Run

Use Python 3.12+, Node and Connect's installed Vitest. The checker uses TLC
1.7.4 and Java, with `TLA2TOOLS` and `JAVA` available as overrides.

```sh
python3 verification/hosted-provisioning/check.py
```

The replay runs three schedules against each of five sources. The schedules
hold the reservation response, the provider response, and the delete route's
row read.

| Source                                | Reservation and provider holds                                                                            | Delete-read hold                                                                  |
| ------------------------------------- | --------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| Fixed routes                          | DELETE 200, POST 409, one deprovision with the ids the provider returned, no token stored, nothing listed | DELETE 200, POST 201, one deprovision with the late handles, nothing listed       |
| Legacy create route (`a55d0a0`)       | DELETE 200, POST 201, no cleanup sent, the resource remains and nothing is listed                         | the same as the fixed routes                                                      |
| Legacy delete route (`a55d0a0`)       | the same as the fixed routes                                                                              | DELETE 200, POST 201, no cleanup sent, the resource remains and nothing is listed |
| Fixed routes and scratch delete guard | DELETE 409, POST 201, provider handles listed                                                             | the same                                                                          |
| Fixed routes, restored                | the fixed outcomes again                                                                                  | the fixed outcomes again                                                          |

Each legacy source reproduces the window its fix closed and shows the replay
tells the old route from the new one. The scratch guard adds a 409 refusal on
DELETE while the row is provisioning. It blocks both windows but would also
block deleting a create killed at its time limit, so it remains in the scratch
replay only. The runner restores each route after every scratch change and
prints the evidence directory. Exit 0 means every model and replay outcome in
the tables was observed.

Read the models with Pstack `/statechart`, using `models/view.mjs` in a
scratch copy. The chart folds internal transitions that leave the display
label unchanged. Reconcile the code, model and expected outcomes if the covered
source changes.
