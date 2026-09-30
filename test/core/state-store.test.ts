import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

let tempRoot = path.join(os.tmpdir(), "vana-connect-state-store-tests");

vi.mock("../../src/core/paths.js", () => ({
  getCliStatePath: () => path.join(tempRoot, "vana-connect-state.json"),
  getVanaHome: () => tempRoot,
}));

import {
  __setStateStoreTestHooks,
  readCliState,
  updateSourceState,
} from "../../src/core/state-store.js";

describe("state-store", () => {
  beforeEach(async () => {
    tempRoot = await fs.mkdtemp(
      path.join(os.tmpdir(), "vana-connect-state-store-"),
    );
    __setStateStoreTestHooks(undefined);
  });

  afterEach(async () => {
    __setStateStoreTestHooks(undefined);
    await fs.rm(tempRoot, { recursive: true, force: true });
  });

  it("preserves concurrent source updates", async () => {
    __setStateStoreTestHooks({
      beforeWrite: async () => {
        await new Promise((resolve) => setTimeout(resolve, 50));
      },
    });

    await Promise.all([
      updateSourceState("github", {
        lastRunOutcome: "connected_local_only",
        dataState: "collected_local",
      }),
      updateSourceState("shop", {
        lastRunOutcome: "legacy_auth",
        dataState: "none",
      }),
    ]);

    await expect(readCliState()).resolves.toEqual({
      version: 1,
      sources: {
        github: {
          lastRunOutcome: "connected_local_only",
          dataState: "collected_local",
        },
        shop: {
          lastRunOutcome: "legacy_auth",
          dataState: "none",
        },
      },
    });
  });

  it("recovers from a stale state lock file", async () => {
    const lockPath = path.join(tempRoot, "vana-connect-state.json.lock");
    await fs.writeFile(lockPath, "stale\n", "utf8");
    const staleTime = new Date(Date.now() - 60_000);
    await fs.utimes(lockPath, staleTime, staleTime);

    await updateSourceState("github", {
      lastRunOutcome: "connected_local_only",
      dataState: "collected_local",
    });

    await expect(readCliState()).resolves.toEqual({
      version: 1,
      sources: {
        github: {
          lastRunOutcome: "connected_local_only",
          dataState: "collected_local",
        },
      },
    });
  });

  it("merges telemetry config into the shared state file", async () => {
    const { updateCliConfig, readCliConfig } =
      await import("../../src/core/state-store.js");

    await updateCliConfig({ personalServerUrl: "http://localhost:8080" });
    await updateCliConfig({
      telemetryEnabled: false,
      telemetryInstallId: "inst_test",
    });

    await expect(readCliConfig()).resolves.toEqual({
      personalServerUrl: "http://localhost:8080",
      telemetryEnabled: false,
      telemetryInstallId: "inst_test",
    });
  });

  it("round-trips local connectors next to the rest of the config", async () => {
    const { updateCliConfig, readCliConfig, readCliState } =
      await import("../../src/core/state-store.js");
    const entry = {
      path: "/abs/data-connectors",
      addedAt: "2026-09-28T00:00:00.000Z",
      displayName: "Slack",
      version: "0.1.0",
      gitHead: "0123456789abcdef0123456789abcdef01234567",
      humanInteraction: ["manual_action"],
    };

    await updateCliConfig({ personalServerUrl: "http://localhost:8080" });
    await updateCliConfig({ localConnectors: { slack_browser: entry } });

    await expect(readCliConfig()).resolves.toEqual({
      personalServerUrl: "http://localhost:8080",
      localConnectors: { slack_browser: entry },
    });
    // It lives under `config` in the state file, next to sources.
    await expect(readCliState()).resolves.toMatchObject({
      version: 1,
      config: { localConnectors: { slack_browser: entry } },
      sources: {},
    });

    await updateCliConfig({ localConnectors: {} });
    await expect(readCliConfig()).resolves.toEqual({
      personalServerUrl: "http://localhost:8080",
      localConnectors: {},
    });
  });
});
