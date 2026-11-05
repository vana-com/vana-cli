# Build and collect a connector with an agent

Use an agent and the Vana CLI to collect one category of your data into your
Personal Server. If the source needs a new connector, the agent builds it with
PDP-Connect's public tools. You choose the data and complete authentication.

You need an agent that can run terminal commands. Creating a connector also
requires Git and the Node version declared by the selected
[`data-connectors` checkout](https://github.com/PDP-Connect/data-connectors).
Connector Factory is optional internal automation; this walkthrough does not
require its repository, hosted browsers, test accounts, or services.

## Install the CLI and read the workflow

Install the CLI using the [Vana CLI installation instructions](../README.md#install).
For the npm route:

```sh
npm install -g vana-cli
```

The running agent reads the bundled instructions directly:

```sh
vana skills show connect-data --json
```

The JSON includes the full `instructions` and required `resources` with their
content. The agent follows them without installing into its harness or starting
another session. It reads `create-connector` or `builder` the same way when the
user's goal needs those workflows. Reading does not write a cache or agent
configuration, and installed releases use their version-matched bundled files.

## Optional installation for future sessions

Persistent installation lets supported harnesses discover the skills in later
sessions. It is not required for the current task. The installer may offer
Connect Data, Create Connector and Builder at a human terminal, shows their
destinations, and asks before copying or replacing files. Declining leaves agent
skills untouched. Automated installs skip the offer. Revisit your choice with:

```sh
vana skills setup
```

Native setup currently installs under `~/.agents/skills/vana-<id>/` and also
`~/.claude/skills/vana-<id>/` when `~/.claude/` exists. Individual
`vana skills install <id> --json` commands remain available to agents with
explicit permission to install a named skill.

Alternatively, use the [skills.sh installer](https://skills.sh/docs/cli):

```sh
npx skills add vana-com/vana-cli --list
npx skills add vana-com/vana-cli --skill connect-data -g
npx skills add vana-com/vana-cli --skill create-connector -g
```

Select your agent when prompted. `-g` installs across projects; omit it for
the current project. Select these two skills rather than every skill in the
repository. Their declared names are `connect-data` and `create-connector`.

The public sources are [Connect Data](https://github.com/vana-com/vana-cli/blob/main/skills/connect-data/SKILL.md)
and [Create Connector](https://github.com/vana-com/vana-cli/blob/main/skills/create-connector/SKILL.md).
Both installers read this repository. Installing a skill teaches an agent the
workflow; it does not install the CLI or implement a provider.

## Ask for the data you want

Ask in ordinary language. For example:

> Use Vana to collect my [data category] from [source] into my Personal Server.

The bundled instructions tell the agent how to discover the source, build a missing
connector, run checks, handle authentication, show progress, and verify storage.
You do not need to name either skill or choose the underlying tools. Further
questions are for account selection, the data you want, authentication, or a
blocked action. This README lets you follow the work and read its commands;
it is not a sequence of prompts you must manage. Collection does not imply
publication or permission for another app to read your data.

## Check the source and your account

The agent checks these before writing data:

```sh
vana whoami --json
vana status --json
vana sources --json
vana connectors list --json
```

Keep the same owner, network, and Account deployment throughout the run. When
you selected a network, carry `--network mainnet` or `--network moksha` through
the account, server, and collection commands. `vana app whoami` identifies an
app, not your owner account.

Discovery and connector authoring do not require Vana sign-in. Once a connector
is available, prepare Vana before running the source: sign in with `vana login`
if needed, select or start the intended owner's server, and complete its CLI
approval. Agents use `vana login --json` and relay the browser URI; JSON login
does not perform server setup. Check `vana status` again before collecting.
For an explicit server environment override, follow collection's sign-in remedy
so Account sign-in and the collection destination remain separate.
A local server (`vana server start --local`) stores data on this machine and
does not register a public endpoint.

The agent checks the upstream connector catalog too. A failed catalog request
does not mean the source is unsupported. Existing connectors go directly to
collection. Missing connectors follow the authoring step below.

## Build a missing connector

The agent follows [Create Connector](./create-connector/SKILL.md), the canonical
task guide for both agents and humans. Link directly to that file rather than
to a generated heading anchor. The CLI reads that same method with
`vana skills show create-connector --json`; no skill installation is needed.

The guide owns source research, checkout setup, implementation and checks.
Connector Factory may supply build tooling, but its integration is separate:
this public workflow needs no private Factory repository. The return to Vana
is the checked connector's directory, source key and selected streams. The same
agent then prepares Vana and continues the original collection request.

## Collect once through the CLI

For an existing catalog source, you can run this in your own terminal:

```sh
vana connect example_source --streams items
```

For a connector the agent has built locally, replace the path with its actual
checkout:

```sh
vana connect example_source --from /absolute/path/to/data-connectors --streams items
```

The command collects the selected stream and ingests it into your selected
Personal Server. The terminal shows progress. A local run prints which source
directory it executes. Use this as the real-account acceptance run; the
upstream developer runner is optional diagnostics, not a required second
collection before ingestion.

For a token or password, the agent gives you the exact command to run and
explains which hidden terminal prompt will receive it. Enter the secret there.
For browser authentication, sign in in the connector's browser and confirm
when finished. Keep credentials out of chat, command arguments, and saved logs.

An agent operating an already authenticated source uses `--json`. When a
browser handoff or protected local credential handoff is available, it uses
`--json --ipc` and follows the emitted input paths. Otherwise it hands you the
interactive command above. `--no-input` refuses prompts; it does not make a
collection command read-only.

## Check what was saved

The agent checks the completed command and inspects its result without running
the provider again:

```sh
vana data show example_source --json
vana data path example_source
vana logs example_source
```

`data show` can include private records. Inspect them locally. The agent's
report names counts, selected streams, and storage status rather than copying
your library into chat or a repository.

| Result                      | What you have                                                       |
| --------------------------- | ------------------------------------------------------------------- |
| `connected_and_ingested`    | Collected data and confirmation that your server stored it.         |
| `connected_local_only`      | A local collection, with server ingestion still to finish.          |
| Input or collection failure | A next action and failure evidence; no successful collection claim. |

Compare recognizable records and the provider's own counts where available.
Distinguish active records from deletion records. For an incomplete API page,
expired session, or changed response format, the agent preserves the failure,
fixes the cause, and repeats only after the problem is understood.

## Repeat or continue

To refresh the local connector after a deliberate code change, rerun the same
`vana connect ... --from ... --streams ...` command. Check that the changed
records reached the same server. For repeated development, the skill explains
optional `vana connectors add`; a one-off trial does not need registration.

Collection finishes a collection-only request. If your original goal also asks
an app to use the data, the agent continues through the public Builder skill:

Read `vana skills show builder --json`; the agent follows its included
[delivery and verification procedure](./builder/reference/verification.md).
The agent reuses the intended app identity, guides explicit consent, handles
any agreed spending limit, and verifies the requested read, storage, display
and persistence in your app. You do not need another implementation prompt,
a reference app, Motel or access to private Vana repositories.

Local success also does not publish the connector or make it appear in native
Vana apps. Automatic testnet setup, native delivery, and publication retain
their own requirements in the builder path.

## Test changes to this walkthrough

When developing `vana-cli`, build that checkout with `pnpm build` and use its
absolute `dist/cli/bin.js` path instead of `vana`. Read the changed instructions
with `skills show connect-data --json` and `skills show create-connector --json`
through that entry point. This tests the bundled files without installing skills.

Before recommending the public install route, repeat discovery and installation
from outside both repositories, with no `VANA_SKILLS_DIR` override or factory
checkout. Compare the installed files to the reviewed source. A local install
passing does not prove the public branch has those changes.
