/**
 * `vana app register` - idempotent builder registration at the gateway.
 *
 * Resolves the app key (generating one on first use), checks the gateway
 * first and exits 0 when the app is already registered, otherwise signs the
 * EIP-712 BuilderRegistration and posts it. Safe at the top of any script.
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
  type ResolvedAppKey,
} from "../../core/app-key.js";
import {
  UnknownNetworkError,
  resolveNetwork,
  type ResolvedNetwork,
} from "../../core/network.js";
import { emitAppOutcome, type AppCommandOptions } from "./outcome.js";

export interface RegisterCommandOptions extends AppCommandOptions {
  /** Public URL of the app; the gateway stores it on the record. */
  appUrl?: string;
}

export interface RegisterDeps {
  createClient?: (gatewayUrl: string) => GatewayClient;
  resolveKey?: typeof resolveAppKey;
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
    key = (deps.resolveKey ?? resolveAppKey)({ allowGenerate: true });
  } catch (error) {
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
