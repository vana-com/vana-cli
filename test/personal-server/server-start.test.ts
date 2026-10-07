import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  runServerStart,
  type ServerStartDeps,
} from "../../src/cli/server-start.js";
import type { VanaCredentials } from "../../src/cli/auth.js";
import {
  resolveServerDataDir,
  serverPidIn,
} from "../../src/personal-server/local/data-dir.js";
import {
  acquireDataDirLock,
  choosePort,
  type LocalServerHandle,
  type ServerMessage,
} from "../../src/personal-server/local/server.js";

const OWNER = "0x99Bf14e94DE7edB022E08528C5Cdb627f73A988d";
const OTHER = "0xbffbd3316ef8c6d8b8046151228c09840ae08d48";

function credentials(
  overrides: Partial<VanaCredentials["account"]> = {},
): VanaCredentials {
  return {
    account: {
      address: OWNER,
      session_token: "token",
      expires_at: "2999-01-01T00:00:00.000Z",
      ...overrides,
    },
    personal_server: null,
  };
}

const PUBLIC_URL = "https://0xserver.server-dev.vana.org";
const DATA_DIR = `/ps/moksha/${OWNER.toLowerCase()}`;

/**
 * A running server that says whether it is registered once someone listens,
 * and answers the registration commands the way entry.mjs does.
 */
function fakeServer(options: { registered?: boolean } = {}) {
  const listeners = new Set<(message: ServerMessage) => void>();
  const sent: Array<Record<string, unknown>> = [];
  const emit = (message: ServerMessage) => {
    for (const listener of [...listeners]) listener(message);
  };
  let announced = false;
  const handle: LocalServerHandle = {
    url: "http://localhost:8080",
    port: 8080,
    accessToken: "ps_token",
    exited: new Promise<number | null>(() => {}),
    send: (command) => {
      sent.push(command);
      queueMicrotask(() => {
        if (command.type === "prepare-registration") {
          emit({
            type: "registration-request",
            request: {
              typedData: {
                domain: { chainId: 14800 },
                message: {
                  serverAddress: "0xserver",
                  publicKey: "0x04",
                  serverUrl: PUBLIC_URL,
                },
              },
            },
          });
        }
        if (command.type === "submit-registration") {
          emit({ type: "registration-submitted", serverId: "42" });
          emit({ type: "tunnel", status: "connected", url: PUBLIC_URL });
        }
      });
    },
    onMessage: (listener) => {
      listeners.add(listener);
      if (!announced) {
        announced = true;
        queueMicrotask(() =>
          emit({
            type: "public",
            registered: Boolean(options.registered),
            serverAddress: "0xserver",
            serverUrl: PUBLIC_URL,
          }),
        );
      }
      return () => void listeners.delete(listener);
    },
    stop: vi.fn(async () => {}),
  };
  return { handle, sent };
}

function harness(overrides: Partial<ServerStartDeps> = {}) {
  const said: string[] = [];
  const events: Array<Record<string, unknown>> = [];
  const store = new Map<string, unknown>();
  const deps: ServerStartDeps = {
    findRunningServers: vi.fn(async () => []),
    loadCredentials: vi.fn(() => credentials()),
    saveCredentials: vi.fn(async () => {}),
    secrets: {
      get: (key) => (store.get(key) as never) ?? null,
      set: (key, value) => void store.set(key, value),
      delete: (key) => void store.delete(key),
    },
    exchange: vi.fn(async () => ({
      signature: "0xsig",
      signerAddress: OWNER,
      trustToken: "trust",
    })),
    openBrowser: vi.fn(),
    findNode: vi.fn(async () => ({ path: "/node", version: "24.21.0" })),
    installNode: vi.fn(async () => ({
      path: "/managed/node",
      version: "24.21.0",
    })),
    runtimeInstalled: vi.fn(() => true),
    ensureRuntime: vi.fn(async () => "/runtime"),
    choosePort: vi.fn(async () => 8080),
    start: vi.fn(async () => fakeServer().handle),
    resolveFrpc: vi.fn(async () => ({
      kind: "ready" as const,
      path: "/frpc",
      source: "managed" as const,
    })),
    installFrpc: vi.fn(async () => "/installed/frpc"),
    signRegistration: vi.fn(async () => ({
      signature: "0xreg",
      signerAddress: OWNER,
      via: "silent" as const,
    })),
    readPublicMarker: vi.fn(() => null),
    writePublicMarker: vi.fn(async () => {}),
    resolveDataDir: vi.fn(async () => ({
      kind: "ready" as const,
      dir: DATA_DIR,
    })),
    serverPidIn: vi.fn(() => null),
    startDetached: vi.fn(
      async (input: { onEvent?: (e: Record<string, unknown>) => void }) => {
        const events = [
          {
            type: "server-ready",
            url: "http://localhost:8080",
            owner: OWNER,
            network: "moksha",
            registered: true,
            publicUrl: PUBLIC_URL,
          },
          { type: "server-tunnel", status: "connected", url: PUBLIC_URL },
        ];
        for (const event of events) input.onEvent?.(event);
        return { events, ready: true, pid: 4242, logPath: "/log" };
      },
    ),
    runningServerCharges: vi.fn(() => null),
    // Ctrl+C right after the server is up, unless a test says otherwise.
    stopRequested: vi.fn(async () => {}),
    lockDataDir: vi.fn(async () => async () => {}),
    sleep: vi.fn(async () => {}),
    now: vi.fn(() => Date.now()),
    ...overrides,
  };
  const io = {
    say: (line: string) => void said.push(line),
    event: (event: Record<string, unknown>) => void events.push(event),
    confirm: vi.fn(async () => true),
  };
  return { deps, io, said, events, store };
}

describe("runServerStart", () => {
  const originalAccountUrl = process.env.VANA_ACCOUNT_URL;
  beforeEach(() => {
    process.env.VANA_ACCOUNT_URL = "https://account-dev.vana.org";
  });
  afterEach(() => {
    if (originalAccountUrl === undefined) delete process.env.VANA_ACCOUNT_URL;
    else process.env.VANA_ACCOUNT_URL = originalAccountUrl;
  });

  it("uses the server already running for this owner and starts nothing", async () => {
    const h = harness({
      findRunningServers: vi.fn(async () => [
        {
          url: "http://localhost:8080",
          owner: "0xbffbd3316ef8c6d8b8046151228c09840ae08d48",
        },
        { url: "http://localhost:8082", owner: OWNER.toLowerCase() },
      ]),
    });
    expect(await runServerStart({ network: "moksha" }, h.io, h.deps)).toBe(0);
    expect(h.deps.start).not.toHaveBeenCalled();
    expect(h.events[0]).toMatchObject({
      type: "server-already-running",
      url: "http://localhost:8082",
    });
  });

  it("tells the owner to restart a running server that serves reads for free", async () => {
    const h = harness({
      findRunningServers: vi.fn(async () => [
        { url: "http://localhost:8080", owner: OWNER, identity: "0xkey" },
      ]),
      runningServerCharges: vi.fn(() => false),
    });
    expect(await runServerStart({ network: "moksha" }, h.io, h.deps)).toBe(0);
    expect(h.deps.start).not.toHaveBeenCalled();
    expect(h.deps.runningServerCharges).toHaveBeenCalledWith("moksha", "0xkey");
    expect(h.said.join("\n")).toContain(
      "vana server stop, then vana server start",
    );
    expect(h.events[0]).toMatchObject({
      type: "server-already-running",
      restartRequired: true,
    });
  });

  it("says nothing more when the running server already charges", async () => {
    const h = harness({
      findRunningServers: vi.fn(async () => [
        { url: "http://localhost:8080", owner: OWNER },
      ]),
      runningServerCharges: vi.fn(() => true),
    });
    expect(await runServerStart({ network: "moksha" }, h.io, h.deps)).toBe(0);
    expect(h.said.join("\n")).not.toContain("vana server stop");
    expect(h.events[0]).not.toHaveProperty("restartRequired");
  });

  it("starts beside another identity's server and says so", async () => {
    const h = harness({
      findRunningServers: vi.fn(async () => [
        { url: "http://localhost:8080", owner: OTHER },
      ]),
    });
    expect(await runServerStart({ network: "moksha" }, h.io, h.deps)).toBe(0);
    expect(h.deps.start).toHaveBeenCalled();
    expect(h.said.join("\n")).toContain(
      `http://localhost:8080 runs a Personal Server for ${OTHER}; yours will use another port.`,
    );
  });

  it("asks for a login when the session expired", async () => {
    const h = harness({
      loadCredentials: vi.fn(() =>
        credentials({ expires_at: "2020-01-01T00:00:00.000Z" }),
      ),
    });
    expect(await runServerStart({ network: "moksha" }, h.io, h.deps)).toBe(7);
    expect(h.deps.exchange).not.toHaveBeenCalled();
  });

  it("does not open a browser under --no-input", async () => {
    const h = harness();
    expect(
      await runServerStart({ network: "moksha", noInput: true }, h.io, h.deps),
    ).toBe(7);
    expect(h.deps.exchange).not.toHaveBeenCalled();
    expect(h.events[0]).toMatchObject({
      type: "server-needs-owner-confirmation",
    });
  });

  it("confirms ownership once, keeps it, and reuses it next time", async () => {
    const h = harness();
    expect(await runServerStart({ network: "moksha" }, h.io, h.deps)).toBe(0);
    expect(h.deps.exchange).toHaveBeenCalledTimes(1);
    expect(
      h.store.get(`account-dev.vana.org:${OWNER.toLowerCase()}`),
    ).toMatchObject({ signature: "0xsig" });

    expect(await runServerStart({ network: "moksha" }, h.io, h.deps)).toBe(0);
    expect(h.deps.exchange).toHaveBeenCalledTimes(1);
  });

  it("refuses a confirmation signed by someone else and saves nothing", async () => {
    const h = harness({
      exchange: vi.fn(async () => ({
        signature: "0xsig",
        signerAddress: OTHER,
        trustToken: null,
      })),
    });
    expect(await runServerStart({ network: "moksha" }, h.io, h.deps)).toBe(1);
    expect(h.store.size).toBe(0);
    expect(h.deps.start).not.toHaveBeenCalled();
  });

  it("stops at one-time setup under --no-input", async () => {
    const h = harness({
      findNode: vi.fn(async () => null),
      runtimeInstalled: vi.fn(() => false),
    });
    h.store.set(`account-dev.vana.org:${OWNER.toLowerCase()}`, {
      signature: "0xsig",
      signerAddress: OWNER,
      trustToken: null,
    });
    expect(
      await runServerStart({ network: "moksha", noInput: true }, h.io, h.deps),
    ).toBe(6);
    expect(h.events[0]).toMatchObject({ type: "server-setup-required" });
    expect(h.deps.installNode).not.toHaveBeenCalled();
  });

  it("starts the server, hands its token to vana connect, and stops on Ctrl+C", async () => {
    const h = harness();
    expect(
      await runServerStart({ network: "moksha", local: true }, h.io, h.deps),
    ).toBe(0);
    expect(h.deps.start).toHaveBeenCalledWith(
      expect.objectContaining({
        network: "moksha",
        port: 8080,
        runtimeDir: "/runtime",
      }),
    );
    expect(h.deps.saveCredentials).toHaveBeenCalledWith(
      expect.objectContaining({
        account: expect.objectContaining({ session_token: "token" }),
        personal_server: expect.objectContaining({
          url: "http://localhost:8080",
          session_token: "ps_token",
        }),
      }),
    );
    expect(h.events.map((event) => event.type)).toEqual([
      "server-ready",
      "server-stopped",
    ]);
    expect(h.events[0]).toMatchObject({ registered: false, owner: OWNER });
  });

  it("stays local and never looks for a tunnel client with --local", async () => {
    const h = harness();
    expect(
      await runServerStart({ network: "moksha", local: true }, h.io, h.deps),
    ).toBe(0);
    expect(h.deps.resolveFrpc).not.toHaveBeenCalled();
    expect(h.deps.start).toHaveBeenCalledWith(
      expect.objectContaining({ frpcPath: null }),
    );
  });

  it("starts local only when no tunnel client may run here", async () => {
    const h = harness({
      resolveFrpc: vi.fn(async () => ({
        kind: "unavailable" as const,
        reason: "No tunnel client signed by Vana is available on this Mac yet.",
      })),
    });
    expect(await runServerStart({ network: "moksha" }, h.io, h.deps)).toBe(0);
    expect(h.deps.start).toHaveBeenCalledWith(
      expect.objectContaining({ frpcPath: null }),
    );
    expect(h.deps.signRegistration).not.toHaveBeenCalled();
  });

  it("by default installs the tunnel client, registers, and remembers it", async () => {
    const server = fakeServer();
    const h = harness({
      resolveFrpc: vi.fn(async () => ({ kind: "installable" as const })),
      start: vi.fn(async () => server.handle),
    });
    expect(await runServerStart({ network: "moksha" }, h.io, h.deps)).toBe(0);
    expect(h.deps.installFrpc).toHaveBeenCalled();
    expect(h.deps.start).toHaveBeenCalledWith(
      expect.objectContaining({ frpcPath: "/installed/frpc" }),
    );
    expect(h.deps.signRegistration).toHaveBeenCalledWith(
      expect.objectContaining({
        trustToken: "trust",
        allowBrowser: true,
        accessToken: "token",
      }),
      expect.anything(),
    );
    expect(server.sent).toEqual([
      { type: "prepare-registration" },
      { type: "submit-registration", signature: "0xreg" },
    ]);
    expect(h.deps.writePublicMarker).toHaveBeenCalledWith(
      DATA_DIR,
      expect.objectContaining({
        serverAddress: "0xserver",
        serverUrl: PUBLIC_URL,
      }),
    );
    expect(
      h.events.find((event) => event.type === "server-ready"),
    ).toMatchObject({ registered: true, publicUrl: PUBLIC_URL });
  });

  it("submits nothing when the registration comes back signed by someone else", async () => {
    const server = fakeServer();
    const h = harness({
      start: vi.fn(async () => server.handle),
      signRegistration: vi.fn(async () => ({
        signature: "0xreg",
        signerAddress: OTHER,
        via: "silent" as const,
      })),
    });
    expect(await runServerStart({ network: "moksha" }, h.io, h.deps)).toBe(0);
    expect(server.sent).toEqual([{ type: "prepare-registration" }]);
    expect(h.deps.writePublicMarker).not.toHaveBeenCalled();
    expect(
      h.events.find((event) => event.type === "server-registration-failed"),
    ).toBeDefined();
    expect(
      h.events.find((event) => event.type === "server-ready"),
    ).toMatchObject({ registered: false, publicUrl: null });
  });

  it("brings a registered server back public without signing again", async () => {
    const server = fakeServer({ registered: true });
    const h = harness({
      start: vi.fn(async () => server.handle),
      readPublicMarker: vi.fn(() => ({
        serverAddress: "0xserver",
        serverUrl: PUBLIC_URL,
        registeredAt: "2026-09-24T00:00:00.000Z",
      })),
    });
    expect(await runServerStart({ network: "moksha" }, h.io, h.deps)).toBe(0);
    expect(h.deps.resolveFrpc).toHaveBeenCalled();
    expect(h.deps.signRegistration).not.toHaveBeenCalled();
    expect(server.sent).toEqual([]);
    expect(
      h.events.find((event) => event.type === "server-ready"),
    ).toMatchObject({ registered: true, publicUrl: PUBLIC_URL });
  });

  it("--detach confirms ownership here, then hands the server to the background", async () => {
    const h = harness();
    expect(
      await runServerStart({ network: "moksha", detach: true }, h.io, h.deps),
    ).toBe(0);
    expect(h.deps.exchange).toHaveBeenCalledTimes(1);
    expect(h.deps.start).not.toHaveBeenCalled();
    expect(h.deps.startDetached).toHaveBeenCalledWith(
      expect.objectContaining({ network: "moksha" }),
    );
    const said = h.said.join("\n");
    expect(said).toContain(`Reachable by apps at ${PUBLIC_URL}`);
    expect(said).toContain("vana server stop");
  });

  it("--detach reports a background server that did not come up", async () => {
    const h = harness({
      startDetached: vi.fn(async (input) => {
        const events = [{ type: "server-failed", logPath: "/x" }];
        for (const event of events) input.onEvent?.(event);
        return { events, ready: false, pid: 1, logPath: "/detached.log" };
      }),
    });
    expect(
      await runServerStart({ network: "moksha", detach: true }, h.io, h.deps),
    ).toBe(1);
    expect(h.said.join("\n")).toContain("/detached.log");
  });

  it("runs the owner's own data dir and keeps its registration marker there", async () => {
    const h = harness();
    expect(await runServerStart({ network: "moksha" }, h.io, h.deps)).toBe(0);
    expect(h.deps.resolveDataDir).toHaveBeenCalledWith("moksha", OWNER, []);
    expect(h.deps.readPublicMarker).toHaveBeenCalledWith(DATA_DIR);
    expect(h.deps.start).toHaveBeenCalledWith(
      expect.objectContaining({ dataDir: DATA_DIR }),
    );
  });

  it("refuses a server already running from this owner's dir before any browser", async () => {
    const h = harness({ serverPidIn: vi.fn(() => 9188) });
    expect(
      await runServerStart({ network: "moksha", detach: true }, h.io, h.deps),
    ).toBe(1);
    expect(h.deps.exchange).not.toHaveBeenCalled();
    expect(h.deps.openBrowser).not.toHaveBeenCalled();
    expect(h.deps.startDetached).not.toHaveBeenCalled();
    expect(h.events[0]).toMatchObject({
      type: "server-failed",
      reason: "already-running",
      pid: 9188,
      message: expect.stringContaining(
        `already running from ${DATA_DIR} (pid 9188)`,
      ),
    });
    expect(h.said.join("\n")).toContain("vana server stop");
  });

  it("refuses an older server nothing says the owner of, before any browser", async () => {
    const h = harness({
      resolveDataDir: vi.fn(async () => ({
        kind: "unknown-owner" as const,
        legacyDir: "/ps/moksha",
        dir: DATA_DIR,
      })),
    });
    expect(
      await runServerStart({ network: "moksha", detach: true }, h.io, h.deps),
    ).toBe(1);
    expect(h.deps.exchange).not.toHaveBeenCalled();
    expect(h.events[0]).toMatchObject({
      type: "server-failed",
      reason: "data-dir-owner-unknown",
      dataDir: "/ps/moksha",
    });
    expect(h.said.join("\n")).toContain(
      `Move its files into /ps/moksha/<owner address>/ (yours: ${DATA_DIR})`,
    );
  });

  it("says when it moved the owner's server out of the older layout", async () => {
    const h = harness({
      resolveDataDir: vi.fn(async () => ({
        kind: "ready" as const,
        dir: DATA_DIR,
        movedFrom: "/ps/moksha",
      })),
    });
    expect(await runServerStart({ network: "moksha" }, h.io, h.deps)).toBe(0);
    expect(h.events[0]).toMatchObject({
      type: "server-data-moved",
      from: "/ps/moksha",
      to: DATA_DIR,
    });
  });

  it("settles the data dir from the binding when the session names no address", async () => {
    const h = harness({
      loadCredentials: vi.fn(() => credentials({ address: "env" })),
    });
    h.store.set("account-dev.vana.org:env", {
      signature: "0xsig",
      signerAddress: OWNER,
      trustToken: null,
    });
    expect(
      await runServerStart({ network: "moksha", local: true }, h.io, h.deps),
    ).toBe(0);
    expect(h.deps.resolveDataDir).toHaveBeenCalledWith("moksha", OWNER, []);
  });

  it("hands the owner's data dir to the background server", async () => {
    const h = harness();
    expect(
      await runServerStart({ network: "moksha", detach: true }, h.io, h.deps),
    ).toBe(0);
    expect(h.deps.startDetached).toHaveBeenCalledWith(
      expect.objectContaining({ dataDir: DATA_DIR }),
    );
  });

  it("--detach tells why the background server failed, in words and in JSON", async () => {
    const message =
      "A Personal Server started by vana is already running from /ps (pid 9188).";
    const h = harness({
      startDetached: vi.fn(async (input) => {
        const events = [
          { type: "server-failed", message, logPath: "/nowhere.log" },
        ];
        for (const event of events) input.onEvent?.(event);
        return { events, ready: false, pid: 1, logPath: "/detached.log" };
      }),
    });
    expect(
      await runServerStart({ network: "moksha", detach: true }, h.io, h.deps),
    ).toBe(1);
    expect(h.said).toContain(message);
    expect(h.events).toContainEqual(
      expect.objectContaining({ type: "server-failed", message }),
    );
    // The log it named does not exist, so it points at one that does.
    expect(h.said.join("\n")).toContain("See /detached.log.");
  });

  it("writes why the server failed to the log it points at", async () => {
    const h = harness({
      start: vi.fn(async () => {
        throw new Error(
          "A Personal Server started by vana is already running from /ps (pid 9188).",
        );
      }),
    });
    expect(await runServerStart({ network: "moksha" }, h.io, h.deps)).toBe(1);
    const failed = h.events.find((event) => event.type === "server-failed");
    expect(failed).toMatchObject({
      message: expect.stringContaining("already running"),
    });
    expect(fs.readFileSync(String(failed?.logPath), "utf8")).toContain(
      "already running from /ps (pid 9188)",
    );
  });

  it("starts a second account beside the first one's running server, in its own dir", async () => {
    // The 0.38.3 report: A's server runs from the older per-network dir and
    // B signs in. B must get its own dir, never A's key or index.
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "vana-ps-two-"));
    const original = process.env.VANA_HOME;
    process.env.VANA_HOME = home;
    try {
      const legacy = path.join(home, "cli", "personal-server", "mainnet");
      const key = "0x86F0c856718414eE5A52AB23f3bA1fd150563BB3";
      fs.mkdirSync(legacy, { recursive: true });
      fs.writeFileSync(
        path.join(legacy, "key.json"),
        JSON.stringify({ address: key }),
      );
      fs.writeFileSync(
        path.join(legacy, ".vana-cli.lock"),
        JSON.stringify({ pid: process.pid }),
      );
      const h = harness({
        loadCredentials: vi.fn(() => credentials({ address: OTHER })),
        exchange: vi.fn(async () => ({
          signature: "0xsig",
          signerAddress: OTHER,
          trustToken: null,
        })),
        findRunningServers: vi.fn(async () => [
          { url: "http://localhost:8080", owner: OWNER, identity: key },
        ]),
        resolveDataDir: resolveServerDataDir,
        serverPidIn,
      });
      expect(
        await runServerStart(
          { network: "mainnet", detach: true },
          h.io,
          h.deps,
        ),
      ).toBe(0);
      expect(h.deps.exchange).toHaveBeenCalledTimes(1);
      expect(h.deps.startDetached).toHaveBeenCalledWith(
        expect.objectContaining({ dataDir: path.join(legacy, OTHER) }),
      );
      // A's server is untouched.
      expect(fs.existsSync(path.join(legacy, "key.json"))).toBe(true);
    } finally {
      if (original === undefined) delete process.env.VANA_HOME;
      else process.env.VANA_HOME = original;
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it("restarts a server that dies on its own, and stops it when asked", async () => {
    // The 0.38.6 report: kill -9 of entry.mjs took the supervisor down too.
    const first = crashingServer();
    const second = crashingServer();
    let stop: () => void = () => {};
    const h = harness({
      start: vi
        .fn()
        .mockResolvedValueOnce(first.handle)
        .mockResolvedValueOnce(second.handle),
      stopRequested: vi.fn(() => new Promise<void>((r) => (stop = r))),
      resolveFrpc: vi.fn(async () => ({
        kind: "unavailable" as const,
        reason: "No tunnel.",
      })),
    });
    const run = runServerStart({ network: "moksha" }, h.io, h.deps);
    await vi.waitFor(() => expect(h.deps.start).toHaveBeenCalledTimes(1));
    first.crash(137);
    await vi.waitFor(() =>
      expect(h.events.at(-1)).toMatchObject({ type: "server-restarted" }),
    );
    expect(h.events).toContainEqual(
      expect.objectContaining({
        type: "server-restarting",
        attempt: 1,
        delayMs: 1_000,
        exitCode: 137,
      }),
    );
    expect(h.deps.sleep).toHaveBeenCalledWith(1_000);
    // The new server's token goes where `vana connect` looks for it.
    expect(h.deps.saveCredentials).toHaveBeenCalledTimes(2);
    stop();
    expect(await run).toBe(0);
    expect(second.handle.stop).toHaveBeenCalled();
    expect(h.deps.start).toHaveBeenCalledTimes(2);
    expect(h.events.at(-1)).toMatchObject({ type: "server-stopped" });
  });

  it("never restarts after a stop that came during the wait", async () => {
    const first = crashingServer();
    let stop: () => void = () => {};
    const h = harness({
      start: vi.fn().mockResolvedValueOnce(first.handle),
      stopRequested: vi.fn(() => new Promise<void>((r) => (stop = r))),
      sleep: vi.fn(() => new Promise<void>(() => {})),
      resolveFrpc: vi.fn(async () => ({
        kind: "unavailable" as const,
        reason: "No tunnel.",
      })),
    });
    const run = runServerStart({ network: "moksha" }, h.io, h.deps);
    await vi.waitFor(() => expect(h.deps.start).toHaveBeenCalledTimes(1));
    first.crash(1);
    await vi.waitFor(() => expect(h.deps.sleep).toHaveBeenCalled());
    stop();
    expect(await run).toBe(0);
    expect(h.deps.start).toHaveBeenCalledTimes(1);
    expect(h.events.at(-1)).toMatchObject({ type: "server-stopped" });
  });

  it("backs off and gives up on a server that keeps crashing", async () => {
    const h = harness({
      start: vi
        .fn()
        .mockResolvedValueOnce(crashingServer({ crashAt: 1 }).handle)
        .mockRejectedValue(
          new Error("The Personal Server exited (code 1) before it was ready."),
        ),
      stopRequested: vi.fn(() => new Promise<void>(() => {})),
      resolveFrpc: vi.fn(async () => ({
        kind: "unavailable" as const,
        reason: "No tunnel.",
      })),
    });
    expect(await runServerStart({ network: "moksha" }, h.io, h.deps)).toBe(1);
    expect(vi.mocked(h.deps.sleep).mock.calls.map(([ms]) => ms)).toEqual([
      1_000, 2_000, 5_000, 10_000, 30_000,
    ]);
    expect(h.events.at(-1)).toMatchObject({
      type: "server-failed",
      reason: "restart-limit",
      restarts: 5,
    });
    expect(h.said.at(-1)).toContain("gave up after 5 restarts");
  });

  it("starts the count over after a server that ran a while", async () => {
    let clock = 0;
    const servers = [1, 2, 3].map(() => crashingServer());
    let stop: () => void = () => {};
    const h = harness({
      start: vi
        .fn()
        .mockResolvedValueOnce(servers[0].handle)
        .mockResolvedValueOnce(servers[1].handle)
        .mockResolvedValueOnce(servers[2].handle),
      now: vi.fn(() => clock),
      stopRequested: vi.fn(() => new Promise<void>((r) => (stop = r))),
      resolveFrpc: vi.fn(async () => ({
        kind: "unavailable" as const,
        reason: "No tunnel.",
      })),
    });
    const run = runServerStart({ network: "moksha" }, h.io, h.deps);
    await vi.waitFor(() => expect(h.deps.start).toHaveBeenCalledTimes(1));
    servers[0].crash(1);
    await vi.waitFor(() => expect(h.deps.start).toHaveBeenCalledTimes(2));
    clock += 10 * 60_000;
    servers[1].crash(1);
    await vi.waitFor(() => expect(h.deps.start).toHaveBeenCalledTimes(3));
    stop();
    expect(await run).toBe(0);
    const attempts = h.events
      .filter((event) => event.type === "server-restarting")
      .map((event) => event.attempt);
    expect(attempts).toEqual([1, 1]);
  });
});

/** A server whose process the test kills. */
function crashingServer(options: { crashAt?: number } = {}) {
  let crash: (code: number) => void = () => {};
  const exited = new Promise<number | null>((resolve) => (crash = resolve));
  if (options.crashAt !== undefined) {
    const code = options.crashAt;
    queueMicrotask(() => crash(code));
  }
  const { handle } = fakeServer();
  const crashing: LocalServerHandle = {
    ...handle,
    exited,
    stop: vi.fn(async () => {}),
  };
  return { handle: crashing, crash: (code: number) => crash(code) };
}

describe("acquireDataDirLock", () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "vana-ps-lock-"));
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it("refuses a dir another live process holds", async () => {
    fs.writeFileSync(
      path.join(dir, ".vana-cli.lock"),
      JSON.stringify({ pid: process.pid }),
    );
    await expect(acquireDataDirLock(dir)).rejects.toThrow(/already running/);
  });

  it("takes over a lock left by a dead process, and releases it", async () => {
    fs.writeFileSync(
      path.join(dir, ".vana-cli.lock"),
      JSON.stringify({ pid: 4_194_303 }),
    );
    const release = await acquireDataDirLock(dir);
    expect(
      JSON.parse(fs.readFileSync(path.join(dir, ".vana-cli.lock"), "utf8")).pid,
    ).toBe(process.pid);
    await release();
    expect(fs.existsSync(path.join(dir, ".vana-cli.lock"))).toBe(false);
  });
});

describe("choosePort", () => {
  it("skips a port whose approval-page neighbour is taken", async () => {
    const blocker = net.createServer();
    await new Promise<void>((resolve) =>
      blocker.listen(0, "127.0.0.1", resolve),
    );
    const taken = (blocker.address() as net.AddressInfo).port;
    try {
      expect(await choosePort(taken - 1)).toBeNull();
    } finally {
      blocker.close();
    }
  });
});

describe("findRunningServers", () => {
  it("counts a server once even though its approval port answers too", async () => {
    const { findRunningServers } =
      await import("../../src/personal-server/local/server.js");
    const health = (owner: string, identity: string) =>
      new Response(JSON.stringify({ owner, identity: { address: identity } }));
    const fetchImpl = (async (url: string | URL | Request) => {
      const target = String(url);
      if (target.includes(":8080/") || target.includes(":8081/")) {
        return health(OWNER, "0xserverA");
      }
      if (target.includes(":8082/")) return health(OTHER, "0xserverB");
      throw new Error("nothing there");
    }) as typeof fetch;

    expect(await findRunningServers(fetchImpl)).toEqual([
      { url: "http://localhost:8080", owner: OWNER, identity: "0xserverA" },
      { url: "http://localhost:8082", owner: OTHER, identity: "0xserverB" },
    ]);
  });
});

describe("runServerStart supervising a real child process", () => {
  let root: string;
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "vana-ps-supervise-"));
  });
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  it("restarts a kill -9'd server, keeps the lock between runs, and stops clean", async () => {
    const { startLocalServer } =
      await import("../../src/personal-server/local/server.js");
    const runtimeDir = path.join(root, "runtime");
    const dataDir = path.join(root, "data");
    fs.mkdirSync(runtimeDir);
    // Stands in for entry.mjs: says ready, records its pid, waits for SIGINT.
    fs.writeFileSync(
      path.join(runtimeDir, "entry.mjs"),
      [
        'import fs from "node:fs";',
        'process.stdin.once("data", (chunk) => {',
        "  const config = JSON.parse(String(chunk).split('\\n')[0]);",
        '  fs.appendFileSync(config.rootPath + "/pids", process.pid + "\\n");',
        '  process.stdout.write(JSON.stringify({ type: "ready", url: "http://localhost:" + config.port }) + "\\n");',
        "});",
        'process.on("SIGINT", () => process.exit(0));',
        "setInterval(() => {}, 1000);",
      ].join("\n"),
    );
    fs.mkdirSync(dataDir);
    const pids = () =>
      fs.existsSync(path.join(dataDir, "pids"))
        ? fs
            .readFileSync(path.join(dataDir, "pids"), "utf8")
            .trim()
            .split("\n")
            .map(Number)
        : [];
    let stop: () => void = () => {};
    const h = harness({
      findNode: vi.fn(async () => ({
        path: process.execPath,
        version: process.versions.node,
      })),
      ensureRuntime: vi.fn(async () => runtimeDir),
      resolveDataDir: vi.fn(async () => ({
        kind: "ready" as const,
        dir: dataDir,
      })),
      choosePort: vi.fn(async () => 18_080),
      start: startLocalServer,
      lockDataDir: acquireDataDirLock,
      sleep: (ms) => new Promise((r) => setTimeout(r, ms / 1000)),
      stopRequested: vi.fn(() => new Promise<void>((r) => (stop = r))),
    });
    const run = runServerStart(
      { network: "moksha", local: true },
      h.io,
      h.deps,
    );
    await vi.waitFor(() => expect(pids()).toHaveLength(1), {
      timeout: 10_000,
    });
    const [firstPid] = pids();
    process.kill(firstPid, "SIGKILL");
    await vi.waitFor(
      () => {
        expect(pids()).toHaveLength(2);
        expect(h.events.at(-1)).toMatchObject({ type: "server-restarted" });
      },
      { timeout: 10_000 },
    );
    // `vana server stop` still finds this process by the lock.
    expect(serverPidIn(dataDir)).toBe(process.pid);
    stop();
    expect(await run).toBe(0);
    const secondPid = pids()[1];
    expect(() => process.kill(secondPid, 0)).toThrow();
    expect(fs.existsSync(path.join(dataDir, ".vana-cli.lock"))).toBe(false);
    expect(pids()).toHaveLength(2);
  }, 30_000);
});
