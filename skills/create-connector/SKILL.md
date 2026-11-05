---
name: create-connector
description: >
  Build or repair a Collection Profile connector with the current agent and
  shared Factory checks. Use when a requested source has no connector or a
  connector needs implementation. Export evidence and API preparation are supported.
---

# Create a connector

Read workflows with `vana skills show <id> --json`. The response includes full
instructions and required reference content; installation into the agent's
harness is optional. Use `connect-data`, `create-connector` or `builder` as the
requested goal needs them.

Take the user's source and data goal through implementation, checks, one real
CLI collection, and a check that the intended Personal Server stored it.
Continue through those steps from one request. Ask for source/account choices,
human authentication, or an action that needs the user's decision. The
[walkthrough](https://github.com/vana-com/vana-cli/blob/main/skills/README.md)
shows the commands beside the user's part of each step.

Reuse completed discovery from the current task. Otherwise check both
`vana sources --json` and upstream's current connectors before creating one.
A catalog failure is not evidence of an unsupported provider. Use an existing
implementation when it satisfies the requested data goal.

Start with the instructions bundled in the installed Vana CLI. This command
works offline without installing an agent skill or Factory.

```bash
vana connectors build --instructions --json
```

The current agent writes and repairs the connector. Factory supplies the
explicit job, private work instructions and executable checks. Do not launch
another coding agent or service.

1. Read the bundled instructions. They include the public data-connectors
   checkout, its locked dependency installation and the exact public
   `@vana/factory-core@0.0.2` release artifact to install locally. No private
   Factory access or internal service is required. Use synthetic or explicitly
   reviewed evidence and a real Node 24 runtime on macOS or Linux; Node 24.22.1
   is recommended for both Factory and the checkout. The instructions set
   `VANA_FACTORY_TOOLS` under `VANA_HOME` (otherwise `~/.vana`) and
   `VANA_FACTORY_BUILD` to the installed executable.
2. Save a version 1 request file with absolute checkout/evidence paths, source
   identity, directory key, exact manifest key, requested streams, and export
   environment variable name or API preparation plan. The bundled instructions
   include a source-general API example. Declare names rather than credential
   values.
   Directory and manifest keys must match after underscore/hyphen normalization.
3. Run `vana connectors build --request /absolute/path/to/request.json --json`.
   Read the returned private `workFile`. For an API, run `actions.prepare.argv`
   for the same UUID and state directory. Explicit prepare acquires only declared
   fetch or GET inputs. Supplied synthetic or reviewed research and responses
   also work offline without credential values. Missing inputs preserve the job.
   Supply them and prepare again. Successful repeated preparation verifies its
   accepted artifacts without network. Changed accepted inputs need a new job.
   Read safe `api.md`, research, profiles and fixtures, then implement in the
   named checkout. Raw captures are private and are not linked for the agent.
   Factory validates stream schemas with `type`, `properties`, `required`,
   `items`, `enum`, `format: date-time`, `minLength` and boolean
   `additionalProperties`. Other assertions need explicit unsupported handling;
   do not remove constraints to obtain a pass.
4. Run the returned `actions.check.argv`. Repair failures and check the same
   job again. Use `actions.resume.argv` to refresh work or continue after
   export prerequisites. Resume and check never acquire API evidence. An API
   check before preparation returns `agent_work` with reason `prepare`. Use
   prepare after supplying API prerequisites. All commands retain the explicit
   UUID and canonical state directory. Never infer a latest job or read private job state as an API.
5. A `checks_passed` result covers `static_and_fixture` checks. Live
   verification remains `pending`; ingestion remains `not_run`. The returned
   connect action verifies the same Vana run before result/checkpoint writes
   and ingestion. Independent server readback remains a separate proof.
6. Only a pass offers `actions.connect.argv`. Preserve its exact directory
   spelling, checkout and requested streams. Supply the required environment
   names derived from `collectionContext.access` when needed. Continue the
   original authorized collection request; ask only for missing account, scope, authentication or a
   blocked decision. Collection and registration are never started by a build.

API preparation supports bounded JSON GET samples and public documentation,
with none, named-header, Bearer or Token auth references. It has no discovery,
automatic retries or pagination. Review declared structural fields and tokens.
Prepared synthetic fixtures still require review before publication. Browser
preparation remains unsupported. Do not imply live provider proof. Missing
prerequisites need a person; global `--yes`, `--no-input`, `--ipc` and `--network` do not grant
new source access. `--detach` is unsupported; `--quiet` hides progress only.

## Collect once through Vana

Read Connect Data with `vana skills show connect-data --json` for discovery,
identity, server readiness, authentication and result inspection. Preserve the
person's owner, network, `VANA_HOME` and Account deployment, and use the same
CLI entry point throughout. For local CLI work, build the actual checkout with
`pnpm build` and use its absolute `dist/cli/bin.js` path in place of `vana`.

Writing and checking the connector does not require Vana sign-in. Before a
real-account collection, follow Connect Data's account/server preparation:
Vana sign-in, server readiness and CLI approval precede source-token entry or
provider reads. Readiness failures include a recovery command; preserve the
original source, checkout path and streams through that recovery.

Have the person use the interactive CLI for secrets. Supply the exact command
with the real key, checkout, streams and selected network, not a token
placeholder they might paste into chat. Keep credentials out of chat, shell
arguments, scripts and logs. Inspect `vana data show <key> --json`,
`vana data path <key>` and `vana logs <key>` without another provider run, and
distinguish `connected_and_ingested` from `connected_local_only`; checks alone
establish neither.

Repeated development may use `vana connectors add <key> --from <checkout>`.
That saves a persistent override which also affects collect, schedules and
MCP; one-off acceptance needs only `--from`. Remove an unwanted override with
`vana connectors remove <key>`. App consent, reading and delivery belong to
the Builder workflow. Native availability, signed release and publication are
separate work, not a side effect of a local test.
