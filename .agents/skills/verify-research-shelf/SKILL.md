---
name: verify-research-shelf
description: Verify Research Shelf delivery, persistence, acknowledgement, same-grant refresh and recovery for PRD steps 4 and 5. Use for a local browser proof, verifier failure control, or live CLI-to-consumer acceptance.
---

# Verify Research Shelf

Read the [feature map](features/README.md). Select the requested claim and lane
before launching. This skill owns the CLI example's runtime and browser driver.
Unity's [workflow verifier](../../../../unity-surfaces/.agents/skills/us-verify-data-connection-workflow/SKILL.md)
owns cross-app acceptance and evidence rules. Product behavior remains in
`examples/perplexity-demo`.

## Select the proof

- **Controlled consumer proof** drives the actual Next app, SDK, storage and
  browser with synthetic service responses and a public test identity. It proves
  consumer behavior. Real collection and Account/Web approval remain blocked
  clauses, even when this lane passes.
- **Live acceptance** follows [the live procedure](references/live-acceptance.md).
  It needs the intended account, provider session, app, server, consent and an
  explicit read budget. Missing inputs produce a blocked result.

Step 5's current trigger is connector rerun followed by **Read latest**. Measure
those actions and duration. Automatic propagation, native delivery and the PRD's
undefined immediacy target are separate claims.

## Launch

Run from the `vana-cli` checkout with already-installed Node and dependencies.
Inspect `git status --short` and preserve other chats' work. Use the repo's pinned
runtime when available. Report missing prerequisites rather than installing.

Choose a new absolute evidence directory outside the checkout. The helper owns
its scratch app, loopback port, fresh browser and private store. Its copied app
has a separate build directory and does not share the user's running example.

```sh
node .agents/skills/verify-research-shelf/scripts/verify.mjs --evidence /private/tmp/research-shelf-proof
```

The command starts an isolated real Motel collector before the app, then owns readiness, browser actions, observations, OTLP export/query, assertions and cleanup. The installed Motel binary is required; it never installs a collector. Use `--motel-endpoint http://127.0.0.1:27686` only to reuse a doctor-checked shared collector, which cleanup preserves.

The command owns launch, readiness, browser actions, assertions and cleanup. A
failed assertion returns nonzero and retains its evidence. Read the report before
retrying in a new directory. Keep success expectations unchanged when diagnosing.

## Doctor

Run this read-only check before a drive or after an unexpected result:

```sh
node .agents/skills/verify-research-shelf/scripts/verify.mjs --doctor
```

A usable instance needs app source, compiled CLI exports, installed Next, SDK and
browser driver, an installed Chromium executable and the installed Motel CLI. A listening port alone is
insufficient. The helper also checks its launched app before driving.

## Drive

Select [first delivery](features/first-delivery.md),
[iteration](features/iteration.md), or [recovery](features/recovery.md). The
controlled command covers their consumer clauses in one serial browser run.
Every substituted external dependency is identified in the result. One agent
drives an instance at a time.

Run the unchanged success assertions against an isolated storage fault:

```sh
node .agents/skills/verify-research-shelf/scripts/verify.mjs --evidence /private/tmp/research-shelf-missing-save --negative-control missing-save
```

Require nonzero at the named persistence or acknowledgement clause, the matching diagnosis from actual Motel query results, evidence that the fault ran, and successful cleanup. Then run the ordinary command in a
new directory and require success. Startup failure is not sensitivity proof.

Run the other cross-boundary controls in separate new evidence directories by replacing `missing-save` with `save-failure`, `ack-failure`, or `read-interrupted`. The diagnoses must be `save-failed-after-read`, `ack-failed-after-save-and-render`, and `read-interrupted-before-save`, respectively. The original `missing-save` control is `ack-refused-missing-save`. A startup or collector failure is not a successful control. Then repeat the ordinary command and require product and Motel assertions to pass.

A fifth control, `missing-observations`, drops the observation stream after the app assertions pass. Require an overall failure with unknown Motel coverage. This is an observation failure, not evidence that the product operation failed.

## Motel observations

The [app-owned contract](../../../examples/perplexity-demo/src/server/observability.md) defines the opt-in local sink. The app emits actual approval-client, read/payment, save and acknowledgement outcomes. The browser driver supplies render and reload observations after checking the actual DOM and private store. Shared per-run aliases link request, grant, revision and attempt without exporting raw identifiers. These are client-boundary observations, not instrumentation inside remote services.

The adapter exports only validated metadata and queries the real collector back. `motel/motel-result.json` and `motel/motel-query.json` retain the returned evidence, coverage and diagnoses. Missing observations remain unknown. Product assertions and observation completeness must both pass; a successful export alone cannot pass the run. The automated lane does not collect from a real provider. Collection and ingestion are recorded only when their existing CLI events are actually observed in an authorized live collection.

For the live collection wrapper and shared context, read [live acceptance](references/live-acceptance.md). Adapter self-tests run with:

```sh
node --test .agents/skills/verify-research-shelf/scripts/motel.test.mjs .agents/skills/verify-research-shelf/scripts/observe-collection.test.mjs
```

## Evidence

Keep one result per attempt with source and verifier fingerprints, runtime
versions, lane, actions, timestamps, assertions, durable side effects, screenshots
and cleanup. Preserve failed control and restored success. Live payloads, keys,
cookies and payment headers stay outside publishable reports. Controlled records
are synthetic.

Report `passed`, `failed`, `blocked` and `reused` per claim. Controlled success is
not full PRD acceptance. Compare source, verifier, lockfile, installed runtime and
service inputs before reusing proof. A changed verifier needs its affected claims
rerun. The [live procedure](references/live-acceptance.md) names the required
external evidence and safe stop conditions.

## Cleanup

The helper closes only its browser, owned app and isolated collector processes, removes its scratch app and retains evidence, including the isolated Motel database. An explicitly reused shared collector remains running. Inspect cleanup on every exit. Preserve the user's app,
server, account sessions and other chats' changes. Live runs restore only their
own temporary connector edit and configuration, preserving payment history.

## Helpers

`node .agents/skills/verify-research-shelf/scripts/verify.mjs --help` lists driver
modes. Keep helper invocations and feature recipes aligned with the app and SDK.
Use Pstack's `maintain-verification-skill` for upkeep. Re-exercise changed claims
and negative controls before carrying forward evidence.
