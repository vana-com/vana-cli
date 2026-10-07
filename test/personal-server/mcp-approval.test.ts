import http from "node:http";
import type { AddressInfo } from "node:net";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  describeRequester,
  describeScopeRequestError,
  findLocalApp,
  isLoopbackRedirect,
  localAppName,
  requesterName,
  startMcpApprovalPage,
} from "../../src/personal-server/local/runtime-pkg/mcp-approval.mjs";

const TOKEN = "owner-token";

/** A Personal Server with one pending authorization from claude.ai, or from `redirectUri`. */
function fakeServer(redirectUri = "https://claude.ai/api/mcp/auth_callback") {
  const approvals: Array<{ scopes: string[] }> = [];
  let status = "pending";
  const server = http.createServer((req, res) => {
    if (req.headers.authorization !== `Bearer ${TOKEN}`) {
      res.writeHead(401).end();
      return;
    }
    const url = new URL(req.url ?? "/", "http://x");
    if (
      url.pathname === "/v1/mcp/oauth/authorizations/auth_1" &&
      req.method === "GET"
    ) {
      res.end(
        JSON.stringify({
          id: "auth_1",
          redirectUri,
          state: "st",
          status,
        }),
      );
      return;
    }
    if (url.pathname === "/v1/mcp/oauth/authorizations/auth_1/approve") {
      let raw = "";
      req.on("data", (chunk) => (raw += chunk));
      req.on("end", () => {
        approvals.push(JSON.parse(raw));
        status = "approved";
        res.end(
          JSON.stringify({
            redirectTo:
              "https://claude.ai/api/mcp/auth_callback?code=c1&state=st",
          }),
        );
      });
      return;
    }
    if (url.pathname === "/v1/data") {
      res.end(
        JSON.stringify({
          scopes: [{ scope: "github.profile" }, { scope: "linkedin.profile" }],
          total: 2,
        }),
      );
      return;
    }
    res.writeHead(404).end();
  });
  return { server, approvals };
}

describe("MCP approval page", () => {
  let backend: ReturnType<typeof fakeServer>;
  let page: { url: string; close: () => void };

  beforeEach(async () => {
    backend = fakeServer();
    await new Promise<void>((resolve) =>
      backend.server.listen(0, "127.0.0.1", resolve),
    );
    const { port } = backend.server.address() as AddressInfo;
    page = await startMcpApprovalPage({
      serverOrigin: () => `http://127.0.0.1:${port}`,
      accessToken: TOKEN,
    });
  });
  afterEach(() => {
    page.close();
    backend.server.close();
  });

  async function open() {
    const response = await fetch(`${page.url}?mcp_authorization=auth_1`);
    const html = await response.text();
    const token = /name="token" value="([^"]+)"/.exec(html)?.[1] ?? "";
    return { response, html, token };
  }

  const post = (body: URLSearchParams) =>
    fetch(page.url, { method: "POST", body, redirect: "manual" });

  it("shows who asks and every scope, ticked", async () => {
    const { response, html } = await open();
    expect(response.status).toBe(200);
    expect(html).toContain("Allow Claude to read your data");
    expect(html).toContain('value="github.profile" checked');
    expect(html).toContain('value="linkedin.profile" checked');
  });

  it("approves the ticked scopes and sends the browser back to Claude", async () => {
    const { token } = await open();
    const response = await post(
      new URLSearchParams([
        ["id", "auth_1"],
        ["token", token],
        ["action", "approve"],
        ["scope", "github.profile"],
      ]),
    );
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toContain("code=c1");
    expect(backend.approvals).toEqual([{ scopes: ["github.profile"] }]);
  });

  it("denies back to Claude with access_denied, sharing nothing", async () => {
    const { token } = await open();
    const response = await post(
      new URLSearchParams({ id: "auth_1", token, action: "deny" }),
    );
    expect(response.status).toBe(303);
    const location = new URL(response.headers.get("location") ?? "");
    expect(location.searchParams.get("error")).toBe("access_denied");
    expect(location.searchParams.get("state")).toBe("st");
    expect(backend.approvals).toHaveLength(0);
  });

  it("refuses a forged or reused form token", async () => {
    const forged = await post(
      new URLSearchParams({
        id: "auth_1",
        token: "x",
        action: "approve",
        scope: "github.profile",
      }),
    );
    expect(forged.status).toBe(403);
    const { token } = await open();
    const body = new URLSearchParams({ id: "auth_1", token, action: "deny" });
    expect((await post(body)).status).toBe(303);
    expect((await post(body)).status).toBe(403);
  });

  it("refuses a request that reaches it under another host name", async () => {
    const { port } = new URL(page.url);
    const response = await new Promise<number>((resolve) => {
      http
        .get(
          {
            host: "127.0.0.1",
            port,
            path: "/mcp?mcp_authorization=auth_1",
            headers: { host: "evil.example" },
          },
          (res) => {
            res.resume();
            resolve(res.statusCode ?? 0);
          },
        )
        .on("error", () => resolve(0));
    });
    expect(response).toBe(400);
  });

  it("names the requester from where it sends the owner back", () => {
    expect(requesterName("https://claude.ai/api/mcp/auth_callback")).toBe(
      "Claude",
    );
    expect(requesterName("https://app.example.com/cb")).toBe("app.example.com");
  });
});

describe("MCP approval page, local client", () => {
  it("names a client on this computer by the program holding its callback port", async () => {
    const backend = fakeServer("http://localhost:61981/callback");
    await new Promise<void>((resolve) =>
      backend.server.listen(0, "127.0.0.1", resolve),
    );
    const { port } = backend.server.address() as AddressInfo;
    const asked: number[] = [];
    const page = await startMcpApprovalPage({
      serverOrigin: () => `http://127.0.0.1:${port}`,
      accessToken: TOKEN,
      findLocalApp: async (callbackPort: number) => {
        asked.push(callbackPort);
        return "Claude Code";
      },
    });
    try {
      const html = await (
        await fetch(`${page.url}?mcp_authorization=auth_1`)
      ).text();
      expect(asked).toEqual([61981]);
      expect(html).toContain("Allow Claude Code to read your data");
      expect(html).toContain("Claude Code (on this computer) asks");
      expect(html).not.toContain("localhost:61981");
    } finally {
      page.close();
      backend.server.close();
    }
  });

  it("says an app on this computer when the program is unknown", async () => {
    expect(
      await describeRequester("http://127.0.0.1:5000/cb", async () => null),
    ).toEqual({ who: "An app on this computer", where: "on this computer" });
    expect(
      await describeRequester(
        "https://claude.ai/api/mcp/auth_callback",
        async () => {
          throw new Error("must not look up a remote client");
        },
      ),
    ).toEqual({ who: "Claude", where: "claude.ai" });
  });

  it("treats only loopback hosts as local", () => {
    expect(isLoopbackRedirect("http://localhost:1/cb")).toBe(true);
    expect(isLoopbackRedirect("http://127.0.0.1:1/cb")).toBe(true);
    expect(isLoopbackRedirect("http://[::1]:1/cb")).toBe(true);
    expect(isLoopbackRedirect("https://localhost.example.com/cb")).toBe(false);
    expect(isLoopbackRedirect("not a url")).toBe(false);
  });

  it("maps known client executables, by base name", () => {
    expect(localAppName("claude")).toBe("Claude Code");
    expect(localAppName("/usr/local/bin/codex\n")).toBe("Codex");
    expect(localAppName("node")).toBeNull();
  });

  it("finds the program from lsof and ps, and gives up quietly", async () => {
    if (process.platform === "win32") return;
    const calls: string[][] = [];
    const exec = async (file: string, args: string[]) => {
      calls.push([file, ...args]);
      return file === "lsof" ? "2916\n" : "claude\n";
    };
    expect(await findLocalApp(61981, exec)).toBe("Claude Code");
    expect(calls).toEqual([
      ["lsof", "-nP", "-t", "-iTCP:61981", "-sTCP:LISTEN"],
      ["ps", "-o", "comm=", "-p", "2916"],
    ]);
    expect(await findLocalApp(61981, async () => "")).toBeNull();
    expect(await findLocalApp(0, exec)).toBeNull();
  });
});

/**
 * A Personal Server whose MCP connection `conn_1` (Claude) asked for
 * youtube.history and spotify.top_artists, answering the scope-request
 * endpoints the way personal-server-ts does (or not at all when `legacy`).
 */
function fakeScopeServer(
  options: {
    legacy?: boolean;
    approveError?: { status: number; errorCode: string; message: string };
  } = {},
) {
  const answers: Array<{ path: string; body: unknown }> = [];
  let pending: {
    scopes: string[];
    reason?: string;
    requestedAt: string;
  } | null = {
    scopes: ["spotify.top_artists", "youtube.history"],
    reason: "To <b>suggest</b> music",
    requestedAt: "2026-10-07T10:00:00.000Z",
  };
  let decision: Record<string, unknown> | undefined;
  let granted = ["github.profile"];
  const view = () => ({
    id: "conn_1",
    displayName: "Claude",
    status: "approved",
    grants: [{ grantId: "0xg1", scopes: granted }],
    ...(options.legacy ? {} : { grantedScopes: granted }),
    ...(pending ? { scopeAccessRequest: pending } : {}),
    ...(decision && !options.legacy ? { scopeAccessDecision: decision } : {}),
  });
  const server = http.createServer((req, res) => {
    if (req.headers.authorization !== `Bearer ${TOKEN}`) {
      res.writeHead(401).end();
      return;
    }
    const url = new URL(req.url ?? "/", "http://x");
    const json = (status: number, body: unknown) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    if (url.pathname === "/v1/mcp/connections" && req.method === "GET") {
      json(200, { connections: [view()] });
      return;
    }
    const match =
      /^\/v1\/mcp\/connections\/([^/]+)\/scope-request\/(approve|deny)$/.exec(
        url.pathname,
      );
    if (match && req.method === "POST" && !options.legacy) {
      let raw = "";
      req.on("data", (chunk) => (raw += chunk));
      req.on("end", () => {
        const body = raw ? JSON.parse(raw) : {};
        answers.push({ path: url.pathname, body });
        if (match[1] !== "conn_1") {
          json(404, {
            error: { code: 404, errorCode: "NOT_FOUND", message: "nope" },
          });
          return;
        }
        if (!pending) {
          json(409, {
            error: {
              code: 409,
              errorCode: "NO_PENDING_REQUEST",
              message: "no pending",
            },
          });
          return;
        }
        if (options.approveError && match[2] === "approve") {
          json(options.approveError.status, {
            error: {
              code: options.approveError.status,
              errorCode: options.approveError.errorCode,
              message: options.approveError.message,
            },
          });
          return;
        }
        const requested = pending.scopes;
        if (match[2] === "deny") {
          decision = {
            decision: "denied",
            approvedScopes: [],
            deniedScopes: requested,
          };
          pending = null;
          json(200, { connection: view() });
          return;
        }
        const approvedScopes = (body.scopes as string[]).slice().sort();
        const deniedScopes = requested.filter(
          (scope) => !approvedScopes.includes(scope),
        );
        granted = [...granted, ...approvedScopes].sort();
        decision = { decision: "approved", approvedScopes, deniedScopes };
        pending = null;
        json(200, {
          connection: view(),
          grantId: "0xg2",
          grantedScopes: granted,
          approvedScopes,
          deniedScopes,
        });
      });
      return;
    }
    res.writeHead(404, { "content-type": "text/plain" }).end("404 Not Found");
  });
  return { server, answers };
}

describe("MCP scope request page", () => {
  let backend: ReturnType<typeof fakeScopeServer>;
  let page: {
    url: string;
    origin: string;
    scopeRequestUrl: (id: string) => string;
    close: () => void;
  };

  async function start(options?: Parameters<typeof fakeScopeServer>[0]) {
    backend = fakeScopeServer(options);
    await new Promise<void>((resolve) =>
      backend.server.listen(0, "127.0.0.1", resolve),
    );
    const { port } = backend.server.address() as AddressInfo;
    page = await startMcpApprovalPage({
      serverOrigin: () => `http://127.0.0.1:${port}`,
      accessToken: TOKEN,
    });
  }
  afterEach(() => {
    page?.close();
    backend?.server.close();
  });

  async function open(id = "conn_1") {
    const response = await fetch(page.scopeRequestUrl(id));
    const html = await response.text();
    const token = /name="token" value="([^"]+)"/.exec(html)?.[1] ?? "";
    return { response, html, token };
  }

  const post = (body: URLSearchParams, headers: Record<string, string> = {}) =>
    fetch(`${page.origin}/scope-request`, {
      method: "POST",
      body,
      headers,
      redirect: "manual",
    });

  it("links to the page by connection id on the loopback origin", async () => {
    await start();
    expect(page.scopeRequestUrl("conn 1")).toBe(
      `${page.origin}/scope-request?connection=conn%201`,
    );
    expect(page.origin).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
  });

  it("shows who asks, their reason, what is shared, and the asked scopes ticked", async () => {
    await start();
    const { response, html } = await open();
    expect(response.status).toBe(200);
    expect(html).toContain("Claude asks for more of your data");
    expect(html).toContain("To &lt;b&gt;suggest&lt;/b&gt; music");
    expect(html).not.toContain("<b>suggest</b>");
    expect(html).toContain("Already shared");
    expect(html).toContain("<li>github.profile</li>");
    expect(html).toContain('value="youtube.history" checked');
    expect(html).toContain('value="spotify.top_artists" checked');
    expect(html).toContain(">Decline</button>");
  });

  it("approves the ticked scopes and says to go back to the app", async () => {
    await start();
    const { token } = await open();
    const response = await post(
      new URLSearchParams([
        ["connection", "conn_1"],
        ["token", token],
        ["action", "approve"],
        ["scope", "youtube.history"],
      ]),
    );
    const html = await response.text();
    expect(response.status).toBe(200);
    expect(html).toContain("Done. Go back to Claude");
    expect(html).toContain("<li>youtube.history</li>");
    expect(html).toContain("Not shared:");
    expect(html).toContain("<li>spotify.top_artists</li>");
    expect(backend.answers).toEqual([
      {
        path: "/v1/mcp/connections/conn_1/scope-request/approve",
        body: { scopes: ["youtube.history"] },
      },
    ]);
  });

  it("declines, sharing nothing new", async () => {
    await start();
    const { token } = await open();
    const response = await post(
      new URLSearchParams({ connection: "conn_1", token, action: "deny" }),
    );
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("Declined. Go back to Claude");
    expect(backend.answers.map((answer) => answer.path)).toEqual([
      "/v1/mcp/connections/conn_1/scope-request/deny",
    ]);
  });

  it("says the request was already answered once it is decided", async () => {
    await start();
    const { token } = await open();
    await post(
      new URLSearchParams({ connection: "conn_1", token, action: "deny" }),
    );
    const again = await open();
    expect(again.response.status).toBe(200);
    expect(again.html).toContain("Already answered");
    expect(again.html).toContain("You already declined this request");
    expect(again.token).toBe("");
  });

  it("refuses a forged or reused form token, and a foreign origin", async () => {
    await start();
    const forged = await post(
      new URLSearchParams({
        connection: "conn_1",
        token: "x",
        action: "approve",
        scope: "youtube.history",
      }),
    );
    expect(forged.status).toBe(403);
    const { token } = await open();
    const foreign = await post(
      new URLSearchParams({ connection: "conn_1", token, action: "deny" }),
      { origin: "https://evil.example" },
    );
    expect(foreign.status).toBe(403);
    const body = new URLSearchParams({
      connection: "conn_1",
      token,
      action: "deny",
    });
    expect((await post(body)).status).toBe(200);
    expect((await post(body)).status).toBe(403);
    expect(backend.answers).toHaveLength(1);
  });

  it("asks to tick something rather than approving nothing", async () => {
    await start();
    const { token } = await open();
    const response = await post(
      new URLSearchParams({ connection: "conn_1", token, action: "approve" }),
    );
    expect(response.status).toBe(400);
    expect(await response.text()).toContain("Try again");
    expect(backend.answers).toHaveLength(0);
  });

  it("explains a gateway failure in plain words and offers a retry", async () => {
    await start({
      approveError: {
        status: 502,
        errorCode: "GATEWAY_UNAVAILABLE",
        message: "Could not read grant 0xg1: fetch failed",
      },
    });
    const { token } = await open();
    const response = await post(
      new URLSearchParams([
        ["connection", "conn_1"],
        ["token", token],
        ["action", "approve"],
        ["scope", "youtube.history"],
      ]),
    );
    const html = await response.text();
    expect(response.status).toBe(502);
    expect(html).toContain("could not reach the Vana network");
    expect(html).toContain("/scope-request?connection=conn_1");
  });

  it("says an unknown connection is gone", async () => {
    await start();
    const { response, html } = await open("conn_x");
    expect(response.status).toBe(404);
    expect(html).toContain("no longer exists");
  });

  it("tells the owner to update a server without the answer endpoints", async () => {
    await start({ legacy: true });
    const { response, html } = await open();
    expect(response.status).toBe(501);
    expect(html).toContain("too old");
  });

  it("maps every server error code to words", () => {
    expect(
      describeScopeRequestError(409, {
        error: { errorCode: "NO_PENDING_REQUEST" },
      }).heading,
    ).toBe("Already answered");
    expect(
      describeScopeRequestError(502, {
        error: { errorCode: "GRANT_CREATION_FAILED", message: "boom" },
      }).heading,
    ).toBe("Vana network unavailable");
    expect(
      describeScopeRequestError(400, {
        error: { errorCode: "GRANT_CREATION_FAILED", message: "bad sig" },
      }).text,
    ).toContain("bad sig");
    expect(
      describeScopeRequestError(409, {
        error: { errorCode: "CONCURRENT_UPDATE" },
      }).retry,
    ).toBe(true);
    expect(describeScopeRequestError(500, null).text).toContain("HTTP 500");
  });
});
