---
name: verify-paid-read-recovery
description: Verify interrupted and overlapping CLI paid reads, receipt-file writers and dead-owner recovery. Use when changing src/cli/app/read.ts, src/core/receipts.ts or src/core/receipts-lock.ts. Runs TLA+ models and offline real-code replays without live paid reads.
---

# Verify paid-read recovery

The promise: an interrupted or overlapping read retains the exact payment
identity needed to resume, without authorizing another payment for the same read
intent. A concurrent state update must not erase a saved receipt.

## Source record

Last confirmed source commit: `a55d0a0006da6a743b6452796435afa6ed177dd8`. The runner records the exact source blobs and rejects drift.

| Owner                                                                             | Coverage                                                                                                                                                                                                                               |
| --------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/cli/app/read.ts`, `runAppRead` and `runPersonalServerRead`                   | Acquire the intent lock before loading saved state; retain it through signing, persistence, transport and error handling. Replay exact headers and refuse rejected-receipt replacement. Contention uses existing `not_ready` / exit 6. |
| `src/core/receipts.ts`, `withReadLock`, `nextNonce`, `saveReceipt`, `dropReceipt` | Intent exclusion and writer exclusion around the complete file read/modify/write. Preserve temporary-file fsync, rename and directory fsync.                                                                                           |
| `src/core/receipts-lock.ts`, `acquireReceiptLock`                                 | Atomic publication of an identified owner; retain live/unknown owners, reclaim demonstrably dead ones, and preserve successor locks.                                                                                                   |
| SDK 4.3.1 direct read/payment helpers                                             | Real fixture signing and request construction. One signed header is reused across transport retries.                                                                                                                                   |

## Run

From the repo root with installed dependencies, Python 3.12+, compatible Node,
TLC 1.7.4 and Java installed through mise:

```sh
python3 verification/paid-read-recovery/check.py
```

The runner exports the recorded fixed commit and overlays only the named
working-tree source owners and regression tests. Expected blob identities prevent
silent source/model drift. `--ref` checks a committed revision instead; it still
must match the checked source blobs. No branch switch or product mutation occurs
in the working checkout. `TLA2TOOLS` and `JAVA` may select existing local tools;
the TLC jar hash is pinned and no dependencies are downloaded.

The command runs four fixed models, four negative models, the real-code tests,
four deliberate source mutations in a disposable copy, then restores all source
bytes and reruns the baseline. It prints the evidence directory. Exit 0 means all
expected positive and negative results hold; exit 2 means an execution or proof
failure. Unexpected external fetches are rejected. Java may need permission for
its local management socket.

## Read every model with /statechart

Use pstack **`/statechart`**, with the Codex adapter when applicable. Follow the
installed skill's current runtime instructions and use a scratch folder outside
the repository. The copied model is `PaidRead.tla`, with `overview.mjs` as the
view and these configurations:

- `single.cfg`: one reader, one crash/restart.
- `concurrent.cfg`: two readers, no crash.
- `writers.cfg`: one reader plus an independent nonce writer sharing the file.
- `concurrent-crash.cfg`: two readers, one crash/restart.
- `no-save.cfg`, `no-refusal.cfg`, `no-read-lock.cfg`, `no-write-lock.cfg`:
  deliberately removed protections. Each must break its original invariant.

`DurableBeforeSend`, `NoDuplicateCharge`, `RejectedNeverReauthorizes` and
`NoDeadlock` must hold in every fixed configuration. The supplied report records
state counts, counterexamples and exact guard mutations. A passing reproduction
test never substitutes for a passing invariant check.

## Real-code owner proof

`test/cli/app-read-loop.test.ts` owns saved-header recovery, rejected receipts,
store corruption/persistence failure, competing writes and overlapping reads.
`test/core/receipts-lock.test.ts` covers unknown owners and the stale-reclaimer
race. Avoid copying these contracts into another fixture test.

The process fixture independently exercises abrupt exits after nonce persistence,
before receipt rename, after persistence, after send and after simulated
settlement. It also blocks a second process behind a live reader, kills that
reader and checks exact-payment recovery. Real SDK signing runs on a public test
key and synthetic data. Transport and settlement are local fixtures.

Removing pre-send save or rejection refusal must fail the existing owner tests.
Removing the read lock must fail the overlap test; removing the writer lock must
fail the competing-write test. Restore every mutation and confirm the baseline
passes again. Do not weaken the invariant to make a control pass.

## Bounds and maintenance

The fixed models cover one payer, network, grant, scope and a fixed supported
legacy grant-fee challenge. Successful signing and rename durability after process
exit are assumed. Lock acquisition abstracts the successful atomic directory
rename; process death makes its lock reclaimable. Unknown owners, PID reuse and
inaccessible owner processes fail closed in the implementation. The actual lock
recovery and successor race also have real-code proof.

Real gateway/chain deduplication, live escrow, access records, server-supplied
nonces, expiry, power loss, remote filesystems and arbitrary numbers of readers
are outside this proof. There is no liveness proof. The 1,654-state passing crash
case exceeds the chart budget, so `/statechart` emits only its passing report.

When an owner changes, read its entire relevant path and update the model from
the code before changing expected blobs. Keep file reads, renames and releases
separate where the code separates them. Use `/maintain-formal-verification-skill`
for skipped verification updates. Follow the updated skill once as the next agent
would, including all negative controls. Keep product and verification changes
reviewable separately; no commit or publication is implied.

See `verification/paid-read-recovery/README.md` for the result.
Do not retrieve credentials or run live paid reads as part of this procedure.
