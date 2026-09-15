/**
 * `vana app ask | status | lineage` - questions over a person's data.
 *
 * A question is computed on the owner's own Personal Server over source
 * scopes the app never reads, and the answer is written into a derived
 * scope the app does read. That is why `ask` goes through consent: the
 * question travels inside the access request, so the app holds a grant on
 * the answer rather than on the sources.
 *
 * Pricing note. Two separate costs live here and the CLI reports them
 * separately rather than folding them into one number, because only one of
 * them exists today and the other is an open decision:
 *
 * - the compute itself emits no fee event today, so it is reported as
 *   `computeCost: null` rather than as free; when a price appears it is a
 *   number in a field that already exists
 * - reading the derived scope afterwards is an ordinary billable read and
 *   goes through the same escrow path, gates and receipts as any other
 *
 * No price is hardcoded anywhere: every amount comes from what the
 * protocol quotes.
 */

import {
  getDerivativeStatus,
  getLineage,
  isDerivativeStatusSettled,
} from "@opendatalabs/vana-sdk";
import { privateKeyToAccount } from "viem/accounts";
import {
  AppKeyMissingError,
  resolveAppKey,
  type ResolvedAppKey,
} from "../../core/app-key.js";
import {
  UnknownNetworkError,
  resolveNetwork,
  type ResolvedNetwork,
} from "../../core/network.js";
import {
  createRequestsStore,
  type RequestsStore,
  type StoredRequest,
} from "../../core/requests-store.js";
import { emitAppOutcome, type AppCommandOptions } from "./outcome.js";

export interface DerivativeCommandOptions extends AppCommandOptions {
  /** Grant covering the derived scope; resolved from the store when absent. */
  grant?: string;
  /** Personal Server URL; resolved from the stored request when absent. */
  server?: string;
}

export interface DerivativeDeps {
  resolveKey?: typeof resolveAppKey;
  requests?: RequestsStore;
  status?: typeof getDerivativeStatus;
  lineage?: typeof getLineage;
}

interface Context {
  network: ResolvedNetwork;
  key: ResolvedAppKey;
  grantId: string;
  personalServerUrl: string;
}

/**
 * Resolve what a derivative call needs: the network, the app key, a grant
 * covering the derived scope and the server that holds it. Explicit flags
 * win; otherwise the newest approved request that covers the scope answers
 * both, which is how `ask` hands off to `status` without the caller
 * carrying ids around.
 */
function resolveContext(
  derivedScope: string,
  options: DerivativeCommandOptions,
  deps: DerivativeDeps,
): { ok: true; context: Context } | { ok: false; exitCode: number } {
  let network: ResolvedNetwork;
  try {
    network = resolveNetwork(options.network);
  } catch (error) {
    if (error instanceof UnknownNetworkError) {
      return {
        ok: false,
        exitCode: emitAppOutcome(options, {
          status: "failed",
          code: "bad_usage",
          message: error.message,
        }),
      };
    }
    throw error;
  }

  let key: ResolvedAppKey;
  try {
    key = (deps.resolveKey ?? resolveAppKey)({});
  } catch (error) {
    if (error instanceof AppKeyMissingError) {
      return {
        ok: false,
        exitCode: emitAppOutcome(options, {
          status: "failed",
          code: "bad_usage",
          message: "No app key on this machine yet.",
          remedy: "vana app register",
          network: network.name,
        }),
      };
    }
    throw error;
  }

  let grantId = options.grant;
  let personalServerUrl = options.server;

  if (!grantId || !personalServerUrl) {
    const match = findApprovedRequest(
      derivedScope,
      network.name,
      key.address,
      deps.requests ?? createRequestsStore(),
    );
    grantId ??= match?.grantId;
    personalServerUrl ??= match?.personalServerUrl;
  }

  if (!grantId) {
    return {
      ok: false,
      exitCode: emitAppOutcome(options, {
        status: "failed",
        code: "grant_invalid",
        message: `No approved grant covering ${derivedScope}.`,
        remedy: `vana app request --scopes ${derivedScope} --question "..." --derived ${derivedScope} --sources <scopes>`,
        network: network.name,
      }),
    };
  }
  if (!personalServerUrl) {
    return {
      ok: false,
      exitCode: emitAppOutcome(options, {
        status: "failed",
        code: "owner_not_ready",
        message:
          "No Personal Server URL for this grant; the owner may serve through the enclave path, which derivatives do not use yet.",
        remedy: "pass --server explicitly if you know the URL",
        network: network.name,
      }),
    };
  }

  return {
    ok: true,
    context: { network, key, grantId, personalServerUrl },
  };
}

function findApprovedRequest(
  derivedScope: string,
  network: string,
  appAddress: string,
  requests: RequestsStore,
): StoredRequest | null {
  return (
    requests
      .list({ network, appAddress })
      .find(
        (entry) =>
          Boolean(entry.grantId) &&
          (entry.approvedScopes ?? entry.scopes).includes(derivedScope),
      ) ?? null
  );
}

export async function runAppStatus(
  derivedScope: string,
  options: DerivativeCommandOptions,
  deps: DerivativeDeps = {},
): Promise<number> {
  const resolved = resolveContext(derivedScope, options, deps);
  if (!resolved.ok) {
    return resolved.exitCode;
  }
  const { network, key, grantId, personalServerUrl } = resolved.context;

  if (!options.quiet && !options.json) {
    // The route is free to the caller and triggers a recompute, so a loop
    // here spends the inference budget without reading anything.
    process.stderr.write(
      "Note: this route can trigger a recompute. Poll on the interval the server names, not faster.\n",
    );
  }

  try {
    const status = await (deps.status ?? getDerivativeStatus)({
      personalServerUrl,
      derivedScope,
      grantId,
      signer: privateKeyToAccount(key.privateKey),
    });

    const settled = isDerivativeStatusSettled(status);
    const ready = status.status === "ready";
    return emitAppOutcome(options, {
      status: ready || settled ? "done" : "failed",
      code: ready
        ? "ok"
        : status.status === "failed"
          ? mapDerivativeError(status.errorCode)
          : "not_ready",
      message: derivativeMessage(status),
      remedy: ready
        ? `vana app read ${derivedScope} --grant ${grantId}`
        : status.retryAfterSeconds
          ? `retry in ${status.retryAfterSeconds}s`
          : undefined,
      network: network.name,
      data: {
        derivedScope,
        state: status.status,
        version: status.derivedVersion,
        lastComputedAt: status.lastComputedAt,
        errorCode: status.errorCode,
        retryAfterSeconds: status.retryAfterSeconds,
        // Compute emits no fee event today; null says "unknown/unpriced",
        // not "free". A price lands here as a number without a shape change.
        computeCost: null,
      },
    });
  } catch (error) {
    return emitAppOutcome(options, {
      status: "failed",
      code: "server_unavailable",
      ...describeDerivativeFailure("status", error, personalServerUrl),
      network: network.name,
    });
  }
}

/**
 * A 404 from this route does not mean the answer is missing, it means the
 * server has no derivative endpoints at all. Saying "Not found" sends people
 * looking for a lost answer instead of at the server's version.
 */
function describeDerivativeFailure(
  what: "status" | "lineage",
  error: unknown,
  personalServerUrl: string,
): { message: string; remedy?: string } {
  const detail = error instanceof Error ? error.message : String(error);
  if (/not found|404/i.test(detail)) {
    return {
      message: `${personalServerUrl} has no derivative ${what} endpoint, so it is too old to answer questions.`,
      remedy: "update the Personal Server, then retry",
    };
  }
  return { message: `Could not read the derivative ${what}: ${detail}` };
}

export async function runAppLineage(
  scope: string,
  options: DerivativeCommandOptions,
  deps: DerivativeDeps = {},
): Promise<number> {
  const resolved = resolveContext(scope, options, deps);
  if (!resolved.ok) {
    return resolved.exitCode;
  }
  const { network, key, grantId, personalServerUrl } = resolved.context;

  try {
    const result = await (deps.lineage ?? getLineage)({
      personalServerUrl,
      scope,
      grantId,
      signer: privateKeyToAccount(key.privateKey),
    } as Parameters<typeof getLineage>[0]);

    return emitAppOutcome(options, {
      status: "done",
      code: "ok",
      message: `Lineage for ${scope}.`,
      network: network.name,
      data: { scope, lineage: result as unknown },
    });
  } catch (error) {
    return emitAppOutcome(options, {
      status: "failed",
      code: "server_unavailable",
      ...describeDerivativeFailure("lineage", error, personalServerUrl),
      network: network.name,
    });
  }
}

function mapDerivativeError(code: string | null | undefined): string {
  switch (code) {
    case "grant_invalid":
      return "grant_invalid";
    case "source_missing":
      return "scope_not_found";
    case "inference_unavailable":
      return "not_ready";
    default:
      return "internal";
  }
}

function derivativeMessage(status: {
  status: string;
  errorCode?: string | null;
  retryAfterSeconds?: number | null;
  derivedVersion?: number | null;
}): string {
  switch (status.status) {
    case "ready":
      return `Answer is ready (version ${status.derivedVersion ?? "?"}).`;
    case "pending":
      return "The answer is being computed.";
    case "stale":
      return "A source changed; the answer is being recomputed.";
    case "failed":
      return `The computation failed: ${status.errorCode ?? "unknown"}.`;
    default:
      return `State: ${status.status}.`;
  }
}
