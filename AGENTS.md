# vana-cli

The Vana command line tool. Two halves in one binary: the **owner side**
(`login`, `connect`, `collect`, `server`, `mcp`) which collects a person's
own data into their Personal Server, and the **builder side** (`vana app`)
which requests consent, reads granted data, pays for it, and asks questions
that compute on the owner's server.

Published as the `vana-cli` npm package with a single bin named `vana`, and
as signed standalone binaries built with Node SEA.

## Architecture

```
src/
|-- cli/              # commander.js command tree
|   |-- bin.ts            # entry point
|   |-- main.ts           # program assembly, global options, preAction hook
|   |-- app/              # the builder group: register, whoami, request,
|   |                     # requests, read, escrow, onchain, ask, derivatives
|   |-- render/           # human output; every app command also emits JSON
|   `-- telemetry.ts
|-- core/             # shared, no command knowledge
|   |-- exit-codes.ts     # the 0-7 contract, and SDK code normalization
|   |-- network.ts        # moksha (default) / mainnet / VANA_ENV=dev hosts
|   |-- app-key.ts        # env -> macOS keychain -> ~/.vana/app-key.json
|   |-- receipts.ts       # durable payment nonces + stored X-PAYMENT headers
|   |-- requests-store.ts # access requests, persisted at creation
|   `-- assets.ts         # ERC20 symbol/decimals resolution for fees
|-- personal-server/  # resolving and talking to a person's server
|-- connectors/       # the source catalog
|-- runtime/          # managed Playwright for browser-based collection
`-- skills/           # agent skills shipped with the CLI
```

## The contracts that matter

**Exit codes are a public interface.** 0 done, 1 failed, 2 bad usage, 3 no
grant, 4 payment required, 5 no server answered, 6 not ready, 7 a person
must act. Everything goes through `src/core/exit-codes.ts`; never return a
bare number from a command.

**Every `app` command ends with exactly one outcome object**, validated by
`appOutcomeSchema` in `src/cli/app/outcome.ts`. `code` is the machine
reason and `remedy` is usually a command the caller can run next. In human
mode failures go to stderr and `read` puts the payload alone on stdout.

**Global flags are declared on the program**, then mirrored onto every leaf
command by `applyGlobalOptions`. Values merge by commander's own provenance
so a subcommand default can never overwrite something the user typed.

**Money needs the asset's own decimals.** The mainnet data access fee is
USDC.e with 6, not native VANA with 18. Anything touching an amount goes
through `src/core/assets.ts`; when an asset cannot be resolved the CLI shows
base units and refuses to enforce `--max-fee` rather than comparing wrong.

**A failed paid read must not pay twice.** Fees settle before data is
served, so `receipts.ts` stores the signed payment header and replays it.
Never paper over a failure with a retry loop.

## Build & test

```bash
pnpm build          # tsc --build
pnpm test           # vitest run
pnpm validate       # lint + eslint + format:check + test
pnpm build:sea      # standalone binary (signs and notarizes when Apple env is set)
pnpm cli -- <args>  # run the built CLI
```

## Conventions

- **ESM-only**, `"type": "module"`; import paths carry the `.js` extension
- **Package manager: pnpm** (`pnpm ...`)
- **Tests: vitest**, with dependencies injected through a `deps` argument
  rather than module mocking, so a command's network calls are passed in
- **Conventional commits** (`feat:`, `fix:`, `docs:`, `chore:`); the version
  and the release are cut by semantic-release from the commit history, so a
  `docs:`-only change ships nothing
- **TSDoc on public exports**, and comments that state a constraint rather
  than narrate the code
- **Contract addresses come from the SDK registry**, never hardcoded here

## Traps

- **VHS is pinned to v0.11.0.** v0.12.0 silently stops writing gifs, which
  fails demo-preview and skips the release.
- **Server registrations are push-only.** Nothing deregisters, so a dead
  entry routinely shadows a live one; `read` tries every registration for
  the owner in order.
- **The browser may only auto-open on a real TTY**, or the test suite pops
  real tabs.
