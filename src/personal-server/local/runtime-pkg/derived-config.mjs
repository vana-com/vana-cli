// The server configuration `vana server start` derives from the network and
// the tunnel client, and how it lands on a persisted server.json. Kept apart
// from entry.mjs so it can be tested without starting a server.

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
export function applyDerived(persisted, derived) {
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

// Everything that follows from the network and the tunnel client. Without a
// tunnel client the server is local only: nothing outside can reach it, so
// it is never registered and has nothing to sync. With one, the server
// reserves its public URL but dials the relay only once registered, and sync
// waits for registration too.
export function derivedConfig(network, tunnel) {
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
    // Builder reads settle a fee from the builder's escrow (x402), as on
    // Vana's hosted servers. The server's default is off, and a server that
    // leaves it off serves every granted read for free - no 402, no payment
    // record. The owner's own reads stay free either way.
    payment: { enabled: true },
    storage: {
      backend: "vana",
      config: { vana: { apiUrl: network.storageApiUrl } },
    },
    sync: { enabled: Boolean(tunnel) },
    tunnel: tunnel
      ? {
          enabled: true,
          serverAddr: tunnel.serverAddr,
          serverPort: tunnel.serverPort,
          binaryPath: tunnel.binaryPath,
        }
      : { enabled: false },
  };
}
