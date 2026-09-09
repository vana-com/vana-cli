/**
 * Lookup of the owner's registered Personal Server URLs at the gateway.
 *
 * The local transport URL (how this CLI reaches the server, often
 * localhost) and the registered public URL (what builders resolve through
 * the gateway) are two names for the same server. Display surfaces show
 * both; this module supplies the second, best-effort and offline-tolerant.
 */

import { createGatewayClient } from "@opendatalabs/vana-sdk";
import {
  VANA_NETWORKS,
  resolveNetwork,
  type VanaNetworkName,
} from "../core/network.js";

export interface RegisteredServer {
  network: VanaNetworkName;
  url: string;
  serverAddress: string;
  status: string;
}

const LOOKUP_TIMEOUT_MS = 5_000;

function withTimeout<T>(promise: Promise<T>, fallback: T): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((resolve) =>
      setTimeout(() => resolve(fallback), LOOKUP_TIMEOUT_MS).unref?.(),
    ),
  ]).catch(() => fallback);
}

/**
 * Active registrations for an owner across both networks, newest first per
 * network. Failures and timeouts yield an empty list, never an error - a
 * display concern must not break a status command.
 */
export async function lookupRegisteredServers(
  owner: string,
  deps: { createClient?: typeof createGatewayClient } = {},
): Promise<RegisteredServer[]> {
  const createClient = deps.createClient ?? createGatewayClient;
  const perNetwork = await Promise.all(
    VANA_NETWORKS.map(async (name): Promise<RegisteredServer[]> => {
      try {
        // Note: VANA_ENV=dev refuses mainnet host resolution; that network
        // simply contributes nothing rather than failing the lookup.
        const network = resolveNetwork(name, process.env);
        const result = await withTimeout(
          createClient(network.gatewayUrl).listServersByOwner(owner),
          null,
        );
        if (!result?.active?.length) {
          return [];
        }
        return result.active
          .filter((record) => Boolean(record.serverUrl))
          .map((record) => ({
            network: name,
            url: record.serverUrl,
            serverAddress: record.serverAddress,
            status: record.status ?? "unknown",
          }));
      } catch {
        return [];
      }
    }),
  );
  return perNetwork.flat();
}
