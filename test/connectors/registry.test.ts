import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  fetchConnectorToCache,
  listAvailableSources,
} from "../../src/connectors/registry.js";

let tempRoot: string;
let cacheDir: string;
let dataConnectorsDir: string;

const MOCK_SCRIPT = "module.exports = async (page) => { return { ok: true }; }";
const MOCK_REGISTRY = {
  connectors: [
    {
      id: "github-playwright",
      name: "GitHub",
      company: "github",
      version: "1.2.0",
      exportFrequency: "weekly",
      files: { script: "github/github-playwright.js" },
    },
  ],
};

describe("fetchConnectorToCache", () => {
  beforeEach(async () => {
    tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "vana-registry-test-"));
    cacheDir = path.join(tempRoot, "connectors");
    dataConnectorsDir = path.join(tempRoot, "data-connectors");
    await fs.mkdir(cacheDir, { recursive: true });
    await fs.mkdir(dataConnectorsDir, { recursive: true });

    // Write local registry and connector script
    await fs.writeFile(
      path.join(dataConnectorsDir, "registry.json"),
      JSON.stringify(MOCK_REGISTRY),
    );
    const scriptDir = path.join(dataConnectorsDir, "github");
    await fs.mkdir(scriptDir, { recursive: true });
    await fs.writeFile(
      path.join(scriptDir, "github-playwright.js"),
      MOCK_SCRIPT,
    );
  });

  afterEach(async () => {
    await fs.rm(tempRoot, { recursive: true, force: true });
  });

  it("downloads connector when no currentVersion is provided", async () => {
    const result = await fetchConnectorToCache(
      "github",
      cacheDir,
      dataConnectorsDir,
    );
    expect(result.version).toBe("1.2.0");
    expect(result.updated).toBe(true);
    expect(result.previousVersion).toBeUndefined();
    // Script should exist on disk
    const content = await fs.readFile(result.connectorPath, "utf8");
    expect(content).toBe(MOCK_SCRIPT);
  });

  it("skips download when currentVersion matches registry version", async () => {
    // First fetch to populate cache
    const first = await fetchConnectorToCache(
      "github",
      cacheDir,
      dataConnectorsDir,
    );
    expect(first.updated).toBe(true);

    // Second fetch with matching version
    const second = await fetchConnectorToCache(
      "github",
      cacheDir,
      dataConnectorsDir,
      "1.2.0",
    );
    expect(second.updated).toBe(false);
    expect(second.version).toBe("1.2.0");
    expect(second.connectorPath).toBe(first.connectorPath);
  });

  it("downloads when currentVersion differs from registry version", async () => {
    // First fetch to populate cache
    await fetchConnectorToCache("github", cacheDir, dataConnectorsDir);

    // Second fetch with outdated version
    const result = await fetchConnectorToCache(
      "github",
      cacheDir,
      dataConnectorsDir,
      "1.1.0",
    );
    expect(result.updated).toBe(true);
    expect(result.previousVersion).toBe("1.1.0");
    expect(result.version).toBe("1.2.0");
  });

  it("re-downloads when cached file is missing despite version match", async () => {
    // Fetch, then delete the cached file
    const first = await fetchConnectorToCache(
      "github",
      cacheDir,
      dataConnectorsDir,
    );
    await fs.rm(first.connectorPath);

    // Should re-download even though version matches
    const second = await fetchConnectorToCache(
      "github",
      cacheDir,
      dataConnectorsDir,
      "1.2.0",
    );
    expect(second.updated).toBe(true);
    const content = await fs.readFile(second.connectorPath, "utf8");
    expect(content).toBe(MOCK_SCRIPT);
  });

  it("falls back to cache when registry is unreachable", async () => {
    // First fetch to populate cache
    const first = await fetchConnectorToCache(
      "github",
      cacheDir,
      dataConnectorsDir,
    );

    // Remove the local registry so it's "unreachable"
    await fs.rm(path.join(dataConnectorsDir, "registry.json"));

    // Without dataConnectorsDir, it would try remote (which would fail in test).
    // But the offline fallback uses findCachedConnectorScript, so we need
    // to use no dataConnectorsDir and stub fetch to fail.
    const originalFetch = globalThis.fetch;
    globalThis.fetch = () => {
      throw new Error("Network unreachable");
    };
    try {
      const result = await fetchConnectorToCache(
        "github",
        cacheDir,
        undefined,
        "1.2.0",
      );
      expect(result.updated).toBe(false);
      expect(result.version).toBe("1.2.0");
      expect(result.connectorPath).toBe(first.connectorPath);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("throws when registry is unreachable and no cache exists", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = () => {
      throw new Error("Network unreachable");
    };
    try {
      await expect(fetchConnectorToCache("github", cacheDir)).rejects.toThrow(
        "Network unreachable",
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("throws when registry is unreachable and no currentVersion", async () => {
    // Even with cached file, if no currentVersion we can't return it safely
    await fetchConnectorToCache("github", cacheDir, dataConnectorsDir);

    const originalFetch = globalThis.fetch;
    globalThis.fetch = () => {
      throw new Error("Network unreachable");
    };
    try {
      await expect(fetchConnectorToCache("github", cacheDir)).rejects.toThrow(
        "Network unreachable",
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("verifies checksum on fresh downloads", async () => {
    const registryWithChecksum = {
      connectors: [
        {
          ...MOCK_REGISTRY.connectors[0],
          checksums: { script: "sha256:badhash" },
        },
      ],
    };
    await fs.writeFile(
      path.join(dataConnectorsDir, "registry.json"),
      JSON.stringify(registryWithChecksum),
    );

    await expect(
      fetchConnectorToCache("github", cacheDir, dataConnectorsDir),
    ).rejects.toThrow("Checksum mismatch");
  });
});

describe("listAvailableSources", () => {
  beforeEach(async () => {
    tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "vana-registry-test-"));
    dataConnectorsDir = path.join(tempRoot, "data-connectors");
    await fs.mkdir(dataConnectorsDir, { recursive: true });
    await fs.writeFile(
      path.join(dataConnectorsDir, "registry.json"),
      JSON.stringify(MOCK_REGISTRY),
    );
  });

  afterEach(async () => {
    await fs.rm(tempRoot, { recursive: true, force: true });
  });

  const entry = {
    path: "/abs/data-connectors",
    addedAt: "2026-09-28T00:00:00.000Z",
    displayName: "Slack",
    version: "0.2.0",
  };

  it("lists a saved local connector as a Collection Profile", async () => {
    const sources = await listAvailableSources(dataConnectorsDir, {
      readLocalConnectors: async () => ({
        slack_browser: { ...entry, humanInteraction: ["manual_action"] },
      }),
    });
    expect(sources.map((source) => source.id).sort()).toEqual([
      "github",
      "slack_browser",
      "whoop",
    ]);
    expect(sources.find((source) => source.id === "slack_browser")).toEqual({
      id: "slack_browser",
      name: "Slack",
      description: "Runs from /abs/data-connectors",
      version: "0.2.0",
      authMode: "legacy",
      runtime: "pdpp",
      origin: "local",
      localPath: "/abs/data-connectors",
    });
    expect(sources.find((source) => source.id === "github")).toMatchObject({
      runtime: "legacy",
    });
  });

  it("does not call a local connector legacy without a manual step", async () => {
    const sources = await listAvailableSources(dataConnectorsDir, {
      readLocalConnectors: async () => ({
        slack_browser: { ...entry, humanInteraction: ["input_request"] },
      }),
    });
    expect(
      sources.find((source) => source.id === "slack_browser"),
    ).toMatchObject({ authMode: "automated", origin: "local" });
  });

  it("lets a local connector override a legacy or pinned one with its id", async () => {
    const sources = await listAvailableSources(dataConnectorsDir, {
      readLocalConnectors: async () => ({
        github: { ...entry, displayName: "GitHub (dev)" },
        whoop: { ...entry, displayName: "WHOOP (dev)" },
      }),
    });
    expect(sources).toHaveLength(2);
    expect(sources.find((source) => source.id === "github")).toMatchObject({
      name: "GitHub (dev)",
      runtime: "pdpp",
      origin: "local",
    });
    expect(sources.find((source) => source.id === "whoop")).toMatchObject({
      name: "WHOOP (dev)",
      runtime: "pdpp",
      origin: "local",
    });
  });

  it("keeps the catalog when the saved entries cannot be read", async () => {
    const sources = await listAvailableSources(dataConnectorsDir, {
      readLocalConnectors: async () => {
        throw new Error("corrupt state file");
      },
    });
    expect(sources.map((source) => source.id).sort()).toEqual([
      "github",
      "whoop",
    ]);
  });
});
