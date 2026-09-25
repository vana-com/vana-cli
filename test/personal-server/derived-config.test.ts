import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import {
  applyDerived,
  derivedConfig,
  // @ts-expect-error - plain ESM module shipped to the server process
} from "../../src/personal-server/local/runtime-pkg/derived-config.mjs";
import { ensureRuntime } from "../../src/personal-server/local/runtime.js";

const NETWORK = {
  gatewayUrl: "https://dp-rpc-dev.vana.org/",
  chainId: 14800,
  contracts: {},
  storageApiUrl: "https://storage-dev.vana.org",
};

const TUNNEL = {
  binaryPath: "/bin/frpc",
  serverAddr: "proxy.server-dev.vana.org",
  serverPort: 7000,
};

describe("derivedConfig", () => {
  it("charges builder reads, public or local", () => {
    expect(derivedConfig(NETWORK, TUNNEL).payment).toEqual({ enabled: true });
    expect(derivedConfig(NETWORK, null).payment).toEqual({ enabled: true });
  });

  it("turns payment on for a server.json written before it was derived", () => {
    const persisted = {
      payment: { enabled: false },
      server: { origin: "https://example.test" },
    };
    const next = applyDerived(persisted, derivedConfig(NETWORK, TUNNEL));
    expect(next.payment).toEqual({ enabled: true });
    expect(next.server).toEqual({ origin: "https://example.test" });
  });
});

describe("ensureRuntime", () => {
  let dir: string | null = null;

  afterEach(() => {
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
    dir = null;
  });

  it("refreshes every script on an existing install, not only the entry", async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "vana-runtime-"));
    const assets = fileURLToPath(
      new URL("../../src/personal-server/local/runtime-pkg/", import.meta.url),
    );
    const hash = crypto
      .createHash("sha256")
      .update(fs.readFileSync(path.join(assets, "package-lock.json")))
      .digest("hex");
    fs.writeFileSync(path.join(dir, ".installed"), `${hash}\n`);
    fs.mkdirSync(
      path.join(dir, "node_modules", "@opendatalabs", "personal-server-ts"),
      { recursive: true },
    );

    await ensureRuntime(
      { path: process.execPath } as Parameters<typeof ensureRuntime>[0],
      path.join(dir, "install.log"),
      dir,
    );

    for (const file of ["entry.mjs", "derived-config.mjs"]) {
      expect(fs.readFileSync(path.join(dir, file), "utf8")).toBe(
        fs.readFileSync(path.join(assets, file), "utf8"),
      );
    }
  });
});
