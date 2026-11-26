---
name: verify-server-supervision
description: Verify the local Personal Server stop and restart boundary. Use when changing the supervisor's backoff, port probing, replacement launch or Stop handling.
---

# Verify local Personal Server supervision

Read the [transition map, bounds and known finding](../../../verification/server-supervision/README.md).
The production source and owner replay were reconciled at
`a55d0a0006da6a743b6452796435afa6ed177dd8`. The [checker](../../../verification/server-supervision/check.py)
pins their exact Git blobs and requires the named TLC verdicts and CLI events.

Use Python 3.12 or newer, the installed Node and Vitest, and pinned TLC 1.7.4
with Java. Set `TLA2TOOLS` and `JAVA` to installed paths if mise cannot locate
them. Run from the CLI root.

```sh
python3 verification/server-supervision/check.py --out "$(mktemp -d)/proof"
```

The current port-probe model and route replay show a late restart. The known
finding must reproduce. The backoff property must hold. The scratch control
removing its fence must fail on a restart event. The scratch port fence must
prevent that event, and the restored source must reproduce both original
results. The replay uses controlled handles and starts no Personal Server.

Read every outcome with Pstack `/statechart`. After a code change, reconcile
the source, the model's await boundaries and the exact replay before moving
the pinned revision. If the port-probe finding is repaired, change its
expected verdict only after showing the old path fail and the new path pass.
