---
name: builder
description: >
  Get a person's permission to use their data, then read it and pay for it,
  from the terminal. Use when: (1) an app or agent needs data that belongs
  to someone else, (2) the user says "ask them for access", "read their
  Spotify", "what did they approve", (3) anything involving a Vana grant,
  escrow, or a data-access fee. Not for collecting your own data, that is
  the connect-data skill.
---

# Builder

The `vana app` command group is the builder side of Vana: register once,
ask a person for access, read what they approved, pay the fee from escrow.
Every command takes `--json` and returns one outcome object; branch on the
exit code, read `code` for the reason and `remedy` for the next command.

## The loop

```bash
vana app register                                  # once per machine
vana app request --scopes spotify.history          # ask a person
vana app read spotify.history --grant <id> --pay   # read and pay
```

Or ask a question instead of reading raw data, in one command:

```bash
vana app ask "Which genres did they listen to most this month?" \
  --sources spotify.history --derived myapp.genres --pay
```

`request` prints an approval URL and waits. The person opens it, approves,
and the grant id comes back to the terminal. Nothing else in the loop needs
a browser.

## Exit codes

Branch on these instead of parsing text.

| Code | Meaning                             | What to do                                                          |
| ---- | ----------------------------------- | ------------------------------------------------------------------- |
| 0    | done                                | continue                                                            |
| 1    | failed                              | read `message`, do not retry blindly                                |
| 2    | bad usage                           | fix the command                                                     |
| 3    | no grant, or it does not cover this | `vana app request` again                                            |
| 4    | payment required                    | add `--pay`, or fund escrow                                         |
| 5    | no server answered                  | the owner's Personal Server is offline; not your fault, retry later |
| 6    | not ready yet                       | wait and repeat, using any interval the payload names               |
| 7    | a person has to act                 | surface the URL to a human                                          |

## Asking for access

```bash
vana app request --scopes spotify.history,spotify.playlists --json
```

Waits up to ten minutes by default (`--timeout <seconds>`). On approval the
outcome carries `grantId` and the exact read command in `remedy`.

When no human is watching the terminal, do not block:

```bash
vana app request --scopes spotify.history --no-input --json
```

That exits **7** immediately with `approvalUrl` in the payload. Hand the URL
to the person however you can, then come back later:

```bash
vana app requests list --json            # find the id you did not keep
vana app requests show dcr_... --json    # did they approve yet?
```

`show` refreshes from the service and writes the result down, so once it
reports a `grantId` that id stays available offline.

## Asking a question instead of reading raw data

Prefer this when you want an answer rather than a dataset. The question is
computed on the person's own server over sources **your app never reads**;
you end up holding a grant on the answer only.

```bash
vana app ask "Which genres did they listen to most this month?" \
  --sources spotify.history \
  --derived myapp.genres \
  --pay --json
```

`ask` runs the whole path for you: it asks the person (same approval URL
and `--no-input` behavior as `request`), waits for the answer to settle,
then reads it. The derived scope must be in your own namespace, never
sharing a first segment with a source.

Two commands let you drive the same path by hand:

```bash
vana app status myapp.genres --json     # is the answer coming, and when
vana app lineage myapp.genres --json    # what it was computed from
```

`status` finds the grant and server from your own request history, so you
do not have to keep ids around. Its states map onto the exit codes: exit 6
means pending or recomputing, and the payload names the interval the server
wants you to wait; exit 0 means ready and the remedy is the read command.

**Do not poll `status` in a tight loop.** It is free to you and it can
trigger a recompute, which spends inference budget without reading
anything. Use the interval the server names.

### What it costs

Two separate costs, reported separately:

- the compute itself reports `computeCost: null`, which means **unpriced,
  not free**; treat a number appearing there as a normal change
- reading the derived scope is an ordinary billable read, with the same
  `--pay` and `--max-fee` gates as any other read

## Reading

```bash
vana app read spotify.history --grant 0x... --json
```

Without `--pay` a priced read stops at exit **4** and tells you the cost, so
you always see the price before spending:

```json
{
  "code": "payment_required",
  "message": "This read costs 0.01 USDC.e and --pay is not set."
}
```

Add `--pay` to settle it from escrow, and `--max-fee` to refuse anything
above a limit. **The limit is in the fee's own asset**, which is not always
VANA: on mainnet a data-access fee is quoted in USDC.e.

```bash
vana app read spotify.history --grant 0x... --pay --max-fee 0.05 --json
```

Two things worth knowing:

- The fee settles **before** data is served, so a blind retry after a
  failure can pay twice. The CLI stores the signed payment header and
  replays it, so re-running a failed read does not settle a second fee.
  Never work around this by looping.
- In human mode the data goes to stdout alone and the summary to stderr, so
  `vana app read ... | jq` is clean.

## Two delivery paths, one command

Some owners serve their data from a Personal Server they run; others from a
TEE sandbox reached through the gateway's job queue. **You never choose.**
`read` takes the path the access request reports and handles both.

What differs, if you see it in the output:

- `delivery: "personal_server"` can cost a fee and produces a receipt
- `delivery: "enclave"` reports `paid: false`, because the gateway currently
  admits those jobs at zero price; that is a protocol state, not a promise
  that enclave reads stay free
- an enclave read can return exit 6 while the owner's sandbox wakes, which
  takes seconds. Run the same command again rather than treating it as a
  failure

## Paying

```bash
vana app escrow balance --json
vana app escrow fund --amount 1 --json                      # native VANA
vana app escrow fund --amount 5 --asset 0xF1815... --json    # an ERC20
```

Fund the asset the reads are actually priced in, which the exit-4 payload
names as `asset`. On mainnet, funding requires `--yes` and spends real
money.

## Checking your work

```bash
vana app whoami --json                                   # who am I, registered?
vana app onchain spotify.history --owner 0x... --json    # version, hashes, deletion
```

## Networks

Everything defaults to **moksha**, the testnet, where fees are play money.
Pass `--network mainnet` deliberately, never by habit.

## Failure notes an agent gets wrong

- Exit 5 with `owner_not_ready` means the person never finished setting up
  a Personal Server. Retrying cannot fix it; they have to act.
- Exit 5 otherwise means their server is offline right now. The CLI already
  tried every server they registered.
- Exit 6 is normal, not a failure. Wait and repeat.
- A denied request is exit 3 and is final. Do not re-ask in a loop.
- `ask` stops at whatever `request` returned. Exit 7 there means the person
  has not approved yet, not that anything failed.
- A derivative that fails with `source_missing` (exit 5) means the person
  has not connected a source yet. Retrying will not change that.
