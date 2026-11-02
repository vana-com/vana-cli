import { describe, expect, it } from "vitest";
import {
  prepareCollection,
  type CollectionReadinessDependencies,
} from "../../src/cli/collection-readiness.js";
import type { PersonalServerTarget } from "../../src/personal-server/index.js";

const owner = {
  accountUrl: "https://account.vana.org",
  address: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
};
const target: PersonalServerTarget = {
  state: "available",
  url: "http://localhost:8080",
  source: "config",
  health: { owner: owner.address, status: "ok", version: "1", uptime: 1 },
};

function fixture() {
  const calls: string[] = [];
  const state = {
    signedIn: true,
    server: target,
    access: "ready" as "ready" | "auth" | "unavailable",
    owner,
  };
  const deps: CollectionReadinessDependencies = {
    interactive: false,
    session: () => ({
      authenticated: state.signedIn,
      owner: state.signedIn ? state.owner : null,
    }),
    signIn: async () => {
      calls.push("sign-in");
      state.signedIn = true;
      return 0;
    },
    detectServer: async () => {
      calls.push("detect");
      return state.server;
    },
    prepareServer: async () => {
      calls.push("start");
      state.server = target;
    },
    approveServer: async () => {
      calls.push("approve");
      state.access = "ready";
      return 0;
    },
    checkAccess: async () => {
      calls.push("access");
      return state.access;
    },
    confirmForeignServer: async () => {
      calls.push("foreign-confirm");
      return false;
    },
    serverStartCommand: "vana server start --network moksha",
    serverApprovalCommand: (server) => `vana login --server ${server.url}`,
  };
  return { calls, state, deps };
}

describe("collection readiness", () => {
  it("establishes identity, destination and approval in that order, then reuses them", async () => {
    const { calls, state, deps } = fixture();
    state.signedIn = false;
    state.server = {
      state: "unavailable",
      url: null,
      source: null,
      health: null,
    };
    state.access = "auth";
    deps.interactive = true;
    expect(await prepareCollection(deps)).toEqual({
      ready: true,
      owner,
      target,
      allowForeignServer: false,
    });
    expect(calls).toEqual([
      "sign-in",
      "detect",
      "start",
      "detect",
      "access",
      "approve",
      "access",
    ]);
    calls.length = 0;
    expect((await prepareCollection(deps)).ready).toBe(true);
    expect(calls).toEqual(["detect", "access"]);
  });

  it.each(["missing", "unknown owner"])(
    "does not open prompts for an automated %s session",
    async (kind) => {
      const { calls, state, deps } = fixture();
      state.signedIn = false;
      if (kind === "unknown owner")
        deps.session = () => ({ authenticated: true, owner: null });
      expect(await prepareCollection(deps)).toMatchObject({
        ready: false,
        exitCode: 7,
        reason:
          kind === "unknown owner"
            ? "vana_owner_unknown"
            : "vana_sign_in_required",
        remedy: "vana login",
      });
      expect(calls).toEqual([]);
    },
  );

  it("refuses an unavailable destination without creating a server in automated mode", async () => {
    const { calls, state, deps } = fixture();
    state.server = {
      state: "unavailable",
      url: null,
      source: null,
      health: null,
    };
    expect(await prepareCollection(deps)).toMatchObject({
      ready: false,
      exitCode: 5,
      reason: "personal_server_unavailable",
      remedy: "vana server start --network moksha",
    });
    expect(calls).toEqual(["detect"]);
  });

  it("requires server approval before automated collection", async () => {
    const { calls, state, deps } = fixture();
    state.access = "auth";
    expect(await prepareCollection(deps)).toMatchObject({
      ready: false,
      exitCode: 7,
      reason: "personal_server_approval_required",
      remedy: "vana login --server http://localhost:8080",
    });
    expect(calls).toEqual(["detect", "access"]);
  });

  it("refuses another account's server without testing its credentials", async () => {
    const { calls, state, deps } = fixture();
    state.server = {
      ...target,
      health: {
        ...target.health!,
        owner: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      },
    };
    expect(await prepareCollection(deps)).toMatchObject({
      ready: false,
      exitCode: 5,
      reason: "personal_server_not_yours",
    });
    expect(calls).toEqual(["detect"]);
  });

  it("does not bind collection to an account switched during approval", async () => {
    const { state, deps } = fixture();
    deps.checkAccess = async () => {
      state.owner = {
        ...owner,
        address: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      };
      return "ready";
    };
    expect(await prepareCollection(deps)).toMatchObject({
      ready: false,
      reason: "collection_account_changed",
    });
  });
});
