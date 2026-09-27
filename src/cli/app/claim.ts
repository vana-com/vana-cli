/**
 * `vana app claim` - hand the app's owner one link that adds this app to
 * their Vana Account, so they can fund its escrow there.
 *
 * An app registered from the CLI has its own key and is in nobody's Apps
 * list, and Account's Fund page only serves apps in the signed-in Account.
 * This signs a BuilderClaimLink with the app key and prints a link to
 * Account; whoever opens it while signed in adds the app with one click and
 * lands on its Fund page. The key never leaves this machine and nothing has
 * to call back into it, so it works from a sandbox or another machine too.
 */

import crypto from "node:crypto";
import {
  createGatewayClient,
  type GatewayClient,
} from "@opendatalabs/vana-sdk";
import { privateKeyToAccount } from "viem/accounts";
import { readAppProfile, saveAppProfile } from "../../core/app-profile.js";
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
import { openBrowser } from "../auth.js";
import { emitAppOutcome, type AppCommandOptions } from "./outcome.js";
import { builderRegistrationDomainFor } from "./register.js";

/**
 * Must match Account's BUILDER_CLAIM_LINK_TYPES. The app name is signed so
 * nobody can relabel the link; Account shows it instead of the URL's host.
 */
export const BUILDER_CLAIM_LINK_TYPES = {
  BuilderClaimLink: [
    { name: "granteeAddress", type: "address" },
    { name: "network", type: "string" },
    { name: "nonce", type: "bytes32" },
    { name: "expiry", type: "uint64" },
    { name: "appName", type: "string" },
  ],
} as const;

/** Account's limit for an app name. */
export const CLAIM_LINK_APP_NAME_MAX_LENGTH = 64;

/** Account accepts links up to an hour out; stay inside it with room for clock skew. */
export const CLAIM_LINK_TTL_SEC = 50 * 60;

export interface ClaimLink {
  url: string;
  expiry: number;
}

export async function buildClaimLink(input: {
  privateKey: `0x${string}`;
  network: ResolvedNetwork;
  appName?: string;
  nowSec?: number;
  nonce?: `0x${string}`;
}): Promise<ClaimLink> {
  const account = privateKeyToAccount(input.privateKey);
  const expiry =
    (input.nowSec ?? Math.floor(Date.now() / 1000)) + CLAIM_LINK_TTL_SEC;
  const nonce =
    input.nonce ??
    (`0x${crypto.randomBytes(32).toString("hex")}` as `0x${string}`);
  const appName = (input.appName ?? "")
    .trim()
    .slice(0, CLAIM_LINK_APP_NAME_MAX_LENGTH);
  const signature = await account.signTypedData({
    domain: builderRegistrationDomainFor(input.network),
    types: BUILDER_CLAIM_LINK_TYPES,
    primaryType: "BuilderClaimLink",
    message: {
      granteeAddress: account.address,
      network: input.network.name,
      nonce,
      expiry: BigInt(expiry),
      appName,
    },
  });
  const params = new URLSearchParams({
    network: input.network.name,
    address: account.address.toLowerCase(),
    nonce,
    expiry: String(expiry),
    signature,
  });
  if (appName) params.set("name", appName);
  return {
    url: `${input.network.accountUrl}/developers/apps/claim?${params}`,
    expiry,
  };
}

export interface ClaimOptions extends AppCommandOptions {
  /** Name to show in the owner's Account; remembered like `register --app-name`. */
  appName?: string;
}

export interface ClaimDeps {
  createClient?: (gatewayUrl: string) => GatewayClient;
  readProfile?: typeof readAppProfile;
  saveProfile?: typeof saveAppProfile;
  resolveKey?: typeof resolveAppKey;
  openUrl?: (url: string) => void;
  isTty?: boolean;
}

export async function runAppClaim(
  options: ClaimOptions,
  deps: ClaimDeps = {},
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

  let key: ReturnType<typeof resolveAppKey>;
  try {
    key = (deps.resolveKey ?? resolveAppKey)({ allowGenerate: false });
  } catch (error) {
    if (error instanceof AppKeyMissingError) {
      return emitAppOutcome(options, {
        status: "failed",
        code: "builder_unknown",
        message: "No app key on this machine yet.",
        remedy: "vana app register",
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

  let registered: boolean | "unknown" = "unknown";
  try {
    registered = await (deps.createClient ?? createGatewayClient)(
      network.gatewayUrl,
    ).isRegisteredBuilder(key.address);
  } catch {
    // Offline: the link still works once the gateway answers Account.
  }
  if (registered === false) {
    return emitAppOutcome(options, {
      status: "failed",
      code: "builder_unknown",
      message: `This app is not registered on ${network.name} yet, so there is nothing to claim.`,
      remedy: "vana app register",
      network: network.name,
    });
  }

  if (options.appName?.trim()) {
    try {
      (deps.saveProfile ?? saveAppProfile)(key.address, {
        name: options.appName,
      });
    } catch {
      // Remembering the name is a convenience; the link carries it anyway.
    }
  }
  const appName =
    options.appName?.trim() ||
    (deps.readProfile ?? readAppProfile)(key.address).name ||
    "";
  const link = await buildClaimLink({
    privateKey: key.privateKey,
    network,
    appName,
  });
  const isTty = deps.isTty ?? Boolean(process.stdout.isTTY);
  if (isTty && !options.json && !options.noInput) {
    (deps.openUrl ?? openBrowser)(link.url);
  }
  const fundUrl = `${network.accountUrl}/developers/apps/${network.name}/${key.address.toLowerCase()}/fund`;
  return emitAppOutcome(options, {
    status: "done",
    code: "ok",
    message:
      "Send this link to the app's owner. Opened while signed in to Vana Account, it adds the app to their Apps and goes to Fund escrow.",
    network: network.name,
    data: {
      appName: appName || undefined,
      claimUrl: link.url,
      expiresAt: new Date(link.expiry * 1000).toISOString(),
      address: key.address,
      fundUrl,
    },
  });
}
