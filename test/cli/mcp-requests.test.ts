import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  SERVER_TOO_OLD_MESSAGE,
  answerScopeRequest,
  approvalUrlFor,
  formatAge,
  listPendingScopeRequests,
  pendingRequestsStatusLine,
  runMcpAnswer,
  runMcpRequests,
  type McpOwnerServer,
} from "../../src/cli/mcp-requests.js";
import { CliExitCode } from "../../src/core/exit-codes.js";
import { localServerNetwork } from "../../src/personal-server/local/config.js";

const SERVER: McpOwnerServer = {
  url: "http://localhost:8080",
  token: "owner-token",
  publicOrigin: "https://abc123.server.vana.org",
  webOrigin: "https://app.vana.org",
};

const LINK =
  "https://app.vana.org/mcp/requests/conn_1?ps_origin=https%3A%2F%2Fabc123.server.vana.org";

interface Call {
  method: string;
  path: string;
  body: unknown;
  auth: string | null;
}

/** The owner API of a server with one waiting request on `conn_1`. */
function fakeOwnerApi(
  options: {
    legacy?: boolean;
    answer?: { status: number; body: unknown };
    connections?: unknown[];
  } = {},
) {
  const calls: Call[] = [];
  const connections = options.connections ?? [
    {
      id: "conn_1",
      displayName: "Claude",
      status: "approved",
      grants: [{ grantId: "0xg1", scopes: ["github.profile"] }],
      ...(options.legacy ? {} : { grantedScopes: ["github.profile"] }),
      scopeAccessRequest: {
        scopes: ["spotify.top_artists", "youtube.history"],
        reason: "To suggest music",
        requestedAt: "2026-10-07T10:00:00.000Z",
      },
    },
    {
      id: "conn_2",
      displayName: "Cursor",
      status: "approved",
      grants: [],
      ...(options.legacy ? {} : { grantedScopes: [] }),
    },
  ];
  const fetchImpl = vi.fn(async (input: string | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const headers = new Headers(init?.headers);
    calls.push({
      method: init?.method ?? "GET",
      path: url.pathname,
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
      auth: headers.get("authorization"),
    });
    const json = (status: number, body: unknown) =>
      new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json" },
      });
    if (url.pathname === "/v1/mcp/connections") {
      return json(200, { connections });
    }
    if (options.legacy) return new Response("404 Not Found", { status: 404 });
    if (options.answer) return json(options.answer.status, options.answer.body);
    const scopes = (calls.at(-1)?.body as { scopes?: string[] })?.scopes ?? [];
    if (url.pathname.endsWith("/deny")) {
      return json(200, {
        connection: { id: "conn_1", displayName: "Claude", grantedScopes: [] },
      });
    }
    return json(200, {
      connection: { id: "conn_1", displayName: "Claude" },
      grantId: "0xg2",
      grantedScopes: ["github.profile", ...scopes].sort(),
      approvedScopes: scopes,
      deniedScopes: ["spotify.top_artists", "youtube.history"].filter(
        (scope) => !scopes.includes(scope),
      ),
    });
  });
  return { fetch: fetchImpl as unknown as typeof fetch, calls };
}

let stdout: string[];
let stderr: string[];
beforeEach(() => {
  stdout = [];
  stderr = [];
  vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
    stdout.push(String(chunk));
    return true;
  });
  vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
    stderr.push(String(chunk));
    return true;
  });
});
afterEach(() => {
  vi.restoreAllMocks();
});

const outcome = () => JSON.parse(stdout.join("").trim().split("\n").at(-1)!);

describe("listing waiting requests", () => {
  it("lists only connections with a waiting request, with the approval link", async () => {
    const api = fakeOwnerApi();
    const { requests, supportsAnswers } = await listPendingScopeRequests(
      SERVER,
      api.fetch,
    );
    expect(supportsAnswers).toBe(true);
    expect(requests).toEqual([
      {
        connectionId: "conn_1",
        displayName: "Claude",
        scopes: ["spotify.top_artists", "youtube.history"],
        reason: "To suggest music",
        requestedAt: "2026-10-07T10:00:00.000Z",
        grantedScopes: ["github.profile"],
        approvalUrl: LINK,
      },
    ]);
    expect(api.calls[0].auth).toBe("Bearer owner-token");
  });

  it("gives no approval link for a server that cannot take the answer", async () => {
    const { requests, supportsAnswers } = await listPendingScopeRequests(
      SERVER,
      fakeOwnerApi({ legacy: true }).fetch,
    );
    expect(supportsAnswers).toBe(false);
    expect(requests[0].approvalUrl).toBeNull();
    expect(requests[0].grantedScopes).toEqual(["github.profile"]);
  });

  it("prints who, what, why, age, and how to answer", async () => {
    const lines: string[] = [];
    const code = await runMcpRequests(
      {},
      {
        resolveServer: async () => SERVER,
        fetch: fakeOwnerApi().fetch,
        now: () => Date.parse("2026-10-07T10:05:00.000Z"),
      },
      { stdout: (text) => lines.push(text) },
    );
    const text = lines.join("");
    expect(code).toBe(CliExitCode.OK);
    expect(text).toContain("1 access request waiting");
    expect(text).toContain("Claude (asked 5 minutes ago)");
    expect(text).toContain("wants:   spotify.top_artists, youtube.history");
    expect(text).toContain('reason:  "To suggest music"');
    expect(text).toContain("has:     github.profile");
    expect(text).toContain(`open:    ${LINK}`);
    expect(text).toContain("approve: vana mcp approve conn_1");
    expect(text).not.toContain("no public URL");
  });

  it("sends a server without a public URL to the terminal answer", async () => {
    const lines: string[] = [];
    const code = await runMcpRequests(
      {},
      {
        resolveServer: async () => ({
          ...SERVER,
          publicOrigin: "http://localhost:8080",
        }),
        fetch: fakeOwnerApi().fetch,
      },
      { stdout: (text) => lines.push(text) },
    );
    const text = lines.join("");
    expect(code).toBe(CliExitCode.OK);
    expect(text).not.toContain("open:");
    expect(text).toContain("approve: vana mcp approve conn_1");
    expect(text).toContain("no public URL");
  });

  it("emits one JSON outcome", async () => {
    const code = await runMcpRequests(
      { json: true },
      { resolveServer: async () => SERVER, fetch: fakeOwnerApi().fetch },
    );
    expect(code).toBe(CliExitCode.OK);
    const result = outcome();
    expect(result).toMatchObject({
      type: "outcome",
      status: "done",
      code: "ok",
      exitCode: 0,
      data: { serverCanAnswer: true },
    });
    expect(result.data.requests).toHaveLength(1);
  });

  it("exits 5 when no server of this account runs", async () => {
    const code = await runMcpRequests(
      { json: true },
      {
        resolveServer: async () => ({
          code: "server_unavailable",
          message: "No Personal Server is running.",
          remedy: "vana server start",
        }),
      },
    );
    expect(code).toBe(CliExitCode.SERVER_UNAVAILABLE);
    expect(outcome()).toMatchObject({
      status: "failed",
      code: "server_unavailable",
      remedy: "vana server start",
    });
  });

  it("says when nothing is waiting", async () => {
    const lines: string[] = [];
    await runMcpRequests(
      {},
      {
        resolveServer: async () => SERVER,
        fetch: fakeOwnerApi({ connections: [] }).fetch,
      },
      { stdout: (text) => lines.push(text) },
    );
    expect(lines.join("")).toBe("No access requests waiting.\n");
  });
});

describe("answering a request", () => {
  it("approves everything asked for when no --scopes is given", async () => {
    const api = fakeOwnerApi();
    const code = await runMcpAnswer(
      { json: true },
      { connectionId: "conn_1", decision: "approve" },
      { resolveServer: async () => SERVER, fetch: api.fetch },
    );
    expect(code).toBe(CliExitCode.OK);
    expect(api.calls.at(-1)).toEqual({
      method: "POST",
      path: "/v1/mcp/connections/conn_1/scope-request/approve",
      body: { scopes: ["spotify.top_artists", "youtube.history"] },
      auth: "Bearer owner-token",
    });
    expect(outcome().data).toMatchObject({
      decision: "approved",
      grantId: "0xg2",
      approvedScopes: ["spotify.top_artists", "youtube.history"],
      deniedScopes: [],
    });
  });

  it("approves only --scopes, and refuses one the agent never asked for", async () => {
    const api = fakeOwnerApi();
    const answer = await answerScopeRequest(
      SERVER,
      {
        connectionId: "conn_1",
        decision: "approve",
        scopes: ["youtube.history"],
      },
      api.fetch,
    );
    expect(answer.approvedScopes).toEqual(["youtube.history"]);
    expect(answer.deniedScopes).toEqual(["spotify.top_artists"]);

    const code = await runMcpAnswer(
      { json: true },
      { connectionId: "conn_1", decision: "approve", scopes: "gmail.messages" },
      { resolveServer: async () => SERVER, fetch: fakeOwnerApi().fetch },
    );
    expect(code).toBe(CliExitCode.USAGE);
    expect(outcome().message).toContain("Not part of the request");
  });

  it("refuses an empty --scopes as bad usage", async () => {
    const code = await runMcpAnswer(
      { json: true },
      { connectionId: "conn_1", decision: "approve", scopes: " , " },
      { resolveServer: async () => SERVER },
    );
    expect(code).toBe(CliExitCode.USAGE);
  });

  it("declines", async () => {
    const api = fakeOwnerApi();
    const code = await runMcpAnswer(
      {},
      { connectionId: "conn_1", decision: "deny" },
      { resolveServer: async () => SERVER, fetch: api.fetch },
    );
    expect(code).toBe(CliExitCode.OK);
    expect(api.calls.at(-1)?.path).toBe(
      "/v1/mcp/connections/conn_1/scope-request/deny",
    );
    expect(stdout.join("")).toContain("Declined. Nothing new was shared");
  });

  it("reports an unknown connection without calling the answer endpoint", async () => {
    const api = fakeOwnerApi();
    const code = await runMcpAnswer(
      { json: true },
      { connectionId: "conn_x", decision: "deny" },
      { resolveServer: async () => SERVER, fetch: api.fetch },
    );
    expect(code).toBe(CliExitCode.FAILURE);
    expect(outcome().code).toBe("not_found");
    expect(api.calls).toHaveLength(1);
  });

  it("maps the server's errors onto exit codes", async () => {
    const cases: Array<[number, string, string, number]> = [
      [409, "NO_PENDING_REQUEST", "no_pending_request", CliExitCode.FAILURE],
      [409, "CONCURRENT_UPDATE", "not_ready", CliExitCode.NOT_READY],
      [400, "SCOPE_NOT_REQUESTED", "bad_usage", CliExitCode.USAGE],
      [
        502,
        "GATEWAY_UNAVAILABLE",
        "server_unavailable",
        CliExitCode.SERVER_UNAVAILABLE,
      ],
      [
        502,
        "GRANT_CREATION_FAILED",
        "server_unavailable",
        CliExitCode.SERVER_UNAVAILABLE,
      ],
      [400, "GRANT_CREATION_FAILED", "grant_creation_failed", 1],
      [409, "INVALID_STATE", "invalid_state", CliExitCode.FAILURE],
      // Removed between listing and answering.
      [404, "MCP_CONNECTION_NOT_FOUND", "not_found", CliExitCode.FAILURE],
    ];
    for (const [status, errorCode, code, exit] of cases) {
      stdout = [];
      const result = await runMcpAnswer(
        { json: true },
        { connectionId: "conn_1", decision: "approve" },
        {
          resolveServer: async () => SERVER,
          fetch: fakeOwnerApi({
            answer: {
              status,
              body: { error: { code: status, errorCode, message: "x" } },
            },
          }).fetch,
        },
      );
      expect([errorCode, result]).toEqual([errorCode, exit]);
      expect([errorCode, outcome().code]).toEqual([errorCode, code]);
    }
  });

  it("tells the owner to update a server without the endpoints", async () => {
    const code = await runMcpAnswer(
      { json: true },
      { connectionId: "conn_1", decision: "approve" },
      {
        resolveServer: async () => SERVER,
        fetch: fakeOwnerApi({ legacy: true }).fetch,
      },
    );
    expect(code).toBe(CliExitCode.FAILURE);
    expect(outcome()).toMatchObject({
      code: "server_too_old",
      message: SERVER_TOO_OLD_MESSAGE,
      remedy: "vana server stop && vana server start",
    });
  });

  it("says the session was refused on a 401", async () => {
    const fetchImpl = (async () =>
      new Response("", { status: 401 })) as unknown as typeof fetch;
    const code = await runMcpAnswer(
      { json: true },
      { connectionId: "conn_1", decision: "deny" },
      { resolveServer: async () => SERVER, fetch: fetchImpl },
    );
    expect(code).toBe(CliExitCode.FAILURE);
    expect(outcome().code).toBe("unauthorized");
  });
});

describe("status line", () => {
  const request = (displayName: string, scopes: string[]) => ({
    connectionId: "c",
    displayName,
    scopes,
    reason: null,
    requestedAt: null,
    grantedScopes: [],
    approvalUrl: null,
  });

  it("is absent when nothing waits", () => {
    expect(pendingRequestsStatusLine([])).toBeNull();
  });

  it("names who wants what, in one line", () => {
    expect(
      pendingRequestsStatusLine([request("Claude", ["youtube.history"])]),
    ).toBe(
      "1 access request waiting: Claude wants youtube.history. Run `vana mcp requests`.",
    );
    expect(
      pendingRequestsStatusLine([
        request("Claude", ["a.x", "b.x", "c.x", "d.x"]),
        request("Cursor", ["e.x"]),
        request("Codex", ["f.x"]),
      ]),
    ).toBe(
      "3 access requests waiting: Claude wants a.x, b.x, c.x and 1 more; Cursor wants e.x; and 1 more. Run `vana mcp requests`.",
    );
  });

  it("formats ages", () => {
    const now = Date.parse("2026-10-07T12:00:00.000Z");
    expect(formatAge("2026-10-07T11:59:30.000Z", now)).toBe("just now");
    expect(formatAge("2026-10-07T11:00:00.000Z", now)).toBe("1 hour ago");
    expect(formatAge(null, now)).toBe("");
  });
});

describe("the Vana Web link", () => {
  it("is on the Vana Web of the server's network", () => {
    expect(localServerNetwork("mainnet").webOrigin).toBe(
      "https://app.vana.org",
    );
    // Moksha runs on the dev deployment (gateway, storage, relay).
    expect(localServerNetwork("moksha").webOrigin).toBe(
      "https://app-dev.vana.org",
    );
  });

  it("names the connection and the server's public origin", () => {
    expect(approvalUrlFor(SERVER, "conn_1")).toBe(LINK);
    expect(
      approvalUrlFor(
        {
          publicOrigin: "https://abc123.server.vana.org/some/path",
          webOrigin: "https://app-dev.vana.org/",
        },
        "conn/2",
      ),
    ).toBe(
      "https://app-dev.vana.org/mcp/requests/conn%2F2?ps_origin=https%3A%2F%2Fabc123.server.vana.org",
    );
  });

  it("is absent for a server Vana Web cannot reach", () => {
    for (const publicOrigin of [
      null,
      "http://localhost:8080",
      "http://127.0.0.1:8080",
      "not a url",
    ]) {
      expect(approvalUrlFor({ ...SERVER, publicOrigin }, "conn_1")).toBeNull();
    }
    expect(approvalUrlFor({ ...SERVER, webOrigin: null }, "conn_1")).toBeNull();
  });
});
