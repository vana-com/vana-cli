# Testing Guide

_How to test the `vana` CLI + SDK end-to-end on this machine._

This guide reflects what was actually verified on September 8, 2026. Every
command below was run against the real environment (local Chrome, live dev
relay, Personal Server on `localhost:8080`).

---

## 0. One-time setup

```bash
cd /Users/volod/vana/vana-cli

# Install pinned pnpm + dependencies (corepack needs a writable cache)
COREPACK_HOME=$PWD/.corepack pnpm install

# Build
COREPACK_HOME=$PWD/.corepack pnpm build
```

Run the CLI from the repo as:

```bash
node dist/cli/bin.js <command>
```

(Or `pnpm cli -- <command>`.) On your PATH there may also be a Homebrew
`vana` — see [§7 Known environment conflicts](#7-known-environment-conflicts)
before mixing them.

## 1. Unit tests + lint

```bash
COREPACK_HOME=$PWD/.corepack pnpm test        # 269 tests
COREPACK_HOME=$PWD/.corepack pnpm validate    # tsc + eslint + prettier + tests
```

Expected: all green. (`validate` includes `tsc --noEmit`, eslint,
prettier check, and the full vitest suite.)

## 2. Offline command smoke test

```bash
node scripts/smoke-cli.mjs
```

Runs the agent/offline surface (`mcp`, `skills`, `telemetry`, `doctor`,
`data list`, `logs`, unknown-command handling) against a throwaway `$HOME`
and prints PASS/FAIL per check. Exits non-zero on any failure.

## 3. CLI live e2e — collect → show → sync

This is the flagship flow. It launches real Chrome (headless), imports
cookies from your active Chrome profile, collects, and syncs to your
Personal Server.

```bash
# One-time: authenticate the CLI against your Personal Server
# (approves automatically from loopback; stores ~/.vana/auth.json)
node dist/cli/bin.js login --server http://localhost:8080

# Collect GitHub (uses the session cached in ~/.vana/browser-profiles)
node dist/cli/bin.js connect github

# Inspect what was collected
node dist/cli/bin.js data show github
node dist/cli/bin.js data show github --json | jq '.summary'

# Personal Server state
node dist/cli/bin.js status
node dist/cli/bin.js server data
```

Expected:

- `connect github` ends with `✓ Connected GitHub.` and a
  `connected_and_ingested` JSON outcome; human output says data was
  "synced to your Personal Server".
- `data show github` shows `State: Synced to Personal Server`.
- `server data` lists the six `github.*` scopes with ≥1 version.

Re-auth path (worth testing once):

```bash
# without auth you should now get a clear hint instead of a bare 401:
VANA_PS_TOKEN= node dist/cli/bin.js connect github --json --yes
#   → ingest-failed event + outcome ingest_failed
#   → human mode: "Your Personal Server requires authentication. Run `vana login` ..."
node dist/cli/bin.js server sync   # manual retry of failed scopes
```

Other live sources (same pattern): `node dist/cli/bin.js connect <source>`
after `node dist/cli/bin.js sources`. Machine mode:
`node dist/cli/bin.js connect <source> --json --no-input` (exits 1 with a
`needs-input` event if login is required).

## 4. SDK connect flow e2e (session relay, live)

Full session lifecycle against the deployed dev session relay:
create → poll pending → claim → approve → poll approved, plus a
`Web3Signed` auth header check.

```bash
# One-time: register a throwaway builder on the dev gateway
# (idempotent — reuses VANA_BUILDER_PRIVATE_KEY if set)
node scripts/dev-register-builder.mjs

# Run the lifecycle e2e
COREPACK_HOME=$PWD/.corepack \
  SESSION_RELAY_URL=https://dev.session-relay.vana.org \
  VANA_BUILDER_PRIVATE_KEY=0x... \   # printed by the register script
  npx vitest run --config test/e2e/vitest.config.ts
```

Expected: 1 passed test
(`full session lifecycle: init → poll (pending) → claim → approve → poll (approved)`).

`scripts/dev-register-builder.mjs` registers a fresh builder via
`POST {gateway}/v1/builders` (EIP-712 `BuilderRegistration`, chain 14800,
gateway `https://dp-rpc-dev.vana.org`) and polls
`GET /v1/builders/{address}` until 200. Keys are throwaway dev keys.

## 5. Next.js starter app (SDK consumer)

```bash
COREPACK_HOME=$PWD/.corepack pnpm --filter nextjs-starter build
COREPACK_HOME=$PWD/.corepack pnpm --filter nextjs-starter dev
# open http://localhost:3001
```

`.env.local` needs `VANA_PRIVATE_KEY` (any 0x key for the build; use a
registered dev builder for a real flow) and `APP_URL=http://localhost:3001`.
Note: `next build` evaluates route modules, so the env must exist before
building — otherwise `createVanaConfig` throws `MissingPrivateKeyError`
during page-data collection.

## 6. MCP server (agent integration)

```bash
# Quick check: list tools over stdio
printf '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"test","version":"0"}}}\n{"jsonrpc":"2.0","id":2,"method":"tools/list"}\n' \
  | node dist/cli/bin.js mcp | tail -2
```

Expect JSON-RPC responses with `serverInfo.name` and a `tools` array
(`check_status`, `list_sources`, `connect_source`, `show_data`, …).
To wire it into Claude Code, see `vana skills` (installs agent docs to
`~/.agents/skills/`).

## 7. Known environment conflicts

- **Homebrew canary**: `/opt/homebrew/bin/vana` (0.8.1-canary) with a
  launchd agent `~/Library/LaunchAgents/com.vana.collect.plist` running
  `vana collect --all` **daily**. That old build 404s on renamed connector
  paths and can overwrite state written by the dev build. Recommended
  while testing the dev build:
  ```bash
  launchctl unload ~/Library/LaunchAgents/com.vana.collect.plist
  # or remove the old install: brew uninstall vana
  ```
  (Re-load with `launchctl load …` when you want the schedule back.)
- **Personal Server auth**: the server on `:8080` requires auth for
  ingest. `vana login --server http://localhost:8080` stores a 30-day
  bearer token; `VANA_PS_TOKEN=<token>` overrides it per-shell.
- **Chrome cookie import**: the CLI copies cookies from your **last used**
  Chrome profile (`Local State → profile.last_used`) into
  `~/.vana/browser-profiles/<source>` on first launch. To re-import,
  delete that profile dir. If the session expires, rerun
  `vana connect <source>` interactively.

## 8. What was verified on 2026-09-08

| Area                                                    | Result                                                                              |
| ------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| Build / lint / format                                   | green (`pnpm validate`)                                                             |
| Unit tests                                              | 269/269                                                                             |
| `connect github` (real Chrome, cookie import)           | collected profile, 10 repos, 10 starred, 221 events, 244 PRs, 4 contribution graphs |
| Personal Server ingest (localhost:8080, bearer auth)    | 6/6 `github.*` scopes stored, outcome `connected_and_ingested`                      |
| `vana login --server` (self-hosted device flow)         | loopback auto-approve, 30-day token                                                 |
| Session relay lifecycle (dev relay, registered builder) | pending → claim → approve → approved                                                |
| `nextjs-starter` build                                  | green with `.env.local`                                                             |
| `worker` typecheck                                      | green                                                                               |
| Offline smoke (`mcp`, `skills`, `telemetry`, …)         | `node scripts/smoke-cli.mjs`                                                        |

## 9. Bugs fixed in this pass

1. **State clobbering on connector-fetch failure** — a failed re-collection
   (404, checksum mismatch, missing display, legacy auth) used to reset
   `dataState: "none"` and `lastResultPath: null`, hiding data that was
   still on disk and disabling `server sync` retry. Now prior data state is
   preserved (`src/cli/index.ts`, 5 call sites).
2. **Misleading ingest-failure copy** — after a sync failure the summary
   claimed data was "saved it locally" without mentioning the failure; on
   HTTP 401 it now says to run `vana login` (`src/cli/index.ts`).
3. **e2e test fragility** — `test/e2e` now skips gracefully on any
   "not registered" relay error, accepts `VANA_BUILDER_PRIVATE_KEY`, and
   compares the approved user address case-insensitively.
4. **`telemetry enable/disable --json`** — subcommands never declared the
   `--json` option (`error: unknown option '--json'`). Declared
   (`src/cli/index.ts`).
5. **`vana mcp` exit 13 on client disconnect** — `StdioServerTransport`
   never resolves on stdin `end`, so shutdown hung ("unsettled top-level
   await"). Now resolves on stdin close (`src/cli/mcp-server.ts`).
6. **Spurious "Moved your data to ~/.vana."** — printed on the second
   command of any fresh install because the routine compat-symlink case
   was reported as a migration (`src/core/paths.ts`).
7. **MCP `generate_context` copy** — pointed agents at the non-existent
   `vana skill install`; corrected to `vana skills install`
   (`src/cli/mcp-server.ts`).
8. **`examples/nextjs-starter` imports** — still referenced the old
   `@opendatalabs/connect` package name; updated to `vana-cli/*` so the
   starter builds against the workspace package.
