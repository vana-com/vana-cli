// The Personal Server process `vana server start` runs, modeled on Vana
// Desktop's sidecar (apps/desktop/personal-server/index.js in unity-surfaces).
//
// It reads one JSON line on stdin, so the owner signature never appears in the
// process list or environment:
//   { rootPath, port, ownerSignature, ownerAddress, network: { gatewayUrl, chainId,
//     contracts, storageApiUrl } }
// and writes one JSON object per line on stdout: ready, error, stopped.
// Logs go to stderr.

import { readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import readline from "node:readline";

import {
  loadConfig,
  startPersonalServer,
} from "@opendatalabs/personal-server-ts/node";

const send = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);

function isPlainObject(value) {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) !== null
  );
}

// Derived leaves win and every other persisted key survives, as in Desktop's
// applyDerivedServerConfig.
function applyDerived(persisted, derived) {
  if (!isPlainObject(persisted)) return structuredClone(derived);
  const merged = { ...persisted };
  for (const [key, value] of Object.entries(derived)) {
    merged[key] =
      isPlainObject(value) && isPlainObject(merged[key])
        ? applyDerived(merged[key], value)
        : structuredClone(value);
  }
  return merged;
}

// Everything that follows from the network. Local only for now: no tunnel,
// so nothing is reachable from outside and nothing may be registered, and no
// sync to Vana storage until registration exists.
function derivedConfig(network) {
  return {
    devUi: { enabled: true },
    gateway: {
      url: network.gatewayUrl,
      chainId: network.chainId,
      contracts: network.contracts,
    },
    inference: {
      baseUrl: `${network.gatewayUrl.replace(/\/+$/, "")}/v1/inference`,
    },
    logging: { level: "info", pretty: false },
    storage: {
      backend: "vana",
      config: { vana: { apiUrl: network.storageApiUrl } },
    },
    sync: { enabled: false },
    tunnel: { enabled: false },
  };
}

async function readInput() {
  const rl = readline.createInterface({ input: process.stdin });
  for await (const line of rl) {
    if (line.trim()) {
      rl.close();
      return JSON.parse(line);
    }
  }
  throw new Error("No configuration on stdin.");
}

let ps = null;

async function main() {
  const input = await readInput();
  const { rootPath, port, ownerSignature, ownerAddress, network } = input;
  const configPath = join(rootPath, "server.json");
  const derived = derivedConfig(network);

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
