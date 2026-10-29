---
name: create-connector
description: >
  Build or repair a Collection Profile connector with the current agent and
  shared Factory checks. Use when a requested source has no connector or a
  connector needs implementation. Export evidence and API preparation are supported.
---

# Create a connector

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
   `@vana/factory-core@0.0.1` release artifact to install locally. No private
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

The older `reference/PAGE-API.md` and `reference/PATTERNS.md` describe legacy
Playwright connectors. Read them only when the task explicitly targets that
format. They do not replace the current Collection Profile workflow.
