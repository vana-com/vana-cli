import path from "node:path";
import { createGatewayClient, type Builder } from "@opendatalabs/vana-sdk";
import { privateKeyToAccount } from "viem/accounts";
import type { ResolvedAppKey } from "../../core/app-key.js";
import { readAppProfile, saveAppProfile } from "../../core/app-profile.js";
import { resolveNetwork, type ResolvedNetwork } from "../../core/network.js";
import { getVanaHome } from "../../core/paths.js";
import {
  createAppRegistrationStore,
  type StoredAppRegistration,
} from "../../core/app-registration-store.js";
import {
  getAccountUrl,
  loadCredentials,
  runDeviceCodeFlow,
  saveCredentials,
} from "../auth.js";
import { emitAppOutcome } from "./outcome.js";
import {
  builderRegistrationDomainFor,
  signBuilderRegistration,
  type RegisterCommandOptions,
  type RegisterDeps,
} from "./register.js";

/** Account's BuilderNetworkAssociation proof; mirrored across the HTTP boundary. */
export const BUILDER_NETWORK_ASSOCIATION_TYPES = {
  BuilderNetworkAssociation: [
    { name: "granteeAddress", type: "address" },
    { name: "accountSubject", type: "string" },
    { name: "accountOrigin", type: "string" },
    { name: "sourceNetwork", type: "string" },
    { name: "network", type: "string" },
    { name: "appUrl", type: "string" },
    { name: "appName", type: "string" },
    { name: "expiry", type: "uint64" },
  ],
} as const;

class RegistrationError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly remedy?: string,
  ) {
    super(message);
  }
}

/**
 * Account rejections that a rerun of the same command cannot change: bad
 * requests, refused ownership and conflicting rows. A 409
 * builder_not_registered only means Account's chain read is behind.
 */
function isPermanentAssociationFailure(
  status: number,
  accountCode: string | null,
): boolean {
  if (status === 400 || status === 403) return true;
  return status === 409 && accountCode !== "builder_not_registered";
}

async function accountErrorCode(response: Response): Promise<string | null> {
  try {
    const body = (await response.json()) as { error?: { code?: unknown } };
    return typeof body.error?.code === "string" ? body.error.code : null;
  } catch {
    return null;
  }
}

/** Finish the existing app's mainnet registration without another Account claim. */
export async function runMainnetRegistration(
  options: RegisterCommandOptions,
  key: ResolvedAppKey,
  network: ResolvedNetwork,
  deps: RegisterDeps,
): Promise<number> {
  const accountUrl = getAccountUrl();
  const store = deps.store ?? createAppRegistrationStore();
  const request = deps.fetch ?? fetch;
  const address = key.address.toLowerCase();
  let gatewayRegistered = false;
  let registrationAttempted = false;
  const fail = (
    code: string,
    message: string,
    remedy = "Rerun the same vana app register command.",
  ) =>
    emitAppOutcome(options, {
      status: "failed",
      code,
      message,
      remedy,
      network: network.name,
      data: {
        address,
        partial: gatewayRegistered || undefined,
        gatewayRegistration: gatewayRegistered
          ? "registered"
          : registrationAttempted
            ? "unknown"
            : "not_started",
      },
    });
  try {
    const saved = store.getRegistration();
    registrationAttempted = Boolean(saved);
    if (
      saved &&
      (saved.appAddress !== address ||
        saved.accountUrl !== accountUrl ||
        saved.gatewayUrl !== network.gatewayUrl ||
        saved.network !== network.name ||
        saved.env !== network.env)
    ) {
      throw new RegistrationError(
        "bad_usage",
        "An unfinished registration belongs to a different app or environment. Resume its original context.",
      );
    }
    const profile = readAppProfile(address, network);
    // Production URLs must be explicit or retained by this exact operation,
    // never inherited from an unscoped historical testnet profile.
    const appUrl = options.appUrl?.trim() || saved?.appUrl;
    const appName =
      options.appName?.trim() ?? saved?.appName ?? profile.name ?? "";
    if (!appUrl || !isHttpUrl(appUrl) || appName.length > 64) {
      throw new RegistrationError(
        "bad_usage",
        "Pass --app-url with the production HTTP(S) URL and an app name of at most 64 characters.",
      );
    }
    if (saved && (saved.appUrl !== appUrl || saved.appName !== appName)) {
      throw new RegistrationError(
        "bad_usage",
        "The unfinished registration has different production metadata. Resume its original URL and name.",
      );
    }

    let credentials = (deps.loadCredentials ?? loadCredentials)();
    if (!credentials) {
      if (
        !process.stdout.isTTY ||
        options.noInput ||
        options.json ||
        options.quiet
      ) {
        return fail(
          "confirmation_required",
          "Sign in to the Account that owns this app, then resume registration.",
          "vana login, then rerun the same vana app register command",
        );
      }
      credentials = await runDeviceCodeFlow(
        {
          onCode: (code, uri) => {
            process.stderr.write(`Sign in to Vana Account: ${uri} (${code})\n`);
          },
          onWaiting: () => {},
          onAuthorized: saveCredentials,
          onExpired: () => {},
          onError: () => {},
        },
        { openBrowser: true },
      );
      if (!credentials)
        return fail(
          "confirmation_required",
          "Account sign-in did not complete. Rerun to continue.",
        );
    }
    const token = credentials.account.session_token;
    const ownership = async (
      target: "moksha" | "mainnet",
      subject?: string,
    ): Promise<{ subject: string; ownership: string }> => {
      const response = await request(
        `${accountUrl}/api/v1/me/app-ownership?address=${address}&network=${target}`,
        {
          headers: { authorization: `Bearer ${token}` },
          redirect: "error",
          signal: AbortSignal.timeout(10_000),
        },
      );
      if (response.status === 401)
        throw new RegistrationError(
          "confirmation_required",
          "Account authentication expired. Sign in and rerun registration.",
        );
      if (!response.ok)
        throw new RegistrationError(
          "not_ready",
          "Account ownership is unavailable. No ownership decision has been made.",
        );
      const body = (await response.json()) as Record<string, unknown>;
      if (
        body.object !== "app_ownership" ||
        body.appAddress !== address ||
        body.network !== target ||
        typeof body.subject !== "string" ||
        !/^vana_user_[a-f0-9]{32}$/.test(body.subject) ||
        (subject && body.subject !== subject) ||
        !["owned", "not_owned"].includes(String(body.ownership))
      ) {
        throw new RegistrationError(
          "not_ready",
          "Account returned ownership evidence for an unexpected identity or network.",
        );
      }
      return { subject: body.subject, ownership: String(body.ownership) };
    };
    const source = await ownership("moksha", saved?.subject);
    if (source.ownership !== "owned")
      throw new RegistrationError(
        "builder_unknown",
        "This Account does not have confirmed Moksha ownership of this app.",
      );
    const createClient = deps.createClient ?? createGatewayClient;
    const sourceBuilder = await createClient(
      resolveNetwork("moksha").gatewayUrl,
    ).getBuilder(address);
    if (
      !sourceBuilder ||
      sourceBuilder.granteeAddress.toLowerCase() !== address ||
      sourceBuilder.ownerAddress.toLowerCase() !== address ||
      sourceBuilder.publicKey.toLowerCase() !== key.publicKey.toLowerCase()
    ) {
      throw new RegistrationError(
        "builder_unknown",
        "The existing Moksha registration is missing or is not the CLI-created identity selected by this key.",
      );
    }
    const context: StoredAppRegistration = {
      appAddress: address,
      subject: source.subject,
      accountUrl,
      gatewayUrl: network.gatewayUrl,
      network: "mainnet",
      env: network.env,
      appUrl,
      appName,
    };
    store.saveRegistration(context);
    const target = createClient(network.gatewayUrl);
    let builder = await target.getBuilder(address);
    if (!builder) {
      // The saved identity survives a lost response. The next invocation reads
      // the registry before attempting this idempotent registration again.
      registrationAttempted = true;
      await target.registerBuilder(
        await signBuilderRegistration(key, network, appUrl),
      );
      builder = await target.getBuilder(address);
    }
    if (!builder)
      throw new RegistrationError(
        "not_ready",
        "Mainnet registration is not confirmed yet.",
      );
    gatewayRegistered = true;
    if (!matchesRegistration(builder, key, appUrl)) {
      throw new RegistrationError(
        "bad_usage",
        "The existing mainnet registration has different ownership, key or URL. No metadata was changed.",
      );
    }
    // The SDK unwraps pending records too. Account requires confirmed chain
    // evidence, so wait on reads before asking it to associate this owner.
    if (!options.json && !options.quiet) {
      process.stderr.write("Confirming mainnet registration…\n");
    }
    await waitForMainnetConfirmation(network, key, appUrl, request);

    // Legacy attribution can already project as owned on mainnet without a
    // scoped production row. Always reconcile that row through Account.
    const expiry = Math.floor(Date.now() / 1000) + 240;
    const signature = await privateKeyToAccount(key.privateKey).signTypedData({
      domain: builderRegistrationDomainFor(network),
      types: BUILDER_NETWORK_ASSOCIATION_TYPES,
      primaryType: "BuilderNetworkAssociation",
      message: {
        granteeAddress: key.address,
        accountSubject: source.subject,
        accountOrigin: new URL(accountUrl).origin,
        sourceNetwork: "moksha",
        network: "mainnet",
        appUrl,
        appName,
        expiry: BigInt(expiry),
      },
    });
    const response = await request(
      `${accountUrl}/api/v1/me/app-registrations`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          address,
          network: "mainnet",
          appUrl,
          appName,
          expiry,
          signature,
        }),
        redirect: "error",
        signal: AbortSignal.timeout(10_000),
      },
    );
    if (response.status === 401)
      throw new RegistrationError(
        "confirmation_required",
        "Account authentication expired after gateway registration. Sign in and resume.",
      );
    if (!response.ok) {
      const accountCode = await accountErrorCode(response);
      if (accountCode === "forbidden_client")
        throw new RegistrationError(
          "confirmation_required",
          "Vana Account does not accept this sign-in for app registration. Sign in from the CLI and rerun.",
        );
      if (isPermanentAssociationFailure(response.status, accountCode)) {
        const refused = accountCode ?? `HTTP ${response.status}`;
        const journal = path.join(getVanaHome(), "app", "registration.json");
        throw new RegistrationError(
          accountCode ?? "association_refused",
          `Mainnet is registered, but Vana Account refused the association (${refused}). Rerunning will not change this.`,
          `Send the app address and "${refused}" to the Vana team. To register a different app on this machine meanwhile, remove ${journal}.`,
        );
      }
      throw new RegistrationError(
        "not_ready",
        `Mainnet is registered; Account association is unconfirmed (${accountCode ?? `HTTP ${response.status}`}). Rerun to finish it.`,
      );
    }
    const targetOwnership = await ownership("mainnet", source.subject);
    if (targetOwnership.ownership !== "owned")
      throw new RegistrationError(
        "not_ready",
        "Mainnet registration is present but Account ownership is not confirmed.",
      );
    (deps.saveProfile ?? saveAppProfile)(
      address,
      { name: appName, url: appUrl },
      network,
    );
    store.completeRegistration(context);
    return emitAppOutcome(options, {
      status: "done",
      code: "ok",
      message: "App registered on mainnet.",
      network: "mainnet",
      data: {
        address,
        subject: source.subject,
        appUrl,
        ownership: "owned",
        mokshaPreserved: true,
      },
    });
  } catch (error) {
    if (error instanceof RegistrationError)
      return fail(
        error.code,
        error.message,
        error.remedy ??
          (error.code === "confirmation_required"
            ? "vana login, then rerun the same vana app register command"
            : undefined),
      );
    return fail(
      "not_ready",
      gatewayRegistered
        ? "Mainnet registration is present; completion could not be confirmed. Rerun to finish."
        : "Registration could not be confirmed. Rerun with the same app and URL.",
    );
  }
}

function matchesRegistration(
  value: unknown,
  key: ResolvedAppKey,
  appUrl: string,
): value is Builder {
  if (!value || typeof value !== "object") return false;
  const record = value as Partial<Builder>;
  return (
    typeof record.granteeAddress === "string" &&
    record.granteeAddress.toLowerCase() === key.address.toLowerCase() &&
    typeof record.ownerAddress === "string" &&
    record.ownerAddress.toLowerCase() === key.address.toLowerCase() &&
    typeof record.publicKey === "string" &&
    record.publicKey.toLowerCase() === key.publicKey.toLowerCase() &&
    record.appUrl === appUrl
  );
}

async function waitForMainnetConfirmation(
  network: ResolvedNetwork,
  key: ResolvedAppKey,
  appUrl: string,
  request: typeof fetch,
): Promise<void> {
  const deadline = Date.now() + 90_000;
  const url = `${network.gatewayUrl}/v1/builders/${key.address.toLowerCase()}`;
  for (;;) {
    // Only GETs are repeated. A lost or delayed confirmation must never
    // submit another gateway registration or change the frozen identity.
    const response = await request(url, {
      redirect: "error",
      signal: AbortSignal.timeout(
        Math.max(1, Math.min(10_000, deadline - Date.now())),
      ),
    }).catch(() => null);
    if (response?.ok) {
      const body = (await response.json().catch(() => null)) as {
        data?: unknown;
        proof?: { status?: unknown };
      } | null;
      if (body?.proof?.status === "confirmed") {
        if (!matchesRegistration(body.data, key, appUrl)) {
          throw new RegistrationError(
            "bad_usage",
            "The confirmed mainnet record has a different key, owner or URL. Account association was not submitted.",
          );
        }
        return;
      }
      if (body?.proof?.status === "failed") {
        throw new RegistrationError(
          "not_ready",
          "Mainnet registration failed confirmation. Account association was not submitted.",
        );
      }
    }
    if (Date.now() >= deadline) {
      throw new RegistrationError(
        "not_ready",
        "Mainnet confirmation is still unavailable after 90 seconds. The operation is saved; no registration was resubmitted.",
      );
    }
    await new Promise<void>((resolve) =>
      setTimeout(resolve, Math.min(2000, deadline - Date.now())),
    );
  }
}

function isHttpUrl(value: string): boolean {
  try {
    return ["http:", "https:"].includes(new URL(value).protocol);
  } catch {
    return false;
  }
}
