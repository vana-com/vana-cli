---
name: create-connector
description: >
  Build or update a PDP-Connect Collection Profile connector and collect
  the owner's requested data through the Vana CLI. Use when a source has
  no connector or its collection code needs changing.
---

# Create a Collection Profile connector

Take the user's source and data goal through implementation, tests, one real
CLI collection, and a check that the intended Personal Server stored it.
Continue through those steps from one request. Ask for source/account choices,
human authentication, or an action that needs the user's decision. Choose the
runtime, helper functions, and verification commands from the public upstream
sources yourself; those are implementation decisions, not prompts for the
user to write. The
[walkthrough](https://github.com/vana-com/vana-cli/blob/main/skills/README.md)
shows the commands beside the user's part of each step.

## Select the source and checkout

Use the installed Connect Data skill for CLI discovery, identity, server
readiness, authentication, and result inspection. Install it if needed:

```sh
vana skills install connect-data --json
```

Read `SKILL.md` at the returned `installedPath`. Preserve the person's owner,
network, `VANA_HOME`, and Account deployment. Use the same CLI entry point
throughout. For local CLI work, build the actual checkout with `pnpm build`
and use its absolute `dist/cli/bin.js` path in place of `vana`.

Check both `vana sources --json` and upstream's current connectors before
creating one. A catalog failure is not evidence of an unsupported provider.
Use an existing implementation when it satisfies the requested data goal.

Keep implementations in the person's intended `data-connectors` checkout,
preserving its changes. If a checkout is needed:

```sh
git clone https://github.com/PDP-Connect/data-connectors.git
cd data-connectors
```

From that root, read `AGENTS.md` and these public references:

- [AUTHORING.md](https://github.com/PDP-Connect/data-connectors/blob/main/AUTHORING.md) for layout and gates.
- [Collection Profile](https://github.com/PDP-Connect/data-connectors/blob/main/docs/spec/collection-profile.md) for manifest and wire contracts.
- [Authoring guide](https://github.com/PDP-Connect/data-connectors/blob/main/packages/polyfill-connectors/docs/connector-authoring-guide.md) for shared helpers and fixture evidence.
- [Runtime note](https://github.com/PDP-Connect/data-connectors/blob/main/packages/polyfill-connectors/docs/collection-profile-runtime.md) for current APIs and gaps.
- [Connector checklist](https://github.com/PDP-Connect/data-connectors/blob/main/packages/polyfill-connectors/CONNECTOR-CHECKLIST.md) and [TESTING.md](https://github.com/PDP-Connect/data-connectors/blob/main/TESTING.md) for verification.

Check `packages/polyfill-connectors/package.json` for Node requirements, then
run `npm ci` at the repository root. Upstream uses npm workspaces; use pnpm
inside `vana-cli`. Resolve moved paths from the chosen checkout rather than
copying stale paths from an example or initializer.

## Implement one useful stream

Choose a lowercase snake_case key and a manifest stream name. From upstream's
`packages/polyfill-connectors` directory:

```sh
node --import tsx bin/connector-init.ts <key> --display-name "<Source name>" --stream <stream>
```

Use `--browser` when browser sign-in is required. Skip initialization for an
existing connector. The initializer refuses existing paths and generates
synthetic starting records; replace provider placeholders before a live run.

Inspect a current connector with the same access mechanism. Prefer an official
API or owner-provided export when it serves the requested data. Use the shared
browser/session helpers when a browser is needed. Declare the actual permitted
hosts, runtime bindings, authentication, interactions, streams, schemas, and
stable primary keys in `manifest.json`.

Reuse `packages/polyfill-connectors/src/connector-runtime.ts`, its current
auth helpers, and `schema-registry.ts`. `runConnector()` owns protocol messages,
interactions, counters, and outcomes. Connector code owns provider access,
parsing, and cursor logic. Inspect installed helper signatures before using
them; a README example is not an API declaration.

Keep code, manifest, record validation, tests, and fixtures together under
`connectors/<key>/`. For token input, use the existing auth strategy and secret
field metadata so the host can present a hidden prompt. For file input, explain
which export to obtain and which path the connector accepts. For browser input,
let the person complete sign-in and human checks in the connector's browser.

Prove pagination termination, stable record identities, requested-stream
selection, and failure behavior with synthetic or reviewed scrubbed fixtures.
Include nullable/empty values and observed response variants. A failed page
must not advance a success checkpoint. Where the provider exposes an independent
count, check completeness against it. State deletion and incremental behavior
explicitly; missing records alone do not establish a provider deletion.

Use the public fixture-capture, scrub, and validation helpers described by the
upstream authoring guide. Record whether fixtures are synthetic or derived
from a reviewed capture, regardless of their directory name. Real records and
credentials stay outside commits. Private Connector Factory code is optional;
a normal user must be able to complete the workflow without it. Its hosted
browser, test-account, registration, and publication pipeline is not a local
CLI prerequisite.

## Verify before the real-account run

Follow the chosen checkout's checklist, including its conformance roster,
manifest version, generated indexes, and narrowly justified sequential-await
exceptions. The roster lives at
`packages/polyfill-connectors/src/connector-conformance-roster.ts`; consult the
current checks for the other paths instead of disabling them to get a pass.

From the upstream root:

```sh
npm run connector-implementation-index:generate
npm run connector-implementation-index:check
```

If manifest options or reason messages changed, run
`npm run polyfill-library-metadata:generate`. Then run:

```sh
npm run verify --workspace @pdpp/polyfill-connectors
scripts/test-sandbox/test-sandbox -- node --import tsx --test connectors/<key>/pilot-fixture.test.ts
```

Run the same per-file test command for relevant provider/parser tests. Follow
`TESTING.md` for Vitest lanes. A passing scaffold test checks its starting
shape, not provider behavior. Report a missing checker or disabled sandbox
accurately; fix the actual prerequisite or leave that check unverified.

## Collect once through Vana

Have the person use the interactive CLI for secrets. Supply the exact command
with real key, checkout, stream, and selected network, not a token placeholder
they might paste into chat:

```sh
vana whoami --json
vana status --json
vana connect <key> --from /absolute/path/to/data-connectors --streams <stream>
```

Carry the selected `--network` through these commands. If the intended server
is unavailable, follow its reported recovery or start a local server with
`vana server start --local` in that same context. Check readiness before
collecting; another account's server is not this owner's server.

`vana connect` collects and ingests in one run. Keep progress visible. For an
agent-controlled browser or protected credential handoff, add `--json --ipc`
and follow Connect Data's input procedure. For a human token prompt, explain
that they run the command in their own terminal and paste at its hidden prompt.
Use the connector's schema to verify that secret fields are hidden. Keep
credentials out of chat, shell arguments, scripts, and logs.

Inspect `vana data show <key> --json`, `vana data path <key>`, and
`vana logs <key>` without another provider run. Report the selected streams,
active/deleted counts where meaningful, and whether ingestion completed. Keep
private payloads local. Distinguish `connected_and_ingested` from
`connected_local_only`; tests alone establish neither.

## Diagnose or iterate

Use the existing logs and failed response shape to reproduce a defect before
changing the parser. After a fix, rerun the focused checks, then repeat the
same CLI collection deliberately. To test a code change, compare meaningful
changed output and stable keys in the server, not just a successful exit.

The upstream developer runner is optional when diagnosing protocol/runtime
behavior separately. From `packages/polyfill-connectors`:

```sh
node --import tsx bin/connector-dev.ts <key> --streams <stream> --summary-out /absolute/path/to/run-summary.json
```

This can contact the provider and ask for sign-in. It does not ingest into a
Personal Server. Do not require this live run before every `vana connect`.
For incremental diagnostics, follow the runner's `--seed-last-state` support
and preserve its successful state. Respect provider refresh limits.

Repeated development may use `vana connectors add <key> --from <checkout>`.
That saves a persistent override which also affects collect, schedules, and
MCP; one-off acceptance needs only `--from`. A key collision needs a deliberate
choice before `--force`. Remove an unwanted override with
`vana connectors remove <key>`.

Finish with the implementation path, checks run, collection/ingestion evidence,
and remaining reusable workflow gaps. App consent, reading, saving, display,
and acknowledgement belong to the Builder workflow. Native availability,
signed release, and publication are separate work, not a side effect of a
local test.
