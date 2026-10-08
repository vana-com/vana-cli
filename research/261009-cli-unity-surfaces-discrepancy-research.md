# CLI and all Unity surfaces: duplication and contract discrepancies

Date: 2026-10-09, Australia/Brisbane. Status: dated source baseline, not an accepted migration plan.

Owner: this cross-repository research note in `vana-cli/research`. Revisit after changes to the producer/consumer contracts identified below; the owning source and current tests take precedence over this baseline. Existing Unity doctrine and upstream consolidation candidates remain at their current owners.

## Finding

The CLI and Unity are not two frontends over one complete implementation. They are several partly connected Vana journeys: owner collection, owner storage, builder consent and consumption, Account identity/signing, and product-specific access. There is real duplication of collection and protocol policy, legitimate host adaptation, and missing integration. Calling every personal-data function a duplicate loses those distinctions.

The highest-priority discrepancies are at usable journey boundaries: a published handoff produces inputs the current Account route rejects; a newer Personal Server produces an approval link the current Web does not implement; derived questions are unavailable on Web's enclave delivery lane; and collection completion has different meanings across hosts. Extracting a common collector alone would leave these problems intact.

## Scope and proof

Inspected current sources, callers, package declarations, selected tests, app instructions and owner contracts in:

- CLI: `/Users/callumflack/Repos/vana-com/vana-cli`, HEAD `f99bec8b235c2c5fdb2bd11875051fb0632f7bfb`.
- Unity: `/Users/callumflack/Repos/vana-com/unity-surfaces`, HEAD `da0c48be65a45468575b6142783c93ea65521985`, with existing unrelated Desktop document/UI changes. This is a working-source comparison, not a clean-commit audit.

Coverage includes every directory in Unity `apps/`: eight packaged apps plus static `open-app`, and the shared packages that own relevant contracts. Read-only research used global/project research skills and the existing data-connection verification/source-capability guidance. No app was driven; no provider collection, login, grant, signing, payment, remote mutation, or runtime test was performed. Tests cited below were inspected, not run.

CLI `node_modules` and the expected local SDK source checkout were unavailable. Unity's installed SDK 4.1.0 could be inspected; the CLI's declared SDK 4.3.1 internals could not. Findings requiring that SDK's outgoing request behavior are explicitly conditional. A source mismatch is not proof that the deployed revisions currently fail.

## Every surface and its relationship to the CLI

| Surface          | Actual responsibility                                                                                                                                                                       | Relationship to CLI                                                                                                                      |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| **Account**      | OAuth/OIDC issuer, owner identity, signing/trust policy, developer app attribution and funding, access review. Its separate data-access-request API is still mock/fixture infrastructure.   | CLI already calls this authority for login and local-server setup. Account is not another connector executor.                            |
| **Web**          | Public/light Data Pipe collection; owner storage/read adapters; Direct data-connection-request approval, scope readiness and Desktop/Mobile continuation; remote MCP setup/approval.        | CLI builder requests depend on the approval/handoff system. Web has a different acquisition and storage path from local CLI collection.  |
| **Desktop**      | Native local collection host, legacy Playwright and PDPP execution, native dialogs, Personal Server sidecar, ingest and recovery.                                                           | Substantial overlapping collection responsibilities; Node/Rust and terminal/native adapters differ.                                      |
| **Mobile**       | Hosted Next UI, connector manifests/scripts, source workflow, scope/time policy, export projection and owner-data signing/writes.                                                           | Overlapping product and data policy, but it does not run the phone's provider WebView itself.                                            |
| **Mobile shell** | Flutter/native auth, provider WebViews, PageShim transport, owner-isolated storage, snapshots/checkpoints and OS/DCR handoff. Active code still supports PS Lite and enclave rollout lanes. | A third native collection host, with necessary phone-specific execution and isolation.                                                   |
| **Community**    | First-party Account client for tasks, XP, auctions and deliveries; owner-written `vana.profile`, a Foundation grant and task verification.                                                  | Another real personal-data producer/consumer, but not a browser connector copy. Its shipping payments are distinct from CLI read escrow. |
| **Metrics**      | Reads aggregate Account/Web database and Amplitude analytics and exposes aggregate account counts.                                                                                          | Observer of journeys, not a collector. Analytics vocabulary is another compatibility surface.                                            |
| **UI**           | Deterministic component workbench, including inert Account presentation specimens.                                                                                                          | No live collection, wallet or authority implementation.                                                                                  |
| **Open app**     | Static `/continue` ticket handoff and `/connect/:sourceId` app-link, QR and installation fallback.                                                                                          | Missing from a package-only inventory. It connects Web to Mobile; it is not a collector or consent authority.                            |

Evidence: [Account policy](https://github.com/vana-com/unity-surfaces/blob/da0c48be65a45468575b6142783c93ea65521985/apps/account/src/lib/signing/client-intent-policy.ts#L29), [Web source runner](https://github.com/vana-com/unity-surfaces/blob/da0c48be65a45468575b6142783c93ea65521985/apps/web/src/features/sources/source-runner.ts#L23), [Desktop executor](https://github.com/vana-com/unity-surfaces/blob/da0c48be65a45468575b6142783c93ea65521985/apps/desktop/src/lib/data-refresh/connector-request-executor.ts#L321), [Mobile driver](https://github.com/vana-com/unity-surfaces/blob/da0c48be65a45468575b6142783c93ea65521985/apps/mobile/src/workflows/connect-flow/drivers/runtime-connect-flow-driver.ts#L322), [shell composition](https://github.com/vana-com/unity-surfaces/blob/da0c48be65a45468575b6142783c93ea65521985/apps/mobile-shell/lib/ui/shell_page.dart#L227), [Community profile write](https://github.com/vana-com/unity-surfaces/blob/da0c48be65a45468575b6142783c93ea65521985/apps/community/src/features/profile/owner-write.ts#L191), [Metrics queries](https://github.com/vana-com/unity-surfaces/blob/da0c48be65a45468575b6142783c93ea65521985/apps/metrics/src/lib/db.ts#L24), [UI fixture boundary](https://github.com/vana-com/unity-surfaces/blob/da0c48be65a45468575b6142783c93ea65521985/apps/ui/README.md#L13), [Open app handoff](https://github.com/vana-com/unity-surfaces/blob/da0c48be65a45468575b6142783c93ea65521985/apps/open-app/index.html#L230) and [source-link fallback](https://github.com/vana-com/unity-surfaces/blob/da0c48be65a45468575b6142783c93ea65521985/apps/open-app/connect.html#L193).

```text
Identity and constrained owner signing: Account
  clients: CLI / Desktop / Web / Mobile shell / Community

Data acquisition:
  CLI         → local Node connector host
  Desktop     → native Rust + Node connector hosts
  Mobile UI   → Mobile shell's WebView/PageShim host
  Web         → hosted Data Pipe for public/light sources
  Community   → owner-entered profile answers

Owner storage:
  CLI/Desktop → native Personal Server ingest
  Web/Mobile  → rollout-selected PS Lite or registry/storage/enclave path
  Community   → shared owner-data storage path

Builder request and consumption:
  CLI app     → Direct request / Web approval and continuation → grant → read
  CLI SDK     → older Session Relay / Account connect route (contract gap)
  Account DAR → separate mock/fixture exchange (not a real protocol grant)

Open app links Web ↔ Mobile. Metrics observes. UI demonstrates presentation.
```

## Concrete journey discrepancies

### 1. Published CLI legacy handoff versus current Account `/connect`

**Direct source mismatch.** CLI's public `vana-cli/server` `connect()` creates a Session Relay session and builds Account `/connect?sessionId=…&secret=…`, without `client_id`. The public React hook also falls back to a session-id URL. Current Account parses an OAuth-style handoff and requires `client_id`; its page shows an invalid state when parsing fails and requires a registered OAuth client.

Sources: [CLI producer](https://github.com/vana-com/vana-cli/blob/f99bec8b235c2c5fdb2bd11875051fb0632f7bfb/src/server/connect.ts#L30), [public hook](https://github.com/vana-com/vana-cli/blob/f99bec8b235c2c5fdb2bd11875051fb0632f7bfb/src/react/useVanaConnect.ts#L84), [Account required fields/parser](https://github.com/vana-com/unity-surfaces/blob/da0c48be65a45468575b6142783c93ea65521985/apps/account/src/app/connect/_lib/handoff-contract.ts#L29), [Account consumer](https://github.com/vana-com/unity-surfaces/blob/da0c48be65a45468575b6142783c93ea65521985/apps/account/src/app/connect/page.tsx#L70).

Implication: the package's published legacy consent path is source-incompatible with this Account checkout. This does not invalidate the newer `vana app request` Direct path. Owner/next action: CLI public API and Account handoff owners establish actual published consumers and deployed revisions, then deliberately preserve compatibility or migrate callers; these are external exports, not automatically disposable internal code.

### 2. Personal Server scope-request links have no matching Web surface

**Producer/consumer gap in current source.** CLI constructs `<web>/mcp/requests/<connection-id>?ps_origin=…` for a remote agent's request for more scopes. Searches of Web/Account routes and Web/shared owner-data source found no matching request route or scope-request approve/deny wiring. Existing `/mcp` pages implement other authorization/setup flows.

Sources: [CLI URL construction](https://github.com/vana-com/vana-cli/blob/f99bec8b235c2c5fdb2bd11875051fb0632f7bfb/src/cli/mcp-requests.ts#L67), [existing Web MCP route logic](https://github.com/vana-com/unity-surfaces/blob/da0c48be65a45468575b6142783c93ea65521985/apps/web/src/app/%28app-shell%29/%28with-nav%29/%28main%29/mcp/mcp-approval-route.ts#L1). Search boundary: `apps/web/src/app`, `apps/account/src/app`, `apps/web/src`, `packages/owner-data-client`; patterns `mcp/requests`, `scope-request/approve`, `scope-request/deny`, `request_scope_access`.

The CLI sidecar is PS 1.32.0; Web/shared PS code is 1.29.2, and CLI's comment dates scope-request answer endpoints to 1.30.0. That supports a version-skew explanation; it does not independently prove a deployed 404. Terminal approval exists. Owner/next action: Web MCP and CLI remedy owners align the route/capability contract and prove a request from the actual server version through owner decision.

### 3. Derived questions and paid reads depend on the data plane

**Explicit capability asymmetry.** `vana app ask` offers question approval followed by answer read. Web accepts questions in Direct requests, but approval preparation returns `enclave_questions_unsupported` whenever enclave delivery is selected. Owner-data Web session derivative methods also explicitly require Desktop. Separately, CLI's enclave read uses `maxPrice: 0` and refuses charged enclave reads even when `--pay` is supplied; the paid native-server read path supports escrow, fee caps and receipt replay.

Sources: [CLI ask](https://github.com/vana-com/vana-cli/blob/f99bec8b235c2c5fdb2bd11875051fb0632f7bfb/src/cli/app/ask.ts#L109), [Web question restriction](https://github.com/vana-com/unity-surfaces/blob/da0c48be65a45468575b6142783c93ea65521985/apps/web/src/app/%28app-shell%29/%28with-nav%29/%28main%29/data-connection-requests/%5Bid%5D/use-data-connection-request-flow.ts#L741), [Web session capabilities](https://github.com/vana-com/unity-surfaces/blob/da0c48be65a45468575b6142783c93ea65521985/apps/web/src/features/personal-server/web-personal-server-session.ts#L578), [CLI enclave price restriction](https://github.com/vana-com/vana-cli/blob/f99bec8b235c2c5fdb2bd11875051fb0632f7bfb/src/cli/app/read.ts#L470).

Implication: approval, compute and paid read are not uniformly available merely because a user has a Personal Server or an Account login. Owner/next action: SDK/CLI, Web approval and Personal Server owners expose and check delivery capabilities before promising the full journey.

### 4. Grant preservation and DCR completion have unproved joins

**Conditional integration risks, not exercised failures.** CLI merges a live grant when it can identify the owner. Its comments also rely on the approval page re-reading that owner's live grant and respecting `removeScopes` when local inference is unavailable or wrong. Current Web Direct parsing has no `removeScopes` field, and grant registration signs `dcr.scopes` as supplied; no approving-owner union was found. If SDK 4.3.1 still targets this route, the fallback promise is unsupported.

CLI treats approved/read-ready status as successful request completion, which is valid for obtaining a grant. Web also needs consumer acknowledgment to finish the entire DCR journey. CLI source has no explicit `acknowledgeRead`/consumer-ack call in its later read path. Web Lite can report fulfilled reads itself, but a corresponding native/enclave link was not established here. Successful CLI command completion must not be presented as proof of Web's completed delivery record.

Sources: [CLI owner/union plan](https://github.com/vana-com/vana-cli/blob/f99bec8b235c2c5fdb2bd11875051fb0632f7bfb/src/cli/app/request.ts#L84), [CLI removal payload](https://github.com/vana-com/vana-cli/blob/f99bec8b235c2c5fdb2bd11875051fb0632f7bfb/src/cli/app/request.ts#L494), [Web Direct parser](https://github.com/vana-com/unity-surfaces/blob/da0c48be65a45468575b6142783c93ea65521985/apps/web/src/app/api/data-connection-requests/route.ts#L369), [Web grant registration](https://github.com/vana-com/unity-surfaces/blob/da0c48be65a45468575b6142783c93ea65521985/apps/web/src/app/%28app-shell%29/%28with-nav%29/%28main%29/data-connection-requests/%5Bid%5D/use-data-connection-request-flow.ts#L1565), [DCR completion store](https://github.com/vana-com/unity-surfaces/blob/da0c48be65a45468575b6142783c93ea65521985/apps/web/src/lib/data-connection-requests/store.ts#L312), [Lite reporter](https://github.com/vana-com/unity-surfaces/blob/da0c48be65a45468575b6142783c93ea65521985/apps/web/src/features/personal-server/web-ps-lite-runtime.ts#L121).

Owner/next action: SDK Direct/Web DCR owners inspect the exact 4.3.1 payload and fulfillment behavior, then check existing-grant extension/removal and a read through both delivery lanes. External SDK/server behavior remains a proof gap here.

### 5. Bare app registration and Account claim disagree on metadata

**Conditional source mismatch.** CLI `app register` signs `appUrl: ""` when no URL is provided and later treats already-registered as success. Account claim fetches the gateway builder and requires a usable HTTP(S) app URL plus public key. If the gateway accepts the blank registration, the advertised subsequent claim/funding journey cannot finish. CLI claim checks registration existence rather than record completeness.

Sources: [CLI registration defaults](https://github.com/vana-com/vana-cli/blob/f99bec8b235c2c5fdb2bd11875051fb0632f7bfb/src/cli/app/register.ts#L125), [CLI claim check](https://github.com/vana-com/vana-cli/blob/f99bec8b235c2c5fdb2bd11875051fb0632f7bfb/src/cli/app/claim.ts#L157), [Account claim requirements](https://github.com/vana-com/unity-surfaces/blob/da0c48be65a45468575b6142783c93ea65521985/apps/account/src/app/api/developers/claim-builder/route.ts#L162), [URL validation](https://github.com/vana-com/unity-surfaces/blob/da0c48be65a45468575b6142783c93ea65521985/apps/account/src/lib/developers/builder-registration.ts#L183).

Owner/next action: CLI registration and Account developer owners agree the minimum gateway metadata and repair/update path, then verify register → claim → fund. Gateway acceptance was not tested.

### 6. Account Access is not a complete inventory of CLI grants

**Distinct access models.** CLI reads real Gateway grants. Account App access reads `account_action_requests` with OAuth attribution, not the DP RPC grant inventory. Its optional legacy-gateway revoke path exists, but that does not establish visibility or revocation of CLI-created grants. Account's separate DAR exchange always fabricates a `vana_grant_<requestId>` result and mock server URL; the pending browser approval is fixture-gated. Those results are not protocol grants.

Sources: [CLI grant lookup](https://github.com/vana-com/vana-cli/blob/f99bec8b235c2c5fdb2bd11875051fb0632f7bfb/src/cli/app/read.ts#L156), [Account inventory](https://github.com/vana-com/unity-surfaces/blob/da0c48be65a45468575b6142783c93ea65521985/apps/account/src/lib/account-access/repo.ts#L160), [optional revoke](https://github.com/vana-com/unity-surfaces/blob/da0c48be65a45468575b6142783c93ea65521985/apps/account/src/lib/account-access/onchain-revoke.ts#L99), [DAR mock creation](https://github.com/vana-com/unity-surfaces/blob/da0c48be65a45468575b6142783c93ea65521985/apps/account/src/lib/data-access-requests/runtime.ts#L170), [mock exchange](https://github.com/vana-com/unity-surfaces/blob/da0c48be65a45468575b6142783c93ea65521985/apps/account/src/lib/data-access-requests/runtime.ts#L315), [fixture browser gate](https://github.com/vana-com/unity-surfaces/blob/da0c48be65a45468575b6142783c93ea65521985/apps/account/src/app/data-access-requests/%5Bid%5D/page.tsx#L63).

Implication: OAuth client, builder key/address, Account attribution, Web DCR, Account POC result and enforceable grant must remain distinct. Owner/next action: Account access and protocol owners define the authoritative inventory and ID mapping before claiming cross-surface revoke coverage. Account issuer, trust and signing authority already exists and is deliberately shared; it should not be moved into CLI.

## Collection policy: real duplication and meaningful divergence

### 7. The same PDPP skip result can mean different completion

**Substantive duplicated-policy divergence.** CLI excludes skipped streams from record/checkpoint merges and exported completed scopes. An all-skipped successful connector run becomes a runtime error and leaves the prior result/state intact. Desktop uses skipped IDs to control full-refresh reset, but publishes all selected scopes and merges captured records/checkpoints; its run path has no equivalent all-skipped guard. A record/checkpoint emitted before a later skip can therefore affect Desktop durable state while CLI ignores it.

Sources: [CLI completion/merge](https://github.com/vana-com/vana-cli/blob/f99bec8b235c2c5fdb2bd11875051fb0632f7bfb/src/pdpp/store.ts#L67), [all-skipped guard](https://github.com/vana-com/vana-cli/blob/f99bec8b235c2c5fdb2bd11875051fb0632f7bfb/src/pdpp/runtime.ts#L394), [CLI regression cases](https://github.com/vana-com/vana-cli/blob/f99bec8b235c2c5fdb2bd11875051fb0632f7bfb/test/pdpp/runtime.test.ts#L268), [Desktop projection/commit](https://github.com/vana-com/unity-surfaces/blob/da0c48be65a45468575b6142783c93ea65521985/apps/desktop/src-tauri/src/commands/pdpp_runtime.rs#L1277), [Desktop reset selection](https://github.com/vana-com/unity-surfaces/blob/da0c48be65a45468575b6142783c93ea65521985/apps/desktop/src-tauri/src/commands/pdpp_runtime.rs#L1486), [Desktop state merge](https://github.com/vana-com/unity-surfaces/blob/da0c48be65a45468575b6142783c93ea65521985/apps/desktop/src-tauri/src/commands/pdpp_collection_state.rs#L215).

This is a source-derived expected outcome; no connector fixture was executed. Owner/next action: collection contract owner plus Node/Rust hosts agree skip/retention semantics and exercise identical protocol cases through both real host interfaces. Native UI does not explain this policy difference.

### 8. Collection, durable export, ingest, sync and request fulfillment are different thresholds

CLI commits local export and collection state before HTTP ingest, then tracks delivery separately. Desktop publishes an owner-scoped export before renderer ingest and checks all expected PDPP scopes and cloud sync before its synced marker. Mobile source connection succeeds when anything was written, while DCR completion requires the requested scopes; its checkpoint/snapshot commitment follows accepted delivery scopes. Community task verification accepts any live scope under the source prefix, a deliberately weaker task threshold than exact DCR readiness.

Sources: [CLI local commitment](https://github.com/vana-com/vana-cli/blob/f99bec8b235c2c5fdb2bd11875051fb0632f7bfb/src/pdpp/runtime.ts#L408), [CLI ingest outcomes](https://github.com/vana-com/vana-cli/blob/f99bec8b235c2c5fdb2bd11875051fb0632f7bfb/src/personal-server/index.ts#L149), [Desktop delivery](https://github.com/vana-com/unity-surfaces/blob/da0c48be65a45468575b6142783c93ea65521985/apps/desktop/src/hooks/useEvents.ts#L602), [Mobile source verdict](https://github.com/vana-com/unity-surfaces/blob/da0c48be65a45468575b6142783c93ea65521985/apps/mobile-shell/lib/connect/connect_run.dart#L994), [Mobile checkpoint eligibility](https://github.com/vana-com/unity-surfaces/blob/da0c48be65a45468575b6142783c93ea65521985/apps/mobile-shell/lib/connect/pdpp_connector_state_store.dart#L102), [Community evidence threshold](https://github.com/vana-com/unity-surfaces/blob/da0c48be65a45468575b6142783c93ea65521985/apps/community/src/lib/owner-data/gateway.ts#L335), [Web exact readiness](https://github.com/vana-com/unity-surfaces/blob/da0c48be65a45468575b6142783c93ea65521985/apps/web/src/features/data-connection-requests/scope-readiness.ts#L186).

Some distinctions are legitimate product rules. The discrepancy is that one informal word, “connected,” cannot prove the same outcome across these apps. The common contract should preserve separate facts: requested, completed, retained, locally durable, ingested, synced, granted and consumed. This does not require every app to have the same success UI.

### 9. Same source name does not mean the same collector or dataset

- CLI legacy collection is pinned to an upstream commit; its signed PDPP admission is WHOOP 0.1.0 only, plus explicit local connector extensions.
- Current Desktop PDPP admission is Strava 1.0.1 and WHOOP 0.1.0. Its separately pinned legacy bundle supports other sources.
- Mobile has hosted host-v1 ChatGPT/Anthropic/Strava-browser/GitHub-browser and experimental Oura-browser artifacts, plus curated legacy compatibility. Its generation workflow draws admission from a separate `pdpp-connector-cutover` branch, not the two-pin active Desktop host.
- Web public/light acquisition delegates GitHub, Instagram, LinkedIn, Spotify and YouTube to Data Pipe; Instagram posts are a separate best-effort run. It does not execute CLI connectors.

Sources: [CLI registry pin](https://github.com/vana-com/vana-cli/blob/f99bec8b235c2c5fdb2bd11875051fb0632f7bfb/src/connectors/registry.ts#L19), [CLI PDPP pins](https://github.com/vana-com/vana-cli/blob/f99bec8b235c2c5fdb2bd11875051fb0632f7bfb/src/pdpp/pins.ts#L21), [Desktop pins](https://github.com/vana-com/unity-surfaces/blob/da0c48be65a45468575b6142783c93ea65521985/apps/desktop/src-tauri/src/commands/pdpp_runtime.rs#L36), [Mobile catalog](https://github.com/vana-com/unity-surfaces/blob/da0c48be65a45468575b6142783c93ea65521985/apps/mobile/public/connectors/host-v1/index.json#L4), [Mobile release selection](https://github.com/vana-com/unity-surfaces/blob/da0c48be65a45468575b6142783c93ea65521985/.github/workflows/mobile-connector-catalog.yml#L33), [Web source authority](https://github.com/vana-com/unity-surfaces/blob/da0c48be65a45468575b6142783c93ea65521985/apps/web/src/features/sources/source-scope-authority.ts#L23).

Scope and history policy differs too: CLI normalizes generic scope names and wraps non-object payloads; Desktop preserves dotted names/bodies; Mobile uses Unity's legacy-scope projection and provider-specific history windows after a full-history run. These are not interchangeable payload contracts. Sources: [CLI resolver](https://github.com/vana-com/vana-cli/blob/f99bec8b235c2c5fdb2bd11875051fb0632f7bfb/src/personal-server/scope-resolver.ts#L27), [Desktop ingest](https://github.com/vana-com/unity-surfaces/blob/da0c48be65a45468575b6142783c93ea65521985/apps/desktop/src/services/personalServerIngest.ts#L13), [Mobile projection/write checks](https://github.com/vana-com/unity-surfaces/blob/da0c48be65a45468575b6142783c93ea65521985/apps/mobile/src/features/personal-server/owner-data-ingest.ts#L430), [Mobile history policy](https://github.com/vana-com/unity-surfaces/blob/da0c48be65a45468575b6142783c93ea65521985/apps/mobile/src/workflows/connect-flow/drivers/connector-run-input.ts#L54).

Owner/next action: upstream connector/catalog owners and each surface's capability policy make source + exact scope + runtime + payload/history guarantee explicit. Do not replace proven admission with “listed somewhere” or create another competing public scope catalog.

### 10. Scheduling and account isolation also differ

CLI schedules `collect --all --no-input` and can run PDPP with saved sessions. Desktop excludes PDPP from automatic refresh and refuses its non-interactive execution. Mobile's inspected collector workflows are user/DCR-driven; background storage sync is a different job. Sources: [CLI schedule](https://github.com/vana-com/vana-cli/blob/f99bec8b235c2c5fdb2bd11875051fb0632f7bfb/src/cli/schedule.ts#L24), [CLI PDPP trigger](https://github.com/vana-com/vana-cli/blob/f99bec8b235c2c5fdb2bd11875051fb0632f7bfb/src/pdpp/runtime.ts#L282), [Desktop exclusion](https://github.com/vana-com/unity-surfaces/blob/da0c48be65a45468575b6142783c93ea65521985/apps/desktop/src/hooks/use-data-refresh-coordinator.ts#L231), [Desktop refusal](https://github.com/vana-com/unity-surfaces/blob/da0c48be65a45468575b6142783c93ea65521985/apps/desktop/src/lib/data-refresh/connector-request-executor.ts#L321).

Desktop/Mobile explicitly partition provider browser storage by owner. CLI owner-keys collection snapshots, but its host profile root/legacy source profile paths do not supply the same owner binding. The connector may choose an additional partition itself, so this is an isolation-proof gap, not a demonstrated leak. Sources: [Desktop lease ownership](https://github.com/vana-com/unity-surfaces/blob/da0c48be65a45468575b6142783c93ea65521985/apps/desktop/src-tauri/src/commands/pdpp_browser.rs#L61), [Mobile profile](https://github.com/vana-com/unity-surfaces/blob/da0c48be65a45468575b6142783c93ea65521985/apps/mobile-shell/lib/connect/connector_profile.dart#L1), [CLI host input](https://github.com/vana-com/vana-cli/blob/f99bec8b235c2c5fdb2bd11875051fb0632f7bfb/src/pdpp/runtime.ts#L262), [CLI browser profile](https://github.com/vana-com/vana-cli/blob/f99bec8b235c2c5fdb2bd11875051fb0632f7bfb/src/runtime/playwright/browser.ts#L447).

Owner/next action: host owners state supported unattended modes and verify account switching at the provider-profile boundary. Sharing implementation must preserve separate data directories, credentials and native storage authority.

## Reuse, copied mechanics, and stale maps

### Existing reuse

CLI already uses SDK protocol/header/Session Relay primitives. Unity already shares runtime-neutral Personal Server contracts, source vocabulary, legacy-scope projection, Account browser transport and owner-data clients across relevant apps. Connector authoring and Personal Server core remain external. CLI's installer is a vendored upstream copy; Desktop uses the upstream installer through a bridge, at a different pin. They share lineage, not proven byte-identical current revisions.

Sources: [CLI SDK wrapper](https://github.com/vana-com/vana-cli/blob/f99bec8b235c2c5fdb2bd11875051fb0632f7bfb/src/server/session-relay.ts#L1), [installer provenance](https://github.com/vana-com/vana-cli/blob/f99bec8b235c2c5fdb2bd11875051fb0632f7bfb/src/vendor/pdpp-connector-manager/VENDOR.md#L3), [Desktop bridge pin](https://github.com/vana-com/unity-surfaces/blob/da0c48be65a45468575b6142783c93ea65521985/apps/desktop/pdpp-installer-bridge/package.json#L10), [Unity owner-data client](https://github.com/vana-com/unity-surfaces/blob/da0c48be65a45468575b6142783c93ea65521985/packages/owner-data-client/src/owner-data-client.ts#L1), [Unity app runtime](https://github.com/vana-com/unity-surfaces/blob/da0c48be65a45468575b6142783c93ea65521985/packages/app-runtime/package.json#L6).

### Concrete candidates for consolidation

CLI's escrow authorization helper explicitly mirrors Account's EIP-3009 fields, beneficiary-nonce construction, domain checks and signature normalization. This is protocol helper duplication; terminal/local app-key funding and Account browser-wallet/ownership guards are legitimate adapters. The shared owner-data client explicitly mirrors Personal Server sync workers' storage/registry write and conflict behavior, while CLI delegates that behavior to its server. Collection skip/merge/completion and scope output are independently governed in Node/Rust/Dart. These are stronger candidates than merely comparing similarly named UI handlers.

Sources: [CLI mirrored escrow](https://github.com/vana-com/vana-cli/blob/f99bec8b235c2c5fdb2bd11875051fb0632f7bfb/src/core/escrow-authorization.ts#L1), [Account helper](https://github.com/vana-com/unity-surfaces/blob/da0c48be65a45468575b6142783c93ea65521985/apps/account/src/lib/developers/escrow-authorization.ts#L50), [owner-data worker mirror](https://github.com/vana-com/unity-surfaces/blob/da0c48be65a45468575b6142783c93ea65521985/packages/owner-data-client/src/owner-data-client.ts#L60).

The CLI's exported runtime is not a full cross-surface engine: it exports legacy managed Playwright, not its internal PDPP host; Unity does not depend on `vana-cli`. Existing March CLI architecture described a thin CLI over reusable orchestration, but current owner orchestration still lives heavily in `src/cli/index.ts`. Sources: [public runtime exports](https://github.com/vana-com/vana-cli/blob/f99bec8b235c2c5fdb2bd11875051fb0632f7bfb/src/runtime/index.ts#L1), [owner orchestration](https://github.com/vana-com/vana-cli/blob/f99bec8b235c2c5fdb2bd11875051fb0632f7bfb/src/cli/index.ts#L1797), [historical intended layering](https://github.com/vana-com/vana-cli/blob/f99bec8b235c2c5fdb2bd11875051fb0632f7bfb/docs/CLI-SDK-ARCHITECTURE.md#L42).

### Version and configuration skew

| Boundary                   | CLI                           | Unity                                                                                       |
| -------------------------- | ----------------------------- | ------------------------------------------------------------------------------------------- |
| SDK declaration            | 4.3.1                         | Account/Web/Desktop/Mobile/Community 4.1.0                                                  |
| Native/Lite PS declaration | CLI wrapper/core 1.32.0       | Desktop/Web and Mobile Lite 1.29.2                                                          |
| Dev builder gateway        | `dp-rpc-dev.vana.org`         | Shared Moksha network config uses `dp-rpc.moksha.vana.org`                                  |
| Owner data plane           | Local/self-hosted HTTP ingest | Native PS, tab/native Lite, or owner registry/storage/enclave, depending on surface/rollout |

Sources: [CLI package](https://github.com/vana-com/vana-cli/blob/f99bec8b235c2c5fdb2bd11875051fb0632f7bfb/package.json#L115), [CLI sidecar](https://github.com/vana-com/vana-cli/blob/f99bec8b235c2c5fdb2bd11875051fb0632f7bfb/src/personal-server/local/runtime-pkg/package.json#L7), [Unity Web package](https://github.com/vana-com/unity-surfaces/blob/da0c48be65a45468575b6142783c93ea65521985/apps/web/package.json#L29), [Mobile Lite package](https://github.com/vana-com/unity-surfaces/blob/da0c48be65a45468575b6142783c93ea65521985/apps/mobile-shell/ps_bundle/package.json#L10), [CLI dev configuration](https://github.com/vana-com/vana-cli/blob/f99bec8b235c2c5fdb2bd11875051fb0632f7bfb/src/core/network.ts#L74), [Unity network/environment configuration](https://github.com/vana-com/unity-surfaces/blob/da0c48be65a45468575b6142783c93ea65521985/packages/app-runtime/src/personal-server/environment.ts#L127).

Different versions/URLs are observations, not proof that either endpoint is wrong. Independent configuration owners and staggered rollout make producer/consumer compatibility checks necessary.

### Documentation is concealing some of the current shape

Mobile-shell README says PS Lite is retired; active shell composition still lazily creates `PsService` and an export sink whose Account rollout selects legacy Lite, owner-data/enclave or paused. The hosted Mobile route also selects these lanes. This is active wiring, not simply leftover files; the deployed distribution was not checked. Sources: [retirement claim](https://github.com/vana-com/unity-surfaces/blob/da0c48be65a45468575b6142783c93ea65521985/apps/mobile-shell/README.md#L8), [live composition](https://github.com/vana-com/unity-surfaces/blob/da0c48be65a45468575b6142783c93ea65521985/apps/mobile-shell/lib/ui/shell_page.dart#L227), [live sink routing](https://github.com/vana-com/unity-surfaces/blob/da0c48be65a45468575b6142783c93ea65521985/apps/mobile-shell/lib/connect/export_sink.dart#L518).

Unity's unification tracker still describes owner-to-server lookup as an on-chain stopgap, while the owning helper now wraps the indexed owner endpoint with health gating. That is a stale gap, not another missing service. Sources: [old tracker entry](https://github.com/vana-com/unity-surfaces/blob/da0c48be65a45468575b6142783c93ea65521985/docs/unification-gaps.md#L7), [current lookup owner](https://github.com/vana-com/unity-surfaces/blob/da0c48be65a45468575b6142783c93ea65521985/packages/vana-account-client/src/personal-server-lookup.ts#L1).

Metrics reads Amplitude connect-v2 vocabulary, while CLI sends a manually mirrored Context Gateway telemetry contract to the telemetry endpoint. This comparison did not trace the external ingestion/translation service; comparable dashboard coverage is unproved, not proven absent. Sources: [Metrics vocabulary](https://github.com/vana-com/unity-surfaces/blob/da0c48be65a45468575b6142783c93ea65521985/apps/metrics/src/lib/connect-v2.ts#L1), [CLI external contract](https://github.com/vana-com/vana-cli/blob/f99bec8b235c2c5fdb2bd11875051fb0632f7bfb/src/cli/telemetry-contract.ts#L1), [CLI destination](https://github.com/vana-com/vana-cli/blob/f99bec8b235c2c5fdb2bd11875051fb0632f7bfb/src/cli/telemetry-contract.ts#L222).

## What the evidence supports doing next

These are proposed priorities, not authorization or a newly adopted architecture:

1. **Repair the usable journey joins first.** Resolve the legacy CLI/Account handoff, Web MCP request route, ask/delivery capability and register/claim metadata contract. Prove each at its actual app/server boundary and deployed revision.
2. **Make the access model explicit.** Map OAuth identity, app key, Account attribution, request IDs and enforceable grant IDs. Establish one authoritative grant inventory/revoke source; keep POC results and audit records separate.
3. **Agree collection semantics before extracting code.** Reuse the real connector/protocol owner for scope output, skips, retention, cursor commitment and completion facts. Run common conformance inputs through Node, Rust and Dart hosts. Different native transports can conform without importing the same Node executable.
4. **Consolidate protocol mechanics at their existing owner.** SDK/protocol owns shared signing/payment/grant mechanics; Account retains identity/signing authority; connectors retain extraction/artifact contracts; Personal Server retains data-plane implementation; Unity and CLI retain their product and host adapters. Review the worker-mirror duplication against those actual owners rather than creating a catch-all Unity or CLI engine.
5. **Reconcile current maps and capability claims.** Source/scope/runtime admission, delivery mode, history policy, versions and deployed support must travel together. Correct stale owner docs as separate scoped work; do not infer feature parity from a source card or the word Personal Server.

Existing preservation: Unity already owns [SDK consolidation candidates](https://github.com/vana-com/unity-surfaces/blob/da0c48be65a45468575b6142783c93ea65521985/docs/vana-sdk-consolidation-candidates.md#L1) and [Direct app doctrine](https://github.com/vana-com/unity-surfaces/blob/da0c48be65a45468575b6142783c93ea65521985/docs/system/direct-vana-data-app-contract.md#L1). The former's audited SDK 3.15.0 baseline is older than these checkouts; its owner placement remains relevant, but its app-specific status was not re-audited here. This note adds the CLI/all-surface comparison rather than duplicating that tracker or creating new rules. The research is preserved at this project owner; a second KB copy would duplicate already-owned material.

## Limits remaining

- Actual SDK 4.3.1 request payload, acknowledgment and external server reporting behavior.
- Deployed Account/Web revisions, rewrites, rollout settings and mobile build distribution.
- Cross-host SKIP, cancellation, partial delivery, replay and account-switch behavior exercised through the real interfaces.
- Gateway acceptance/update behavior for blank builder metadata and a complete claim/fund round trip.
- Complete enforcement-level grant visibility/revocation across native and enclave data planes.
- Translation between CLI telemetry and the Metrics/Amplitude observation contract.

Those checks have named owners above. They are not performed or claimed by this source research. No implementation, dependency update, commit, push, CI or deployment is part of this result.

## Architectural direction: one plumbing infrastructure, CLI as executable schematic

**You’re right about the direction. The CLI makes the existing divergence easier to see—and adds another implementation of parts of it.** Your question is stronger than “how much code is duplicated?”

I’d tighten your principle to:

> Each plumbing responsibility has one authoritative owner and contract, with one implementation wherever practical. Every surface—including the CLI—uses that owner through the adapters its runtime requires. Surface code owns the experience, not independent versions of the underlying rules.

That means **one coherent infrastructure with multiple capabilities**: identity, signing, collection, storage, grants, payments and delivery. Each capability can live in its appropriate package or service.

For the same operation, all surfaces should agree on:

- What inputs and authority it requires.
- What it does and which state it changes.
- What success, partial completion, cancellation and failure mean.
- What evidence proves completion.

Where runtimes permit, they should call the same implementation. Where they don’t, separate adapters should implement the same contract and pass the same behavioral cases. A phone WebView and a Node browser need different execution machinery; they shouldn’t independently invent what a skipped stream means.

**The qualification is “the same operation.”** Public-profile collection and private-account export may require different providers. Owner reads and builder paid reads require different authority. Those distinctions belong explicitly in the common plumbing rather than emerging accidentally from whichever app implemented them.

Your CLI idea is good too: **the CLI should be an executable schematic of that infrastructure.** Its commands should expose the underlying capabilities, state transitions and outcomes clearly enough that someone can understand and diagnose the system through it. A CLI command should exercise the same plumbing an app uses.

That does require separating the CLI’s terminal behavior from the capabilities underneath it. Some browser and mobile handshakes will still require a person or device; the CLI can expose their initiation, status and result without pretending to perform every native step.

So I’d correct the line of questioning to:

> **Why do our surfaces independently own rules for the same plumbing operations? What is the canonical owner of each operation, and can every surface consume it—with the CLI providing the clearest executable map of the system?**

That’s the architectural problem the research supports. The next step is to map those operations and their competing owners, then decide which implementation becomes authoritative. Code extraction follows that decision.

## Why isn't the CLI part of Unity Surfaces?

**If we understand the CLI as the schematic for our plumbing, it makes sense in Unity Surfaces.** Nothing in the architecture I found requires it to be separate. I found no documented decision specifically explaining its exclusion.

The current [Unity boundary](https://github.com/vana-com/unity-surfaces/blob/da0c48be65a45468575b6142783c93ea65521985/docs/adr/0001-app-surface-boundary.md) separates product/account surfaces from the surrounding SDK, connector and Personal Server implementations. The CLI currently combines a terminal surface with SDK and runtime responsibilities, and publishes independently.

That explains the current arrangement. It doesn’t establish that the arrangement is necessary. The CLI’s own [architecture document](https://github.com/vana-com/vana-cli/blob/f99bec8b235c2c5fdb2bd11875051fb0632f7bfb/docs/CLI-SDK-ARCHITECTURE.md) explicitly says it could live in a monorepo and that the CLI should be thin, with business logic underneath it.

**Under this model, the CLI belongs alongside Web, Desktop and Mobile as another Vana surface.** It could live at `apps/cli`, keep its npm package, signed binaries and release cadence, and consume the same canonical capabilities through Node adapters.

The plumbing still needs explicit owners: Account for its authority, Personal Server for its responsibilities, shared packages or services for the other capabilities. Repository membership doesn’t require moving every implementation into Unity.

So the question is fair: **if the CLI is the schematic for our plumbing, why the fuck isn’t it in Unity Surfaces?** Why is a Vana-owned surface maintained separately while independently implementing overlapping plumbing? The documented boundaries don’t adequately answer that. Moving it into Unity could make shared ownership easier, but the substantive change is making every surface consume those same owners.
