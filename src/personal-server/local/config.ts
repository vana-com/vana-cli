import path from "node:path";

import { getVanaHome } from "../../core/paths.js";
import type { VanaNetworkName } from "../../core/network.js";

/** What a Personal Server needs to know about the network it serves. */
export interface LocalServerNetwork {
  name: VanaNetworkName;
  chainId: number;
  gatewayUrl: string;
  storageApiUrl: string;
  contracts: Record<string, string>;
}

// Same deployment on both chains. Mirrors the `contracts` block of Vana
// Desktop's packages/app-runtime/src/personal-server/environments.json.
const CONTRACTS: Record<string, string> = {
  dataPortabilityEscrow: "0x07d7769081adc3a3DBe91f5E4B98E9A5a6B292e3",
  dataPortabilityGrantees: "0x8325C0A0948483EdA023A1A2Fd895e62C5131234",
  dataPortabilityPermissions: "0x4d3FA76064D88e0454cFc4CaD7e5FeC3e3124011",
  dataPortabilityServer: "0xCae2CE0e9caa6643ed28186cF57bd40Bd9E17Eab",
  dataRefinerRegistry: "0x93c3EF89369fDcf08Be159D9DeF0F18AB6Be008c",
  dataRegistry: "0x8f1eFCdff3d0d5BB535e32620721c7EBed151867",
  feeRegistry: "0xb4FA18443E0FA6cdC0280D20b8cCDB2377D13Bf2",
};

const NETWORKS: Record<VanaNetworkName, LocalServerNetwork> = {
  moksha: {
    name: "moksha",
    chainId: 14800,
    gatewayUrl: "https://dp-rpc.moksha.vana.org",
    storageApiUrl: "https://storage-dev.vana.org",
    contracts: CONTRACTS,
  },
  mainnet: {
    name: "mainnet",
    chainId: 1480,
    gatewayUrl: "https://dp-rpc.vana.org",
    storageApiUrl: "https://storage.vana.org",
    contracts: CONTRACTS,
  },
};

export function localServerNetwork(name: VanaNetworkName): LocalServerNetwork {
  return NETWORKS[name];
}

/** The pinned server release, matching runtime-pkg/package.json. */
export const PERSONAL_SERVER_VERSION = "1.24.6";

export function localServerHome(): string {
  return path.join(getVanaHome(), "cli", "personal-server");
}

/**
 * The CLI's own data dir per network. Never Desktop's
 * (`~/.vana/desktop/personal-server/...`): two processes on one index and one
 * server key would corrupt both.
 */
export function localServerDataDir(network: VanaNetworkName): string {
  return path.join(localServerHome(), network);
}

export function localServerRuntimeDir(): string {
  return path.join(localServerHome(), "runtime", PERSONAL_SERVER_VERSION);
}

/** Ports Desktop and the CLI both try first; the loopback approval page is port + 1. */
export const LOCAL_SERVER_PORTS = [8080, 8082, 8084] as const;
