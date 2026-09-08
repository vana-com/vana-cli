# CLI Exit Code Matrix

_Updated September 8, 2026 — replaces the March 14, 2026 contract._

One table for the whole binary. The previous contract (0/1 only, bad usage
inheriting commander's 1) and the never-implemented 2-5 set that used to be
described in CLI-AGENT-FRIENDLY.md are both replaced by this table. Anything
that branched on `exit == 1` should re-check: bad usage now exits `2`, and
statuses with a distinct slot below stop returning `1` as they are wired in.

| Code | Meaning                                         | What it replaces                     |
| ---- | ----------------------------------------------- | ------------------------------------ |
| 0    | done                                            | nothing, it already meant this       |
| 1    | failed                                          | every failure the binary had         |
| 2    | bad usage                                       | commander's 1; old docs' needs_input |
| 3    | no grant, or the grant does not cover this      | old docs' setup_required             |
| 4    | payment required and not settled                | old docs' auth_failed                |
| 5    | no server holding this data answered            | old docs' connector_unavailable      |
| 6    | not ready yet, come back                        | new                                  |
| 7    | a person has to confirm before this can proceed | new                                  |

Source of truth in code: `src/core/exit-codes.ts` (`CliExitCode`,
`exitCodeForOutcome`, `exitCodeForProtocolCode`). The JSON outcome's `code`
field carries the finer-grained reason (`owner_not_ready`, `grant_revoked`,
`max_fee_exceeded`, ...); the exit code is the coarse branch for shells.

## What is wired today

- Usage errors — unknown command, unknown option, missing or invalid
  argument — exit `2` (commander errors are mapped centrally in
  `src/cli/index.ts`).
- `--help` / `--version` exit `0`.
- Owner-side command failures still return `1` until each command adopts
  `exitCodeForOutcome`; the mapping for their statuses is:
  `personal_server_unavailable -> 5`, `needs_input -> 7`, success -> `0`,
  everything else `1`.
- The builder command group (`vana app ...`) emits through the mapper from
  its first release.

## Notes for agents

- Branch on the exit code for control flow, read the JSON `code` for the
  reason and the `remedy` for the next command to run.
- Exit `5` can carry `code: "owner_not_ready"` — the owner has never
  finished Personal Server setup; retrying does not help, a person must
  complete setup in the web app.
- Exit `6` means retry later; when the payload names a poll interval, use
  that instead of your own.
- No failure code is documented as safe to retry blindly: on the paid read
  path a retry can settle a second fee (see the receipts cache).
