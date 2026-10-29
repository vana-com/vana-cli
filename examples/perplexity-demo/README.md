# Perplexity demo — Research Shelf

A separate Next.js example based on the existing starter. It requests `perplexity.conversations`, reads through the app's own Moksha grant, saves conversation titles and update times locally, renders them, then acknowledges delivery. The original ChatGPT `nextjs-starter` is unchanged.

The server refuses payments by default. Explicit Moksha opt-in, a per-read cap and a total cap are all required before it can transmit a payment, including replay of an existing signed receipt. No owner-key read, Mainnet payment, automatic faucet, Desktop dependency or Registry work is included.

## Choose one app identity

Use the same dedicated Moksha app throughout the CLI, Account and this backend. Claiming the app in Account is separate from approving data access.

```sh
vana app whoami --network moksha --json
```

If you need a new identity, register it deliberately, rather than silently replacing an existing app:

```sh
vana app register --network moksha --app-name "Perplexity CLI demo" --app-url http://localhost:3090
vana app claim --network moksha
```

Open the signed claim link in the intended Account and add the app. Reusing a suitable registered Moksha identity is also supported. Its registered app URL must match this example's `APP_URL`.

Copy `.env.local.example` to `.env.local` and set:

| Setting            | Meaning                                                                                                                                                                                                    |
| ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `VANA_PRIVATE_KEY` | The **same app private key** the CLI selects through `VANA_APP_KEY` or its credential store. This is not the owner's wallet/master key. `VANA_APP_PRIVATE_KEY` is accepted if `VANA_PRIVATE_KEY` is unset. |
| `VANA_APP_ADDRESS` | The address reported by `vana app whoami`. Startup rejects a key/address mismatch.                                                                                                                         |
| `APP_URL`          | `http://localhost:3090` for this local example, matching registration and the signed return URL.                                                                                                           |
| `VANA_ENV`         | `prod` for `app.vana.org`/`account.vana.org`, as used in preflight; `dev` selects the development Vana hosts. Both use Moksha because the controller fixes `network: "moksha"` independently.              |

Keep the key server-only. Do not prefix it with `NEXT_PUBLIC_`, commit it, print it in shell output or place it in a browser/request body. Injecting it into the Next process environment is also supported; a plaintext `.env.local` is optional. The example never generates another key or reads owner credentials.

## Prepare real conversations and serving

The verified preflight combination is CLI 0.41.7, SDK 4.3.1, Personal Server 1.33.8 and Perplexity connector 0.1.1 (Collection Profile 0.1.0), on Moksha chain 14800. The CLI selected Node 24.22.1 for the connector. Recheck compatibility before changing these pins; this example does not migrate the runtime or ingestion format.

Sign into the intended Vana account, then start its Personal Server. The installed standalone CLI's background launcher failed during preflight, while its supported foreground mode worked:

```sh
vana login --network moksha
vana server start --network moksha --foreground --yes
```

Keep that terminal/process running. The first start needs Account's owner-authorization confirmation. A later noninteractive foreground start may add `--no-input` after that confirmation is saved. This setup does not survive a reboot automatically.

In another terminal, collect conversations only from a local checkout of the existing connector:

```sh
vana connect perplexity --from /path/to/data-connectors --streams conversations --network moksha --yes --ipc
vana server status --network moksha --json
```

Sign into the connector's separate secure Perplexity browser and complete any provider human check yourself. The connector verifies the session before continuing. Respect its one-hour minimum refresh interval. Do not repeat collection merely to get another passing run or edit exported JSON to stand in for a connector change.

Verify a healthy, reachable owner-bound server, the exact `perplexity.conversations` scope, successful ingestion and real owner-authorized readback through the public serving path. A successful local export, an advancing version or a catalogue entry alone is insufficient. Perplexity must still be unfamiliar to the target Vana approval catalogue for the owner-only approval milestone; do not hide or rename a listed source to force that state.

## Fund the app manually

Get Moksha test VANA from the [faucet](https://faucet.vana.com/moksha), sending it to the **app address**. Complete the site's human steps and wait for the actual chain balance; a submitted faucet request is not a payout. Retain enough native VANA for gas.

```sh
vana app escrow fund --network moksha --amount 1
vana app escrow balance --network moksha --json
```

Use the normal escrow path and check that the deposit is finalized with positive available balance. Do not use an owner-key shortcut or disable fees. A future paid read must check the current fee quote and a configured cap; a funded balance is not itself proof of successful app delivery. Reading may spend test VANA only after the opt-in and caps below are configured.

## Run and review

From the repository root:

```sh
pnpm install --frozen-lockfile
pnpm --filter perplexity-demo dev
```

Open `http://localhost:3090` in a desktop browser. **Connect with Vana** signs a request with the selected app key, opens approval and polls status. **Open approval** remains available if the popup is blocked. Creation/status failures, denial and expiry produce an actionable error; **Start again** resets the flow.

Both `dev` and `start` bind to `127.0.0.1`. After building, use `pnpm --filter perplexity-demo start` to review the production build on the same local URL.

## Enable bounded test reads

Add server-only configuration deliberately:

```dotenv
VANA_ALLOW_MOKSHA_PAYMENT=true
VANA_MAX_FEE=0.02
VANA_MAX_TOTAL=0.04
```

Amounts are native Moksha VANA (18 decimals). These examples permit the observed 0.011 quote; recheck the current fee and finalized available escrow before choosing limits. `VANA_MAX_TOTAL` is a conservative authorization budget for each app/environment/owner/grant/scope ledger, including uncertain transmissions. It is not a chain accounting total. Reconnecting a browser does not reset it. Lowering or disabling the policy also blocks transmission of retained payment headers.

The example supports the selected pinned server's `grant` challenge. A changed payment scheme, network, asset, invalid challenge, increased quote, insufficient finalized escrow or cap violation stops before signing. Transport retries are disabled. A payment is persisted before transmission; the received server envelope is also saved privately before decoding into titles; an uncertain response retains and replays the same signed header instead of signing another charge for the same operation. New connector data versions can require a new bounded authorization.

`VANA_SHELF_DIRECTORY` selects a **private local** writable directory (default `.research-shelf`, gitignored). Files contain saved titles, trusted grant/server bindings and signed payment receipts. Directories use mode 0700, files 0600 and writes use fsync plus atomic rename. Do not publish this directory or its contents. The browser receives an opaque HttpOnly cookie and saved titles, never private keys, payment headers or a browser-selectable grant/server URL. This local single-owner example is not hosted multi-user authentication.

App/environment changes invalidate the session. The app rechecks live grant ownership, scope, expiry/revocation and the registered owner-bound server before a new read. A failed read preserves the earlier saved list. `/api/acknowledge` only accepts the exact saved revision; the UI invokes it after that list commits to the DOM. Confirmation failure offers a separate retry without rereading or repaying.

For an existing **local dev** approval test, set `VANA_APPROVAL_URL=http://localhost:3083` with `VANA_ENV=dev`. `VANA_RESUME_REQUEST_ID=dcr_...` may resume a deliberately selected existing approval server-side, checking its live grant/binding first; it does not mint consent or bypass a pending/refused approval. Leave it unset for normal Connect/new-request behavior.

### Interrupted-process recovery

The store fails closed if an action lock survives a process crash. Each `.lock` file records its process ID and creation time. Stop the owned demo process, confirm the recorded PID no longer exists and no other process is serving this store, then remove **only that abandoned `.lock` file** before restarting. Retain the connection and payment JSON files: deleting those would lose uncertain-payment protection and spending history. A live/unknown owner is not permission to clear a lock. Errors caught by a running process release their lock normally.

The Web owner-only unfamiliar-source approval is BUI-924's separate dependency. If Vana cannot approve Perplexity yet, keep the refusal visible; do not manufacture consent, substitute a public source or use owner credentials. The result is complete only when real conversations are saved and rendered and Vana receives acknowledgement. Mobile/Desktop app handoffs, the public Registry and connector publication are outside this example.

## Verify

```sh
pnpm test test/examples/perplexity-demo.test.ts test/examples/nextjs-starter.test.ts examples/perplexity-demo/src/components/ConnectFlow.test.js
pnpm --filter perplexity-demo build
```

Route tests use fixed local HTTP responses with the real SDK and public Hardhat identity. They verify normal app-key payment signatures, spending and grant refusals, reconnect/restart receipt recovery, actual private-file persistence, no acknowledgement before saving, and separate acknowledgement retry. They do not establish live provider collection, real paid delivery, browser rendering or the changed-output loop.

The component regression renders the actual connection flow with delayed synthetic responses. It checks that a late saved-data snapshot cannot replace a newer delivered result, while ordinary saved-data restoration still works.

## Live proof: distinct outcomes

Use the maintained [connection verification evidence rules](https://github.com/vana-com/unity-surfaces/blob/a87843f90b9b570ce493e769d348b1a869a9ebae/.agents/skills/us-verify-data-connection-workflow/references/evidence-and-reruns.md) from merged #1933. Keep one private result per attempt with exact CLI/SDK/server/demo revisions, configuration, request/grant references, timestamps, actions and failures. Record these separately:

1. CLI emitted and synced real conversations.
2. The app's grant returned the selected scope through the public server path; record the current fee, budget and actual payment/grant status.
3. The app durably saved a recognizable stable thread ID/title/time, then displayed that saved value in its actual browser route.
4. Acknowledgement succeeded after persistence and rendering. `approved`, HTTP 200 or `completed` alone is insufficient proof of all four.

Keep private titles and raw payloads outside Git/Linear. A successful server access log with no saved demo result is a failed consumer-delivery attempt, not end-to-end success. Preserve its receipt and cost; a fresh charged attempt requires an explicit operator decision rather than automatic replacement. Compare saved content to what the browser actually displays, and retain failure attempts rather than relabelling them. A grant's chain finalization and consumer acknowledgement are separate observations.

[Motel composition guidance](https://github.com/vana-com/unity-surfaces/blob/a87843f90b9b570ce493e769d348b1a869a9ebae/.agents/skills/us-verify-with-motel/SKILL.md) is optional diagnosis. Its existing exporter is Desktop-specific and does not capture this example. Use existing request/payment/save evidence first; add app-owned, metadata-only probes only for a concrete unresolved failure. Do not launch Desktop, upgrade Personal Server or build an observability programme for this milestone.

## Iterate through the same grant — BUI-932

After reload, the app first restores its saved connection before offering any connection action. Saved conversations keep the **Conversations saved** status and **Read latest** action; reviewing access again remains an explicit recovery action.

After the first result is saved, displayed and acknowledged, **Read latest** performs a fresh SDK read using the owner/app/network/grant/server binding retained privately by the backend. It accepts no grant, server, scope or request overrides from the browser and does not reopen the completed Direct request. The backend rechecks the live grant and owner-bound server. If access has expired or been revoked, the saved list stays visible and **Review access again** is available. Funding and transient server errors remain read/funding problems.

Every deliberately fresh read can incur the current capped test-VANA fee. Earlier successful receipts remain in private history; a failed or uncertain fresh attempt reuses its own receipt instead of authorizing another fee. A delivered body that has not been decoded/saved, or a saved response lost before the browser received it, is recovered before another paid read. Acknowledgement follows rendering of the recovered/new revision. The BUI-931 ledger is adopted only when its saved, acknowledged revision matches its retained received body; uncertain legacy payments are not relabelled as successful.

To prove a connector change:

1. Record one real conversation's stable ID and current title in private evidence. Keep the same app, grant, owner, network and conversations scope.
2. In an isolated, unpublished checkout of the **same connector version**, edit `connectors/perplexity/parsers.ts` so `conversationRecord` prefixes only that record's returned title with `CLI edit — `. Keep its ID and scope unchanged and respect the title's 500-character bound. Do not edit exported JSON, the app's saved list or synthetic fixtures.
3. Rerun `vana connect perplexity --from /path/to/edited/data-connectors --streams conversations --network moksha --yes --ipc`. The selected 0.1.1 conversations-only path emits its listed conversations on every run; do not clear cursors, bypass refresh limits or import messages merely to force an update. Keep the CLI receipt and prove that the actual emitted record contains the changed title.
4. Verify ingestion and serving of the changed payload on the same owner-bound server. A new version number alone is insufficient. Record any manual setup/copy assistance explicitly; a development-wallet copy is not automatic CLI delivery.
5. After the original Direct request is complete, click **Read latest**. Prove a new saved revision with the changed title in the real demo, using the same grant, then observe acknowledgement after rendering. Record the current fee, preserved previous receipts and total authorized amount. Refresh the page to verify the saved result survives.

The local connector edit is an acceptance experiment, not a connector publication or upstream feature. Keep its private record ID and real data outside this repository. Mainnet, native per-account delivery, publishing, review and the public Registry remain separate.
