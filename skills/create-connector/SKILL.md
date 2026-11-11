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
   checkout, its locked dependency installation and how to select a compatible
   Factory executable. Use synthetic or explicitly
   reviewed evidence and a real Node 24 runtime on macOS or Linux; Node 24.22.1
   is recommended for both Factory and the checkout.
2. Save a version 1 request file with absolute checkout/evidence paths, source
   identity, directory key, exact manifest key, requested streams, and export
   environment variable name or API preparation plan. The bundled instructions
   include a source-general API example. Declare names rather than credential
   values.
   Directory and manifest keys must match after underscore/hyphen normalization.
   Run `"${VANA_FACTORY_BUILD-factory-build}" capabilities --include-fixtures --json`
   before building. This probes the configured executable or uses PATH when the
   override is unset.
   When it reports `fixtureTestsVersion: 1`, declare `fixtureTests` in the initial request.
   Name the connector-local tests that will prove collection with synthetic data.
   The names are fixed for the job. Write the files before running check and
   register at least one passing `node:test` case directly in each named file.
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

## Submit a connector for review

When the builder explicitly asks to submit a new connector or an improvement,
run the upstream checks, then prepare its public handoff. These commands read
reported evidence. They do not execute the test commands in the evidence file.

1. Keep one signed-off commit directly on the reviewed upstream main revision.
   Change only the selected connector and its generated implementation-index
   entry. New connectors need a unique key, manifest and `index.ts`. Updates
   need a higher manifest version.
2. Save reviewed synthetic evidence outside the connector commit using the
   example below. Replace the commit, date, commands, results, source and
   record with observed values. This content becomes public with the PR.
3. Run `vana connectors prepare-pr <directory> --checkout /path/to/data-connectors --base <upstream-main-commit> --head <connector-commit> --summary "<change and reason>" --evidence /path/to/reviewed-evidence.json --json`.
   Review the full committed diff and PR description. Older evidence summaries
   remain previewable, with missing review evidence listed.
4. Sign in with `gh auth login --hostname github.com` if needed. The builder
   needs a writable public fork of `PDP-Connect/data-connectors`. A GitHub data
   connection does not select the account used to submit code.
5. Replace `prepare-pr` with `submit-pr` using the same arguments. It shows the
   GitHub account, public destination, exact commit, diff and evidence, then
   exits with code 7 and a confirmation digest. Show the preview to the builder.
   Global `--yes` does not approve publication.
6. After explicit approval, rerun with `--confirm <digest>` to push the reviewed
   commit and open a draft PR. Changed evidence or account needs a new review.
   If interrupted, retry the same confirmed submission. It finds the existing
   PR before any write and returns its URL.
7. The builder marks the draft ready and responds to reviewers on GitHub.
   Report submission, approval, merge, signing, publication and Vana app
   availability only when each is actually verified.

An example evidence file for a new connector follows.

```json
{
  "kind": "synthetic",
  "commit": "<full connector commit SHA>",
  "checkedAt": "2026-11-11T00:00:00Z",
  "environment": "Node 24.22.1, Linux, synthetic provider fixture",
  "checks": [
    {
      "name": "Synthetic collection and schema test",
      "result": "passed",
      "command": "node --import tsx --test connectors/example/index.test.ts",
      "exitCode": 0,
      "output": "tests 1\npass 1\nfail 0"
    }
  ],
  "sample": {
    "source": { "id": "item-1", "title": "Example item" },
    "after": { "id": "item-1", "title": "Example item" }
  },
  "storedData": "Initial upstream connector. Local test records are unchanged. IDs use the source item ID; the first collection starts without a cursor."
}
```

For an update, add `sample.before` with the old output for the same input, or
`null` if no record was emitted. Explain existing-record effects in `storedData`,
including IDs, types, cursors and any required reimport. Keep secrets, personal
records and raw private captures out of every field.

Each check reports `passed`, `failed` or `not run`, its exact command, exit
status and output. A passed check needs status 0. A failed check needs a nonzero
status. A check not run uses `exitCode: null` and explains why in `output`.
For upstream failures, include the base SHA, environment, command and result in
the reviewed output. Keep failed and skipped checks visible. Synthetic evidence
does not establish live provider behavior or app availability.

Commands and the environment support 300 characters each. Outputs and the
stored-data explanation support 12,000 characters each. The full description
must fit within 60,000 UTF-8 bytes. Review output before sharing it.
