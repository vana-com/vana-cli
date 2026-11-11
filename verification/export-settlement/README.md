# Verify CLI export settlement

A collection can finish while an older upload is still in flight. The local
result path and sync status must belong to the currently accepted receipt.
When a pending export belongs to another account, a competing collector must
keep its result separate and leave the accepted receipt in place.

## Code map

| Model action                             | CLI owner                                                                                                                                                                                                                                                                                                         |
| ---------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `CompleteCollection`                     | `runConnect` in `src/cli/index.ts` receives the runtime's result at its run-specific path and computes the receipt and byte digest.                                                                                                                                                                               |
| `PublishReceipt` and `RefusePublication` | `updateSourceState` in `src/core/state-store.ts` reloads the source slot under the file lock. `pendingExportBlockReason` in `src/core/source-export.ts` refuses replacement of unresolved foreign or unattributed bytes. A successful publish advances the receipt, result path and initial sync status together. |
| `StartUpload` and `ReceiveUploadResult`  | `ingestResult` in `src/personal-server/index.ts` validates the receipt and performs remote I/O outside the source-state lock.                                                                                                                                                                                     |
| `SettleResult` and `RejectStaleResult`   | `runConnect` supplies the receipt ID as `settle`. `updateSourceState` compares it with the accepted ID under the lock before merging the result path and sync status. `syncPendingSources` uses the same guard for deferred sync.                                                                                 |

## Run the check

From the CLI repository root with installed repository dependencies,
Python 3.12 or later, Node 24, Java and TLC 1.7.4:

```sh
python3 verification/export-settlement/check.py
```

The runner verifies the mapped source and replay blobs at main `a55d0a0006da6a743b6452796435afa6ed177dd8`.

Use `TLA2TOOLS` and `JAVA` to select installed binaries, or the runner resolves
them through mise. The TLC jar checksum is pinned. The runner checks the two
normal models and two deliberately broken controls. It exports the pinned
revision to scratch, builds the CLI with installed dependencies, runs both
existing regressions, removes one source guard at a time, and restores the
original bytes before rerunning. The synthetic connector and Personal Server
use test records and loopback HTTP. The scratch replay preserves a Node
preload across the fixture's environment filtering to reject outbound
non-loopback connections. It does not open a browser or start a real server.
Use `--out` for a fresh evidence directory.

Use Pstack `/statechart` with the model files and `view.mjs` in a scratch copy.
The chart combines adjacent steps that keep the same visible receipt and
status. The full TLC verdict comes from the configuration and bounds.

## Invariants and controls

The same-owner configuration explores 100 states. The two-owner configuration
explores 52. Both complete without deadlock. The selected built-CLI assertions
pass before and after both deliberate source mutations on each pinned revision.

| Configuration                         | Rule checked or broken                                                                                                                                                                                                                                                                                                                                                                  |
| ------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `same-owner.cfg` and `two-owners.cfg` | `VisibleResultMatchesReceipt` and `ForeignPendingReceiptPreserved` both hold.                                                                                                                                                                                                                                                                                                           |
| `no-settle-guard.cfg`                 | `VisibleResultMatchesReceipt` breaks. A first export starts uploading, a second export becomes current, then the first upload reports back and overwrites the visible state. The real CLI replay holds the first response until the second export has also uploaded. Removing the comparison lets the first command exit successfully instead of refusing stale settlement with exit 5. |
| `no-publish-guard.cfg`                | `ForeignPendingReceiptPreserved` breaks. Two collectors finish for different accounts. The second replaces the first account's pending receipt. The real CLI replay lets A queue an interrupted upload before it releases B's already-running collector. Removing the pending-export check lets B publish and upload instead of keeping its result separate with exit 5.                |

The model has one source, two distinct run IDs and two collectors that have
already passed collection admission. Each collector produces one result and
gets one success or failure response. An unresolved export is represented by
a local or failed status. A partial upload with failed scopes is treated as
unresolved. The model treats locked publication and settlement as atomic
transitions. It does not prove the lock algorithm, browser or provider
collection, auth, upload order on the Personal Server, visibility of remote
writes, byte hashing, scope merge behavior, legacy receipt migration, process
crash recovery, or liveness. Deferred sync shares the same settlement guard
but its retry, scope selection and upload behavior is outside this check.
