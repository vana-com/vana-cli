---
name: verify-export-settlement
description: Verify queued export owner binding and generation settlement. Use for result publication, pending upload receipts, or retry and sync changes.
---

# Verify queued export settlement

Read the [transition map, source pins, bounds and replay](../../../verification/export-settlement/README.md).
This proof was reconciled against CLI main `a55d0a0006da6a743b6452796435afa6ed177dd8`
and the integrated main snapshot recorded in its checker.

A late upload must leave the current generation's receipt and visible result
aligned. A foreign collection must preserve pending bytes that belong to
another owner. The proof checks both with TLC 1.7.4 and the built CLI.

Run from the CLI root with Python 3.12 or newer, the installed package
dependencies and Java. Set `TLA2TOOLS` and `JAVA` to installed tool paths.

```sh
python3 verification/export-settlement/check.py
```

Require both current cases and offline CLI replays to pass. Require each
broken case and corresponding scratch source mutation to fail on the intended
contract. Read every TLA+ outcome with Pstack `/statechart`.

When covered source changes, trace publication and settlement at their actual
lock and commit boundaries. Advance the source pins after the checked model,
broken controls and restored replays agree.
