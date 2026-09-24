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
    waitForStop: vi.fn(async () => "stopped" as const),
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
    expect(await runServerStart({ network: "moksha" }, h.io, h.deps)).toBe(0);
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

  it("stays local and never looks for a tunnel client without --public", async () => {
    const h = harness();
    expect(await runServerStart({ network: "moksha" }, h.io, h.deps)).toBe(0);
    expect(h.deps.resolveFrpc).not.toHaveBeenCalled();
    expect(h.deps.start).toHaveBeenCalledWith(
      expect.objectContaining({ frpcPath: null }),
    );
  });

  it("--public stops before anything starts when no tunnel client may run", async () => {
    const h = harness({
      resolveFrpc: vi.fn(async () => ({
        kind: "unavailable" as const,
        reason: "No tunnel client signed by Vana is available on this Mac yet.",
      })),
    });
    expect(
      await runServerStart({ network: "moksha", public: true }, h.io, h.deps),
    ).toBe(6);
    expect(h.deps.start).not.toHaveBeenCalled();
  });

  it("--public installs the tunnel client, registers, and remembers it", async () => {
    const server = fakeServer();
    const h = harness({
      resolveFrpc: vi.fn(async () => ({ kind: "installable" as const })),
      start: vi.fn(async () => server.handle),
    });
    expect(
      await runServerStart({ network: "moksha", public: true }, h.io, h.deps),
    ).toBe(0);
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
      "moksha",
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
    expect(
      await runServerStart({ network: "moksha", public: true }, h.io, h.deps),
    ).toBe(0);
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

  it("reports a server that dies on its own", async () => {
    const h = harness({ waitForStop: vi.fn(async () => "exited" as const) });
    expect(await runServerStart({ network: "moksha" }, h.io, h.deps)).toBe(1);
    expect(h.events.at(-1)).toMatchObject({ type: "server-exited" });
  });
});

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
      { url: "http://localhost:8080", owner: OWNER },
      { url: "http://localhost:8082", owner: OTHER },
    ]);
  });
});
