# Build and collect a connector with an agent

Use an agent and the Vana CLI to collect one category of your data into your
Personal Server. If the source needs a new connector, the agent builds it with
PDP-Connect's public tools. You choose the data and complete authentication.

You need an agent that can run terminal commands. Creating a connector also
requires Git and the Node version declared by the selected
[`data-connectors` checkout](https://github.com/PDP-Connect/data-connectors).
Connector Factory is optional internal automation; this walkthrough does not
require its repository, hosted browsers, test accounts, or services.

## Install the CLI and skills

Install the CLI using the [Vana CLI installation instructions](../README.md#install).
For the npm route:

```sh
npm install -g vana-cli
vana --version
```

Install the two skills through the CLI:

```sh
vana skills install connect-data --json
vana skills install create-connector --json
```

Each response gives `installedPath`. The CLI installs to
`~/.agents/skills/vana-connect-data` and `vana-create-connector`, and also to
Claude Code's skill directory when detected. Have your agent read `SKILL.md`
at the returned path. Refresh its skill discovery if it was already running.

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

The installed skills tell the agent how to discover the source, build a missing
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

If you are not signed in, use `vana login`. If you need a server on this
machine, start one with `vana server start --local`. Check `vana status`
again before collecting. A local server stores data on this machine and does
not register a public endpoint.

The agent checks the upstream connector catalog too. A failed catalog request
does not mean the source is unsupported. Existing connectors go directly to
collection. Missing connectors follow the authoring step below.

## Build a missing connector

The agent follows [Create Connector](./create-connector/SKILL.md). Its detailed
authoring steps belong in that skill and the upstream authoring guide. The
main terminal steps are shown here so you can follow its work.

From a directory you choose:

```sh
git clone https://github.com/PDP-Connect/data-connectors.git
cd data-connectors
npm ci
```

Reuse an existing checkout when you have one. The agent checks its Node
requirements and reads `AGENTS.md`, `AUTHORING.md`, and `TESTING.md` first.
Upstream uses npm; development in `vana-cli` uses pnpm.

Choose a connector key such as `example_source` and a stream such as `items`.
From the `data-connectors` root:

```sh
cd packages/polyfill-connectors
node --import tsx bin/connector-init.ts example_source --display-name "Example Source" --stream items
```

The initializer creates starting files, not a working provider integration.
The agent writes the provider code, record schema, and tests. It prefers an
official API or data export when suitable. Browser sources use the shared
browser helpers. Tokens and file imports do not require a browser just to
follow this walkthrough.

From the `data-connectors` root, the agent runs the relevant connector tests
and the repository checks required by its current authoring guide, including:

```sh
npm run connector-implementation-index:generate
npm run connector-implementation-index:check
npm run verify --workspace @pdpp/polyfill-connectors
```

Tests use synthetic or reviewed scrubbed input. Real account access comes in
the collection step. The agent reports failed checks and missing tools rather
than treating a partial verification run as a pass.

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

Collection finishes this walkthrough. Giving another app access is a separate
step using the Builder skill, explicit approval, and app persistence checks.
Local success also does not publish the connector or make it appear in native
Vana apps. Automatic testnet setup, native delivery, and publication retain
their own requirements in the builder path.

## Test changes to this walkthrough

When developing `vana-cli`, build that checkout with `pnpm build` and use its
absolute `dist/cli/bin.js` path instead of `vana`. Install the changed skills
from that checkout with the native install commands above, or use
`npx skills add /absolute/path/to/vana-cli --skill connect-data` and the
equivalent `create-connector` command in a temporary project.

Before recommending the public install route, repeat discovery and installation
from outside both repositories, with no `VANA_SKILLS_DIR` override or factory
checkout. Compare the installed files to the reviewed source. A local install
passing does not prove the public branch has those changes.
