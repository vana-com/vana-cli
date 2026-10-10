# Vana CLI

`vana` is the command line for Vana: it collects a person's own data into
their Personal Server, and it drives the builder side of the protocol so an
app or an agent can ask for that data, read it, and pay for it from a
terminal.

This repository includes a Next.js starter that consumes the canonical
`@opendatalabs/vana-sdk` Direct integration. Legacy JavaScript connection
exports remain available for compatibility.

## Install

Run it without installing anything:

```bash
npx vana-cli status
```

Or install the standalone binary, which is signed and notarized on macOS:

```bash
curl -fsSL https://raw.githubusercontent.com/vana-com/vana-cli/main/install/install.sh | sh
vana status
```

Windows uses `install/install.ps1`. The Homebrew tap (`vana-com/tap`) is
no longer updated and ships a months-old canary, so use one of the routes
above instead.

The npm route runs under your own Node, which some endpoint security
products prefer over an unknown executable; the installer gives you a
single self-contained binary with no Node required. Both are the same CLI.

## Two halves

**Owner side** collects your own data and keeps it in your Personal Server:

```bash
vana login                  # Vana account, or --server <url> for a self-hosted PS
vana connect github         # managed browser, collects, syncs to your server
vana data show github       # what was collected
vana server status          # your server, local and registered URLs
vana server start           # run your own server in the background (no Desktop needed)
```

`vana server start` runs your Personal Server in the background and returns
once it answers; `vana server stop` stops it, and `--foreground` keeps it in
the terminal with its logs. It is public by default: registered on-chain for
your account, reachable through Vana's relay, and synced to Vana storage.
`--local` keeps it on this machine only. On a Mac the tunnel client is a build of frpc
signed and notarized by Vana (or Vana Desktop's copy, when installed).

**Builder side** is what an app or an agent uses to work with someone
else's data, with their consent:

```bash
vana app register                                  # once per machine
vana app request --scopes github.repositories      # prints an approval URL, waits
vana app read github.repositories --grant <id>     # signed read
```

`request` returns the grant id once the person approves. Asking the same
person again extends their grant rather than replacing it: `request` keeps
what the live grant already covers and prints what it keeps, adds and
removes (`--remove-scopes` to give one up). `read` stops at
exit 4 with the exact price before spending anything; add `--pay` to settle
it from escrow and `--max-fee` to cap it. The rest of the group:

| Command                                              | What it does                                                                    |
| ---------------------------------------------------- | ------------------------------------------------------------------------------- |
| `vana app ask "<q>" --sources a,b --derived <scope>` | ask a question computed on the person's own server, without reading the sources |
| `vana app status <derived-scope>`                    | is the answer coming, and when                                                  |
| `vana app lineage <scope>`                           | what an answer was computed from, redacted where it must be                     |
| `vana app whoami`                                    | app address, key source, network, registration state                            |
| `vana app claim`                                     | a link that adds the app to its owner's Vana Account, to fund its escrow        |
| `vana app requests list\|show <id>`                  | what was asked, what was approved                                               |
| `vana app escrow balance\|fund`                      | what the app can spend, and funding it                                          |
| `vana app onchain <scope> --owner <addr>`            | data point version, hashes, deletion state                                      |

Everything defaults to **mainnet**, where your data and apps live. Paying is
never implied: a paid read stops with the exact price until you add `--pay`,
and `--max-fee` caps it. `--network moksha` is the testnet, where fees are
play money.

## For agents

Every command takes `--json` and `--no-input`, and exits with a code an
agent can branch on: `0` done, `1` failed, `2` bad usage, `3` no grant,
`4` payment required, `5` no server answered, `6` not ready yet, `7` a
person has to act. The full contract is in
[docs/CLI-EXIT-CODE-MATRIX.md](./docs/CLI-EXIT-CODE-MATRIX.md).

Install the skills that teach an agent each half:

```bash
vana skills install builder        # ask for access, read, pay
vana skills install agent-access   # give your own agent (OpenClaw, Hermes) scoped, paid access
vana skills install connect-data   # collect your own data
```

There is also an MCP server over stdio for clients that prefer tools:

```bash
claude mcp add vana -- vana mcp
```

When an agent connected to your Personal Server asks to read more of your
data, it shows you a link to the request on Vana Web (app.vana.org), where
you tick what to share, from any device. A server started with `--local` has
no public URL for Vana Web to reach, so there you answer in the terminal,
which works for any server:

```bash
vana mcp requests                                 # who wants what, and why
vana mcp approve <connection-id> [--scopes a,b]   # share all or some of it
vana mcp deny <connection-id>
```

## Web app integration

For a web app whose users approve data access in Vana, use the Direct integration from `@opendatalabs/vana-sdk`. For terminal scripts and agents, use `vana app request` and `vana app read` above.

The [Next.js starter](./examples/nextjs-starter/README.md) includes the complete browser and server flow with SDK 4.3.1. It replaces the starter's session-only Account link, which current Account rejects with `client_id: Required`.

### Server

Install the SDK with `pnpm add @opendatalabs/vana-sdk@4.3.1`. Keep its controller in a server-only module.

```typescript
import {
  createDirectDataController,
  PaymentRequiredError,
} from "@opendatalabs/vana-sdk/server";

const vana = createDirectDataController({
  appPrivateKey: process.env.VANA_APP_PRIVATE_KEY!,
  app: { id: "your-app", name: "Your App", homepageUrl: "https://yourapp.com" },
  source: "chatgpt",
  scopes: ["chatgpt.conversations"],
  env: "production",
  personalServerFetch: async (url, init) => {
    const response = await fetch(url, init);
    if (response.status === 402) {
      throw new PaymentRequiredError(
        "Payment required. No payment authorized.",
      );
    }
    return response;
  },
  personalServerTransportRetry: { attempts: 1 },
});

// Expose these through your own authenticated server routes.
const request = await vana.createAccessRequest({
  returnUrl: "https://yourapp.com",
});
const status = await vana.getAccessRequestStatus(request.requestId);
const result = await vana.readApprovedData({
  requestId: request.requestId,
  scope: "chatgpt.conversations",
});
```

Register the app identity on the selected network before requesting data. Keep app keys and scope selection on the server. The payment policy above stops every 402 before the SDK can sign a payment challenge. The starter applies this policy too.

### Browser

```tsx
import { useDirectVanaConnect } from "@opendatalabs/vana-sdk/react";

// Implement these transports with checked responses from your own routes.
const { state, start, retryRead, reset } = useDirectVanaConnect({
  createRequest,
  getStatus,
  readResult,
});

// Call start directly from a user click so the SDK can open the approval tab.
<button onClick={start}>Connect with Vana</button>;
```

Render `state.type` and the SDK's request/result values. Handle blocked popups with `request.approvalUrl`, mobile `ready_to_open` with `mobileContinuationUrl`, and errors with `retryRead` or `reset`. After approval, the hook automatically reads data. See the starter for the complete state rendering and HTTP handling.

SDK 4.3.1's controller reads Personal Server delivery and attempts consumer acknowledgement after the read. Acknowledgement is best effort. A completed request is terminal. The starter documents these limits and never treats a browser-supplied grant or server URL as read authority.

### Legacy library exports

The existing `vana-cli/server`, `vana-cli/react`, and `vana-cli/core` exports remain available for compatibility. `connect()`, `useVanaConnect()`, `useVanaData()`, and `ConnectButton` use Session Relay. Their session-only Account URLs do not satisfy current Account's OAuth client requirements. Migrate browser approval integrations to the SDK's Direct controller and React hook above. This change does not remove those public exports or alter the terminal commands.

`getData()` retains its grant-based server contract. New Direct integrations use `readApprovedData({ requestId, scope })` so the server rechecks the approved Direct request before reading. `signVanaManifest()` retains the signed manifest contract used by the starter. The starter's webhook remains a stub.

| Import                          | Environment | Purpose                                                    |
| ------------------------------- | ----------- | ---------------------------------------------------------- |
| `@opendatalabs/vana-sdk/server` | Node.js     | Direct controller, request/status/result types, and errors |
| `@opendatalabs/vana-sdk/react`  | Browser     | `useDirectVanaConnect()` and Direct flow states            |
| `vana-cli/server`               | Node.js     | Legacy Session Relay, grant reads, and signed manifests    |
| `vana-cli/react`                | Browser     | Legacy Session Relay hooks and `ConnectButton`             |
| `vana-cli/core`                 | Universal   | Legacy connection types, errors, and constants             |
| `vana-cli/runtime`              | Node.js     | `ManagedPlaywrightRuntime`, used by `vana connect`         |
| `vana-cli/connectors`           | Node.js     | Connector catalog                                          |
| `vana-cli/cli`                  | Node.js     | In-process CLI entry point                                 |

`runtime` and `connectors` are for apps that collect data themselves, including Vana Desktop.

## Connectors

Available data connectors and their scopes (schema definitions):
[`PDP-Connect/data-connectors/schemas`](https://github.com/PDP-Connect/data-connectors/tree/main/schemas)

A Collection Profile connector you are still writing can run straight from
its directory. `vana connect <key> --from <dir>` runs it once; registering
it makes every later command use it:

```bash
vana connectors add slack_browser --from ~/src/data-connectors   # validates, saves the absolute path
vana connect slack_browser                                       # runs from that directory
vana collect slack_browser                                       # so do collect, --detach, the schedule and MCP
vana connectors list
vana connectors remove slack_browser
```

The directory needs `connectors/<key>/index.ts`, a manifest whose
`connector_key` is `<key>`, and `node_modules/tsx` (run `npm install`
there). A registered connector runs its source unsigned and unverified,
every time, so register only directories you trust; each run prints
`Running <key> from <dir>` (a `local-connector` event under `--json`).
A key that a pinned or legacy connector already uses needs `--force`, and
then shares that connector's state, browser profile and scope names.

## Contributing

This repo uses pnpm for local development and the examples; the npm and
npx commands above are only for installing the published package.

`pnpm build:sea` uses Node 25's `--build-sea` flow to create a small `vana` launcher and packages the real app payload next to it under `app/`.
It produces a platform-specific release directory plus a release archive and matching checksum file under `artifacts/sea/`.

Review material for the CLI:

- [CLI review surface](./docs/CLI-REVIEW-SURFACE.md)
- [CLI transcripts](./docs/CLI-TRANSCRIPTS.md)
- [CLI demos](./docs/vhs/README.md)

## License

MIT
