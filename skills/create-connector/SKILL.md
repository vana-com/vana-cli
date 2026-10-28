---
name: create-connector
description: >
  Build or update a PDP-Connect Collection Profile connector and test it
  through the Vana CLI from a local source checkout. Use when a requested
  data source has no connector or its collection code needs changing.
---

# Create a Collection Profile connector

Keep connector implementations in PDP-Connect's `data-connectors` repository.
Use its maintained runtime and development tools, then use Vana to prove
owner-side collection and ingestion. A local registration does not publish a
connector or deliver it to native Vana apps.

## Prepare the source checkout

Use the person's intended checkout, preserving its existing changes. If a
checkout is needed, choose a suitable parent directory and run:

```bash
git clone https://github.com/PDP-Connect/data-connectors.git
cd data-connectors
```

All upstream paths below are relative to that repository root. Read its
`AGENTS.md` and these maintained references from the selected checkout:

- [AUTHORING.md](https://github.com/PDP-Connect/data-connectors/blob/main/AUTHORING.md) for layout and authoring gates.
- [Collection Profile](https://github.com/PDP-Connect/data-connectors/blob/main/docs/spec/collection-profile.md) for manifest and wire contracts.
- [Runtime note](https://github.com/PDP-Connect/data-connectors/blob/main/packages/polyfill-connectors/docs/collection-profile-runtime.md) for current APIs and known gaps.
- [Connector checklist](https://github.com/PDP-Connect/data-connectors/blob/main/packages/polyfill-connectors/CONNECTOR-CHECKLIST.md) for tests, fixtures and evidence levels.
- [TESTING.md](https://github.com/PDP-Connect/data-connectors/blob/main/TESTING.md) for supported test lanes and host requirements.

Check `packages/polyfill-connectors/package.json` for the required Node
version before installing. From the upstream repository root:

```bash
node --version
npm ci
```

Upstream uses npm workspaces and `package-lock.json`. Use pnpm for development
inside `vana-cli`; keep the repositories' installation commands separate.

Resolve the Vana CLI entry point before changing directories. For local CLI
changes, build the actual `vana-cli` checkout with `pnpm build` and invoke its
absolute `dist/cli/bin.js` path in place of `vana` below.

## Implement the smallest useful stream

For a new connector, choose a lowercase snake_case key and use upstream's
initializer from `packages/polyfill-connectors`:

```bash
cd packages/polyfill-connectors
node --import tsx bin/connector-init.ts <key> --display-name "<Source name>" --stream <stream>
```

Add `--browser` to that invocation when browser sign-in is required. The
initializer refuses existing paths. For updates, skip initialization and
preserve the connector's key and scope names. Generated records are synthetic;
replace the provider placeholders before claiming real collection.

Inspect a current implementation with the same auth and collection mechanism.
For example, `connectors/perplexity/` uses browser sign-in and
`connectors/netflix_export/` reads an owner-provided file.

Keep `index.ts`, `manifest.json`, parsers, record validation, tests and reviewed
scrubbed fixtures together under `connectors/<key>/`. Follow upstream's
versioning and generated-index rules when adding or changing a connector.

Use `packages/polyfill-connectors/src/connector-runtime.ts` and its existing
authentication and browser helpers. `runConnector()` owns protocol messages, interaction
handling, counters and terminal outcomes. Connector code owns provider access,
parsing, stream records and cursor logic. Follow the current helper signatures
and imports rather than implementing a parallel runner.

Declare the actual runtime bindings, permitted hosts, interactions, streams,
record schemas and stable primary keys in `manifest.json`. Implement record
validation against those schemas. Keep the requested stream set and incremental
state meaningful; a checkpoint must not claim unread data was collected.

Inspect the provider's current sign-in and data access behavior. Let the
person perform sign-in and human checks. Start with one useful stream and
tests using synthetic or reviewed scrubbed input before a real-account run.

## Check the implementation

Return to the upstream repository root. Refresh the implementation index after
adding a connector or changing its manifest:

```bash
npm run connector-implementation-index:generate
npm run connector-implementation-index:check
```

If `options_schema` or `reason_display_messages` changed, regenerate the
library metadata before verification:

```bash
npm run polyfill-library-metadata:generate
```

Then run the verify gate:

```bash
npm run verify --workspace @pdpp/polyfill-connectors
```

Run the generated scaffold's Node test through upstream's sandbox:

```bash
scripts/test-sandbox/test-sandbox -- node --import tsx --test connectors/<key>/pilot-fixture.test.ts
```

Use the same per-file command for relevant Node parser and collection tests.
Follow `TESTING.md` for existing Vitest tests and full suite lanes. A scaffold
test proves its generated shape; provider behavior needs its own tests and run.

The local developer runner lives in `packages/polyfill-connectors`. Replace
`<key>` and `<stream>` with the connector key and a manifest stream name:

```bash
cd packages/polyfill-connectors
node --import tsx bin/connector-dev.ts <key> --streams <stream> --summary-out /absolute/path/to/run-summary.json
```

This runs real collection and can ask for sign-in. Use a terminal for its
interactive prompts. Inspect the streamed result and the saved summary. It
does not ingest records into a Vana Personal Server.

After a successful run that wrote state, test incremental behavior with:

```bash
node --import tsx bin/connector-dev.ts <key> --streams <stream> --seed-last-state --summary-out /absolute/path/to/next-summary.json
```

The runner stores state under `packages/polyfill-connectors/runs/<key>/`
relative to the repository root. Respect provider refresh limits. Keep real
records and run artifacts out of commits; passing fixture tests alone does
not establish real-account support or justify a lifecycle promotion.

## Prove the Vana integration

Preserve the intended owner, Account deployment and server context. These
examples use Moksha. Check identity and server readiness before collecting:

```bash
vana whoami --network moksha --json
vana status --network moksha --json
vana connect <key> --from /absolute/path/to/data-connectors --streams <stream> --network moksha --json --ipc
```

The checkout must have its own installed `tsx` and a manifest whose
`connector_key` matches the selected key. Handle IPC and browser input using the
Connect Data skill. If needed, install it with
`vana skills install connect-data --json` and read `SKILL.md` under the
returned `installedPath`.

Inspect the collected result without another provider run:

```bash
vana data show <key>
vana data path <key>
vana logs <key>
```

For repeated local development, register the checkout deliberately:

```bash
vana connectors add <key> --from /absolute/path/to/data-connectors
vana connectors list
vana connect <key> --streams <stream> --network moksha --json --ipc
```

A saved local entry runs unsigned checkout source on subsequent collection,
including schedules and MCP. Each run reports `Running <key> from <dir>` and
emits `local-connector`. An existing key collision needs an explicit decision
before `--force`, because the override shares that connector's state and scopes.
Remove a development registration when it is no longer wanted:

```bash
vana connectors remove <key>
```

Report which checks ran, whether a real provider run occurred, and whether
Vana collected locally or ingested into the intended server. App reading,
saving and display remain a separate Builder workflow with explicit consent.
Publishing, signed release and account-scoped native delivery are separate
work. Use upstream's contribution and artifact instructions when requested;
do not describe this local loop as an automated publication command.
