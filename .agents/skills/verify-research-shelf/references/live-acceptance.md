# Verify live steps 4 and 5

Use this procedure for actual Account/Web consent, real provider collection and
changed connector output. The controlled helper is consumer proof only. Start
with the [existing example README](../../../../examples/perplexity-demo/README.md)
and the public Builder [delivery and evidence rules](../../../../skills/builder/reference/verification.md).
Retained reports keep their original time and scope.

## Establish readiness and authority

1. Record CLI, example, connector, SDK and Personal Server revisions, dirty files,
   installed versions, Account deployment and network. Use the intended app and
   owner. Record service revisions as unknown when they cannot be established.
2. Require an identified account, provider session, app configuration, owner-bound
   server and private store. Require the exact collection scope and explicit
   per-read and total budget before fresh collection, consent or paid transmission.
   A historical cap is not authorization for another attempt. Without those
   inputs, record their clauses blocked and continue only independent checks.
3. Resolve the built CLI from this checkout. Inspect without collecting or paying:

   ```sh
   node dist/cli/bin.js --version
   VANA_ENV=dev node dist/cli/bin.js whoami --network moksha --json
   VANA_ENV=dev node dist/cli/bin.js status --network moksha --json
   VANA_ENV=dev node dist/cli/bin.js app whoami --network moksha --json
   VANA_ENV=dev node dist/cli/bin.js app escrow balance --network moksha --json
   ```

   These examples select dev/Moksha. Preserve an explicitly selected Account URL
   and app key reference. Do not switch identity to make readiness pass. Keep
   account-identifying output private.

4. Check port 3090 ownership before launch. An existing instance must have known
   app/store/build identity and one authorized browser driver. Reuse it only for
   the agreed run. Otherwise follow the example README's configuration and start
   an owned `pnpm --filter perplexity-demo dev` session. Preserve its returned PID.
   Missing configuration is blocked, not permission to retrieve credentials.
5. Use a fresh named browser through the installed browser tool. Start recording
   before the first action. Capture actual app URL, browser version and viewport,
   API method/status/timing, screenshots and private request/grant references.
   Observe network metadata without exporting cookies or payment headers.

## Prove step 4

1. Open Research Shelf and choose **Connect Vana**. Record the request creation
   and entry into the real Web approval page. Have the person complete required
   Account sign-in/signing and explicit approval. Observe the actual requested
   app, owner, network and `perplexity.conversations` scope.
2. Follow the return to the same app connection. Record the actual app-key read
   and current bounded payment evidence. A successful approval or served receipt
   alone is insufficient.
3. Privately compare one stable record ID and title/time in the received response,
   durable saved revision and actual rendered DOM. Hash sensitive values for the
   report. Record the save before its delivered response and the DOM before the
   matching acknowledgement. Use the app's actual private file as the durable
   oracle, not a response labelled saved.
4. Reload and confirm the saved content is restored without another paid read.
   When the run owns the server, stop and restart that PID with the same private
   store and configuration, then repeat the retained-content check. If restart
   authority is absent, mark that clause blocked rather than restarting a shared
   instance.

## Prove step 5

1. Retain the delivered app, owner, network, scope, server, grant and record ID.
   Record baseline hashes and the original request's completion status.
2. Use an isolated, unpublished copy of the existing Perplexity connector. Follow
   the example README's BUI-932 source-edit procedure. Change only the selected
   real record's emitted title in `connectors/perplexity/parsers.ts`. Preserve the
   record ID, scope, version and title length. Save the source diff privately.
3. Run the supported collection command from the CLI checkout, replacing only the
   reviewed connector path:

   ```sh
   VANA_ENV=dev node dist/cli/bin.js connect perplexity --from /absolute/path/to/edited/data-connectors --streams conversations --network moksha --yes --ipc
   ```

   Handle human input through the public Connect Data skill. Install with
   `vana skills install connect-data --json` if needed and read the returned
   `installedPath`'s `SKILL.md`. Preserve provider refresh limits and
   cursors. Verify the actual emitted record and successful ingestion into the
   same owner-bound server. A copied export or edited JSON cannot pass this clause.

4. Under the agreed read budget, choose **Read latest**. Prove the same grant and
   binding, no replacement consent request, changed response, new durable revision,
   matching DOM, acknowledgement after render and retained value after reload.
5. Record action timestamps and elapsed collection, ingestion and consumer-refresh
   durations. State that the observed trigger is manual rerun plus **Read latest**.
   Leave automatic propagation and any undefined immediacy target unverified.

## Recover, decide and clean up

A failed fresh read must preserve earlier saved content. An uncertain payment
must retain its existing header/operation. Use the app's confirmation retry for
an eligible lost acknowledgement, and prove that it sends neither another data
read nor another payment. Exercise faults only in an isolated authorized setup.
The controlled helper's storage control never licenses faults in personal data.

Write one private `result.md` with each clause passed, failed, blocked or reused.
Include action/evidence paths, UTC times, original local timezone, revisions,
configuration identity, fees authorized and actual transmission observations,
source diff, response/file/DOM hashes and acknowledgement ordering. Unknown
settlement is separate from saved-and-acknowledged delivery. Keep failed attempts.

Restore the run's temporary connector edit and any deliberately changed server
selection. Preserve data and payment history. Close only owned browser and server
sessions. Confirm evidence survives cleanup. Report fresh proof separately from
reused evidence and controlled-service results. Live full acceptance requires all
requested clauses, not a passing controlled helper.

## Observe the authorized live run with Motel

Use one private correlation context for the CLI, app and browser observer. Create a private directory and a JSON file with `{run, salt, mode: "live", file}`. `run` is a new UUID, `salt` is 32 random bytes encoded as 64 hex characters and `file` is an absolute JSONL path in that directory. Keep the file and salt private. Add the selected request/grant IDs only in this local context after they are known; exports contain keyed aliases only. Separate pre-consent collection events remain explicitly unlinked until a verified mapping exists.

Set the app's four `VANA_SHELF_OBSERVABILITY_` settings from that context using the app-owned contract. Launch the current instrumented app with the existing identity, private store and approved caps. Do not assume an older running build emits the new observations. Start or doctor the collector before the first action. The existing Desktop exporter is not used for this journey.

For a separately authorized real collection, use the fixed-scope wrapper instead of an unobserved collection command:

```sh
node .agents/skills/verify-research-shelf/scripts/observe-collection.mjs --context /absolute/private/context.json --from /absolute/path/to/edited/data-connectors --allow-collection
```

The wrapper runs the real CLI for Perplexity conversations and observes its existing collection and ingestion terminal events. It excludes payloads from observation output. Collection completion alone never implies ingestion. Missing terminal events remain unknown. The wrapper does not authorize a paid app read or data consent.

After the run, export and query the same JSONL using the adapter's documented CLI:

```sh
node .agents/skills/verify-research-shelf/scripts/motel.mjs --help
```

Follow that command's explicit file/run/endpoint/evidence arguments. Preserve the real query records and inspect run/request/grant/revision matches, coverage, pagination and diagnoses. Use actual observer events and independent browser/storage assertions together. Do not manufacture render or collection events from expected outcomes. Cross-service observations still missing at an owning boundary remain blocked. No live acceptance follows from the controlled collector tests.
