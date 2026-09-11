/**
 * `vana app request` - ask a person for access and get the grant back.
 *
 * The half of the loop that cannot be driven headlessly: the CLI creates
 * the access request, prints the approval URL, and polls until the person
 * approves, denies, or it expires. With `--no-input` it prints the URL and
 * exits 7, so an agent can hand the link to a human and come back later
 * with `vana app requests show <id>`.
 *
 * The request is persisted the moment it is created, before any approval,
 * so a `--no-input` run is findable afterwards.
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
  type StoredRequest,
  type StoredRequestStatus,
} from "../../core/requests-store.js";
import { emitAppOutcome, type AppCommandOptions } from "./outcome.js";

export interface RequestCommandOptions extends AppCommandOptions {
  scopes?: string;
  /** Derivative question text, requires --derived and --sources. */
  question?: string;
  derived?: string;
  sources?: string;
  /** Where the approval UI returns the person after they decide. */
  returnUrl?: string;
  /** Seconds to poll before giving up. */
  timeout?: string;
  appId?: string;
  appName?: string;
  appUrl?: string;
}

export interface RequestDeps {
  resolveKey?: typeof resolveAppKey;
  createController?: typeof createDirectDataController;
  requests?: RequestsStore;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

const POLL_INTERVAL_MS = 3_000;
const DEFAULT_TIMEOUT_SECONDS = 600;
/** Statuses that end the poll loop. */
const TERMINAL: ReadonlySet<string> = new Set([
  "approved",
  "ready_for_read",
  "completed",
  "denied",
  "expired",
]);

function splitList(value: string | undefined): string[] {
  return (value ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

export async function runAppRequest(
  options: RequestCommandOptions,
  deps: RequestDeps = {},
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

  const scopes = splitList(options.scopes);
  if (scopes.length === 0) {
    return emitAppOutcome(options, {
      status: "failed",
      code: "bad_usage",
      message: "At least one scope is required.",
      remedy: "vana app request --scopes github.repositories",
      network: network.name,
    });
  }

  // A question needs its derived scope granted as a plain read too, which
  // the SDK validates eagerly; check it here so the error names the fix.
  const sourceScopes = splitList(options.sources);
  if (options.question || options.derived || sourceScopes.length > 0) {
    if (!options.question || !options.derived || sourceScopes.length === 0) {
      return emitAppOutcome(options, {
        status: "failed",
        code: "bad_usage",
        message:
          "A derivative question needs --question, --derived and --sources together.",
        network: network.name,
      });
    }
    if (!scopes.includes(options.derived)) {
      return emitAppOutcome(options, {
        status: "failed",
        code: "bad_usage",
        message: `The derived scope ${options.derived} must also appear in --scopes as a plain read.`,
        remedy: `vana app request --scopes ${[...scopes, options.derived].join(",")} ...`,
        network: network.name,
      });
    }
  }

  let key: ResolvedAppKey;
  try {
    key = (deps.resolveKey ?? resolveAppKey)({});
  } catch (error) {
    if (error instanceof AppKeyMissingError) {
      return emitAppOutcome(options, {
        status: "failed",
        code: "bad_usage",
        message: "No app key on this machine yet.",
        remedy: "vana app register",
        network: network.name,
      });
    }
    throw error;
  }

  const controller = (deps.createController ?? createDirectDataController)({
    // The dev host set serves moksha; production serves both networks.
    env: network.env === "dev" ? "dev" : "production",
    network: network.name,
    appPrivateKey: key.privateKey,
    app: {
      id: options.appId ?? "vana-cli",
      name: options.appName ?? "Vana CLI",
      homepageUrl: options.appUrl ?? "https://github.com/vana-com/vana-cli",
    },
    source: scopes[0].replace(/^write:/, "").split(".")[0],
    scopes,
  });

  const requests = deps.requests ?? createRequestsStore();
  let created;
  try {
    created = await controller.createAccessRequest({
      returnUrl: options.returnUrl ?? "https://github.com/vana-com/vana-cli",
      ...(options.question && options.derived
        ? {
            questions: [
              {
                derivedScope: options.derived,
                sourceScopes,
                question: options.question,
              } as never,
            ],
          }
        : {}),
    });
  } catch (error) {
    return emitAppOutcome(options, {
      status: "failed",
      code: "gateway_unreachable",
      message: `Could not create the access request: ${
        error instanceof Error ? error.message : String(error)
      }`,
      network: network.name,
    });
  }

  // Persist before anything can go wrong, so --no-input runs are findable.
  const stored: StoredRequest = {
    requestId: created.requestId,
    appAddress: key.address,
    network: network.name,
    gatewayUrl: network.gatewayUrl,
    scopes,
    approvalUrl: created.approvalUrl,
    createdAt: new Date().toISOString(),
    status: "pending",
    updatedAt: new Date().toISOString(),
    ...(created.expiresAt ? { expiresAt: created.expiresAt } : {}),
    ...(options.question && options.derived
      ? { questions: [{ derivedScope: options.derived, sourceScopes }] }
      : {}),
  };
  requests.save(stored);

  if (options.noInput) {
    return emitAppOutcome(options, {
      status: "failed",
      code: "confirmation_required",
      message: "A person has to approve this request.",
      remedy: `send them ${created.approvalUrl}, then: vana app requests show ${created.requestId}`,
      network: network.name,
      data: {
        requestId: created.requestId,
        approvalUrl: created.approvalUrl,
        scopes,
        expiresAt: created.expiresAt ?? null,
      },
    });
  }

  if (!options.json && !options.quiet) {
    process.stderr.write(
      `\n  Approve at  ${created.approvalUrl}\n  Request     ${created.requestId}\n  Waiting for approval...\n\n`,
    );
  }

  const sleep =
    deps.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const now = deps.now ?? (() => Date.now());
  const deadline =
    now() + Number(options.timeout ?? DEFAULT_TIMEOUT_SECONDS) * 1000;

  while (now() < deadline) {
    let status;
    try {
      status = await controller.getAccessRequestStatus(created.requestId);
    } catch {
      await sleep(POLL_INTERVAL_MS);
      continue;
    }

    if (TERMINAL.has(status.status)) {
      requests.update(created.requestId, {
        status: status.status as StoredRequestStatus,
        ...(status.grantId ? { grantId: status.grantId } : {}),
        ...(status.scopes ? { approvedScopes: status.scopes } : {}),
        ...(status.delivery ? { delivery: status.delivery } : {}),
        ...(status.personalServerUrl
          ? { personalServerUrl: status.personalServerUrl }
          : {}),
      });

      if (status.status === "denied" || status.status === "expired") {
        return emitAppOutcome(options, {
          status: "failed",
          code: "grant_invalid",
          message: `The request was ${status.status}.`,
          network: network.name,
          data: { requestId: created.requestId },
        });
      }

      const approvedScopes = status.scopes ?? scopes;
      return emitAppOutcome(options, {
        status: "done",
        code: "ok",
        message: `Approved. Grant ${status.grantId ?? "(pending id)"}.`,
        remedy: status.grantId
          ? `vana app read ${approvedScopes[0]} --grant ${status.grantId}`
          : undefined,
        network: network.name,
        data: {
          requestId: created.requestId,
          grantId: status.grantId ?? null,
          scopes: approvedScopes,
          delivery: status.delivery ?? "personal_server",
          personalServerUrl: status.personalServerUrl ?? null,
        },
      });
    }
    await sleep(POLL_INTERVAL_MS);
  }

  return emitAppOutcome(options, {
    status: "failed",
    code: "not_ready",
    message: "Nobody approved the request in time; it is still open.",
    remedy: `vana app requests show ${created.requestId}`,
    network: network.name,
    data: {
      requestId: created.requestId,
      approvalUrl: created.approvalUrl,
    },
  });
}
