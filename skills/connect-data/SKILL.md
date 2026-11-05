---
name: connect-data
description: >
  Collect a person's own data with the Vana CLI. Use for requests such as
  "use Vana to connect my data", source collection or refresh, and inspection
  of collected results. Route a missing connector to create-connector.
---

# Connect personal data

Read workflows with `vana skills show <id> --json`. The response includes full
instructions and required reference content; installation into the agent's
harness is optional. Use `connect-data`, `create-connector` or `builder` as the
requested goal needs them.

Use the Vana CLI for discovery, collection, owner identity and results. The
person completes provider sign-in and human checks in the browser when needed.
App access to collected data is a separate Builder workflow.

Start from the person's data goal, such as "Use Vana to collect my highlights".
Select and load the required skills yourself. Continue through discovery,
any necessary connector authoring, collection, and result inspection. The
person does not need to name a skill, choose a helper, or supply another
implementation prompt. Ask for account/data choices and human authentication.
The public
[walkthrough](https://github.com/vana-com/vana-cli/blob/main/skills/README.md)
pairs the user's part with the commands.

## Select the CLI and owner context

Check the available CLI:

```bash
vana --version
vana --help
```

If it is missing, use the [official installation instructions](https://github.com/vana-com/vana-cli#readme).
The published package is `vana-cli`, with a `vana` binary.

When testing local changes, run these from the actual `vana-cli` checkout:

```bash
pnpm build
node dist/cli/bin.js --help
```

Use that checkout's absolute `dist/cli/bin.js` path in place of `vana` for the
remaining commands. Keep the same entry point throughout the task.

Preserve the selected `VANA_HOME`, Account deployment (`VANA_ENV` or
`VANA_ACCOUNT_URL`) and network. Carry the same `--network` option through
commands when a network was explicitly selected. Check before collecting:

```bash
vana whoami --json
vana status --json
vana sources --json
vana connectors list --json
```

`vana whoami` identifies the person. `vana app whoami` identifies an app and
does not select the person's login. A Personal Server session alone is not an
authenticated Vana Account. Inspect the selected server and any servers listed
under other accounts before writing data.

For installation or runtime problems, inspect `vana doctor` and `vana logs`.
If the browser runtime is missing and collection needs it, run `vana setup --yes`.
Use the CLI's recovery command with its environment and network intact.

## Select the source

Use `sources` for available sources and `connectors list` for saved checkout
paths. Replace `<source>` with the selected key and inspect it:

```bash
vana sources <source> --json
```

When changing a local connector, read its manifest from the path reported by
`connectors list`.

If the source is missing or needs a code change, read Create Connector:

```bash
vana skills show create-connector --json
```

Read its returned `instructions` and required `resources`. That skill owns the
current PDP-Connect authoring and local-checkout workflow. Check upstream's
existing connectors before deciding a provider needs a new implementation;
an empty or unavailable catalog alone does not establish that.

Reuse discovery already completed in this task rather than repeating the same
search. Connector creation returns a directory, connector key and selected
streams to this collection workflow; it does not require Vana sign-in.

## Prepare Vana before collection

Once the connector is available, establish the Vana account and intended server
BEFORE requesting source credentials or running the provider. Reuse a valid
session. If signed out, run `vana login --json`, relay the returned browser URI,
and wait for the person to finish signing in there. No code is entered in the
terminal. Then check `vana whoami --json` and `vana status --json` in the same
home, Account deployment and network. JSON login does not start a server or
approve its CLI session. Follow the reported server-start or approval command;
an existing server owned by another account is not this person's destination.
If `VANA_PS_URL` or `VANA_PERSONAL_SERVER_URL` explicitly selects a server, use
the collection command's reported sign-in remedy: it targets Account sign-in
and preserves the selected server in the collection retry command.

Every collection entry checks readiness. Automated runs return `needs_input`
(exit 7) for Vana sign-in or server approval, or `personal_server_unavailable`
(exit 5) for an unavailable/unverified destination, with `reason` and `remedy`.
Follow the remedy, then retry the ORIGINAL collection command including `--from`,
`--streams` and its context. These outcomes precede connector credential prompts
and provider reads. A bare `VANA_SESSION_TOKEN` has no verified owner identity;
use a saved Account sign-in instead. Do not collect anonymously and try to
assign the export to an account later.

## Collect and handle human input

For an agent-controlled browser or protected local credential handoff, run
collection in a background process you can inspect while the person signs in:

```bash
vana connect <source> --json --ipc
```

For a Collection Profile source, select only the requested manifest stream
names with `--streams <stream,stream>`. An explicit source is required.
For a local implementation, add `--from /absolute/path/to/data-connectors`
without registering a persistent override for a one-off trial.

For a person entering a token or password, give them the exact interactive
command to run in their own terminal, with the real source/path/streams and
selected network. Explain where to paste the secret and that hidden input
does not echo. Verify secret fields have password metadata in the connector's
interaction schema. Keep the secret out of chat, command arguments, scripts,
and logs. A credential form in the chat is not the local terminal prompt.

Keep progress visible. In agent mode, relay meaningful stage/count events;
in human mode, leave the CLI's progress on the terminal. `vana connect`
collects and ingests in one run. The upstream developer runner is optional
diagnostics, not a prerequisite that collects from the provider a second time.

Read the emitted events until the process finishes. A Collection Profile
connector can request browser sign-in through `headed-required` and then a
`needs-input` event. Complete that handoff rather than treating every browser
source as unsupported by agents.

For `needs-input` events with `pendingInputPath` and `responseInputPath`:

1. Read the exact pending file and its requested fields.
2. Have the person complete browser sign-in or a human check. For secret
   fields, use an available protected local input channel. If none is available,
   stop/cancel this waiting run and hand over the interactive terminal command.
3. Write the resulting JSON to the exact response path using a file API.
   Restrict credential files to the current user; keep secrets out of chat,
   shell arguments, and logs.
4. For a Collection Profile manual action with no fields, write `{}` only
   after the person confirms completion. To decline, write `{"status":"cancelled"}`.
5. Continue reading events. Further prompts may follow, and input can expire.

Use the running CLI's message for legacy connectors that require a manual
terminal or browser handoff. An intermediate event is not a successful collection.

`--no-input` refuses human prompts, but it can still collect and upload data
when a session is available. Use `status` and `data` commands for inspection.

## Verify the result

Distinguish `connected_and_ingested` from `connected_local_only`. Local
collection does not prove Personal Server ingestion or delivery to an app.
Inspect the result and logs without starting another collection:

```bash
vana data list
vana data show <source>
vana data path <source>
vana logs <source>
```

Summarize the requested records, any skipped streams, and whether ingestion
succeeded. Preserve saved results and follow the reported recovery action on
failure. Do not rerun automatically just to obtain a cleaner transcript.
Inspect private records locally and report counts/status instead of copying
payloads into chat or a repository. Compare recognizable records and any
independent provider counts before claiming completeness.

If the person wants an app to consume the data, read
`vana skills show builder --json` and follow its instructions and resources.
Keep app identity, explicit
consent and paid app reads separate from owner-side collection.
