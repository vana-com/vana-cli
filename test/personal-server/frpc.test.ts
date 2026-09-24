import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import * as tar from "tar";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  FRPC_ARTIFACTS,
  FRPC_VERSION,
  installFrpc,
  resolveFrpc,
  VANA_APPLE_TEAM_ID,
} from "../../src/personal-server/local/frpc.js";

describe("resolveFrpc", () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "vana-frpc-"));
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  const base = () => ({
    env: {},
    platform: "linux" as NodeJS.Platform,
    arch: "x64",
    managedDir: path.join(dir, "managed"),
    desktopPaths: [] as string[],
    signedByTeam: vi.fn(async () => false),
  });

  it("uses VANA_FRPC_PATH when it names a file", async () => {
    const file = path.join(dir, "frpc");
    fs.writeFileSync(file, "");
    expect(
      await resolveFrpc({ ...base(), env: { VANA_FRPC_PATH: file } }),
    ).toEqual({ kind: "ready", path: file, source: "env" });
    expect(
      await resolveFrpc({
        ...base(),
        env: { VANA_FRPC_PATH: path.join(dir, "missing") },
      }),
    ).toMatchObject({ kind: "unavailable" });
  });

  it("trusts its own install only when the marker matches the pinned hash", async () => {
    const deps = base();
    fs.mkdirSync(deps.managedDir);
    fs.writeFileSync(path.join(deps.managedDir, "frpc"), "");
    fs.writeFileSync(path.join(deps.managedDir, ".installed"), "stale\n");
    expect(await resolveFrpc(deps)).toEqual({ kind: "installable" });

    fs.writeFileSync(
      path.join(deps.managedDir, ".installed"),
      `${FRPC_ARTIFACTS["linux-x64"].sha256}\n`,
    );
    expect(await resolveFrpc(deps)).toMatchObject({
      kind: "ready",
      source: "managed",
    });
  });

  it("on a Mac, runs Desktop's copy only when Vana signed it", async () => {
    const desktop = path.join(dir, "Vana.app-frpc");
    fs.writeFileSync(desktop, "");
    const deps = { ...base(), platform: "darwin" as const, arch: "arm64" };

    expect(await resolveFrpc({ ...deps, desktopPaths: [desktop] })).toEqual({
      kind: "unavailable",
      reason: expect.stringContaining("signed by Vana"),
    });

    const signedByTeam = vi.fn(async () => true);
    expect(
      await resolveFrpc({ ...deps, desktopPaths: [desktop], signedByTeam }),
    ).toEqual({ kind: "ready", path: desktop, source: "desktop" });
    expect(signedByTeam).toHaveBeenCalledWith(desktop, VANA_APPLE_TEAM_ID);
  });

  it("never offers the ad-hoc upstream download on a Mac", () => {
    expect(
      Object.keys(FRPC_ARTIFACTS).some((key) => key.startsWith("darwin")),
    ).toBe(false);
  });
});

describe("installFrpc", () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "vana-frpc-install-"));
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  async function archive(): Promise<Buffer> {
    const root = path.join(dir, "src");
    const inner = `frp_${FRPC_VERSION}_linux_amd64`;
    fs.mkdirSync(path.join(root, inner), { recursive: true });
    fs.writeFileSync(path.join(root, inner, "frpc"), "#!/bin/sh\n");
    const file = path.join(dir, "frp.tar.gz");
    await tar.c({ gzip: true, file, cwd: root }, [inner]);
    return fs.readFileSync(file);
  }

  it("refuses a download whose checksum does not match, and installs nothing", async () => {
    const body = await archive();
    const managedDir = path.join(dir, "managed");
    await expect(
      installFrpc(path.join(dir, "log"), {
        platform: "linux",
        arch: "x64",
        managedDir,
        fetchImpl: (async () => new Response(body)) as typeof fetch,
      }),
    ).rejects.toThrow(/checksum/);
    expect(fs.existsSync(managedDir)).toBe(false);
  });

  it("installs a download that matches the pin, with its marker", async () => {
    const body = await archive();
    const managedDir = path.join(dir, "managed");
    const sha256 = crypto.createHash("sha256").update(body).digest("hex");
    const pinned = FRPC_ARTIFACTS["linux-x64"];
    const original = pinned.sha256;
    pinned.sha256 = sha256;
    try {
      const installed = await installFrpc(path.join(dir, "log"), {
        platform: "linux",
        arch: "x64",
        managedDir,
        fetchImpl: (async () => new Response(body)) as typeof fetch,
      });
      expect(installed).toBe(path.join(managedDir, "frpc"));
      expect(fs.statSync(installed).mode & 0o111).not.toBe(0);
      expect(
        fs.readFileSync(path.join(managedDir, ".installed"), "utf8").trim(),
      ).toBe(sha256);
    } finally {
      pinned.sha256 = original;
    }
  });
});
