// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import ConnectFlow from "./ConnectFlow.js";

const older = {
  revision: "older-result",
  savedAt: "2026-10-27T07:00:00Z",
  threads: [{ id: "thread", title: "Previous saved title", updatedAt: null }],
};
const newer = {
  revision: "newer-result",
  savedAt: "2026-10-27T08:00:00Z",
  threads: [{ id: "thread", title: "Newly delivered title", updatedAt: null }],
};
let root;
let container;
let releaseSnapshot;

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.spyOn(window, "open").mockReturnValue(null);
  const snapshot = new Promise((resolve) => {
    releaseSnapshot = () =>
      resolve(Response.json({ saved: older, acknowledged: true }));
  });
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url, init) => {
      if (url === "/api/data" && !init?.method) return snapshot;
      if (url === "/api/connect")
        return Response.json({
          requestId: "dcr_newer",
          approvalUrl: "https://approval.example/request",
          expiresAt: "2099-01-01T00:00:00Z",
        });
      if (url.startsWith("/api/status?"))
        return Response.json({ status: "approved" });
      if (url === "/api/data")
        return Response.json({
          scope: "perplexity.conversations",
          data: newer,
        });
      if (url === "/api/acknowledge")
        return Response.json({ acknowledged: true });
      throw new Error(`Unexpected request: ${url}`);
    }),
  );
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

it("keeps a newer delivered result when initial saved-data hydration arrives late", async () => {
  await act(async () => root.render(createElement(ConnectFlow)));
  await act(async () => {
    [...container.querySelectorAll("button")]
      .find((button) => button.textContent === "Connect with Vana")
      .click();
  });
  await act(async () => vi.advanceTimersByTimeAsync(1500));
  expect(container.textContent).toContain("Newly delivered title");
  expect(container.textContent).toContain("Delivery confirmed in Vana.");

  await act(async () => {
    releaseSnapshot();
  });

  expect(container.textContent).toContain("Newly delivered title");
  expect(container.textContent).not.toContain("Previous saved title");
  expect(container.textContent).toContain("Delivery confirmed in Vana.");
});

it("restores saved data when no newer connection has started", async () => {
  await act(async () => root.render(createElement(ConnectFlow)));
  await act(async () => {
    releaseSnapshot();
  });
  expect(container.textContent).toContain("Previous saved title");
  expect(fetch.mock.calls.some(([url]) => url === "/api/acknowledge")).toBe(
    false,
  );
});
