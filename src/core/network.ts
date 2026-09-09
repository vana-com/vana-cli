/**
 * Resolved network configuration for builder-side commands.
 *
 * The owner-side commands keep using {@link getEnvConfig} from constants.ts
 * (a dev/prod host axis) untouched. Builder commands need one resolved
 * object carrying the chain and every host, selected with `--network`:
 * moksha is the default because its fees are play money, and mainnet spends
 * real USDC.e from the app's escrow.
 *
 * `VANA_ENV=dev` swaps in the dev host set (internal use; dev serves the
 * moksha chain).
 */

export type VanaNetworkName = "moksha" | "mainnet";

export const VANA_NETWORKS: readonly VanaNetworkName[] = [
  "moksha",
  "mainnet",
] as const;

export const DEFAULT_NETWORK: VanaNetworkName = "moksha";

export interface ResolvedNetwork {
  /** Network name as selected. */
  name: VanaNetworkName;
  /** Host set: "dev" only when VANA_ENV=dev (moksha chain, dev hosts). */
  env: "dev" | "prod";
  /** Vana chain id: 14800 moksha, 1480 mainnet. */
  chainId: number;
  /** Data Gateway base URL (the only address a builder needs). */
  gatewayUrl: string;
  /** Vana Account base URL. */
  accountUrl: string;
  /** Consent / approval app base URL. */
  approvalUrl: string;
  /** Session relay base URL (owner-side flows). */
  sessionRelayUrl: string;
  /** Block explorer base URL. */
  explorerUrl: string;
  /** JSON-RPC endpoint for on-chain calls (escrow depositNative). */
  rpcUrl: string;
  /** DataPortabilityGrantees contract, the EIP-712 verifying contract for
   * builder registration (same deployment address on both networks). */
  granteesContract: string;
}

const NETWORKS: Record<VanaNetworkName, Omit<ResolvedNetwork, "env">> = {
  moksha: {
    name: "moksha",
    chainId: 14800,
    granteesContract: "0x8325C0A0948483EdA023A1A2Fd895e62C5131234",
    gatewayUrl: "https://dp-rpc.moksha.vana.org",
    accountUrl: "https://account.vana.org",
    approvalUrl: "https://app.vana.org",
    sessionRelayUrl: "https://session-relay.vana.org",
    explorerUrl: "https://moksha.vanascan.io",
    rpcUrl: "https://rpc.moksha.vana.org",
  },
  mainnet: {
    name: "mainnet",
    chainId: 1480,
    granteesContract: "0x8325C0A0948483EdA023A1A2Fd895e62C5131234",
    gatewayUrl: "https://dp-rpc.vana.org",
    accountUrl: "https://account.vana.org",
    approvalUrl: "https://app.vana.org",
    sessionRelayUrl: "https://session-relay.vana.org",
    explorerUrl: "https://vanascan.io",
    rpcUrl: "https://rpc.vana.org",
  },
};

/** Dev host overrides (moksha chain served by the dev deployment). */
const DEV_HOSTS = {
  gatewayUrl: "https://dp-rpc-dev.vana.org",
  accountUrl: "https://account-dev.vana.org",
  // The SDK's dev consent endpoints live on app-dev (see
  // @opendatalabs/vana-sdk dist/direct/endpoints.js); mixing the prod
  // approval app with dev everything-else would split deployments.
  approvalUrl: "https://app-dev.vana.org",
  sessionRelayUrl: "https://dev.session-relay.vana.org",
} as const;

export class UnknownNetworkError extends Error {
  constructor(public readonly value: string) {
    super(
      `Unknown network "${value}". Expected one of: ${VANA_NETWORKS.join(", ")}.`,
    );
    this.name = "UnknownNetworkError";
  }
}

export function isVanaNetworkName(value: string): value is VanaNetworkName {
  return (VANA_NETWORKS as readonly string[]).includes(value);
}

/**
 * Resolve a network selection into hosts and chain.
 *
 * @param name - `--network` value; falls back to `VANA_NETWORK`, then moksha.
 * @param env - process env, injectable for tests.
 * @throws {UnknownNetworkError} for a name outside {@link VANA_NETWORKS}.
 */
export function resolveNetwork(
  name?: string,
  env: Record<string, string | undefined> = process.env,
): ResolvedNetwork {
  const raw = (name ?? env.VANA_NETWORK ?? DEFAULT_NETWORK).toLowerCase();
  if (!isVanaNetworkName(raw)) {
    throw new UnknownNetworkError(raw);
  }
  const base = NETWORKS[raw];
  const dev = env.VANA_ENV === "dev";
  if (dev && raw === "mainnet") {
    // There is no dev host set for mainnet; refuse rather than guess.
    throw new UnknownNetworkError("mainnet with VANA_ENV=dev");
  }
  return dev ? { ...base, ...DEV_HOSTS, env: "dev" } : { ...base, env: "prod" };
}
