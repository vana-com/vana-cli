import { expect, it, vi } from "vitest";
import { resolveApprovalLink } from "../../src/cli/app/approval-link.js";
import { resolveNetwork } from "../../src/core/network.js";

const network = resolveNetwork("moksha", { VANA_ENV: "dev" });
const owner = "0x1111111111111111111111111111111111111111";
const app = "0x2222222222222222222222222222222222222222";
const server = "0x3333333333333333333333333333333333333333";
const tunnel = "https://owner-server.example";
const link = `${network.approvalUrl}/data-connection-requests/dcr_example?mode=page`;

function fixture() {
  return {
    accountUrl: () => network.accountUrl,
    credentials: () => ({
      account: {
        address: owner,
        session_token: "fixture",
        expires_at: "2099-01-01",
      },
      personal_server: null,
    }),
    detectTarget: vi.fn(async () => ({
      state: "available" as const,
      source: "config" as const,
      url: "http://localhost:8084",
      health: {
        status: "healthy",
        version: "1",
        uptime: 10,
        owner,
        identity: server,
        apiOrigin: tunnel,
      },
    })),
    lookupServers: vi.fn(async () => [
      {
        network: "moksha" as const,
        url: tunnel,
        serverAddress: server,
        status: "finalized",
      },
    ]),
    fetchFn: vi.fn(async (_input: URL | RequestInfo) =>
      Response.json({
        object: "app_ownership",
        appAddress: app,
        network: "moksha",
        ownership: "owned",
      }),
    ),
  };
}

it("preserves the approval handoff and pins the configured, registered server of the app owner", async () => {
  const deps = fixture();
  expect(await resolveApprovalLink(link, network, app, undefined, deps)).toBe(
    `${link}&server_address=${server}`,
  );
  expect(String(deps.fetchFn.mock.calls[0]?.[0])).toBe(
    `${network.accountUrl}/api/v1/me/app-ownership?address=${app}&network=moksha`,
  );
});

it("leaves links unchanged when Account cannot confirm ownership or the selected server is unregistered", async () => {
  const unowned = fixture();
  unowned.fetchFn.mockResolvedValueOnce(
    Response.json({ ownership: "not_owned" }),
  );
  expect(
    await resolveApprovalLink(link, network, app, undefined, unowned),
  ).toBe(link);

  const unregistered = fixture();
  unregistered.lookupServers.mockResolvedValueOnce([]);
  expect(
    await resolveApprovalLink(link, network, app, undefined, unregistered),
  ).toBe(link);
});

it("keeps an explicit hint and avoids lookups for a different recipient or approval host", async () => {
  const deps = fixture();
  const selected = `${link}&server_address=${server}`;
  const foreignHost = link.replace(
    network.approvalUrl,
    "https://other.example",
  );
  expect(
    await resolveApprovalLink(selected, network, app, undefined, deps),
  ).toBe(selected);
  expect(
    await resolveApprovalLink(foreignHost, network, app, undefined, deps),
  ).toBe(foreignHost);
  expect(await resolveApprovalLink(link, network, app, app, deps)).toBe(link);
  expect(deps.detectTarget).not.toHaveBeenCalled();
  expect(deps.fetchFn).not.toHaveBeenCalled();
});
