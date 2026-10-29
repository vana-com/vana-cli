/**
 * `vana app register` - idempotent builder registration at the gateway.
 *
 * Moksha can generate a first app key. Mainnet reuses the established Moksha
 * identity and completes Account association before reporting success.
 */

import {
  BUILDER_REGISTRATION_TYPES,
  createGatewayClient,
  type GatewayClient,
} from "@opendatalabs/vana-sdk";
import { privateKeyToAccount } from "viem/accounts";
import {
  resolveAppKey,
  InvalidAppKeyError,
  AppKeyMissingError,
  type ResolvedAppKey,
} from "../../core/app-key.js";
import {
  UnknownNetworkError,
  resolveNetwork,
  type ResolvedNetwork,
} from "../../core/network.js";
import { saveAppProfile } from "../../core/app-profile.js";
import { emitAppOutcome, type AppCommandOptions } from "./outcome.js";
import { runMainnetRegistration } from "./mainnet-registration.js";
import type { AppRegistrationStore } from "../../core/app-registration-store.js";
import type { loadCredentials } from "../auth.js";

export interface RegisterCommandOptions extends AppCommandOptions {
  /** Public URL of the app; the gateway stores it on the record. */
  appUrl?: string;
  /** Name people see when this app asks for access; remembered locally. */
  appName?: string;
}

export interface RegisterDeps {
  fetch?: typeof fetch;
  loadCredentials?: typeof loadCredentials;
  store?: AppRegistrationStore;
  createClient?: (gatewayUrl: string) => GatewayClient;
  resolveKey?: typeof resolveAppKey;
  saveProfile?: typeof saveAppProfile;
}

const EIP712_DOMAIN_NAME = "Vana Data Portability";
const EIP712_DOMAIN_VERSION = "1";

export function builderRegistrationDomainFor(network: ResolvedNetwork) {
  return {
    name: EIP712_DOMAIN_NAME,
    version: EIP712_DOMAIN_VERSION,
    chainId: BigInt(network.chainId),
    verifyingContract: network.granteesContract as `0x${string}`,
  } as const;
}

export async function signBuilderRegistration(
  key: ResolvedAppKey,
  network: ResolvedNetwork,
  appUrl: string,
): Promise<{
  ownerAddress: string;
  granteeAddress: string;
  publicKey: string;
  appUrl: string;
  signature: string;
}> {
  const account = privateKeyToAccount(key.privateKey);
  const message = {
    ownerAddress: key.address,
    granteeAddress: key.address,
    publicKey: key.publicKey,
    appUrl,
  };
  const signature = await account.signTypedData({
    domain: builderRegistrationDomainFor(network),
    types: BUILDER_REGISTRATION_TYPES,
    primaryType: "BuilderRegistration",
    message,
  });
  return { ...message, signature };
}

export async function runAppRegister(
  options: RegisterCommandOptions,
  deps: RegisterDeps = {},
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

  let key: ResolvedAppKey;
  try {
    key = (deps.resolveKey ?? resolveAppKey)({
      allowGenerate: network.name !== "mainnet",
    });
  } catch (error) {
    if (error instanceof AppKeyMissingError) {
      return emitAppOutcome(options, {
        status: "failed",
        code: "builder_unknown",
        message:
          "No existing app key was found. Mainnet registration never generates a replacement key.",
        remedy:
          "Select the existing app key, or create and test an app on Moksha first.",
        network: network.name,
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

  if (network.name === "mainnet")
    return runMainnetRegistration(options, key, network, deps);

  // Remember how this app introduces itself, so `vana app request` shows it
  // on the approval page without repeating --app-name every time.
  // A local file that cannot be written must not cost the registration.
  try {
    (deps.saveProfile ?? saveAppProfile)(
      key.address,
      {
        name: options.appName,
        url: options.appUrl,
      },
      network,
    );
  } catch {
    // The name then has to be passed as --app-name on each request.
  }

  const client = (deps.createClient ?? createGatewayClient)(network.gatewayUrl);

  try {
    if (await client.isRegisteredBuilder(key.address)) {
      return emitAppOutcome(options, {
        status: "done",
        code: "ok",
        message: "Already registered.",
        network: network.name,
        data: {
          address: key.address,
          keySource: key.source,
          alreadyRegistered: true,
        },
      });
    }

    const params = await signBuilderRegistration(
      key,
      network,
      options.appUrl ?? "",
    );
    const result = await client.registerBuilder(params);
    return emitAppOutcome(options, {
      status: "done",
      code: "ok",
      message: result.alreadyRegistered
        ? "Already registered."
        : "Builder registered.",
      network: network.name,
      data: {
        address: key.address,
        keySource: key.source,
        builderId: result.builderId ?? null,
        alreadyRegistered: result.alreadyRegistered,
      },
    });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Gateway request failed.";
    return emitAppOutcome(options, {
      status: "failed",
      code: "gateway_unreachable",
      message: `Builder registration failed: ${message}`,
      remedy: "check connectivity to " + network.gatewayUrl + " and retry",
      network: network.name,
      data: { address: key.address },
    });
  }
}
