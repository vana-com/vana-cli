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

export interface CheckedServer extends RegisteredServer {
  /** Answered /health from outside as this owner's server. */
  reachable: boolean;
}

/**
 * Ask each registration's public URL whether it answers, in parallel. A
 * registration only counts as live when its /health says it belongs to this
 * owner and, when it says who it is, that it is the registered server.
 */
export async function checkRegisteredServers(
  servers: RegisteredServer[],
  owner: string,
  fetchImpl: typeof fetch = fetch,
): Promise<CheckedServer[]> {
  return Promise.all(
    servers.map(async (server) => {
      try {
        const response = await fetchImpl(
          `${server.url.replace(/\/+$/, "")}/health`,
          { signal: AbortSignal.timeout(LOOKUP_TIMEOUT_MS) },
        );
        if (!response.ok) return { ...server, reachable: false };
        const health = (await response.json()) as {
          owner?: unknown;
          identity?: { address?: unknown };
        };
        const ownerMatches =
          typeof health.owner === "string" &&
          health.owner.toLowerCase() === owner.toLowerCase();
        const identity = health.identity?.address;
        const identityMatches =
          typeof identity !== "string" ||
          identity.toLowerCase() === server.serverAddress.toLowerCase();
        return { ...server, reachable: ownerMatches && identityMatches };
      } catch {
        return { ...server, reachable: false };
      }
    }),
  );
}
