/**
 * `vana app whoami` - the app identity at a glance: address, where the key
 * came from, network, registration state. Never creates a key.
 */

import {
  createGatewayClient,
  type GatewayClient,
} from "@opendatalabs/vana-sdk";
import {
  AppKeyMissingError,
  InvalidAppKeyError,
  resolveAppKey,
} from "../../core/app-key.js";
import {
  UnknownNetworkError,
  resolveNetwork,
  type ResolvedNetwork,
} from "../../core/network.js";
import { emitAppOutcome, type AppCommandOptions } from "./outcome.js";

export interface WhoamiDeps {
  createClient?: (gatewayUrl: string) => GatewayClient;
  resolveKey?: typeof resolveAppKey;
}

export async function runAppWhoami(
  options: AppCommandOptions,
  deps: WhoamiDeps = {},
): Promise<number> {
  let network: ResolvedNetwork;
  try {
    network = resolveNetwork(options.network);
  } catch (error) {
    if (error instanceof UnknownNetworkError) {
      return emitAppOutcome(options, {
        status: "failed",
        code: "bad_usage",
        message: error.message,
      });
    }
    throw error;
  }

  try {
    const key = (deps.resolveKey ?? resolveAppKey)({ allowGenerate: false });
    let registered: boolean | "unknown" = "unknown";
    try {
      const client = (deps.createClient ?? createGatewayClient)(
        network.gatewayUrl,
      );
      registered = await client.isRegisteredBuilder(key.address);
    } catch {
      // Offline is a fine state for whoami; report what is known locally.
    }
    return emitAppOutcome(options, {
      status: "done",
      code: "ok",
      message: key.address,
      network: network.name,
      data: {
        address: key.address,
        keySource: key.source,
        network: network.name,
        chainId: network.chainId,
        gatewayUrl: network.gatewayUrl,
        registered,
      },
    });
  } catch (error) {
    if (error instanceof AppKeyMissingError) {
      return emitAppOutcome(options, {
        status: "done",
        code: "ok",
        message: "No app key on this machine yet.",
        remedy: "vana app register",
        network: network.name,
        data: { address: null, keySource: null, registered: false },
      });
    }
    if (error instanceof InvalidAppKeyError) {
      return emitAppOutcome(options, {
        status: "failed",
        code: "bad_usage",
        message: error.message,
        network: network.name,
      });
    }
    throw error;
  }
}
