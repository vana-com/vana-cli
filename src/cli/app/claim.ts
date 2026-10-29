/**
 * `vana app claim` - hand the app's owner one link that adds this app to
 * their Vana Account, then confirm ownership through Account.
 *
 * An app registered from the CLI has its own key and is in nobody's Apps
 * list, and Account's Fund page only serves apps in the signed-in Account.
 * This signs a BuilderClaimLink with the app key and prints a link to
 * Account; whoever opens it while signed in adds the app with one click and
 * lands on its Fund page. The key never leaves this machine and nothing has
 * to call back into it. Recovery retains the same app, Account and link.
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
import { getAccountUrl, loadCredentials, openBrowser } from "../auth.js";
import {
  createAppClaimStore,
  type StoredAppClaim,
} from "../../core/app-claim-store.js";
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
  /** Continue the saved claim for this app, Account deployment and network. */
  resume?: boolean;
  /** Maximum interactive wait for Account confirmation, in seconds. */
  timeout?: string;
}

export interface ClaimDeps {
  createClient?: (gatewayUrl: string) => GatewayClient;
  readProfile?: typeof readAppProfile;
  saveProfile?: typeof saveAppProfile;
  resolveKey?: typeof resolveAppKey;
  openUrl?: (url: string) => void;
  isTty?: boolean;
  fetch?: typeof fetch;
  loadCredentials?: typeof loadCredentials;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
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
    // Registration must be confirmed before claiming completion.
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
  const accountUrl = getAccountUrl();
  const address = key.address.toLowerCase();
  const context = {
    address,
    accountUrl,
    gatewayUrl: network.gatewayUrl,
    network: network.name,
  };
  const store = createAppClaimStore(context);
  let saved: StoredAppClaim | null = null;
  const quotedAccountUrl = `'${accountUrl.replace(/'/g, "'\\''")}'`;
  const resumeCommand = `${network.env === "dev" ? "VANA_ENV=dev " : ""}${process.env.VANA_ACCOUNT_URL ? `VANA_ACCOUNT_URL=${quotedAccountUrl} ` : ""}vana app claim --network ${network.name} --resume${options.json ? " --json" : ""}${options.noInput ? " --no-input" : ""}`;
  const fail = (
    code: string,
    message: string,
    data: Record<string, unknown> = {},
  ) =>
    emitAppOutcome(options, {
      status: "failed",
      code,
      message,
      remedy: saved ? resumeCommand : resumeCommand.replace(" --resume", ""),
      network: network.name,
      data: { address, ...data },
    });
  const waitSeconds = Number(options.timeout ?? 120);
  if (!Number.isFinite(waitSeconds) || waitSeconds < 0)
    return fail(
      "bad_usage",
      "--timeout must be a nonnegative number of seconds.",
    );
  if (registered === "unknown")
    return fail(
      "not_ready",
      "App registration could not be checked. No claim was started.",
    );
  try {
    saved = store.read();
  } catch {
    return fail(
      "not_ready",
      "Saved claim cannot be read. No replacement claim was created.",
    );
  }
  if (options.resume && !saved)
    return fail(
      "bad_usage",
      "No saved claim exists for this app and environment. Run vana app claim without --resume to start.",
    );
  const credentials = (deps.loadCredentials ?? loadCredentials)();
  if (!credentials)
    return emitAppOutcome(options, {
      status: "failed",
      code: "confirmation_required",
      network: network.name,
      message:
        "Sign in to the Vana Account that should own this app, then continue claiming.",
      remedy: `vana login, then ${saved ? resumeCommand : resumeCommand.replace(" --resume", "")}`,
      data: { address },
    });
  if (
    saved &&
    options.appName !== undefined &&
    options.appName.trim() !== saved.appName
  )
    return fail(
      "bad_usage",
      "Resume the saved claim with its original app name.",
    );
  if (!saved && options.appName?.trim()) {
    try {
      (deps.saveProfile ?? saveAppProfile)(key.address, {
        name: options.appName,
      });
    } catch {
      // Remembering the name is a convenience; the link carries it anyway.
    }
  }
  const appName =
    saved?.appName ??
    (options.appName?.trim() ||
      (deps.readProfile ?? readAppProfile)(key.address).name ||
      "");
  const now = deps.now ?? Date.now;
  const deadline = now() + waitSeconds * 1000;
  const isTty = deps.isTty ?? Boolean(process.stdout.isTTY);
  let opened = false;
  for (;;) {
    let body: Record<string, unknown>;
    try {
      const response = await (deps.fetch ?? fetch)(
        `${accountUrl}/api/v1/me/app-ownership?address=${address}&network=${network.name}`,
        {
          headers: {
            authorization: `Bearer ${credentials.account.session_token}`,
          },
          redirect: "error",
          signal: AbortSignal.timeout(10_000),
        },
      );
      if (response.status === 401)
        return emitAppOutcome(options, {
          status: "failed",
          code: "confirmation_required",
          network: network.name,
          message:
            "Account sign-in expired. Sign in again to confirm this claim.",
          remedy: `vana login, then ${saved ? resumeCommand : resumeCommand.replace(" --resume", "")}`,
          data: { address },
        });
      if (!response.ok)
        return fail(
          "not_ready",
          "Account ownership is unavailable. Claim completion is unconfirmed.",
        );
      body = (await response.json()) as Record<string, unknown>;
    } catch {
      return fail(
        "not_ready",
        "Account ownership could not be checked. Claim completion is unconfirmed.",
      );
    }
    if (
      !body ||
      body.object !== "app_ownership" ||
      body.appAddress !== address ||
      body.network !== network.name ||
      typeof body.subject !== "string" ||
      !/^vana_user_[a-f0-9]{32}$/.test(body.subject) ||
      !["owned", "not_owned"].includes(String(body.ownership))
    )
      return fail(
        "not_ready",
        "Account returned invalid ownership evidence. Claim completion is unconfirmed.",
      );
    if (saved && saved.subject !== body.subject)
      return fail(
        "bad_usage",
        "This claim belongs to a different Account. Sign in to its original Account before resuming.",
      );
    if (!saved) saved = { ...context, subject: body.subject, appName };
    if (body.ownership === "owned") {
      try {
        store.save(saved);
      } catch {
        return fail(
          "not_ready",
          "Account confirmed ownership, but claim recovery state could not be saved. Rerun the same command.",
        );
      }
      return emitAppOutcome(options, {
        status: "done",
        code: "ok",
        message: "App registered and linked to your Account.",
        network: network.name,
        data: {
          address,
          subject: body.subject,
          ownership: "owned",
          appName: saved.appName || undefined,
        },
      });
    }
    if (!saved.link || saved.link.expiry <= Math.floor(now() / 1000))
      saved.link = await buildClaimLink({
        privateKey: key.privateKey,
        network: { ...network, accountUrl },
        appName: saved.appName,
        nowSec: Math.floor(now() / 1000),
      });
    try {
      store.save(saved);
    } catch {
      return fail(
        "not_ready",
        "Cannot save claim recovery state. No browser claim was opened.",
      );
    }
    const data = {
      appName: saved.appName || undefined,
      ownership: "not_owned",
      claimUrl: saved.link.url,
      expiresAt: new Date(saved.link.expiry * 1000).toISOString(),
      fundUrl: `${accountUrl}/developers/apps/${network.name}/${address}/fund`,
    };
    if (!isTty || options.json || options.noInput || options.quiet)
      return fail(
        "confirmation_required",
        "Open the Account claim link, then resume to confirm the app is linked.",
        data,
      );
    if (!opened) {
      process.stderr.write(
        `Claim this app in Vana Account: ${saved.link.url}\nWaiting for Account confirmation...\n`,
      );
      (deps.openUrl ?? openBrowser)(saved.link.url);
      opened = true;
    }
    if (now() >= deadline)
      return fail(
        "confirmation_required",
        "Account ownership is not confirmed yet. Resume after completing the browser claim.",
        data,
      );
    await (
      deps.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)))
    )(Math.min(2000, Math.max(0, deadline - now())));
  }
}
