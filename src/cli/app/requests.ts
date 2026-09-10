/**
 * `vana app requests list|show <id>` - what this machine asked for, and
 * what came back.
 *
 * `list` reads the local index alone, so it works offline and is the way an
 * agent recovers a request id it did not keep. `show` merges the local
 * entry with the live status and writes back what changed, which is how a
 * `--no-input` request eventually learns its grant id.
 */

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

export interface RequestsDeps {
  resolveKey?: typeof resolveAppKey;
  createController?: typeof createDirectDataController;
  requests?: RequestsStore;
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

  return emitAppOutcome(options, {
    status: "done",
    code: "ok",
    message:
      entries.length === 0
        ? "No access requests from this machine yet."
        : `${entries.length} access request${entries.length === 1 ? "" : "s"}.`,
    remedy:
      entries.length === 0 ? "vana app request --scopes <scope>" : undefined,
    network: network.name,
    data: {
      count: entries.length,
      requests: entries.map((entry) => ({
        requestId: entry.requestId,
        status: entry.status,
        scopes: entry.scopes,
        grantId: entry.grantId ?? null,
        createdAt: entry.createdAt,
      })),
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
        source: stored.scopes[0].replace(/^write:/, "").split(".")[0],
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
      ...(live.scopes ? { approvedScopes: live.scopes } : {}),
      ...(live.delivery ? { delivery: live.delivery } : {}),
      ...(live.personalServerUrl
        ? { personalServerUrl: live.personalServerUrl }
        : {}),
    });
  }

  const status = live?.status ?? stored.status;
  const grantId = live?.grantId ?? stored.grantId ?? null;
  const scopes = live?.scopes ?? stored.approvedScopes ?? stored.scopes;

  return emitAppOutcome(options, {
    status: "done",
    code: "ok",
    message: `${requestId}: ${status}${live ? "" : " (local record, service not reached)"}.`,
    remedy: grantId
      ? `vana app read ${scopes[0]} --grant ${grantId}`
      : status === "pending"
        ? `still waiting; approve at ${stored.approvalUrl}`
        : undefined,
    network: network.name,
    data: {
      requestId,
      status,
      live: Boolean(live),
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
