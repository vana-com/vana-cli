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
import { isHttpUrl, runMainnetRegistration } from "./mainnet-registration.js";
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
      // The record cannot change. An empty URL still works for paid reads,
      // but Account can never claim the app, so say so instead of hiding it.
      const recorded =
        typeof client.getBuilder === "function"
          ? await client.getBuilder(key.address).catch(() => null)
          : null;
      const claimable = recorded?.appUrl === "" ? false : undefined;
      return emitAppOutcome(options, {
        status: "done",
        code: "ok",
        message:
          claimable === false
            ? "Already registered, without an app URL, so Vana Account cannot claim this app."
            : "Already registered.",
        network: network.name,
        data: {
          address: key.address,
          keySource: key.source,
          alreadyRegistered: true,
          claimable,
        },
      });
    }

    // The gateway keeps the first registration, and Account cannot claim
    // (or approve owner-only sources for) an app whose record has no URL.
    // Refuse rather than create an identity that can never be claimed.
    const appUrl = options.appUrl?.trim() ?? "";
    if (!isHttpUrl(appUrl)) {
      return emitAppOutcome(options, {
        status: "failed",
        code: "bad_usage",
        message:
          "Pass --app-url with an http(s) URL. Vana Account cannot claim an app registered without one, and the URL cannot be changed after registration.",
        remedy: `vana app register --network ${network.name} --app-url http://localhost:3000 --app-name "<your app>"`,
        network: network.name,
        data: { address: key.address },
      });
    }

    const params = await signBuilderRegistration(key, network, appUrl);
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
