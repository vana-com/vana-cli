---
name: verify-mainnet-registration
description: Verify mainnet app registration and Account association recovery. Use for the registration journal, gateway confirmation, retry, or ownership check.
---

# Verify mainnet app registration

Read the [transition map, bounds and replay](../../../verification/mainnet-registration/README.md).
The [checker](../../../verification/mainnet-registration/check.py) pins the reviewed
source from CLI main `a55d0a0006da6a743b6452796435afa6ed177dd8`.

Persist the original registration context before the first gateway request.
Require a matching confirmed app before associating it with Account, and
confirm Account ownership before clearing the recovery journal.

Use Python 3.12 or newer, installed Node and Vitest, and pinned TLC 1.7.4 with
Java. Set `TLA2TOOLS` and `JAVA` if mise cannot locate them. Run from the CLI root.

```sh
python3 verification/mainnet-registration/check.py
```

Require the current model and real-command replays to pass. The checker must
observe every named model violation, catch its scratch source mutant, restore
the source, and pass the baseline again. Read all outcomes with Pstack
`/statechart`. Update the pinned source only after rechecking the model's
journal, remote confirmation, and Account ownership boundaries.
