/**
 * `vana app requests list|show <id>` - what this machine asked for, and
 * what came back.
 *
 * `list` reads the local index, so it works offline and is the way an
 * agent recovers a request id it did not keep. `show` merges the local
 * entry with the live status and writes back what changed, which is how a
 * `--no-input` request eventually learns its grant id.
 *
 * An approval is not forever: the owner can revoke the grant, and a later
 * approval for the same app replaces its scopes (one grant per owner and
 * app). Both commands check every grant id against the gateway, and say
 * when it no longer holds, or that it could not be checked.
 */

import {
  createGatewayClient,
  type GatewayClient,
} from "@opendatalabs/vana-sdk";
import { createDirectDataController } from "@opendatalabs/vana-sdk/server";
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
  type StoredRequestStatus,
} from "../../core/requests-store.js";
import { emitAppOutcome, type AppCommandOptions } from "./outcome.js";
import { resolveSourceKey } from "./request.js";

export interface RequestsDeps {
  resolveKey?: typeof resolveAppKey;
  createController?: typeof createDirectDataController;
  requests?: RequestsStore;
  createClient?: (gatewayUrl: string) => Pick<GatewayClient, "getGrant">;
}

/** Whether a request's grant still gives the app what it asked for. */
export type GrantCheck =
  | { state: "active" }
  | {
      state: "revoked" | "replaced" | "expired" | "missing";
      reason: string;
      revokedAt?: string;
      grantScopes?: string[];
    }
  | { state: "unverified"; reason: string };

const GRANT_LOOKUP_TIMEOUT_MS = 5_000;

const bareScope = (scope: string) => scope.replace(/^write:/, "");

/**
 * Ask the gateway (public, no key needed) whether `grantId` still covers
 * `scopes`. Never throws: a gateway that cannot be reached is "unverified".
 */
export async function checkGrant(
  client: Pick<GatewayClient, "getGrant">,
  grantId: string,
  scopes: string[],
): Promise<GrantCheck> {
  let timer: NodeJS.Timeout | undefined;
  try {
    const grant = await Promise.race([
      client.getGrant(grantId),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("timed out")),
          GRANT_LOOKUP_TIMEOUT_MS,
        );
      }),
    ]);
    if (!grant) {
      return {
        state: "missing",
        reason: `the gateway has no grant ${grantId}`,
      };
    }
    if (grant.revokedAt) {
      return {
        state: "revoked",
        reason: `revoked by the owner at ${grant.revokedAt}`,
        revokedAt: grant.revokedAt,
      };
    }
    const granted = new Set(grant.scopes.map(bareScope));
    const lost = scopes.filter((scope) => !granted.has(bareScope(scope)));
    if (lost.length) {
      return {
        state: "replaced",
        reason: `replaced by a later approval: the grant now covers ${grant.scopes.join(", ") || "nothing"}, not ${lost.join(", ")}`,
        grantScopes: grant.scopes,
      };
    }
    if (grant.expired) {
      return { state: "expired", reason: "the grant expired" };
    }
    return { state: "active" };
  } catch (error) {
    return {
      state: "unverified",
      reason: `the gateway was not reached (${error instanceof Error ? error.message : String(error)})`,
    };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** False once the grant is known to be gone; unverified keeps the record's word. */
function grantHolds(check: GrantCheck | null): boolean {
  return !check || check.state === "active" || check.state === "unverified";
}

function newRequestRemedy(scopes: string[]): string {
  return `vana app request --scopes ${scopes.join(",")}`;
}

function resolveNetworkOrFail(
  options: AppCommandOptions,
): { ok: true; network: ResolvedNetwork } | { ok: false; exitCode: number } {
  try {
    return { ok: true, network: resolveNetwork(options.network) };
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
}

export async function runAppRequestsList(
  options: AppCommandOptions,
  deps: RequestsDeps = {},
): Promise<number> {
  const resolved = resolveNetworkOrFail(options);
  if (!resolved.ok) {
    return resolved.exitCode;
  }
  const { network } = resolved;

  // Scoped to this app when a key exists; without one, show everything the
  // machine has rather than nothing.
  let appAddress: string | undefined;
  try {
    appAddress = (deps.resolveKey ?? resolveAppKey)({}).address;
  } catch (error) {
    if (!(error instanceof AppKeyMissingError)) {
      throw error;
    }
  }

  const entries = (deps.requests ?? createRequestsStore()).list({
    appAddress,
    network: network.name,
  });
  const withGrant = entries.filter((entry) => entry.grantId);
  const client = withGrant.length
    ? (deps.createClient ?? createGatewayClient)(network.gatewayUrl)
    : null;
  const checks = new Map<string, GrantCheck>();
  await Promise.all(
    withGrant.map(async (entry) => {
      checks.set(
        entry.requestId,
        await checkGrant(
          client!,
          entry.grantId!,
          entry.approvedScopes ?? entry.scopes,
        ),
      );
    }),
  );
  const gone = [...checks.values()].filter((check) => !grantHolds(check));

  return emitAppOutcome(options, {
    status: "done",
    code: "ok",
    message:
      entries.length === 0
        ? "No access requests from this machine yet."
        : `${entries.length} access request${entries.length === 1 ? "" : "s"}${gone.length ? `; ${gone.length} grant${gone.length === 1 ? " is" : "s are"} no longer in force` : ""}.`,
    remedy:
      entries.length === 0
        ? "vana app request --scopes <scope>"
        : gone.length
          ? "vana app requests show <id>"
          : undefined,
    network: network.name,
    data: {
      count: entries.length,
      requests: entries.map((entry) => {
        const check = checks.get(entry.requestId) ?? null;
        return {
          requestId: entry.requestId,
          status: entry.status,
          scopes: entry.scopes,
          grantId: entry.grantId ?? null,
          createdAt: entry.createdAt,
          ...(check
            ? {
                live: grantHolds(check),
                grant: check,
              }
            : {}),
        };
      }),
    },
  });
}

export async function runAppRequestsShow(
  requestId: string,
  options: AppCommandOptions,
  deps: RequestsDeps = {},
): Promise<number> {
  const resolved = resolveNetworkOrFail(options);
  if (!resolved.ok) {
    return resolved.exitCode;
  }
  const { network } = resolved;
  const requests = deps.requests ?? createRequestsStore();
  const stored = requests.get(requestId);

  if (!stored) {
    return emitAppOutcome(options, {
      status: "failed",
      code: "bad_usage",
      message: `No local record of ${requestId}.`,
      remedy: "vana app requests list",
      network: network.name,
    });
  }

  let key: ResolvedAppKey | null = null;
  try {
    key = (deps.resolveKey ?? resolveAppKey)({});
  } catch (error) {
    if (!(error instanceof AppKeyMissingError)) {
      throw error;
    }
  }

  // Refresh from the service when we can sign; offline or keyless, report
  // what the local index knows rather than failing.
  let live: Awaited<
    ReturnType<
      ReturnType<typeof createDirectDataController>["getAccessRequestStatus"]
    >
  > | null = null;
  if (key) {
    try {
      const controller = (deps.createController ?? createDirectDataController)({
        env: network.env === "dev" ? "dev" : "production",
        network: network.name,
        appPrivateKey: key.privateKey,
        app: {
          id: "vana-cli",
          name: "Vana CLI",
          homepageUrl: "https://github.com/vana-com/vana-cli",
        },
        source: resolveSourceKey(
          stored.scopes,
          stored.questions?.[0]?.derivedScope,
          stored.questions?.[0]?.sourceScopes ?? [],
        ),
        scopes: stored.scopes,
      });
      live = await controller.getAccessRequestStatus(requestId);
    } catch {
      live = null;
    }
  }

  if (live) {
    requests.update(requestId, {
      status: live.status as StoredRequestStatus,
      ...(live.grantId ? { grantId: live.grantId } : {}),
      // What was approved is fixed at approval; never let a later read of
      // the status overwrite it, or a replaced grant would look covered.
      ...(live.scopes && !stored.approvedScopes
        ? { approvedScopes: live.scopes }
        : {}),
      ...(live.delivery ? { delivery: live.delivery } : {}),
      ...(live.personalServerUrl
        ? { personalServerUrl: live.personalServerUrl }
        : {}),
    });
  }

  const status = live?.status ?? stored.status;
  const grantId = live?.grantId ?? stored.grantId ?? null;
  const scopes = live?.scopes ?? stored.approvedScopes ?? stored.scopes;
  // A question's answer is what the app came for; point at it when granted.
  const nextScope =
    stored.questions
      ?.map((question) => question.derivedScope)
      .find((scope) => scopes.includes(scope)) ?? scopes[0];

  const grant = grantId
    ? await checkGrant(
        (deps.createClient ?? createGatewayClient)(network.gatewayUrl),
        grantId,
        stored.approvedScopes ?? scopes,
      )
    : null;
  const holds = grantHolds(grant);
  const note = !live
    ? " (local record, service not reached)"
    : grant?.state === "unverified"
      ? ` (grant not verified: ${grant.reason})`
      : "";

  return emitAppOutcome(options, {
    status: "done",
    code: "ok",
    message:
      grant && grant.state !== "active" && !holds
        ? `${requestId}: ${status}, but the grant is no longer in force: ${grant.reason}.`
        : `${requestId}: ${status}${note}.`,
    remedy: !holds
      ? newRequestRemedy(stored.scopes)
      : grantId
        ? `vana app read ${nextScope} --grant ${grantId}`
        : status === "pending"
          ? `still waiting; approve at ${stored.approvalUrl}`
          : undefined,
    network: network.name,
    data: {
      requestId,
      status,
      // The service answered, and the grant, when there is one, has not
      // been revoked or replaced. An unverified grant keeps the record's word.
      live: Boolean(live) && holds,
      ...(grant ? { grant } : {}),
      scopes,
      requestedScopes: stored.scopes,
      grantId,
      delivery: live?.delivery ?? stored.delivery ?? null,
      personalServerUrl:
        live?.personalServerUrl ?? stored.personalServerUrl ?? null,
      approvalUrl: stored.approvalUrl,
      createdAt: stored.createdAt,
      expiresAt: stored.expiresAt ?? null,
    },
  });
}
