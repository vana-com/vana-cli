# Vana CLI

`vana` is the command line for Vana: it collects a person's own data into
their Personal Server, and it drives the builder side of the protocol so an
app or an agent can ask for that data, read it, and pay for it from a
terminal.

This repository also ships the JavaScript SDK the CLI is built on, which is
documented further down.

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
vana server start           # run your own server here when Vana Desktop is not
```

`vana server start` is local only: `vana connect` writes to it, apps cannot
reach it. `vana server start --public` registers it on-chain for your
account, opens a public URL through Vana's relay, syncs to Vana storage, and
stays public on every later start. A registration cannot be removed, so this
is a step you take on purpose. On a Mac the tunnel client is a build of frpc
signed and notarized by Vana (or Vana Desktop's copy, when installed).

**Builder side** is what an app or an agent uses to work with someone
else's data, with their consent:

```bash
vana app register                                  # once per machine
vana app request --scopes github.repositories      # prints an approval URL, waits
vana app read github.repositories --grant <id>     # signed read
```

`request` returns the grant id once the person approves. `read` stops at
exit 4 with the exact price before spending anything; add `--pay` to settle
it from escrow and `--max-fee` to cap it. The rest of the group:

| Command                                              | What it does                                                                    |
| ---------------------------------------------------- | ------------------------------------------------------------------------------- |
| `vana app ask "<q>" --sources a,b --derived <scope>` | ask a question computed on the person's own server, without reading the sources |
| `vana app status <derived-scope>`                    | is the answer coming, and when                                                  |
| `vana app lineage <scope>`                           | what an answer was computed from, redacted where it must be                     |
| `vana app whoami`                                    | app address, key source, network, registration state                            |
| `vana app requests list\|show <id>`                  | what was asked, what was approved                                               |
| `vana app escrow balance\|fund`                      | what the app can spend, and funding it                                          |
| `vana app onchain <scope> --owner <addr>`            | data point version, hashes, deletion state                                      |

Everything defaults to **moksha**, the testnet; `--network mainnet` spends
real money and is never implied.

## For agents

Every command takes `--json` and `--no-input`, and exits with a code an
agent can branch on: `0` done, `1` failed, `2` bad usage, `3` no grant,
`4` payment required, `5` no server answered, `6` not ready yet, `7` a
person has to act. The full contract is in
[docs/CLI-EXIT-CODE-MATRIX.md](./docs/CLI-EXIT-CODE-MATRIX.md).

Install the skills that teach an agent each half:

```bash
vana skills install builder        # ask for access, read, pay
vana skills install connect-data   # collect your own data
```

There is also an MCP server over stdio for clients that prefer tools:

```bash
claude mcp add vana -- vana mcp
```

## The SDK

The same package is also a JavaScript SDK for apps that ask their users for
data from a web page. Which one to use:

- **A web app** whose users approve access in the browser: use the SDK below.
- **A script, a backend job or an agent** working from a terminal: use
  `vana app request` and `vana app read` above. They cover the same consent
  and add escrow payment, derived answers and exit codes an agent can
  branch on.

### What problem this solves

Your users already have rich personal data (ChatGPT conversations, Instagram activity, Gmail, purchase history), but it's locked inside the platforms that collected it. As a builder, you can't easily use that data to personalize onboarding, tailor recommendations, or skip lengthy signup forms.

**Data portability** means users can export their data from these platforms and grant your app scoped access to it, with their explicit consent, cryptographic verification, and full control over what's shared and when to revoke it.

Today, getting access to user data means asking for manual file uploads (high friction), scraping on their behalf (fragile and legally risky), or negotiating enterprise API deals (slow and expensive). This SDK gives you a standardized way to request and receive personal data through Vana's [Data Portability Protocol](https://docs.vana.org/), handling session creation, grant verification, and data fetching in three function calls.

### How it works

```
Your App                         Vana Protocol
------------------------------   ------------------------------

1. connect({ scopes })
   creates a session
   returns a connect URL    -->  2. User opens the Vana app,
                                    reviews scopes, exports data,
                                    approves the grant

3. Poll resolves with grant  <--  Grant signed and registered

4. getData({ grant })        -->  5. Personal Server returns
   structured JSON                   user data over TLS
```

The [Data Portability Protocol](https://docs.vana.org/) defines how users collect data from platforms, store it under their control (on-device or hosted), and grant third-party apps scoped access. This SDK handles session creation, cryptographic request signing, polling, and data fetching. You write three function calls; the protocol handles the rest.

### Try the example app

`examples/nextjs-starter` is a complete working app wired to the development
environment:

```bash
git clone https://github.com/vana-com/vana-cli.git
cd vana-cli/examples/nextjs-starter
cp .env.local.example .env.local
```

Use the pre-registered dev key in .env.local. Note that this private key is ONLY for testing and works only with a testing Vana environment.

```
VANA_PRIVATE_KEY=0x3c05ac1a00546bc0b1b8d3a11fb908409005fac3f26d25f70711e4f632e720d3
APP_URL=http://localhost:3001
```

Install and run:

```bash
pnpm install
pnpm dev
```

The example's own [README](./examples/nextjs-starter/README.md) walks
through approving a request as the end user.

### Add it to your app

#### Installation

```bash
npm install vana-cli
```

#### Prerequisites

First, register your app in the [Developer Portal](https://vana-developers.replit.app/). You will need to provide the URL where your app will be deployed, and then be given a private key after registration.

#### 1. Create a session (server)

```typescript
import { connect } from "vana-cli/server";

const session = await connect({
  privateKey: process.env.VANA_APP_PRIVATE_KEY as `0x${string}`,
  scopes: ["chatgpt.conversations"],
  webhookUrl: "https://yourapp.com/api/webhook", // optional, data can be pushed to a web hook after a grant is approved
  appUserId: "yourapp-user-42", // optional: correlate your app user with the data they provided
});

// Return to your frontend:
// session.sessionId  - used for polling
// session.connectUrl - where the user reviews and approves the request
// session.expiresAt  - ISO 8601 expiration
```

#### 2. Poll for user approval (client)

```tsx
import { useVanaConnect } from "vana-cli/react";

function ConnectData({ sessionId }: { sessionId: string }) {
  const { connect, status, grant, connectUrl } = useVanaConnect();

  useEffect(() => {
    connect({ sessionId });
  }, [sessionId]);

  if (status === "waiting" && connectUrl) {
    return <a href={connectUrl}>Connect your data</a>;
  }
  if (status === "approved" && grant) {
    // grant.grantId, grant.userAddress, grant.scopes are available
    return <p>Connected.</p>;
  }
  return <p>{status}</p>;
}
```

Or use the pre-built button:

```tsx
import { ConnectButton } from "vana-cli/react";

<ConnectButton
  sessionId={sessionId}
  onComplete={(grant) => saveGrant(grant)}
  onError={(err) => console.error(err)}
/>;
```

#### 3. Fetch user data (server)

```typescript
import { getData } from "vana-cli/server";

const data = await getData({
  privateKey: process.env.VANA_APP_PRIVATE_KEY as `0x${string}`,
  grant, // GrantPayload from step 2
});

// Record<string, unknown> keyed by scope
const conversations = data["chatgpt.conversations"];
```

#### Web App Manifest

The Vana app verifies your identity by fetching your manifest. Use `signVanaManifest()` to generate it:

```typescript
import { signVanaManifest } from "vana-cli/server";

// In your manifest route handler (e.g. Next.js /manifest.json/route.ts):
const vanaBlock = await signVanaManifest({
  privateKey: process.env.VANA_APP_PRIVATE_KEY as `0x${string}`,
  appUrl: "https://yourapp.com",
  privacyPolicyUrl: "https://yourapp.com/privacy",
  termsUrl: "https://yourapp.com/terms",
  supportUrl: "https://yourapp.com/support",
  webhookUrl: "https://yourapp.com/api/webhook",
});

const manifest = {
  name: "Your App",
  short_name: "YourApp",
  start_url: "/",
  display: "standalone",
  vana: vanaBlock, // signed identity block
};
```

Make sure your HTML includes `<link rel="manifest" href="/manifest.json">`.

### API Reference

#### Entrypoints

| Import                | Environment | Exports                                                             |
| --------------------- | ----------- | ------------------------------------------------------------------- |
| `vana-cli/server`     | Node.js     | `connect()`, `getData()`, `signVanaManifest()`, low-level clients   |
| `vana-cli/react`      | Browser     | `useVanaConnect()`, `useVanaData()`, `ConnectButton`                |
| `vana-cli/core`       | Universal   | Types, `ConnectError`, constants                                    |
| `vana-cli/runtime`    | Node.js     | `ManagedPlaywrightRuntime`, the browser runtime `vana connect` uses |
| `vana-cli/connectors` | Node.js     | `listAvailableSources()` and the connector catalog                  |
| `vana-cli/cli`        | Node.js     | `runCli()`, to run the CLI in-process                               |

`runtime` and `connectors` are for app surfaces such as the Vana desktop
app that collect data themselves; prefer them over shelling out to the CLI.

#### `connect(config): Promise<SessionInitResult>`

Creates a session on the Session Relay. Returns `sessionId`, `connectUrl`, and `expiresAt`.

| Param        | Type                | Required | Description                                                            |
| ------------ | ------------------- | -------- | ---------------------------------------------------------------------- |
| `privateKey` | `` `0x${string}` `` | Yes      | Builder private key                                                    |
| `scopes`     | `string[]`          | Yes      | Data scopes to request                                                 |
| `webhookUrl` | `string`            | No       | Public HTTPS URL for grant event notifications (localhost is rejected) |
| `appUserId`  | `string`            | No       | Your app's user ID for correlation                                     |

#### `getData(config): Promise<Record<string, unknown>>`

Fetches user data from their Personal Server using a signed grant.

| Param        | Type                | Required | Description                  |
| ------------ | ------------------- | -------- | ---------------------------- |
| `privateKey` | `` `0x${string}` `` | Yes      | Builder private key          |
| `grant`      | `GrantPayload`      | Yes      | Grant from the approval step |

#### `useVanaConnect(config?): UseVanaConnectResult`

React hook that polls the Session Relay and manages connection state.

```typescript
const { connect, status, grant, error, connectUrl, reset } = useVanaConnect();
```

`status` transitions: `idle`, then `connecting`, then `waiting`, then one of `approved`, `denied`, `expired` or `error`.

#### `GrantPayload`

Returned when a user approves access:

```typescript
interface GrantPayload {
  grantId: string; // on-chain permission ID
  userAddress: string; // user's wallet address
  builderAddress: string; // your registered address
  scopes: string[]; // approved data scopes
  serverAddress?: string; // user's Personal Server
  appUserId?: string; // your app's user ID (if provided)
}
```

#### Low-level clients

For full control over individual protocol interactions:

```typescript
import {
  createRequestSigner, // Web3Signed header generation
  createSessionRelay, // Session Relay HTTP client
  createDataClient, // Data Gateway HTTP client
} from "vana-cli/server";
```

## Connectors

Available data connectors and their scopes (schema definitions):
[`PDP-Connect/data-connectors/schemas`](https://github.com/PDP-Connect/data-connectors/tree/main/schemas)

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
