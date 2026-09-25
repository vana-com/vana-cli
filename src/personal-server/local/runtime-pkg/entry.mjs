// The Personal Server process `vana server start` runs, modeled on Vana
// Desktop's sidecar (apps/desktop/personal-server/index.js in unity-surfaces).
//
// The first JSON line on stdin is its configuration, so the owner signature
// never appears in the process list or environment:
//   { rootPath, port, ownerSignature, ownerAddress, network: { gatewayUrl, chainId,
//     contracts, storageApiUrl }, tunnel: { binaryPath, serverAddr, serverPort } | null }
// Later lines are commands from the CLI, which holds the Account session:
//   { type: "prepare-registration" } -> registration-request
//   { type: "submit-registration", signature } -> registration-submitted
// It writes one JSON object per line on stdout: ready, public, tunnel,
// registration-request, registration-submitted, command-failed, error,
// stopped. Logs go to stderr.

import { readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import readline from "node:readline";

import {
  loadConfig,
  startPersonalServer,
} from "@opendatalabs/personal-server-ts/node";

import { applyDerived, derivedConfig } from "./derived-config.mjs";

const send = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);

const lines = readline
  .createInterface({ input: process.stdin })
  [Symbol.asyncIterator]();

async function readInput() {
  for (;;) {
    const { value, done } = await lines.next();
    if (done) throw new Error("No configuration on stdin.");
    if (value.trim()) return JSON.parse(value);
  }
}

let ps = null;

// Only a tunnel URL may be registered: without one the server offers its
// localhost origin, which no app could ever reach.
function publicState(info) {
  const tunnel = info.details?.tunnel ?? null;
  return {
    registered: Boolean(info.registration?.registered),
    serverAddress: info.server?.address ?? null,
    serverUrl: info.urls?.public ?? null,
    tunnel: tunnel
      ? {
          status: tunnel.status ?? null,
          routable: tunnel.routable !== false,
          warning: tunnel.warning ?? null,
        }
      : null,
  };
}

let watching = false;

// The server dials the relay on its own once it sees the registration (it
// polls the gateway); report when the public URL answers, as Desktop does.
async function watchTunnel() {
  if (watching) return;
  watching = true;
  const started = Date.now();
  let last = null;
  while (Date.now() - started < 10 * 60_000) {
    try {
      last = publicState(await ps.info());
      if (last.tunnel?.status === "connected" && last.tunnel.routable) {
        send({ type: "tunnel", status: "connected", url: last.serverUrl });
        return;
      }
    } catch (error) {
      process.stderr.write(`[entry] tunnel check failed: ${error}\n`);
    }
    await new Promise((resolve) => setTimeout(resolve, 3_000));
  }
  send({
    type: "tunnel",
    status: last?.tunnel?.status ?? "unknown",
    url: last?.serverUrl ?? null,
    warning: last?.tunnel?.warning ?? "The tunnel did not connect in time.",
  });
}

// Typed data can carry bigints, which JSON.stringify refuses.
const plain = (value) =>
  JSON.parse(
    JSON.stringify(value, (_key, item) =>
      typeof item === "bigint" ? item.toString() : item,
    ),
  );

async function handleCommands() {
  for (;;) {
    const { value, done } = await lines.next();
    if (done) return;
    if (!value.trim()) continue;
    let command;
    try {
      command = JSON.parse(value);
    } catch {
      continue;
    }
    try {
      if (command.type === "prepare-registration") {
        const { serverUrl } = publicState(await ps.info());
        if (!serverUrl) throw new Error("The server has no public URL.");
        const request = await ps.prepareRegistration({ serverUrl });
        send({
          type: "registration-request",
          request: { typedData: plain(request.typedData) },
        });
      } else if (command.type === "submit-registration") {
        const result = await ps.submitRegistration({
          signature: command.signature,
        });
        send({
          type: "registration-submitted",
          serverId: result?.serverId ?? null,
          alreadyRegistered: Boolean(result?.alreadyRegistered),
        });
        void watchTunnel();
      }
    } catch (error) {
      send({
        type: "command-failed",
        command: command.type,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }
}

async function main() {
  const input = await readInput();
  const { rootPath, port, ownerSignature, ownerAddress, network, tunnel } =
    input;
  const configPath = join(rootPath, "server.json");
  const derived = derivedConfig(network, tunnel ?? null);

  // Persist the derived block the way Desktop does, so a network change can
  // never leave an old gateway or storage host behind in server.json.
  let persisted = null;
  try {
    persisted = JSON.parse(await readFile(configPath, "utf8"));
  } catch {
    persisted = null;
  }
  const next = applyDerived(persisted, derived);
  const temporary = `${configPath}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(next, null, 2)}\n`, {
    mode: 0o600,
  });
  await rename(temporary, configPath);

  // configDefaults merges shallowly for some sections, so hand back whole
  // sections from the schema-complete loaded config.
  const loaded = await loadConfig({ configPath, rootPath });
  const configDefaults = {
    server: {
      ...loaded.server,
      port,
      ...(ownerAddress ? { address: ownerAddress } : {}),
    },
  };
  for (const key of Object.keys(derived)) {
    configDefaults[key] = applyDerived(loaded[key], derived[key]);
  }

  ps = await startPersonalServer({
    configPath,
    rootPath,
    port,
    ownerSignature,
    mcpOAuthApprovalUrl: "vana://mcp-authorization",
    configDefaults,
    onStatus: (status) => process.stderr.write(`[status] ${status}\n`),
  });
  const info = await ps.ready();
  send({
    type: "ready",
    port,
    url: info.urls?.local ?? `http://localhost:${port}`,
  });
  void handleCommands();
  if (!tunnel) return;

  // Waits for the gateway registration check and the tunnel URL reservation.
  const state = publicState(await ps.ready({ publicUrl: true }));
  send({ type: "public", ...state });
  if (state.registered) void watchTunnel();
}

async function shutdown(signal) {
  process.stderr.write(`[entry] ${signal}, stopping\n`);
  try {
    await ps?.stop();
  } finally {
    send({ type: "stopped" });
    process.exit(0);
  }
}

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));

main().catch((error) => {
  send({
    type: "error",
    message: error instanceof Error ? error.message : String(error),
  });
  process.exit(1);
});
