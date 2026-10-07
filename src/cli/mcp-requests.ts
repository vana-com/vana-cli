/**
 * `vana mcp requests | approve | deny`: answer the scope requests MCP agents
 * leave on this account's Personal Server.
 *
 * A connected agent (Claude, Claude Code, Cursor) that needs data it cannot
 * read calls the server's `request_scope_access` tool. The server records the
 * request on the connection and, when it has a public https origin, hands the
 * agent a Vana Web link (`<web>/mcp/requests/<id>?ps_origin=<origin>`), where
 * the owner answers from any device. These commands are the same answer from
 * the terminal, through the owner-only API with the PS session token the CLI
 * already holds, and the only one for a server without a public URL:
 *
 *   GET  /v1/mcp/connections
 *   POST /v1/mcp/connections/:id/scope-request/approve  { scopes }
 *   POST /v1/mcp/connections/:id/scope-request/deny
 *
 * The answer endpoints arrived in personal-server-ts 1.30.0; an older server
 * lists the requests but cannot take the answer.
 */

import { emitAppOutcome, type AppCommandOptions } from "./app/outcome.js";
import { CliExitCode } from "../core/exit-codes.js";

/** One agent's pending request, as `vana mcp requests` lists it. */
export interface PendingScopeRequest {
  connectionId: string;
  displayName: string;
  scopes: string[];
  reason: string | null;
  requestedAt: string | null;
  grantedScopes: string[];
  /** The Vana Web page to answer it on, when the server has a public origin. */
  approvalUrl: string | null;
}

/** The running server these commands talk to. */
export interface McpOwnerServer {
  url: string;
  /** The owner's PS session token; null when the CLI holds none for it. */
  token: string | null;
  /**
   * The server's public https origin (its tunnel URL), which Vana Web calls
   * back; null for a `--local` server or before the tunnel is up.
   */
  publicOrigin: string | null;
  /** Vana Web for the server's network (app.vana.org, app-dev on moksha). */
  webOrigin: string | null;
}

/** Why there is no server to talk to. */
export interface McpOwnerServerProblem {
  code: "server_unavailable";
  message: string;
  remedy?: string;
}

export interface McpRequestsDeps {
  resolveServer(): Promise<McpOwnerServer | McpOwnerServerProblem>;
  fetch?: typeof fetch;
  now?: () => number;
}

export const SERVER_TOO_OLD_MESSAGE =
  "Your Personal Server is too old to answer access requests. Update vana, then run `vana server stop && vana server start`.";
const SERVER_TOO_OLD_REMEDY = "vana server stop && vana server start";

/**
 * The Vana Web page for one connection's request, built the way the server's
 * `vanaWebMcpScopeRequestApprovalUrl` hook builds the link it hands the agent:
 * `<web>/mcp/requests/<id>?ps_origin=<server origin>`. Null unless the server
 * has a public https origin, since a page on the web cannot reach any other.
 */
export function approvalUrlFor(
  server: Pick<McpOwnerServer, "publicOrigin" | "webOrigin">,
  connectionId: string,
): string | null {
  if (!server.webOrigin || !server.publicOrigin || !connectionId) return null;
  try {
    const web = new URL(server.webOrigin);
    const origin = new URL(server.publicOrigin);
    if (origin.protocol !== "https:") return null;
    const url = new URL(
      `/mcp/requests/${encodeURIComponent(connectionId)}`,
      web.origin,
    );
    url.searchParams.set("ps_origin", origin.origin);
    return url.toString();
  } catch {
    return null;
  }
}

interface ConnectionView {
  id?: unknown;
  displayName?: unknown;
  status?: unknown;
  grants?: unknown;
  grantedScopes?: unknown;
  scopeAccessRequest?: {
    scopes?: unknown;
    reason?: unknown;
    requestedAt?: unknown;
  } | null;
}

const strings = (value: unknown): string[] =>
  Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];

function grantedScopesOf(view: ConnectionView): string[] {
  if (Array.isArray(view.grantedScopes)) return strings(view.grantedScopes);
  // An older server: the same thing from its grants.
  const grants = Array.isArray(view.grants) ? view.grants : [];
  return [
    ...new Set(
      grants.flatMap((grant) =>
        strings((grant as { scopes?: unknown } | null)?.scopes),
      ),
    ),
  ].sort();
}

/** The pending request on one connection view, or null. */
export function pendingRequestOf(
  view: ConnectionView,
  server: Pick<McpOwnerServer, "publicOrigin" | "webOrigin"> | null,
): PendingScopeRequest | null {
  if (typeof view.id !== "string" || view.status !== "approved") return null;
  const scopes = strings(view.scopeAccessRequest?.scopes);
  if (scopes.length === 0) return null;
  const reason = view.scopeAccessRequest?.reason;
  const requestedAt = view.scopeAccessRequest?.requestedAt;
  return {
    connectionId: view.id,
    displayName:
      typeof view.displayName === "string" && view.displayName.trim()
        ? view.displayName.trim()
        : "An app",
    scopes,
    reason: typeof reason === "string" && reason.trim() ? reason.trim() : null,
    requestedAt: typeof requestedAt === "string" ? requestedAt : null,
    grantedScopes: grantedScopesOf(view),
    approvalUrl: server ? approvalUrlFor(server, view.id) : null,
  };
}

/** A failed owner API call, in the words and codes the commands use. */
export class McpOwnerApiError extends Error {
  constructor(
    public code: string,
    message: string,
    public remedy?: string,
  ) {
    super(message);
    this.name = "McpOwnerApiError";
  }
}

function ownerHeaders(server: McpOwnerServer): Record<string, string> {
  return {
    "content-type": "application/json",
    ...(server.token ? { authorization: `Bearer ${server.token}` } : {}),
  };
}

function unauthorized(): McpOwnerApiError {
  return new McpOwnerApiError(
    "unauthorized",
    "Your Personal Server did not accept this CLI's session. Restart it with `vana server start` while logged in.",
    "vana server start",
  );
}

interface ListedConnections {
  views: ConnectionView[];
  /** Whether the server has the scope-request answer endpoints. */
  supportsAnswers: boolean;
}

/** Every MCP connection on the server, owner view. */
export async function listConnections(
  server: McpOwnerServer,
  fetchImpl: typeof fetch = fetch,
  timeoutMs = 10_000,
): Promise<ListedConnections> {
  let response: Response;
  try {
    response = await fetchImpl(`${server.url}/v1/mcp/connections`, {
      headers: ownerHeaders(server),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    throw new McpOwnerApiError(
      "server_unavailable",
      `Your Personal Server at ${server.url} did not answer: ${error instanceof Error ? error.message : String(error)}`,
      "vana server start",
    );
  }
  if (response.status === 401 || response.status === 403) throw unauthorized();
  if (response.status === 404) {
    throw new McpOwnerApiError(
      "server_too_old",
      "Your Personal Server has no MCP connections API. Update vana, then run `vana server stop && vana server start`.",
      SERVER_TOO_OLD_REMEDY,
    );
  }
  if (!response.ok) {
    throw new McpOwnerApiError(
      "internal",
      `Your Personal Server could not list its MCP connections (HTTP ${response.status}).`,
    );
  }
  const body = (await response.json().catch(() => ({}))) as {
    connections?: unknown;
  };
  const views = (
    Array.isArray(body.connections) ? body.connections : []
  ).filter(
    (item): item is ConnectionView => Boolean(item) && typeof item === "object",
  );
  // `grantedScopes` arrived together with the answer endpoints.
  const supportsAnswers =
    views.length === 0 ||
    views.some((view) => Array.isArray(view.grantedScopes));
  return { views, supportsAnswers };
}

/** Every pending request on the server, oldest first. */
export async function listPendingScopeRequests(
  server: McpOwnerServer,
  fetchImpl: typeof fetch = fetch,
  timeoutMs?: number,
): Promise<{ requests: PendingScopeRequest[]; supportsAnswers: boolean }> {
  const { views, supportsAnswers } = await listConnections(
    server,
    fetchImpl,
    timeoutMs,
  );
  const requests = views
    .map((view) => pendingRequestOf(view, supportsAnswers ? server : null))
    .filter((item): item is PendingScopeRequest => item !== null)
    .sort((a, b) =>
      String(a.requestedAt ?? "").localeCompare(String(b.requestedAt ?? "")),
    );
  return { requests, supportsAnswers };
}

/** The server's scope-request error, mapped onto the CLI's codes. */
export function scopeRequestError(
  status: number,
  body: unknown,
  connectionId: string,
): McpOwnerApiError {
  const error = (body as { error?: { errorCode?: unknown; message?: unknown } })
    ?.error;
  const code = typeof error?.errorCode === "string" ? error.errorCode : null;
  const detail =
    typeof error?.message === "string" ? error.message : `HTTP ${status}`;
  switch (code) {
    case "NOT_FOUND":
    case "MCP_CONNECTION_NOT_FOUND":
      return new McpOwnerApiError(
        "not_found",
        `No MCP connection ${connectionId} on your Personal Server.`,
        "vana mcp requests",
      );
    case "NO_PENDING_REQUEST":
      return new McpOwnerApiError(
        "no_pending_request",
        "Nothing is waiting on this connection: the request was already answered.",
        "vana mcp requests",
      );
    case "INVALID_STATE":
      return new McpOwnerApiError(
        "invalid_state",
        "This connection is not active (removed or never approved), so there is nothing to add to.",
      );
    case "CONCURRENT_UPDATE":
      return new McpOwnerApiError(
        "not_ready",
        "The connection changed while approving. Nothing was added; try again.",
        `vana mcp approve ${connectionId}`,
      );
    case "SCOPES_REQUIRED":
    case "SCOPE_NOT_REQUESTED":
    case "INVALID_SCOPE":
      return new McpOwnerApiError(
        "bad_usage",
        `${detail}. Approve only scopes the request asks for; see \`vana mcp requests\`.`,
        "vana mcp requests",
      );
    case "GATEWAY_UNAVAILABLE":
      return new McpOwnerApiError(
        "server_unavailable",
        "Your Personal Server could not reach the Vana network to record this. Nothing changed; try again in a moment.",
        `vana mcp approve ${connectionId}`,
      );
    case "GRANT_CREATION_FAILED":
      return status >= 500
        ? new McpOwnerApiError(
            "server_unavailable",
            `Your Personal Server could not reach the Vana network to record this (${detail}). Nothing changed; try again in a moment.`,
            `vana mcp approve ${connectionId}`,
          )
        : new McpOwnerApiError(
            "grant_creation_failed",
            `The Vana network did not accept this approval: ${detail}. Nothing changed.`,
          );
    default:
      if (status === 401 || status === 403) return unauthorized();
      return new McpOwnerApiError(
        "internal",
        `Your Personal Server could not do this: ${detail}.`,
      );
  }
}

export interface ScopeRequestAnswer {
  connectionId: string;
  displayName: string;
  decision: "approved" | "denied";
  approvedScopes: string[];
  deniedScopes: string[];
  grantedScopes: string[];
  grantId: string | null;
}

/**
 * Approve (part of) or decline the pending request on one connection. With no
 * `scopes`, approve approves everything the agent asked for.
 */
export async function answerScopeRequest(
  server: McpOwnerServer,
  input: {
    connectionId: string;
    decision: "approve" | "deny";
    scopes?: string[];
  },
  fetchImpl: typeof fetch = fetch,
): Promise<ScopeRequestAnswer> {
  const { views } = await listConnections(server, fetchImpl);
  const view = views.find((item) => item.id === input.connectionId);
  if (!view) {
    throw scopeRequestError(
      404,
      { error: { errorCode: "NOT_FOUND" } },
      input.connectionId,
    );
  }
  if (!Array.isArray(view.grantedScopes)) {
    throw new McpOwnerApiError(
      "server_too_old",
      SERVER_TOO_OLD_MESSAGE,
      SERVER_TOO_OLD_REMEDY,
    );
  }
  const pending = pendingRequestOf(view, null);
  const scopes =
    input.scopes && input.scopes.length > 0
      ? input.scopes
      : (pending?.scopes ?? []);
  if (input.decision === "approve" && pending) {
    const unknown = scopes.filter((scope) => !pending.scopes.includes(scope));
    if (unknown.length > 0) {
      throw new McpOwnerApiError(
        "bad_usage",
        `Not part of the request: ${unknown.join(", ")}. ${pending.displayName} asked for ${pending.scopes.join(", ")}.`,
        "vana mcp requests",
      );
    }
  }

  let response: Response;
  try {
    response = await fetchImpl(
      `${server.url}/v1/mcp/connections/${encodeURIComponent(input.connectionId)}/scope-request/${input.decision}`,
      {
        method: "POST",
        headers: ownerHeaders(server),
        body: JSON.stringify(input.decision === "approve" ? { scopes } : {}),
        // Approving signs a grant at the gateway: allow for a slow one.
        signal: AbortSignal.timeout(60_000),
      },
    );
  } catch (error) {
    throw new McpOwnerApiError(
      "server_unavailable",
      `Your Personal Server at ${server.url} did not answer: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const body = (await response.json().catch(() => null)) as {
    connection?: ConnectionView & { scopeAccessDecision?: unknown };
    grantId?: unknown;
    grantedScopes?: unknown;
    approvedScopes?: unknown;
    deniedScopes?: unknown;
    error?: { errorCode?: unknown };
  } | null;
  if (!response.ok || !body?.connection) {
    // A route the server does not have: an older server.
    if (response.status === 404 && typeof body?.error?.errorCode !== "string") {
      throw new McpOwnerApiError(
        "server_too_old",
        SERVER_TOO_OLD_MESSAGE,
        SERVER_TOO_OLD_REMEDY,
      );
    }
    throw scopeRequestError(response.status, body, input.connectionId);
  }
  const displayName =
    typeof body.connection.displayName === "string" &&
    body.connection.displayName.trim()
      ? body.connection.displayName.trim()
      : "The app";
  if (input.decision === "deny") {
    return {
      connectionId: input.connectionId,
      displayName,
      decision: "denied",
      approvedScopes: [],
      deniedScopes: pending?.scopes ?? [],
      grantedScopes: grantedScopesOf(body.connection),
      grantId: null,
    };
  }
  return {
    connectionId: input.connectionId,
    displayName,
    decision: "approved",
    approvedScopes: strings(body.approvedScopes),
    deniedScopes: strings(body.deniedScopes),
    grantedScopes: strings(body.grantedScopes),
    grantId: typeof body.grantId === "string" ? body.grantId : null,
  };
}

/** "5 minutes ago", for a request's age. */
export function formatAge(iso: string | null, now: number): string {
  if (!iso) return "";
  const then = Date.parse(iso);
  if (!Number.isFinite(then)) return "";
  const seconds = Math.max(0, Math.round((now - then) / 1000));
  if (seconds < 60) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? "" : "s"} ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours} hour${hours === 1 ? "" : "s"} ago`;
  const days = Math.round(hours / 24);
  return `${days} days ago`;
}

function shortList(scopes: string[], max = 3): string {
  return scopes.length <= max
    ? scopes.join(", ")
    : `${scopes.slice(0, max).join(", ")} and ${scopes.length - max} more`;
}

/**
 * The one `vana status` line for waiting requests, or null:
 * "1 access request waiting: Claude wants youtube.history. Run `vana mcp requests`."
 */
export function pendingRequestsStatusLine(
  requests: PendingScopeRequest[],
): string | null {
  if (requests.length === 0) return null;
  const who = requests
    .slice(0, 2)
    .map(
      (request) => `${request.displayName} wants ${shortList(request.scopes)}`,
    )
    .join("; ");
  const more = requests.length > 2 ? `; and ${requests.length - 2} more` : "";
  const count = `${requests.length} access request${requests.length === 1 ? "" : "s"} waiting`;
  return `${count}: ${who}${more}. Run \`vana mcp requests\`.`;
}

interface Output {
  stdout(text: string): void;
}

const defaultOutput: Output = {
  stdout: (text) => process.stdout.write(text),
};

function failure(options: AppCommandOptions, error: unknown): CliExitCode {
  const known =
    error instanceof McpOwnerApiError
      ? error
      : new McpOwnerApiError(
          "internal",
          error instanceof Error ? error.message : String(error),
        );
  return emitAppOutcome(options, {
    status: "failed",
    code: known.code,
    message: known.message,
    ...(known.remedy ? { remedy: known.remedy } : {}),
  });
}

async function resolveOrFail(
  options: AppCommandOptions,
  deps: McpRequestsDeps,
): Promise<McpOwnerServer | CliExitCode> {
  const server = await deps.resolveServer();
  if ("code" in server) {
    return emitAppOutcome(options, {
      status: "failed",
      code: server.code,
      message: server.message,
      ...(server.remedy ? { remedy: server.remedy } : {}),
    });
  }
  return server;
}

/** `vana mcp requests` */
export async function runMcpRequests(
  options: AppCommandOptions,
  deps: McpRequestsDeps,
  out: Output = defaultOutput,
): Promise<CliExitCode> {
  const server = await resolveOrFail(options, deps);
  if (typeof server === "number") return server;
  const fetchImpl = deps.fetch ?? fetch;
  let listed: Awaited<ReturnType<typeof listPendingScopeRequests>>;
  try {
    listed = await listPendingScopeRequests(server, fetchImpl);
  } catch (error) {
    return failure(options, error);
  }
  const { requests, supportsAnswers } = listed;
  if (options.json) {
    return emitAppOutcome(options, {
      status: "done",
      code: "ok",
      message:
        requests.length === 0
          ? "No access requests waiting."
          : `${requests.length} access request${requests.length === 1 ? "" : "s"} waiting.`,
      data: { requests, serverCanAnswer: supportsAnswers },
    });
  }
  if (requests.length === 0) {
    out.stdout("No access requests waiting.\n");
    return CliExitCode.OK;
  }
  const now = (deps.now ?? Date.now)();
  out.stdout(
    `${requests.length} access request${requests.length === 1 ? "" : "s"} waiting:\n`,
  );
  for (const request of requests) {
    const age = formatAge(request.requestedAt, now);
    out.stdout(
      `\n  ${request.displayName}${age ? ` (asked ${age})` : ""}\n` +
        `    wants:   ${request.scopes.join(", ")}\n` +
        (request.reason ? `    reason:  "${request.reason}"\n` : "") +
        `    has:     ${request.grantedScopes.length ? request.grantedScopes.join(", ") : "nothing yet"}\n` +
        (request.approvalUrl ? `    open:    ${request.approvalUrl}\n` : "") +
        `    approve: vana mcp approve ${request.connectionId}\n` +
        `    decline: vana mcp deny ${request.connectionId}\n`,
    );
  }
  if (!supportsAnswers) {
    out.stdout(`\n${SERVER_TOO_OLD_MESSAGE}\n`);
  } else if (!server.publicOrigin?.startsWith("https://")) {
    // A `--local` server: Vana Web cannot reach it, so the terminal is the
    // only place to answer.
    out.stdout(
      "\nYour Personal Server has no public URL, so there is no Vana Web link. Approve with `vana mcp approve <id>` or decline with `vana mcp deny <id>`.\n",
    );
  }
  return CliExitCode.OK;
}

/** `vana mcp approve <id> [--scopes a,b]` and `vana mcp deny <id>` */
export async function runMcpAnswer(
  options: AppCommandOptions,
  input: {
    connectionId: string;
    decision: "approve" | "deny";
    scopes?: string;
  },
  deps: McpRequestsDeps,
): Promise<CliExitCode> {
  const scopes = input.scopes
    ?.split(",")
    .map((scope) => scope.trim())
    .filter(Boolean);
  if (input.scopes !== undefined && (!scopes || scopes.length === 0)) {
    return emitAppOutcome(options, {
      status: "failed",
      code: "bad_usage",
      message:
        "--scopes needs at least one scope, comma separated. To decline everything, use `vana mcp deny`.",
      remedy: "vana mcp requests",
    });
  }
  const server = await resolveOrFail(options, deps);
  if (typeof server === "number") return server;
  let answer: ScopeRequestAnswer;
  try {
    answer = await answerScopeRequest(
      server,
      { connectionId: input.connectionId, decision: input.decision, scopes },
      deps.fetch ?? fetch,
    );
  } catch (error) {
    return failure(options, error);
  }
  const message =
    answer.decision === "approved"
      ? `Approved. ${answer.displayName} can now also read ${answer.approvedScopes.join(", ")}. Tell it you are done.`
      : `Declined. Nothing new was shared with ${answer.displayName}.`;
  return emitAppOutcome(options, {
    status: "done",
    code: "ok",
    message,
    data: {
      connectionId: answer.connectionId,
      displayName: answer.displayName,
      decision: answer.decision,
      approvedScopes: answer.approvedScopes,
      deniedScopes: answer.deniedScopes,
      grantedScopes: answer.grantedScopes,
      ...(answer.grantId ? { grantId: answer.grantId } : {}),
    },
  });
}
