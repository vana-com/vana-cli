---
name: verify-collection-admission
description: Verify CLI collection admission across identity, Personal Server approval and foreign-server confirmation. Use for collection readiness or its identity recheck.
---

# Verify collection admission

Read the [transition map, bounds and scratch controls](../../../verification/collection-admission/README.md).
The [checker](../../../verification/collection-admission/check.py) pins the
covered source and replay from main `a55d0a0006da6a743b6452796435afa6ed177dd8`.

Automated collection must refuse another account's server before probing
credentials. A late approval response must not admit collection for an
account that changed while preparation was pending.

Use Python 3.12 or newer, installed Node and Vitest, and pinned TLC 1.7.4
with Java. Set `TLA2TOOLS` and `JAVA` to installed paths. Run from the CLI root.

```sh
python3 verification/collection-admission/check.py --out "$(mktemp -d)/proof"
```

Require the current config and offline replay to pass. The named broken
configurations and their scratch source changes must fail on their intended
contracts. Read every outcome with Pstack `/statechart`. Reconcile new awaits
and owner boundaries before advancing the source pins.
