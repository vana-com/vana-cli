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

import {
  createGatewayClient,
  type GatewayClient,
} from "@opendatalabs/vana-sdk";
import {
  createDirectDataController,
  parseScopeEntry,
} from "@opendatalabs/vana-sdk/server";
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
import { readAppProfile } from "../../core/app-profile.js";
import {
  assertNoGrantUnionConflict,
  GrantUnionConflictError,
  mergeWithLiveGrant,
  unionGrantScopes,
  type GrantUnion,
} from "../../core/grant-union.js";
import { emitAppOutcome, type AppCommandOptions } from "./outcome.js";

export interface RequestCommandOptions extends AppCommandOptions {
  scopes?: string;
  /** Live grant entries to give up instead of carrying them over. */
  removeScopes?: string;
  /** Whose live grant to extend, when this machine cannot tell. */
  owner?: string;
  /** `false` (`--no-merge-grant`) sends --scopes verbatim. */
  mergeGrant?: boolean;
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
  readProfile?: typeof readAppProfile;
  createClient?: (gatewayUrl: string) => GrantUnionClient;
}

type GrantUnionClient = Pick<
  GatewayClient,
  "getGrant" | "listGrantsByUser" | "getBuilder"
>;

/**
 * What a new request does to the app's live grant: the gateway keeps one
 * grant per owner and app, and an approval replaces its scopes, so the
 * request carries what the grant already covers.
 */
export type GrantUnionPlan = GrantUnion & {
  status:
    | "merged"
    | "no_live_grant"
    | "owner_unknown"
    | "owner_ambiguous"
    | "disabled"
    | "unavailable";
  owner?: string;
  grantId?: string;
  reason?: string;
  /**
   * The explicit `--remove-scopes` list. The request always carries it,
   * whatever the live grant read found: the approval page re-reads the live
   * grant and leaves these entries out of the union it signs.
   */
  removeScopes: string[];
};

/** How long one live grant read may take before it counts as failed. */
export const GRANT_LOOKUP_TIMEOUT_MS = 10_000;
/** Live grant reads are retried once on a timeout or network error. */
export const GRANT_LOOKUP_ATTEMPTS = 2;
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("timed out")), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

/**
 * Work out whose live grant to extend and merge it.
 *
 * The person is anonymous until they approve, so the owner comes from
 * `--owner` or from an earlier approval of this app key on this machine.
 * Grant ids are one per owner and app, so two different grant ids mean two
 * different people approved, and merging either one's scopes would ask the
 * other for data they never granted: that case is left to the approval
 * page, which signs the union for whoever actually approves.
 *
 * Never throws for the network: a gateway that does not answer within the
 * timeout (tried twice) sends the request with --scopes only. The explicit
 * --remove-scopes list is kept on every outcome, so the request still
 * carries it to the approval page.
 */
export async function planGrantUnion(input: {
  scopes: string[];
  removeScopes: string[];
  owner?: string;
  merge: boolean;
  appAddress: string;
  network: string;
  gatewayUrl: string;
  requests: RequestsStore;
  createClient: (gatewayUrl: string) => GrantUnionClient;
  /** Per-attempt timeout; defaults to {@link GRANT_LOOKUP_TIMEOUT_MS}. */
  timeoutMs?: number;
  /** Total attempts; defaults to {@link GRANT_LOOKUP_ATTEMPTS}. */
  attempts?: number;
}): Promise<GrantUnionPlan> {
  assertNoGrantUnionConflict(input.scopes, input.removeScopes);
  const removeScopes = [...new Set(input.removeScopes)];
  const requestedOnly = {
    ...unionGrantScopes([], input.scopes, input.removeScopes),
    removeScopes,
  };
  if (!input.merge) {
    return { status: "disabled", ...requestedOnly };
  }

  let grantIds: string[] = [];
  if (!input.owner) {
    grantIds = [
      ...new Set(
        input.requests
          .list({ appAddress: input.appAddress, network: input.network })
          .filter(
            (entry) => entry.grantId && entry.gatewayUrl === input.gatewayUrl,
          )
          .map((entry) => entry.grantId!.toLowerCase()),
      ),
    ];
    if (grantIds.length === 0) {
      return {
        status: "owner_unknown",
        reason: "no earlier approval for this app on this machine",
        ...requestedOnly,
      };
    }
    if (grantIds.length > 1) {
      return {
        status: "owner_ambiguous",
        reason: `${grantIds.length} different people approved this app; pass --owner to extend one person's grant`,
        ...requestedOnly,
      };
    }
  }

  const timeoutMs = input.timeoutMs ?? GRANT_LOOKUP_TIMEOUT_MS;
  const attempts = Math.max(1, input.attempts ?? GRANT_LOOKUP_ATTEMPTS);
  let lastError: unknown;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      return await readAndMerge(grantIds[0]);
    } catch (error) {
      lastError = error;
    }
  }
  return {
    status: "unavailable",
    reason: `the gateway was not reached (${lastError instanceof Error ? lastError.message : String(lastError)})`,
    ...(input.owner ? { owner: input.owner } : {}),
    ...requestedOnly,
  };

  async function readAndMerge(
    grantId: string | undefined,
  ): Promise<GrantUnionPlan> {
    const client = input.createClient(input.gatewayUrl);
    let owner = input.owner;
    let granteeId: string | undefined;
    if (!owner) {
      const previous = await withTimeout(client.getGrant(grantId!), timeoutMs);
      if (!previous) {
        return {
          status: "owner_unknown",
          reason: `the gateway has no grant ${grantId}`,
          ...requestedOnly,
        };
      }
      owner = previous.grantorAddress;
      granteeId = previous.granteeId;
    }
    const merged = await withTimeout(
      mergeWithLiveGrant({
        gateway: client,
        owner,
        ...(granteeId ? { granteeId } : { appAddress: input.appAddress }),
        scopes: input.scopes,
        removeScopes: input.removeScopes,
      }),
      timeoutMs,
    );
    return { ...merged, owner, removeScopes };
  }
}

/** The kept/added/removed lists every outcome of a request carries. */
function grantUnionData(plan: GrantUnionPlan): Record<string, unknown> {
  return {
    kept: plan.kept,
    added: plan.added,
    removed: plan.removed,
    // Sent on the request whatever the live grant read found; the approval
    // page removes them from the live grant if it holds them.
    removeScopes: plan.removeScopes,
    grantUnion: {
      status: plan.status,
      owner: plan.owner ?? null,
      grantId: plan.grantId ?? null,
      ...(plan.reason ? { reason: plan.reason } : {}),
      notCarried: plan.notCarried,
    },
  };
}

function describePlan(plan: GrantUnionPlan): string {
  const list = (entries: string[]) => entries.join(", ") || "nothing";
  const lines: string[] = [];
  if (plan.status === "merged") {
    lines.push(`  Live grant  ${plan.grantId} (owner ${plan.owner})`);
  } else if (plan.status === "no_live_grant") {
    lines.push(`  Live grant  none for owner ${plan.owner}`);
  } else if (plan.status !== "disabled") {
    lines.push(
      `  Live grant  not read: ${plan.reason}. The approval page keeps what the approver already granted.`,
    );
  }
  lines.push(`  Keeping     ${list(plan.kept)}`);
  lines.push(`  Adding      ${list(plan.added)}`);
  const liveGrantRead =
    plan.status === "merged" || plan.status === "no_live_grant";
  if (!liveGrantRead && plan.removeScopes.length > 0) {
    // The live grant is unknown here, but the request carries these and the
    // approval page drops them from the live grant if it holds them.
    lines.push(`  Removing (if shared) ${plan.removeScopes.join(", ")}`);
  } else if (plan.removed.length > 0 || plan.status !== "merged") {
    lines.push(`  Removing    ${list(plan.removed)}`);
  }
  if (plan.notCarried.length > 0) {
    lines.push(
      `  Not carried ${plan.notCarried.join(", ")} (this request cannot hold these; the approval page decides)`,
    );
  }
  return `\n${lines.join("\n")}\n`;
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

/**
 * The connector source shown on the approval screen.
 *
 * It has to come from a scope the person actually connected, not from the
 * first entry in the list: with a derivative question the derived scope can
 * come first, and a request for `coach.weekly,spotify.history` would ask
 * the person to "Connect coach", a source that does not exist. Source
 * scopes win, then any non-derived scope, and `write:` prefixes never count
 * as a source name.
 */
export function resolveSourceKey(
  scopes: string[],
  derived: string | undefined,
  sourceScopes: string[],
): string {
  const namespace = (scope: string) =>
    scope.replace(/^write:/, "").split(".")[0];
  if (sourceScopes.length > 0) {
    return namespace(sourceScopes[0]);
  }
  const plain = scopes.filter((scope) => scope !== derived);
  return namespace((plain[0] ?? scopes[0]) as string);
}

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

  const sourceScopes = splitList(options.sources);
  const hasQuestion = Boolean(
    options.question || options.derived || sourceScopes.length > 0,
  );
  // With a question, the derived scope is the only read the app needs, so
  // it is the default grant.
  const scopes =
    hasQuestion && !options.scopes && options.derived
      ? [options.derived]
      : splitList(options.scopes);
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
  if (hasQuestion) {
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
    // The approval page tells the person the app will not see a question's
    // sources. Granting one as a plain read in the same request would make
    // that untrue, so refuse rather than let the copy lie.
    const rawSources = sourceScopes.filter((scope) => scopes.includes(scope));
    if (rawSources.length > 0) {
      return emitAppOutcome(options, {
        status: "failed",
        code: "bad_usage",
        message: `${rawSources.join(", ")} would be granted as a raw read, but the person is told the app will not see a question's sources. Request raw reads separately.`,
        remedy: `vana app request --scopes ${scopes
          .filter((scope) => !rawSources.includes(scope))
          .join(",")} ...`,
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

  // What `vana app register --app-name/--app-url` remembered for this key.
  const profile = (deps.readProfile ?? readAppProfile)(key.address);

  const removeScopes = splitList(options.removeScopes);
  for (const entry of removeScopes) {
    try {
      // Grammar only: a wildcard such as `chatgpt.*` is a valid removal.
      parseScopeEntry(entry);
    } catch (error) {
      return emitAppOutcome(options, {
        status: "failed",
        code: "bad_usage",
        message: `--remove-scopes ${entry}: ${error instanceof Error ? error.message : String(error)}`,
        network: network.name,
      });
    }
  }
  if (options.owner && !ADDRESS.test(options.owner)) {
    return emitAppOutcome(options, {
      status: "failed",
      code: "bad_usage",
      message: `--owner ${options.owner} is not an address.`,
      network: network.name,
    });
  }
  const requests = deps.requests ?? createRequestsStore();
  let plan: GrantUnionPlan;
  try {
    plan = await planGrantUnion({
      scopes,
      removeScopes,
      owner: options.owner,
      merge: options.mergeGrant !== false,
      appAddress: key.address,
      network: network.name,
      gatewayUrl: network.gatewayUrl,
      requests,
      createClient: deps.createClient ?? createGatewayClient,
    });
  } catch (error) {
    if (error instanceof GrantUnionConflictError) {
      return emitAppOutcome(options, {
        status: "failed",
        code: "bad_usage",
        message: error.message,
        network: network.name,
      });
    }
    throw error;
  }
  // A question's source may not also be a raw read on the same request (the
  // service refuses it: the person is told the app will not see the
  // sources), so a live raw read of one is left for the approval page.
  const carriedSources = sourceScopes.filter((scope) =>
    plan.kept.includes(scope),
  );
  if (carriedSources.length > 0) {
    plan = {
      ...plan,
      scopes: plan.scopes.filter((scope) => !carriedSources.includes(scope)),
      kept: plan.kept.filter((scope) => !carriedSources.includes(scope)),
      notCarried: [...plan.notCarried, ...carriedSources],
    };
  }
  const requestScopes = plan.scopes;
  if (!options.json && !options.quiet) {
    process.stderr.write(describePlan(plan));
  }

  const controller = (deps.createController ?? createDirectDataController)({
    // The dev host set serves moksha; production serves both networks.
    env: network.env === "dev" ? "dev" : "production",
    network: network.name,
    appPrivateKey: key.privateKey,
    app: {
      id: options.appId ?? "vana-cli",
      name: options.appName ?? profile.name ?? "Vana CLI",
      homepageUrl:
        options.appUrl ?? profile.url ?? "https://github.com/vana-com/vana-cli",
    },
    source: resolveSourceKey(scopes, options.derived, sourceScopes),
    scopes: requestScopes,
  });

  let created;
  try {
    // `removeScopes` tells the approval page to leave those entries out of
    // the union it signs. No `owner` is passed: the union above is already
    // merged into the controller's scopes, so the controller sends them as is.
    created = await controller.createAccessRequest({
      ...(removeScopes.length > 0 ? { removeScopes } : {}),
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
    scopes: requestScopes,
    ...(removeScopes.length > 0 ? { removeScopes } : {}),
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
        scopes: requestScopes,
        expiresAt: created.expiresAt ?? null,
        ...grantUnionData(plan),
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
          data: { requestId: created.requestId, ...grantUnionData(plan) },
        });
      }

      const approvedScopes = status.scopes ?? requestScopes;
      const nextScope =
        options.derived && approvedScopes.includes(options.derived)
          ? options.derived
          : approvedScopes[0];
      return emitAppOutcome(options, {
        status: "done",
        code: "ok",
        message: `Approved. Grant ${status.grantId ?? "(pending id)"}.`,
        remedy: status.grantId
          ? `vana app read ${nextScope} --grant ${status.grantId}`
          : undefined,
        network: network.name,
        data: {
          requestId: created.requestId,
          grantId: status.grantId ?? null,
          scopes: approvedScopes,
          delivery: status.delivery ?? "personal_server",
          personalServerUrl: status.personalServerUrl ?? null,
          ...grantUnionData(plan),
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
      ...grantUnionData(plan),
    },
  });
}
