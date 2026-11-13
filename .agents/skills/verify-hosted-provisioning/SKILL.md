---
name: verify-hosted-provisioning
description: Verify hosted Personal Server resource ownership across create and delete. Use for Connect's server API, provisioning-row updates, or deprovisioning admission.
---

# Verify hosted Personal Server provisioning

Read the [transition map, bounds and known finding](../../../verification/hosted-provisioning/README.md).
The [checker](../../../verification/hosted-provisioning/check.py) pins the reviewed
route source and requires the model and offline API replay to agree.

An accepted provider resource needs a durable row with the handles required
for cleanup. A delete during provisioning can race the provider result
before either handle exists.

Use Python 3.12 or newer, installed Node and CLI and Connect dependencies,
and pinned TLC 1.7.4 with Java. Set `TLA2TOOLS` and `JAVA` to installed
paths. Run from the CLI root.

```sh
python3 verification/hosted-provisioning/check.py
```

Read the current counterexample and the scratch-guard outcome with Pstack
`/statechart`. Require the signed route replay to reproduce the current
finding and the scratch guard to block it. Restore the source and rerun.
Reconcile the provider boundary, database state, and observed HTTP outcomes
before moving the source pins.
