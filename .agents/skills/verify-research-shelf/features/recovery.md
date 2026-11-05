# Recover saved work

## Sub-features

- Recover the committed revision after page reload and server restart.
- Retry confirmation without another read or payment.
- Detect lost durable state instead of declaring complete delivery.
- Preserve saved content when a fresh read fails.

## How to get to it (user POV)

Return to the connection after interruption. Use its specific confirmation retry
when acknowledgement fails. A deliberately fresh read uses **Read latest**.

## Driving it with the verifier

Run the ordinary controlled command, then the four `--negative-control` cases from
the parent skill. The controls fault isolated storage, acknowledgement and read boundaries while retaining the same success assertions. Require the matching failure diagnosis from actual Motel query results as well as the independent failed product assertion. Require recorded fault activation, nonzero at the intended
claim and complete cleanup. Run the ordinary command again in a new directory.

The example README owns focused route tests for payment caps, interrupted reads
and acknowledgement-only retry. Record deterministic tests separately from actual
browser observations. Mark a recovery clause blocked if neither a selected
browser case nor its named deterministic test ran.

## Gotchas

Faults affect only the helper's store. Preserve user connection files, payment
history and locks. Lost-response fixtures cannot prove live service retention or
replay guarantees. Service uncertainty does not authorize a replacement payment.
