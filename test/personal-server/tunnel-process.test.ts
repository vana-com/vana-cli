import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  findTunnelClients,
  isTunnelClientFor,
  stopTunnelClients,
  tunnelConfigPath,
  type TunnelProcessDeps,
} from "../../src/personal-server/local/tunnel-process.js";

const DIR = "/home/u/.vana/cli/personal-server/mainnet/0xabc";
const CONFIG = `${DIR}/tunnel/frpc.toml`;
const DESKTOP_FRPC =
  "/Applications/Vana.app/Contents/Resources/personal-server/dist/frpc";

describe("isTunnelClientFor", () => {
  it("matches an frpc on this data dir's config only", () => {
    expect(isTunnelClientFor(`${DESKTOP_FRPC} -c ${CONFIG}`, CONFIG)).toBe(
      true,
    );
    expect(
      isTunnelClientFor(`/x/frpc.exe -c ${CONFIG} --log debug`, CONFIG),
    ).toBe(true);
    // Another account's dir, and a longer path sharing the prefix.
    expect(
      isTunnelClientFor(
        `${DESKTOP_FRPC} -c /home/u/.vana/cli/personal-server/mainnet/0xdef/tunnel/frpc.toml`,
        CONFIG,
      ),
    ).toBe(false);
    expect(isTunnelClientFor(`${DESKTOP_FRPC} -c ${CONFIG}.bak`, CONFIG)).toBe(
      false,
    );
    // Something else that merely mentions the config.
    expect(isTunnelClientFor(`/usr/bin/less -c ${CONFIG}`, CONFIG)).toBe(false);
    expect(isTunnelClientFor(`vim ${CONFIG}`, CONFIG)).toBe(false);
  });
});

function fakeProcesses(
  entries: Array<{ pid: number; command: string }>,
  options: { ignoresTerm?: number[] } = {},
) {
  const alive = new Set(entries.map((entry) => entry.pid));
  const signals: Array<[number, string]> = [];
  const deps: TunnelProcessDeps = {
    listProcesses: vi.fn(async () =>
      entries.filter((entry) => alive.has(entry.pid)),
    ),
    kill: vi.fn((pid: number, signal: NodeJS.Signals) => {
      signals.push([pid, signal]);
      if (signal === "SIGKILL" || !options.ignoresTerm?.includes(pid)) {
        alive.delete(pid);
      }
    }),
    isRunning: (pid) => alive.has(pid),
    sleep: vi.fn(async () => {}),
  };
  return { deps, signals, alive };
}

describe("stopTunnelClients", () => {
  it("stops this dir's frpc and leaves every other process alone", async () => {
    const { deps, signals, alive } = fakeProcesses([
      { pid: 10, command: `${DESKTOP_FRPC} -c ${CONFIG}` },
      {
        pid: 11,
        command: `${DESKTOP_FRPC} -c /Users/u/Library/Application Support/Vana/tunnel/frpc.toml`,
      },
      { pid: 12, command: "node entry.mjs" },
    ]);
    expect(await stopTunnelClients(DIR, deps)).toEqual([10]);
    expect(signals).toEqual([[10, "SIGTERM"]]);
    expect([...alive].sort()).toEqual([11, 12]);
  });

  it("kills an frpc that ignores SIGTERM", async () => {
    const { deps, signals } = fakeProcesses(
      [{ pid: 10, command: `${DESKTOP_FRPC} -c ${CONFIG}` }],
      { ignoresTerm: [10] },
    );
    expect(await stopTunnelClients(DIR, deps, 0)).toEqual([10]);
    expect(signals).toEqual([
      [10, "SIGTERM"],
      [10, "SIGKILL"],
    ]);
  });

  it("does nothing when no frpc runs", async () => {
    const { deps, signals } = fakeProcesses([]);
    expect(await stopTunnelClients(DIR, deps)).toEqual([]);
    expect(signals).toEqual([]);
  });
});

describe.skipIf(process.platform === "win32")("with real processes", () => {
  let root: string;
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "vana-tunnel-"));
  });
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  it("finds and stops an orphaned frpc on this data dir", async () => {
    // Stands in for frpc: a script named frpc that runs until signalled.
    const bin = path.join(root, "bin");
    fs.mkdirSync(bin);
    const fakeFrpc = path.join(bin, "frpc");
    fs.writeFileSync(fakeFrpc, "setInterval(() => {}, 1000);\n");
    const dataDir = path.join(root, "data");
    const child = spawn(
      process.execPath,
      [fakeFrpc, "-c", tunnelConfigPath(dataDir)],
      { stdio: "ignore", detached: true },
    );
    child.unref();
    const exited = new Promise((resolve) => child.once("exit", resolve));
    try {
      await vi.waitFor(async () =>
        expect(await findTunnelClients(dataDir)).toEqual([child.pid]),
      );
      expect(await findTunnelClients(path.join(root, "other"))).toEqual([]);
      expect(await stopTunnelClients(dataDir)).toEqual([child.pid]);
      await exited;
      expect(await findTunnelClients(dataDir)).toEqual([]);
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill();
    }
  });
});
