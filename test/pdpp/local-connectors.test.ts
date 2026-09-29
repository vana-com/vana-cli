import path from "node:path";

import { describe, expect, it } from "vitest";

import type { CliConfig } from "../../src/core/state-store.js";
import {
  addLocalConnector,
  LocalConnectorConflictError,
  removeLocalConnector,
  resolvePdppSource,
  type LocalConnectorDeps,
} from "../../src/pdpp/local-connectors.js";
import type { PdppLaunch } from "../../src/pdpp/profile.js";

function fakeLaunch(key: string, humanInteraction?: string[]): PdppLaunch {
  return {
    source: key,
    displayName: "Slack",
    version: "0.3.0",
    profile: {
      connector_key: key,
      version: "0.3.0",
      display_name: "Slack",
      streams: [{ name: "messages" }],
      ...(humanInteraction
        ? { capabilities: { human_interaction: humanInteraction } }
        : {}),
    },
    args: ["--import", "tsx", `/abs/connectors/${key}/index.ts`],
    cwd: "/abs",
    nodeRange: ">=24.15.0 <25",
    installRoot: null,
    hostPackages: [],
    origin: "local",
  };
}

function makeDeps(initial: CliConfig = {}) {
  const config: CliConfig = { ...initial };
  const calls: string[] = [];
  const deps: LocalConnectorDeps = {
    readCliConfig: async () => ({ ...config }),
    updateCliConfig: async (patch) => {
      Object.assign(config, patch);
    },
    resolveLocalLaunch: async (checkout, source) => {
      calls.push(`${checkout}:${source}`);
      return fakeLaunch(source, ["manual_action"]);
    },
    gitHead: (dir) => (dir.endsWith("repo") ? "a".repeat(40) : undefined),
    now: () => new Date("2026-09-28T12:00:00.000Z"),
  };
  return { config, calls, deps };
}

describe("addLocalConnector", () => {
  it("validates the checkout as a run would and saves an absolute path", async () => {
    const { config, calls, deps } = makeDeps();
    const result = await addLocalConnector(
      "Slack_Browser",
      "./relative/repo",
      {},
      deps,
    );
    const expectedPath = path.resolve("./relative/repo");
    expect(calls).toEqual([`${expectedPath}:slack_browser`]);
    expect(result).toEqual({
      key: "slack_browser",
      replaced: false,
      conflicts: [],
      entry: {
        path: expectedPath,
        addedAt: "2026-09-28T12:00:00.000Z",
        displayName: "Slack",
        version: "0.3.0",
        gitHead: "a".repeat(40),
        humanInteraction: ["manual_action"],
      },
    });
    expect(config.localConnectors).toEqual({
      slack_browser: result.entry,
    });
  });

  it("leaves gitHead out when the directory is not a repository", async () => {
    const { deps } = makeDeps();
    const result = await addLocalConnector("slack", "/abs/plain", {}, deps);
    expect(result.entry.gitHead).toBeUndefined();
  });

  it("keeps other entries and reports a replacement", async () => {
    const { config, deps } = makeDeps({
      localConnectors: {
        other: {
          path: "/abs/other",
          addedAt: "t",
          displayName: "Other",
          version: "1",
        },
        slack: { path: "/old", addedAt: "t", displayName: "Old", version: "0" },
      },
    });
    const result = await addLocalConnector("slack", "/abs/new", {}, deps);
    expect(result.replaced).toBe(true);
    expect(Object.keys(config.localConnectors ?? {})).toEqual([
      "other",
      "slack",
    ]);
    expect(config.localConnectors?.slack.path).toBe("/abs/new");
  });

  it("refuses a pinned key without --force, before touching the checkout", async () => {
    const { calls, deps } = makeDeps();
    await expect(
      addLocalConnector("whoop", "/abs/repo", {}, deps),
    ).rejects.toThrow(LocalConnectorConflictError);
    await expect(
      addLocalConnector("whoop", "/abs/repo", {}, deps),
    ).rejects.toThrow(/state, browser profile and scope names/);
    expect(calls).toEqual([]);
  });

  it("refuses a legacy registry key without --force", async () => {
    const { deps } = makeDeps();
    await expect(
      addLocalConnector(
        "github",
        "/abs/repo",
        { catalogIds: ["GitHub"] },
        deps,
      ),
    ).rejects.toMatchObject({ key: "github", conflicts: ["legacy"] });
  });

  it("registers over a conflict with --force and says which it overrode", async () => {
    const { deps } = makeDeps();
    const result = await addLocalConnector(
      "whoop",
      "/abs/repo",
      { force: true, catalogIds: ["whoop"] },
      deps,
    );
    expect(result.conflicts).toEqual(["pinned", "legacy"]);
  });

  it("propagates the checkout's own validation error", async () => {
    const { deps } = makeDeps();
    deps.resolveLocalLaunch = async () => {
      throw new Error("tsx is not installed in /abs/repo.");
    };
    await expect(
      addLocalConnector("slack", "/abs/repo", {}, deps),
    ).rejects.toThrow(/tsx is not installed/);
  });
});

describe("removeLocalConnector", () => {
  it("drops one entry and reports whether it existed", async () => {
    const { config, deps } = makeDeps({
      localConnectors: {
        slack: { path: "/abs", addedAt: "t", displayName: "S", version: "0" },
        other: { path: "/abs", addedAt: "t", displayName: "O", version: "0" },
      },
    });
    await expect(removeLocalConnector("Slack", deps)).resolves.toBe(true);
    expect(Object.keys(config.localConnectors ?? {})).toEqual(["other"]);
    await expect(removeLocalConnector("slack", deps)).resolves.toBe(false);
  });
});

describe("resolvePdppSource", () => {
  const entry = {
    path: "/abs/repo",
    addedAt: "t",
    displayName: "WHOOP dev",
    version: "0",
  };

  it("prefers --from, then the saved entry, then the pin", async () => {
    const { deps } = makeDeps({ localConnectors: { whoop: entry } });
    await expect(
      resolvePdppSource("whoop", { from: "./elsewhere" }, deps),
    ).resolves.toEqual({ kind: "from", path: path.resolve("./elsewhere") });
    await expect(resolvePdppSource("WHOOP", {}, deps)).resolves.toEqual({
      kind: "local",
      path: "/abs/repo",
      entry,
    });
    await expect(
      resolvePdppSource("whoop", {}, makeDeps().deps),
    ).resolves.toMatchObject({ kind: "pinned", pin: { id: "whoop" } });
  });

  it("is null for a source nobody provides", async () => {
    await expect(
      resolvePdppSource("github", {}, makeDeps().deps),
    ).resolves.toBeNull();
  });
});
