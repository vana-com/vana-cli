---
name: builder
description: >
  Get permission for an app or agent to use a person's Vana data, read it,
  and verify the requested result. Use for consuming-app integration,
  including the developer's own collected data, grants, escrow, fees,
  saved app delivery and connector iteration. Source collection belongs
  to connect-data.
---

# Builder

The `vana app` command group is the builder side of Vana: register once,
ask a person for access, read what they approved, pay the fee from escrow.
Every command takes `--json` and returns one outcome object; branch on the
exit code, read `code` for the reason and `remedy` for the next command.

Start from the person's intended result and continue through the app handoff
and verification they requested. Select the commands yourself; the person
handles account choices, sign-in, consent and any spending decision. Use the
intended app's existing backend key, owner, Account deployment and network.
An app name does not select its credentials. Keep keys server-side and out of
chat, browser code and saved reports.

For an app integration, read [delivery and verification](reference/verification.md)
before requesting access. It covers readiness, real approval, bounded reads,
durable storage, display, recovery and same-grant iteration for any consumer.
The instructions and required references are public. The user's app supplies
its own storage and UI; no reference app or observability service is required.

## The loop

```bash
vana app register --app-name "<your name>"             # once per machine
vana app request --scopes spotify.savedTracks          # ask a person
vana app read spotify.savedTracks --grant <id> --pay   # read and pay
```

Check `vana app whoami --json` first and reuse an appropriate registration.
Register with the name the person should see on the approval page, such as
your agent's name. The CLI remembers it for this app key; without it the
request shows as "Vana CLI".

Or ask a question instead of reading raw data, in one command:

```bash
vana app ask "Which genres fill their saved tracks?" \
  --sources spotify.savedTracks --derived myapp.genres --pay
```

`request` prints an approval URL and waits. The person opens it, approves,
and the grant id comes back to the terminal. The read command returns data;
an app integration must also verify its own save and display.
The `--pay` examples require an agreed fee-asset limit before execution.

## Exit codes

Branch on these instead of parsing text.

| Code | Meaning                             | What to do                                                             |
| ---- | ----------------------------------- | ---------------------------------------------------------------------- |
| 0    | done                                | continue                                                               |
| 1    | failed                              | read `message`, do not retry blindly                                   |
| 2    | bad usage                           | fix the command                                                        |
| 3    | no grant, or it does not cover this | `vana app request` again                                               |
| 4    | payment required                    | inspect the quote and obtain a spending limit before paying or funding |
| 5    | no server answered                  | the owner's Personal Server is offline; not your fault, retry later    |
| 6    | not ready yet                       | wait and repeat, using any interval the payload names                  |
| 7    | a person has to act                 | surface the URL to a human                                             |

## Asking for access

```bash
vana app request --scopes spotify.savedTracks,spotify.playlists --json
```

Waits up to ten minutes by default (`--timeout <seconds>`). On approval the
outcome carries `grantId` and the exact read command in `remedy`.

One grant per owner and app: an approval replaces the grant's scopes, it
does not add a second grant. So when this machine already holds an approval
for the app key, `request` reads that live grant and asks for the union, and
prints what it keeps, adds and removes before creating the request. Give up
a scope with `--remove-scopes a,b`; pick whose grant to extend with
`--owner <address>` when more than one person approved; send `--scopes`
verbatim with `--no-merge-grant`. `--json` carries `kept`, `added`,
`removed`, `removeScopes` and `grantUnion.status` (`merged`, `no_live_grant`,
`owner_unknown`, `owner_ambiguous`, `disabled`, `unavailable`). With no
earlier approval the person is unknown until they approve, and the approval
page keeps what they already granted. `--remove-scopes` is always sent, even
when the live grant could not be read; then it prints as "Removing (if
shared)" and the approval page drops those entries if the grant holds them.

When no human is watching the terminal, do not block:

```bash
vana app request --scopes spotify.savedTracks --no-input --json
```

That exits **7** immediately with `approvalUrl` in the payload. Hand the URL
to the person however you can, then come back later:

```bash
vana app requests list --json            # find the id you did not keep
vana app requests show dcr_... --json    # did they approve yet?
```

`show` refreshes from the service and writes the result down, so once it
reports a `grantId` that id stays available offline. Both commands check
each grant at the gateway: `data.grant.state` is `revoked` or `replaced`
(one grant per owner and app, so a later approval replaces its scopes) when
it no longer holds, and `unverified` when the gateway did not answer.

If creation was interrupted, use the saved recovery command instead of
creating another request. Builds with `request --resume` expose the saved
setup ID through `vana app requests list --json`. Check `vana app request --help`
before using the option on an older installed CLI. Resume preserves the app,
environment, network and original payload; an unavailable service does not
authorize a replacement request or another payment.

## Asking a question instead of reading raw data

Prefer this when you want an answer rather than a dataset. The question is
computed on the person's own server over sources **your app never reads**;
you end up holding a grant on the answer only.

```bash
vana app ask "Which genres fill their saved tracks?" \
  --sources spotify.savedTracks \
  --derived myapp.genres \
  --pay --json
```

`ask` runs the whole path for you: it asks the person (same approval URL
and `--no-input` behavior as `request`), waits for the answer to settle,
then reads it. The derived scope must be in your own namespace, never
sharing a first segment with a source. Both `--sources` and `--derived` are
required. The request grants the derived scope only; the sources go to the
person's server as the question's inputs, so `app request` refuses a
question whose source is also listed in `--scopes`.

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
vana app read spotify.savedTracks --grant 0x... --json
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
vana app read spotify.savedTracks --grant 0x... --pay --max-fee 0.05 --json
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
vana app escrow fund --amount 5 --asset 0xF1815... --json    # an ERC20, no gas
```

Fund the asset the reads are actually priced in, which the exit-4 payload
names as `asset`. On mainnet, funding requires `--yes` and spends real
money.

An ERC20 deposit (USDC.e) goes through the gateway relayer, which pays the
gas, so the app wallet needs only the token, not VANA. `--self-pay-gas`
sends it from the app wallet instead. A native VANA deposit always pays its
own gas.

To have a person fund it from their browser instead, run
`vana app claim --json` and send them `data.claimUrl`: it adds this app to
their Vana Account and opens its Fund page.

## Checking your work

```bash
vana app whoami --json                                   # who am I, registered?
vana app onchain spotify.savedTracks --owner 0x... --json    # version, hashes, deletion
```

Match the result to the user's goal using the [verification procedure](reference/verification.md).
A grant proves permission; a read proves receipt; neither proves the consuming
app saved or displayed it. Verify those outcomes at the actual app. Keep
collection, consent, reading, storage and display as separate observed results.

## Networks

Everything defaults to **mainnet**, where fees are real USDC.e. A read never
pays by itself: it stops at exit 4 with the price until you pass `--pay`,
and `--max-fee` caps it. Pass `--network moksha` to try a flow on the
testnet first, where fees are play money.

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
