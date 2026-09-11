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

### Asking a question instead of reading raw data

A request can carry a question whose answer is computed on the person's own
server, so the app never reads the sources:

```bash
vana app request \
  --scopes spotify.history,coach.weekly \
  --question "Which genres did they listen to most this month?" \
  --derived coach.weekly \
  --sources spotify.history \
  --json
```

The derived scope must also appear in `--scopes` as a plain read. The CLI
checks this before sending and tells you if it is missing.

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
