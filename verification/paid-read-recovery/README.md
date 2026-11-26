# Paid-read concurrency repair — local verification

The repair on main serializes overlapping reads and receipt-file writes. Receipt-file updates now
hold a process-owned lock across the complete read/modify/write. Each read intent
also holds its own lock from loading recovery state through payment and response
handling. An overlapping invocation returns the existing `not_ready` outcome
(exit 6); retrying later reloads the saved header.

All fixed model configurations pass. The real CLI/SDK/store regressions pass,
including abrupt-process recovery. Removing either new lock brings back the
corresponding failure. No live paid reads, credentials, publication or release
were used.

## What changed

| Owner                                                             | Protection                                                                                                                                                                                                                                     |
| ----------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/core/receipts.ts`, `nextNonce`, `saveReceipt`, `dropReceipt` | One writer owns the full file update, including reading the prior state. Temporary write, fsync, rename and directory fsync stay unchanged. A competing writer fails before loading mutable state.                                             |
| `src/core/receipts.ts`, `withReadLock`                            | A receipt-key-specific lock excludes overlapping decisions/payments for the same network, grant and scope.                                                                                                                                     |
| `src/cli/app/read.ts`, `runAppRead`, `runPersonalServerRead`      | Load the saved receipt inside that read lock. Hold it until the read finishes or fails. Contention uses existing exit 6, without another payment attempt.                                                                                      |
| `src/core/receipts-lock.ts`, `acquireReceiptLock`                 | Publish a nonempty owner directory with atomic rename. Reclaim only a lock whose recorded process no longer exists. Invalid, inaccessible or live owners remain blocked. Unique owner filenames keep stale recovery from removing a successor. |

Both positive regressions failed on the original implementation before repair:
competing receipt writes were admitted, and an overlapping read sent another
payment instead of returning exit 6. Their primary owner is
`test/cli/app-read-loop.test.ts`; duplicate discovery-only fixture tests were
removed. `test/core/receipts-lock.test.ts` covers unidentified owners and the
stale-reclaimer/successor race.

The version-1 receipt schema, payment headers and central exit-code table are
unchanged. Contention fails promptly; it does not spin, wait indefinitely, retry
a failed payment or expire a live lock on a timer.

## Formal result: updated and passing

The invariants remain unchanged:

- `DurableBeforeSend`: the exact payment header is retained when it is sent.
- `NoDuplicateCharge`: the simulated server cannot settle two payment identities
  for one fixed read intent.
- `RejectedNeverReauthorizes`: rejection of a saved header cannot authorize a
  replacement payment.

`NoDeadlock` also passes. The model now separates read-lock acquisition, saved
state loading, write-lock acquisition, file reads, temporary writes, renames,
directory fsync and lock release. This follows the implementation rather than
treating a whole store operation as indivisible.

| Fixed configuration    | Bounds                                      | Reached states | Result         |
| ---------------------- | ------------------------------------------- | -------------- | -------------- |
| `single.cfg`           | One reader, one crash/restart               | 96             | All rules hold |
| `concurrent.cfg`       | Two readers, no crash                       | 250            | All rules hold |
| `writers.cfg`          | One reader plus an independent nonce writer | 219            | All rules hold |
| `concurrent-crash.cfg` | Two readers, one crash/restart              | 1,654          | All rules hold |

The independent writer case ensures that the read lock alone cannot mask the
file-update defect. The crash case releases model ownership after process death;
real-code child-process tests check that dead owner directories can be reclaimed.
No invariant was weakened and the earlier bounds were retained; the writer and
concurrent-crash cases add coverage.

## Run

Use Python 3.12+, the CLI's installed Node dependencies, Java and TLC 1.7.4.
Set `TLA2TOOLS` and `JAVA` for locally installed tools.

```sh
python3 verification/paid-read-recovery/check.py --out /tmp/vana-cli-paid-read-recovery-proof
```

Use a fresh evidence path. The runner checks the main source at `a55d0a0006da6a743b6452796435afa6ed177dd8`.
It checks current and deliberately broken models, exercises the real code with
synthetic transport, restores the scratch source and repeats the replay.
The output directory contains the individual verdicts and replay logs.

Use Pstack `/statechart` with the configs and view in `models/`.
The [CLI statecharts](../../docs/STATECHARTS.md) show the shorter scenarios.
