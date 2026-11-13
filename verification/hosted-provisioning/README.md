# Hosted server provisioning and deletion

**Bug and tracking issue.** The bug is in the Connect web app (the `connect/`
directory), not in the CLI command code. If a signed API request deletes a
hosted server while it is still being set up, the record is removed but the
virtual machine, disk, tunnel and DNS record are still created. The owner was
told the server was deleted, and those resources now exist untracked.
Tracked in [BUI-1010](https://linear.app/vana-team/issue/BUI-1010). The replay
used a fake provider and an in-memory store. Nothing was checked against the
live deployment.

The current Connect API can acknowledge deletion of a provisioning row, then
acknowledge the original creation after the provider finishes. The successful
create has no row or provider handles left for the owner to find or remove.

The normal [server page](../../connect/src/app/server/page.tsx) hides Remove
Server while provisioning. The authenticated API still allows it. A signed
owner can list the provisioning record and send its ID to DELETE directly.
This is a source and controlled-route finding. Deployment exposure and live
cloud resources were outside the replay.

## Source and model

The runner pins the checked source and replays at main `a55d0a0006da6a743b6452796435afa6ed177dd8`.

| Action                   | Source boundary                                                                                                                                                                                                        |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Reserve and list         | [Server collection route](../../connect/src/app/api/servers/route.ts) inserts a provisioning row without handles before it awaits the provider. The owner can list this row while the POST waits.                      |
| Read for deletion        | [Server item route](../../connect/src/app/api/servers/%5Bid%5D/route.ts) checks the owner and starts provider cleanup only if the row snapshot has a VM, tunnel or DNS handle.                                         |
| Delete the row           | The item route awaits cleanup when it found handles, otherwise it immediately calls `deleteServer` and returns success.                                                                                                |
| Publish provider handles | The collection route writes provider handles and the control-plane token. [The store](../../connect/src/lib/db/neon.ts) returns null when the row is missing. The route falls back to the earlier row and returns 201. |

TLC checks one owner, one hosted server, one creation, and one deletion.
Reservation, provider reply, handle publication and response are separate steps.
The model assumes successful provider calls and a surviving resource after
provider success. It leaves out retries, partial provider cleanup, database
failures, a second create, and the network and chain lifecycle. The replay
substitutes an in-memory database and provider. It holds either the reservation
response, after the row is visible, or the provider response.
It uses the actual route handlers and signature recovery with an ephemeral test
wallet. Unexpected external fetch fails.

## Run

Use Python 3.12+, Node and Connect's installed Vitest. The checker uses TLC
1.7.4 and Java, with `TLA2TOOLS` and `JAVA` available as overrides.

```sh
python3 verification/hosted-provisioning/check.py
```

The current model must violate `CreatedResourceHasTrackingRow`. Its replay
lists the new row and deletes it with HTTP 200 before provider handles exist.
The shortest path holds the DB reply before the provider is invoked. The other
replay holds the provider itself. Both then let creation finish. Create returns HTTP 201, no cleanup was sent and the
owner's listing is empty while the fixture resource remains.

The scratch control adds a 409 refusal while the row is provisioning. Its model
passes and the same replay keeps the provider handles in the list. The runner
restores the original route and reproduces the finding again. It prints the
evidence directory. Exit 0 means the known finding and both replay outcomes were
observed. The guard remains in the scratch replay only.

Read both models with Pstack `/statechart`, using `models/view.mjs` in a
scratch copy. The chart folds internal transitions that leave the display
label unchanged. Reconcile the code, model and expected outcomes if the covered
source changes.
