import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

const mocks = vi.hoisted(() => ({
  readCliConfig: vi.fn(),
  loadPersonalServerSession: vi.fn(),
  actualLoadPersonalServerSession: null as null | (() => unknown),
}));

vi.mock("../../src/core/state-store.js", () => ({
  readCliConfig: mocks.readCliConfig,
}));

vi.mock("../../src/cli/auth.js", async () => {
  const actual = await vi.importActual<object>("../../src/cli/auth.js");
  mocks.actualLoadPersonalServerSession = (
    actual as { loadPersonalServerSession: () => unknown }
  ).loadPersonalServerSession;
  return {
    ...actual,
    loadPersonalServerSession: mocks.loadPersonalServerSession,
  };
});

import {
  detectPersonalServerTarget,
  personalServerOwnerMismatch,
  resolvePersonalServerAuthConfig,
} from "../../src/personal-server/index.js";
import { getAuthFilePath, saveCredentials } from "../../src/cli/auth.js";

const originalEnv = { ...process.env };
const fetchMock = vi.fn<typeof fetch>();

beforeEach(() => {
  mocks.readCliConfig.mockReset();
  mocks.readCliConfig.mockResolvedValue({});
  mocks.loadPersonalServerSession.mockReset();
  mocks.loadPersonalServerSession.mockReturnValue(null);
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  process.env = { ...originalEnv };
  vi.unstubAllGlobals();
});

describe("resolvePersonalServerAuthConfig", () => {
  it("uses VANA_PS_TOKEN for localhost servers", () => {
    process.env.VANA_PS_TOKEN = "ps-token";

    expect(resolvePersonalServerAuthConfig("http://localhost:8080")).toEqual({
      type: "bearerToken",
      token: "ps-token",
    });
  });

  it("uses VANA_PS_TOKEN for remote servers", () => {
    process.env.VANA_PS_TOKEN = "ps-token";

    expect(resolvePersonalServerAuthConfig("https://ps.example.com")).toEqual({
      type: "bearerToken",
      token: "ps-token",
    });
  });

  it("uses the saved personal server session token when the target URL matches", () => {
    mocks.loadPersonalServerSession.mockReturnValue({
      url: "http://localhost:8080/",
      session_token: "saved-ps-token",
      expires_at: "2026-04-22T00:00:00.000Z",
    });

    expect(resolvePersonalServerAuthConfig("http://localhost:8080")).toEqual({
      type: "bearerToken",
      token: "saved-ps-token",
    });
  });

  it("does not reuse a saved personal server session token for a different URL", () => {
    mocks.loadPersonalServerSession.mockReturnValue({
      url: "https://ps.example.com",
      session_token: "saved-ps-token",
      expires_at: "2026-04-22T00:00:00.000Z",
    });

    expect(
      resolvePersonalServerAuthConfig("https://other.example.com"),
    ).toBeUndefined();
  });

  describe("with a real auth.json", () => {
    const authDir = join(homedir(), ".vana");
    const past = "2020-01-01T00:00:00.000Z";
    const future = "2099-01-01T00:00:00.000Z";

    async function writeAuth(accountExpiresAt: string, psExpiresAt: string) {
      await mkdir(authDir, { recursive: true });
      await writeFile(
        join(authDir, "auth.json"),
        JSON.stringify({
          account: {
            address: "0x1234567890abcdef1234567890abcdef12345678",
            session_token: "account-token",
            expires_at: accountExpiresAt,
          },
          personal_server: {
            url: "http://localhost:8080",
            session_token: "saved-ps-token",
            expires_at: psExpiresAt,
            started_by: "vana-server-start",
          },
        }),
      );
    }

    beforeEach(() => {
      delete process.env.VANA_PS_TOKEN;
      delete process.env.VANA_SESSION_TOKEN;
      mocks.loadPersonalServerSession.mockImplementation(() =>
        mocks.actualLoadPersonalServerSession?.(),
      );
    });

    afterEach(async () => {
      await rm(authDir, { recursive: true, force: true });
    });

    it("keeps sending the PS token after the Account session expires", async () => {
      // The nightly collect failed every sync with 401 MISSING_AUTH because
      // an expired Account login hid a PS token that was still valid.
      await writeAuth(past, future);

      expect(resolvePersonalServerAuthConfig("http://localhost:8080")).toEqual({
        type: "bearerToken",
        token: "saved-ps-token",
      });
    });

    it("sends nothing once the PS token itself has expired", async () => {
      await writeAuth(future, past);

      expect(
        resolvePersonalServerAuthConfig("http://localhost:8080"),
      ).toBeUndefined();
    });
  });
});

describe("detectPersonalServerTarget", () => {
  beforeEach(() => {
    delete process.env.VANA_SESSION_TOKEN;
  });

  afterEach(async () => {
    await rm(getAuthFilePath(), { force: true });
  });

  it("falls back from an unreachable saved URL to the authenticated personal server URL", async () => {
    mocks.readCliConfig.mockResolvedValue({
      personalServerUrl: "https://dead.example.com",
    });
    mocks.loadPersonalServerSession.mockReturnValue({
      url: "http://localhost:8080",
      session_token: "vana_ps_token",
      expires_at: "2026-04-22T00:00:00.000Z",
    });

    fetchMock.mockRejectedValueOnce(new Error("dead")).mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          status: "healthy",
          version: "0.0.1",
          uptime: 1,
          owner: "0x1234567890abcdef1234567890abcdef12345678",
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );

    await expect(detectPersonalServerTarget()).resolves.toEqual({
      state: "available",
      url: "http://localhost:8080",
      source: "auth",
      health: {
        status: "healthy",
        version: "0.0.1",
        uptime: 1,
        owner: "0x1234567890abcdef1234567890abcdef12345678",
      },
    });
  });

  it.each(["2099-01-01T00:00:00.000Z", "2000-01-01T00:00:00.000Z"])(
    "prefers a scanned server the saved account owns with Account expiry %s",
    async (expiresAt) => {
      const mine = "0x1234567890abcdef1234567890abcdef12345678";
      const theirs = "0x99bf14e94de7edb022e08528c5cdb627f73a988d";
      await saveCredentials({
        account: {
          address: mine,
          session_token: "t",
          expires_at: expiresAt,
        },
        personal_server: null,
      });

      const health = (owner: string) =>
        new Response(
          JSON.stringify({
            status: "healthy",
            version: "1.0.0",
            uptime: 1,
            owner,
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      // 8080 answers first but belongs to another identity.
      fetchMock
        .mockResolvedValueOnce(health(theirs))
        .mockResolvedValueOnce(health(mine));

      await expect(detectPersonalServerTarget()).resolves.toMatchObject({
        url: "http://localhost:8081",
        source: "scan",
        health: { owner: mine },
      });
    },
  );

  it.each(["2099-01-01T00:00:00.000Z", "2000-01-01T00:00:00.000Z"])(
    "passes over a saved foreign server with Account expiry %s",
    async (expiresAt) => {
      // Two accounts' servers on one machine: auth.json still names A's.
      const mine = "0xaff7000000000000000000000000000000000001";
      const theirs = "0x99bf14e94de7edb022e08528c5cdb627f73a988d";
      await saveCredentials({
        account: {
          address: mine,
          session_token: "t",
          expires_at: expiresAt,
        },
        personal_server: null,
      });
      mocks.loadPersonalServerSession.mockReturnValue({
        url: "http://localhost:8080",
        session_token: "vana_ps_token",
        expires_at: "2999-01-01T00:00:00.000Z",
      });
      const owners: Record<string, string> = {
        "http://localhost:8080/health": theirs,
        "http://localhost:8082/health": mine,
      };
      fetchMock.mockImplementation(async (input) => {
        const owner = owners[String(input)];
        if (!owner) throw new Error("nothing there");
        return new Response(
          JSON.stringify({ status: "healthy", version: "1", uptime: 1, owner }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      });

      await expect(detectPersonalServerTarget()).resolves.toMatchObject({
        url: "http://localhost:8082",
        source: "scan",
        health: { owner: mine },
      });

      // With ours down, the saved one is still reported, as someone else's.
      delete owners["http://localhost:8082/health"];
      await expect(detectPersonalServerTarget()).resolves.toMatchObject({
        url: "http://localhost:8080",
        source: "auth",
        health: { owner: theirs },
      });
    },
  );

  it("falls back to a server owned by someone else when nothing of ours answers", async () => {
    const theirs = "0x99bf14e94de7edb022e08528c5cdb627f73a988d";
    await saveCredentials({
      account: {
        address: "0x1234567890abcdef1234567890abcdef12345678",
        session_token: "t",
        expires_at: "2026-04-22T00:00:00.000Z",
      },
      personal_server: null,
    });

    fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({
          status: "healthy",
          version: "1.0.0",
          uptime: 1,
          owner: theirs,
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );

    await expect(detectPersonalServerTarget()).resolves.toMatchObject({
      url: "http://localhost:8080",
      source: "scan",
      health: { owner: theirs },
    });
  });
});

describe("personalServerOwnerMismatch", () => {
  const mine = "0xbffbd3316ef8c6d8b8046151228c09840ae08d48";
  const theirs = "0x99Bf14e94DE7edB022E08528C5Cdb627f73A988d";

  it("reports a server owned by another identity", () => {
    expect(personalServerOwnerMismatch(theirs, mine)).toEqual({
      owner: theirs,
      account: mine,
    });
  });

  it("ignores checksum casing", () => {
    expect(personalServerOwnerMismatch(mine.toUpperCase(), mine)).toBe(null);
  });

  it("stays quiet when either side is unknown", () => {
    expect(personalServerOwnerMismatch(null, mine)).toBe(null);
    expect(personalServerOwnerMismatch(theirs, null)).toBe(null);
    expect(personalServerOwnerMismatch(theirs, "env")).toBe(null);
  });
});

describe("urlsMatch", () => {
  it("treats every loopback spelling as the same server", async () => {
    const { urlsMatch } = await import("../../src/personal-server/index.js");
    expect(urlsMatch("http://127.0.0.1:8080", "http://localhost:8080/")).toBe(
      true,
    );
    expect(urlsMatch("http://[::1]:8080", "http://localhost:8080")).toBe(true);
  });

  it("still tells different ports and hosts apart", async () => {
    const { urlsMatch } = await import("../../src/personal-server/index.js");
    expect(urlsMatch("http://localhost:8080", "http://localhost:8082")).toBe(
      false,
    );
    expect(urlsMatch("https://ps.example", "http://localhost:8080")).toBe(
      false,
    );
  });
});
