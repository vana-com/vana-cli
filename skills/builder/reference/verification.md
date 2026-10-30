# Verify data use in the consuming app

Owner: the public Builder skill. Use this procedure when integrating Vana data
into an app or verifying a connector change. For a request to read data only,
verify the returned records; do not invent a consuming app or require one.
These instructions work with the user's own app. Research Shelf is an optional
[public example](https://github.com/vana-com/vana-cli/tree/main/examples/perplexity-demo).
Its developer verifier and Motel are not prerequisites for using Vana.

## Establish one consistent context

1. Identify the requested data, person, consuming app and intended result.
   Reuse the app's backend credentials and registration. Inspect without paying:

   ```sh
   vana --version
   vana app whoami --json
   vana app requests list --json
   vana app escrow balance --json
   ```

2. Carry the selected network and Account deployment through every action.
   Mainnet is the default and can charge real fees. The app backend and CLI
   must use the same app identity, network and compatible service configuration.
   Check source collection and server readiness with Connect Data when needed;
   a local export does not prove server ingestion.
3. Inspect the app's existing Vana integration, secure configuration and storage
   interface. Implement missing app integration in that app using the public
   [SDK documentation](https://docs.vana.org/build-a-vana-app), rather than
   substituting a successful terminal read for the app's behavior.
4. Establish any required per-read and total spending limit in the quoted asset.
   Check available credit before proposing funding. Automatic free test funding
   is not assumed. Missing funds, unsupported source approval or unavailable
   services are concrete blockers, not permission to change networks or waive fees.

## Approve, read and verify the requested outcome

1. Initiate the app's existing connection flow, or use `vana app request` for
   the same app identity and requested scopes. Present the actual approval URL.
   The person completes sign-in and explicit consent. Preserve the returned
   request and grant identifiers. An existing valid grant may be reused where
   the task permits it; label that reuse instead of claiming fresh approval.
2. Drive the consuming app's actual read. Use `vana app read` when the CLI itself
   is the requested consumer or for separately agreed diagnostics. A priced
   read without `--pay` reports its quote; a paid CLI read must include the
   agreed `--max-fee`. Do not transmit payment merely because a remedy suggests it.
3. Check that recognizable records match the requested scope and person. Keep
   raw payloads private. Verify completeness against provider counts or another
   independent source where available; a nonempty response alone is insufficient.
4. If the requested result includes storage, inspect the app's real durable
   store through its existing interface. Match record identity and content to
   the received data. A response labelled "saved" is not the storage oracle.
5. If the app displays the data, open the actual app and match the rendered
   records to the saved result. When its integration requires a delivery
   acknowledgement, verify the existing acknowledgement follows the required
   save/render steps and refers to that delivery. Do not invent another API.
6. Reload and confirm the saved result persists without another paid read.
   Restart only an app process owned by this run, with the same storage and
   configuration, when restart persistence is part of the requested proof.
   Preserve existing user sessions and other running apps.

## Verify a connector change

Keep owner, app, network, scope and valid grant fixed. Make the intended change
in the connector's source and use Connect Data to rerun it through the CLI.
Check the emitted change and ingestion into the same server before refreshing
the consuming app. Then prove changed received, saved and displayed values under
the same grant, with no replacement consent unless changed access requires it.
Retain stable record identity where the change permits it. Editing an export or
the app's stored JSON does not prove connector iteration.

Record the actual trigger and elapsed collection, ingestion and app-refresh
times. Manual collection plus an app refresh does not prove automatic updates.

## Recovery and evidence

An interrupted paid read reuses its saved payment header; an interrupted
consent creation reuses its saved request intent. Follow the specific recovery
command, preserve state and stop on uncertain payment outcomes. Do not loop on
`--pay`, fund again or clear receipts to make a failure disappear. A failed new
read should preserve the app's previously saved result. An eligible
acknowledgement retry should not read or pay again.

Report each requested stage as passed, failed, blocked or reused. Name the
owner/app/network/scope, CLI and relevant source versions, commands/actions,
observed records or private hashes, storage/UI evidence and missing next action.
Record UTC times and the user's timezone. Keep credentials, cookies, raw data
and signed payment headers out of shared reports.

For a repeatable developer check, retain one result per attempt, including
source/verifier/dependency identities, assertions, substituted services,
negative controls and owned-process cleanup. A fault control must fail at its
named assertion; restore the original behavior and pass again. A setup failure
is not a successful control. Compare relevant sources, dependencies, verifier
and configuration before reusing dated evidence; mark missing comparisons blocked.
Source inspection, synthetic service responses, live consent, paid reads and
durable app delivery are separate claims. Record unavailable service revisions
as unknown rather than requiring access to private backend repositories.
