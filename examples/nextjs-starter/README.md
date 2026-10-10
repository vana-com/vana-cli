# Next.js starter

Connect ChatGPT data to a Next.js app through Vana approval. The starter uses `createDirectDataController` and `useDirectVanaConnect` from `@opendatalabs/vana-sdk` 4.3.1. App keys, scope selection, request signing, and Personal Server reads stay on the server.

## Run the app

1. Register your app identity on the selected Vana network and obtain its app private key.
2. Copy `.env.local.example` to `.env.local`.
3. Set `VANA_PRIVATE_KEY` and `APP_URL`. The server also accepts `VANA_APP_PRIVATE_KEY` when `VANA_PRIVATE_KEY` is unset.
4. Set `VANA_ENV=dev` for Moksha and `app-dev.vana.org`, or `VANA_ENV=prod` for mainnet and `app.vana.org`. Other values fail configuration.
5. Run `pnpm install` from the repository root.
6. Run `pnpm --filter nextjs-starter dev`.
7. Open `http://localhost:3001` and click **Connect with Vana**.
8. Approve the requested data in Vana. The starter automatically reads the approved ChatGPT conversations and displays the response in the original tab.

The owner needs ChatGPT data available through their Personal Server. This app resolves the server from the approved request. It does not start or configure a Personal Server.

Set the app identity, `source`, and concrete scope in `src/config.ts` before adapting this example. The starter requests and reads `chatgpt.conversations`. The browser cannot select the scope, grant, server URL, or return URL. Keep `.env.local` private and never give the app key a `NEXT_PUBLIC_` prefix.

## Request flow

`POST /api/connect` creates a signed Direct access request and returns the SDK's `AccessRequest`, including `requestId` and `approvalUrl`. `GET /api/status?requestId=...` fetches signed, uncached status. `POST /api/data` accepts only `{ "requestId": "dcr_..." }`, rechecks approval, and reads the configured scope through the SDK.

The SDK opens the approval tab during the button click. If the popup is blocked, the starter shows **Open approval**. On supported mobile requests it shows the SDK's HTTPS **Open Vana** continuation link. The starter polls while approval is pending. **Try again** reuses a live approved request after a read failure when the SDK can do so. **Reset** starts a fresh flow.

The controller currently reads Personal Server delivery. An enclave-only result has no Personal Server URL and cannot be read by this starter. Successful reads trigger a best-effort consumer acknowledgement. Displayed data does not confirm that the acknowledgement succeeded or that Vana closed the approval tab. Completed requests are terminal and require a fresh flow.

## Payment policy

This starter does not authorize payments. Its Personal Server fetch policy rejects every HTTP 402 before the SDK can sign or send `X-PAYMENT`. It uses one transport attempt per read. A 402 response becomes **Payment required** in the app. An explicit retry makes another unpaid read attempt. There is no automatic payment opt-in.

## Manifest and webhook

`GET /manifest.json` retains the existing signed W3C manifest contract through `signVanaManifest()` from `vana-cli/server`. The manifest uses the same server-only key and `APP_URL`. Replace its example privacy, terms, and support URLs before publication. The starter exposes `/icon.svg`.

`POST /api/webhook` retains the existing stub for grant notifications. It logs the payload and does not verify signatures or process grants. The Direct browser flow uses status polling and does not depend on this stub. Add authentication and processing before using the webhook in production.

## Verify

From the repository root, run `pnpm test test/examples/nextjs-starter.test.ts` and `pnpm --filter nextjs-starter build`. Route tests use local transport fixtures with the real SDK. They cover signed request creation and status, input rejection, read outcomes, and payment refusal. They do not prove hosted approval, live owner consent, or provider delivery.

For a live check, run the app with your registered identity, approve a request in Vana, and confirm the configured scope appears in the original tab. A local fixture response is separate from that proof.
