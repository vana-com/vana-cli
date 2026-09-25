import http from "node:http";
import type { AddressInfo } from "node:net";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  requesterName,
  startMcpApprovalPage,
} from "../../src/personal-server/local/runtime-pkg/mcp-approval.mjs";

const TOKEN = "owner-token";

/** A Personal Server with one pending authorization from claude.ai. */
function fakeServer() {
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
          redirectUri: "https://claude.ai/api/mcp/auth_callback",
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
