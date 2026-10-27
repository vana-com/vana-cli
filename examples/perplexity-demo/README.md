# Perplexity demo — Research Shelf

A separate Next.js example based on the ChatGPT starter. It creates signed Vana requests for `perplexity.conversations` on Moksha and shows the connection state beside an empty thread-list view. The original `nextjs-starter` is unchanged.

This is BUI-929's connection/setup slice. `/api/data` returns HTTP 501 with `read_not_enabled`: it does not read data, authorize payment, persist threads or acknowledge delivery. The controller also refuses every Personal Server 402 before the SDK can sign a payment. The next slice, BUI-931, supplies the bounded paid read, save and display. BUI-932 supplies Read latest through the same grant after a connector edit. No fabricated conversation data is shown.

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

Use the normal escrow path and check that the deposit is finalized with positive available balance. Do not use an owner-key shortcut or disable fees. A future paid read must check the current fee quote and a configured cap; a funded balance is not itself proof of successful app delivery. This version deliberately does not spend escrow.

## Run and review

From the repository root:

```sh
pnpm install --frozen-lockfile
pnpm --filter perplexity-demo dev
```

Open `http://localhost:3090` in a desktop browser. **Connect with Vana** signs a request with the selected app key, opens approval and polls status. **Open approval** remains available if the popup is blocked. Creation/status failures, denial and expiry produce an actionable error; **Start again** resets the flow.

Both `dev` and `start` bind to `127.0.0.1`. After building, use `pnpm --filter perplexity-demo start` to review the production build on the same local URL.

The Web owner-only unfamiliar-source approval is BUI-924's separate dependency. If Vana cannot approve Perplexity yet, keep the refusal visible; do not manufacture consent, substitute a public source or use owner credentials. After approval becomes available, this version still stops with “Data reads are not enabled” and leaves the thread list empty. Mobile/Desktop app handoffs, the public Registry and connector publication are outside this example.

## Verify

```sh
pnpm test test/examples/perplexity-demo.test.ts test/examples/nextjs-starter.test.ts
pnpm --filter perplexity-demo build
```

Route tests use local HTTP fixtures with the real SDK and a public Hardhat test identity. They verify the signed app identity, exact conversations-only Moksha request, deployment selection, key/address validation, status polling and the no-read/no-payment boundary. They do not establish live owner consent, paid delivery or the final iteration loop.
