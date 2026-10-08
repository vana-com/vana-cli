import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { privateKeyToAccount } from "viem/accounts";
import { resolveSourceKey, runAppRequest } from "../../src/cli/app/request.js";
import {
  runAppRequestsList,
  runAppRequestsShow,
} from "../../src/cli/app/requests.js";
import { appOutcomeSchema } from "../../src/cli/app/outcome.js";
import { createRequestsStore } from "../../src/core/requests-store.js";
import type { ResolvedAppKey } from "../../src/core/app-key.js";

const KEY =
  "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d" as const;
const account = privateKeyToAccount(KEY);
const appKey: ResolvedAppKey = {
  privateKey: KEY,
  address: account.address,
  publicKey: account.publicKey,
  source: "env",
};
const REQUEST_ID = "dcr_abc123";
const GRANT =
  "0x1111111111111111111111111111111111111111111111111111111111111111";

let stdout: string;
let tempDir: string;

beforeEach(() => {
  stdout = "";
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "vana-requests-"));
  vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
    stdout += String(chunk);
    return true;
  });
  vi.spyOn(process.stderr, "write").mockImplementation(() => true);
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

function store() {
  return createRequestsStore(path.join(tempDir, "requests.json"));
}

/** Controller stub: created request plus a scripted status sequence. */
function controller(statuses: Array<Record<string, unknown>>) {
  let call = 0;
  return () =>
    ({
      createAccessRequest: async () => ({
        requestId: REQUEST_ID,
        approvalUrl: "https://app.vana.org/approve/abc",
        appAddress: account.address,
        expiresAt: "2099-01-01T00:00:00Z",
      }),
      getAccessRequestStatus: async () => {
        const status = statuses[Math.min(call, statuses.length - 1)];
        call += 1;
        return status;
      },
    }) as never;
}

/** Gateway stub answering getGrant for GRANT. */
function gateway(grant: Record<string, unknown> | null | Error) {
  const getGrant = vi.fn(async () => {
    if (grant instanceof Error) throw grant;
    return grant as never;
  });
  return { createClient: () => ({ getGrant }), getGrant };
}

const activeGrant = (scopes: string[]) => ({
  id: GRANT,
  scopes,
  revokedAt: null,
  expired: false,
});

describe("vana app request", () => {
  it("requires scopes with exit 2", async () => {
    const exitCode = await runAppRequest(
      { json: true },
      { resolveKey: () => appKey, requests: store() },
    );
    expect(exitCode).toBe(2);
    expect(appOutcomeSchema.parse(JSON.parse(stdout)).code).toBe("bad_usage");
  });

  it("rejects a question whose derived scope is not in --scopes", async () => {
    const exitCode = await runAppRequest(
      {
        json: true,
        scopes: "github.repositories",
        question: "what?",
        derived: "coach.weekly",
        sources: "github.repositories",
      },
      { resolveKey: () => appKey, requests: store() },
    );
    expect(exitCode).toBe(2);
    const outcome = appOutcomeSchema.parse(JSON.parse(stdout));
    expect(outcome.message).toContain("must also appear in --scopes");
  });

  it("rejects a partial question spec", async () => {
    const exitCode = await runAppRequest(
      { json: true, scopes: "github.repositories", question: "what?" },
      { resolveKey: () => appKey, requests: store() },
    );
    expect(exitCode).toBe(2);
  });

  it("grants only the derived scope when a question omits --scopes", async () => {
    let configured: { scopes?: string[] } = {};
    let questions: unknown;
    const exitCode = await runAppRequest(
      {
        json: true,
        noInput: true,
        question: "Which languages?",
        derived: "myapp.languages",
        sources: "github.repositories",
      },
      {
        resolveKey: () => appKey,
        requests: store(),
        createController: ((config: typeof configured) => {
          configured = config;
          const inner = controller([{ status: "pending" }])() as {
            createAccessRequest: (input: { questions?: unknown }) => unknown;
          };
          return {
            ...inner,
            createAccessRequest: async (input: { questions?: unknown }) => {
              questions = input.questions;
              return inner.createAccessRequest(input);
            },
          };
        }) as never,
      },
    );
    expect(exitCode).toBe(7);
    expect(configured.scopes).toEqual(["myapp.languages"]);
    // The source still reaches the person's server, as the question's input.
    expect(questions).toEqual([
      {
        derivedScope: "myapp.languages",
        sourceScopes: ["github.repositories"],
        question: "Which languages?",
      },
    ]);
  });

  it("refuses to grant a question's source as a raw read", async () => {
    // The approval page tells the person the app will not see the sources.
    const exitCode = await runAppRequest(
      {
        json: true,
        noInput: true,
        scopes: "github.repositories,myapp.languages",
        question: "Which languages?",
        derived: "myapp.languages",
        sources: "github.repositories",
      },
      {
        resolveKey: () => appKey,
        requests: store(),
        createController: () => {
          throw new Error("must not create a request");
        },
      },
    );
    expect(exitCode).toBe(2);
    const outcome = appOutcomeSchema.parse(JSON.parse(stdout));
    expect(outcome.code).toBe("bad_usage");
    expect(outcome.message).toContain("github.repositories");
    expect(outcome.remedy).toContain("--scopes myapp.languages ");
  });

  it("points next at the derived scope once a question is approved", async () => {
    const exitCode = await runAppRequest(
      {
        json: true,
        question: "Which languages?",
        derived: "myapp.languages",
        sources: "github.repositories",
      },
      {
        resolveKey: () => appKey,
        requests: store(),
        sleep: async () => {},
        createController: controller([
          { status: "approved", grantId: GRANT, scopes: ["myapp.languages"] },
        ]),
      },
    );
    expect(exitCode).toBe(0);
    expect(appOutcomeSchema.parse(JSON.parse(stdout)).remedy).toBe(
      `vana app read myapp.languages --grant ${GRANT}`,
    );
  });

  it("persists the request before approval and exits 7 under --no-input", async () => {
    const requests = store();
    const exitCode = await runAppRequest(
      { json: true, noInput: true, scopes: "github.repositories" },
      {
        resolveKey: () => appKey,
        requests,
        createController: controller([{ status: "pending" }]),
      },
    );
    expect(exitCode).toBe(7);
    const outcome = appOutcomeSchema.parse(JSON.parse(stdout));
    expect(outcome.code).toBe("confirmation_required");
    expect(outcome.data).toMatchObject({ requestId: REQUEST_ID });

    // Findable afterwards, which is the whole point of saving early.
    const saved = requests.get(REQUEST_ID);
    expect(saved).toMatchObject({
      requestId: REQUEST_ID,
      status: "pending",
      scopes: ["github.repositories"],
      appAddress: account.address,
    });
  });

  it("shows the name register remembered, not Vana CLI, on the approval page", async () => {
    let configured: { app?: { name?: string; homepageUrl?: string } } = {};
    const exitCode = await runAppRequest(
      { json: true, noInput: true, scopes: "oura.sleep" },
      {
        resolveKey: () => appKey,
        requests: store(),
        readProfile: () => ({
          name: "OpenClaw",
          url: "https://github.com/openclaw/openclaw",
        }),
        createController: ((config: typeof configured) => {
          configured = config;
          return controller([{ status: "pending" }])();
        }) as never,
      },
    );
    expect(exitCode).toBe(7);
    expect(configured.app?.name).toBe("OpenClaw");
    expect(configured.app?.homepageUrl).toBe(
      "https://github.com/openclaw/openclaw",
    );
  });

  it("lets --app-name override the remembered name for one request", async () => {
    let configured: { app?: { name?: string } } = {};
    await runAppRequest(
      { json: true, noInput: true, scopes: "oura.sleep", appName: "Test run" },
      {
        resolveKey: () => appKey,
        requests: store(),
        readProfile: () => ({ name: "OpenClaw" }),
        createController: ((config: typeof configured) => {
          configured = config;
          return controller([{ status: "pending" }])();
        }) as never,
      },
    );
    expect(configured.app?.name).toBe("Test run");
  });

  it("polls to approval and reports the grant", async () => {
    const requests = store();
    const exitCode = await runAppRequest(
      { json: true, scopes: "github.repositories" },
      {
        resolveKey: () => appKey,
        requests,
        sleep: async () => {},
        createController: controller([
          { status: "pending" },
          { status: "pending" },
          {
            status: "approved",
            grantId: GRANT,
            scopes: ["github.repositories"],
            delivery: "personal_server",
            personalServerUrl: "https://ps.example",
          },
        ]),
      },
    );
    expect(exitCode).toBe(0);
    const outcome = appOutcomeSchema.parse(JSON.parse(stdout));
    expect(outcome.data).toMatchObject({
      grantId: GRANT,
      delivery: "personal_server",
    });
    expect(outcome.remedy).toContain(`--grant ${GRANT}`);
    expect(requests.get(REQUEST_ID)).toMatchObject({
      status: "approved",
      grantId: GRANT,
    });
  });

  it("maps a denial to exit 3", async () => {
    const exitCode = await runAppRequest(
      { json: true, scopes: "github.repositories" },
      {
        resolveKey: () => appKey,
        requests: store(),
        sleep: async () => {},
        createController: controller([{ status: "denied" }]),
      },
    );
    expect(exitCode).toBe(3);
    expect(appOutcomeSchema.parse(JSON.parse(stdout)).code).toBe(
      "grant_invalid",
    );
  });

  it("gives up with exit 6 when nobody approves in time", async () => {
    let clock = 0;
    const exitCode = await runAppRequest(
      { json: true, scopes: "github.repositories", timeout: "5" },
      {
        resolveKey: () => appKey,
        requests: store(),
        sleep: async () => {
          clock += 3000;
        },
        now: () => clock,
        createController: controller([{ status: "pending" }]),
      },
    );
    expect(exitCode).toBe(6);
    const outcome = appOutcomeSchema.parse(JSON.parse(stdout));
    expect(outcome.code).toBe("not_ready");
    expect(outcome.remedy).toContain("requests show");
  });
});

describe("resolveSourceKey", () => {
  it("uses the plain scope when there is no question", () => {
    expect(resolveSourceKey(["github.repositories"], undefined, [])).toBe(
      "github",
    );
  });

  it("prefers a source scope over a derived one listed first", () => {
    // Asking for the derived scope first used to make the approval screen
    // say "Connect coach", a source nobody can connect.
    expect(
      resolveSourceKey(["coach.weekly", "spotify.history"], "coach.weekly", [
        "spotify.history",
      ]),
    ).toBe("spotify");
  });

  it("skips the derived scope even without explicit sources", () => {
    expect(
      resolveSourceKey(["coach.weekly", "spotify.history"], "coach.weekly", []),
    ).toBe("spotify");
  });

  it("never treats a write prefix as the source name", () => {
    expect(resolveSourceKey(["write:coach.weekly"], undefined, [])).toBe(
      "coach",
    );
  });
});

describe("vana app requests", () => {
  it("lists nothing on a fresh machine", async () => {
    const exitCode = await runAppRequestsList(
      { json: true },
      { resolveKey: () => appKey, requests: store() },
    );
    expect(exitCode).toBe(0);
    expect(appOutcomeSchema.parse(JSON.parse(stdout)).data).toMatchObject({
      count: 0,
    });
  });

  it("shows a stored request and refreshes it from the service", async () => {
    const requests = store();
    await runAppRequest(
      { json: true, noInput: true, scopes: "github.repositories" },
      {
        resolveKey: () => appKey,
        requests,
        createController: controller([{ status: "pending" }]),
      },
    );
    stdout = "";

    const exitCode = await runAppRequestsShow(
      REQUEST_ID,
      { json: true },
      {
        resolveKey: () => appKey,
        requests,
        createController: controller([
          {
            status: "approved",
            grantId: GRANT,
            scopes: ["github.repositories"],
          },
        ]),
        createClient: gateway(activeGrant(["github.repositories"]))
          .createClient,
      },
    );
    expect(exitCode).toBe(0);
    const outcome = appOutcomeSchema.parse(JSON.parse(stdout));
    expect(outcome.data).toMatchObject({
      status: "approved",
      grantId: GRANT,
      live: true,
      grant: { state: "active" },
    });
    // The refresh is written back, so a later offline show still knows.
    expect(requests.get(REQUEST_ID)?.grantId).toBe(GRANT);
  });

  it("points next at a question's derived scope, never its source", async () => {
    const requests = store();
    requests.save({
      requestId: REQUEST_ID,
      appAddress: account.address,
      network: "mainnet",
      gatewayUrl: "https://gateway.example",
      // A request made before the derived-only fix also granted the source.
      scopes: ["github.repositories", "myapp.languages"],
      approvalUrl: "https://app.vana.org/approve/abc",
      createdAt: "2026-10-06T00:00:00Z",
      updatedAt: "2026-10-06T00:00:00Z",
      status: "approved",
      grantId: GRANT,
      questions: [
        {
          derivedScope: "myapp.languages",
          sourceScopes: ["github.repositories"],
        },
      ],
    });

    const exitCode = await runAppRequestsShow(
      REQUEST_ID,
      { json: true },
      {
        resolveKey: () => appKey,
        requests,
        createController: () => {
          throw new Error("offline");
        },
        createClient: gateway(
          activeGrant(["github.repositories", "myapp.languages"]),
        ).createClient,
      },
    );
    expect(exitCode).toBe(0);
    expect(appOutcomeSchema.parse(JSON.parse(stdout)).remedy).toBe(
      `vana app read myapp.languages --grant ${GRANT}`,
    );
  });

  describe("an approved request whose grant changed since", () => {
    function approved() {
      const requests = store();
      requests.save({
        requestId: REQUEST_ID,
        appAddress: account.address,
        network: "mainnet",
        gatewayUrl: "https://gateway.example",
        scopes: ["github.repositories"],
        approvedScopes: ["github.repositories"],
        approvalUrl: "https://app.vana.org/approve/abc",
        createdAt: "2026-10-06T00:00:00Z",
        updatedAt: "2026-10-06T00:00:00Z",
        status: "approved",
        grantId: GRANT,
      });
      return requests;
    }
    // The service still says approved: the DCR record never changes.
    const service = controller([
      { status: "approved", grantId: GRANT, scopes: ["github.repositories"] },
    ]);

    it("says the owner revoked it", async () => {
      const gw = gateway({
        ...activeGrant(["github.repositories"]),
        revokedAt: "2026-10-07T10:00:00Z",
      });
      const exitCode = await runAppRequestsShow(
        REQUEST_ID,
        { json: true },
        {
          resolveKey: () => appKey,
          requests: approved(),
          createController: service,
          createClient: gw.createClient,
        },
      );
      expect(exitCode).toBe(0);
      expect(gw.getGrant).toHaveBeenCalledWith(GRANT);
      const outcome = appOutcomeSchema.parse(JSON.parse(stdout));
      expect(outcome.data).toMatchObject({
        status: "approved",
        live: false,
        grant: { state: "revoked", revokedAt: "2026-10-07T10:00:00Z" },
      });
      expect(outcome.message).toContain("revoked by the owner");
      expect(outcome.remedy).toBe(
        "vana app request --scopes github.repositories",
      );
    });

    it("says a later approval replaced its scopes", async () => {
      const requests = approved();
      const exitCode = await runAppRequestsShow(
        REQUEST_ID,
        { json: true },
        {
          resolveKey: () => appKey,
          requests,
          // The status route may report the grant's scopes as they are now.
          createController: controller([
            { status: "approved", grantId: GRANT, scopes: ["spotify.history"] },
          ]),
          createClient: gateway(activeGrant(["spotify.history"])).createClient,
        },
      );
      expect(exitCode).toBe(0);
      const outcome = appOutcomeSchema.parse(JSON.parse(stdout));
      expect(outcome.data).toMatchObject({
        live: false,
        grant: { state: "replaced", grantScopes: ["spotify.history"] },
      });
      expect(outcome.message).toContain("replaced by a later approval");
      expect(outcome.remedy).toBe(
        "vana app request --scopes github.repositories",
      );
      // What was approved stays on record.
      expect(requests.get(REQUEST_ID)?.approvedScopes).toEqual([
        "github.repositories",
      ]);
    });

    it("keeps the stored status but says so when the gateway is down", async () => {
      const exitCode = await runAppRequestsShow(
        REQUEST_ID,
        { json: true },
        {
          resolveKey: () => appKey,
          requests: approved(),
          createController: service,
          createClient: gateway(new Error("fetch failed")).createClient,
        },
      );
      expect(exitCode).toBe(0);
      const outcome = appOutcomeSchema.parse(JSON.parse(stdout));
      expect(outcome.data).toMatchObject({
        status: "approved",
        grant: { state: "unverified" },
      });
      expect(outcome.message).toContain("grant not verified");
      expect(outcome.remedy).toBe(
        `vana app read github.repositories --grant ${GRANT}`,
      );
    });

    it("flags it in the list too", async () => {
      const exitCode = await runAppRequestsList(
        { json: true },
        {
          resolveKey: () => appKey,
          requests: approved(),
          createClient: gateway({
            ...activeGrant(["github.repositories"]),
            revokedAt: "2026-10-07T10:00:00Z",
          }).createClient,
        },
      );
      expect(exitCode).toBe(0);
      const outcome = appOutcomeSchema.parse(JSON.parse(stdout));
      expect(outcome.message).toContain("no longer in force");
      expect(outcome.data?.requests).toEqual([
        expect.objectContaining({
          requestId: REQUEST_ID,
          live: false,
          grant: expect.objectContaining({ state: "revoked" }),
        }),
      ]);
    });
  });

  it("falls back to the local record when the service is unreachable", async () => {
    const requests = store();
    await runAppRequest(
      { json: true, noInput: true, scopes: "github.repositories" },
      {
        resolveKey: () => appKey,
        requests,
        createController: controller([{ status: "pending" }]),
      },
    );
    stdout = "";

    const exitCode = await runAppRequestsShow(
      REQUEST_ID,
      { json: true },
      {
        resolveKey: () => appKey,
        requests,
        createController: () => {
          throw new Error("offline");
        },
      },
    );
    expect(exitCode).toBe(0);
    const outcome = appOutcomeSchema.parse(JSON.parse(stdout));
    expect(outcome.data).toMatchObject({ live: false, status: "pending" });
  });

  it("reports an unknown id with exit 2", async () => {
    const exitCode = await runAppRequestsShow(
      "dcr_nope",
      { json: true },
      {
        resolveKey: () => appKey,
        requests: store(),
      },
    );
    expect(exitCode).toBe(2);
    expect(appOutcomeSchema.parse(JSON.parse(stdout)).remedy).toBe(
      "vana app requests list",
    );
  });
});

describe("vana app request - extending the live grant", () => {
  const OWNER = "0x00000000000000000000000000000000000000aa";
  const BUILDER = `0x${"ab".repeat(32)}`;

  /** A store that already holds one approved request, so the owner is known. */
  function storeWithApproval(grantId = GRANT) {
    const requests = store();
    requests.save({
      requestId: "dcr_earlier",
      appAddress: account.address,
      network: "mainnet",
      gatewayUrl: "https://dp-rpc.vana.org",
      scopes: ["oura.sleep"],
      approvalUrl: "https://app.vana.org/approve/earlier",
      createdAt: "2026-10-01T00:00:00Z",
      status: "completed",
      updatedAt: "2026-10-01T00:00:00Z",
      grantId,
    });
    return requests;
  }

  function liveGateway(scopes: string[]) {
    const liveGrant = {
      id: GRANT,
      grantorAddress: OWNER,
      granteeId: BUILDER,
      scopes,
      revokedAt: null,
      expired: false,
      grantVersion: "3",
    };
    const client = {
      getGrant: vi.fn(async () => liveGrant as never),
      listGrantsByUser: vi.fn(async () => [liveGrant] as never),
      getBuilder: vi.fn(async () => ({ id: BUILDER }) as never),
    };
    return { client, createClient: vi.fn(() => client) };
  }

  /** Controller stub recording the configured scopes and the create input. */
  function recordingController() {
    const seen: { scopes?: string[]; input?: Record<string, unknown> } = {};
    const createController = ((config: { scopes: string[] }) => {
      seen.scopes = config.scopes;
      const inner = controller([{ status: "pending" }])() as {
        createAccessRequest: (input: Record<string, unknown>) => unknown;
      };
      return {
        ...inner,
        createAccessRequest: async (input: Record<string, unknown>) => {
          seen.input = input;
          return inner.createAccessRequest(input);
        },
      };
    }) as never;
    return { seen, createController };
  }

  it("keeps what the live grant covers, adds the new scope, drops removals", async () => {
    const requests = storeWithApproval();
    const gw = liveGateway(["oura.sleep", "github.repositories"]);
    const { seen, createController } = recordingController();
    const exitCode = await runAppRequest(
      {
        json: true,
        noInput: true,
        scopes: "whoop.recovery",
        removeScopes: "github.repositories",
      },
      {
        resolveKey: () => appKey,
        requests,
        createClient: gw.createClient,
        createController,
      },
    );
    expect(exitCode).toBe(7);
    expect(gw.client.listGrantsByUser).toHaveBeenCalledWith(OWNER);
    expect(seen.scopes).toEqual(["oura.sleep", "whoop.recovery"]);
    expect(seen.input).toMatchObject({ removeScopes: ["github.repositories"] });
    const outcome = appOutcomeSchema.parse(JSON.parse(stdout));
    expect(outcome.data).toMatchObject({
      scopes: ["oura.sleep", "whoop.recovery"],
      kept: ["oura.sleep"],
      added: ["whoop.recovery"],
      removed: ["github.repositories"],
      grantUnion: { status: "merged", owner: OWNER, grantId: GRANT },
    });
    expect(requests.get(REQUEST_ID)).toMatchObject({
      scopes: ["oura.sleep", "whoop.recovery"],
      removeScopes: ["github.repositories"],
    });
  });

  it("prints what will be kept, added and removed before creating", async () => {
    const gw = liveGateway(["oura.sleep", "github.repositories"]);
    let stderr = "";
    vi.mocked(process.stderr.write).mockImplementation((chunk) => {
      stderr += String(chunk);
      return true;
    });
    await runAppRequest(
      {
        noInput: true,
        scopes: "whoop.recovery",
        removeScopes: "github.repositories",
      },
      {
        resolveKey: () => appKey,
        requests: storeWithApproval(),
        createClient: gw.createClient,
        createController: controller([{ status: "pending" }]),
      },
    );
    expect(stderr).toContain(`Live grant  ${GRANT} (owner ${OWNER})`);
    expect(stderr).toContain("Keeping     oura.sleep");
    expect(stderr).toContain("Adding      whoop.recovery");
    expect(stderr).toContain("Removing    github.repositories");
  });

  it("reads nothing when this machine has no earlier approval", async () => {
    const gw = liveGateway(["oura.sleep"]);
    const { seen, createController } = recordingController();
    await runAppRequest(
      { json: true, noInput: true, scopes: "whoop.recovery" },
      {
        resolveKey: () => appKey,
        requests: store(),
        createClient: gw.createClient,
        createController,
      },
    );
    expect(gw.createClient).not.toHaveBeenCalled();
    expect(seen.scopes).toEqual(["whoop.recovery"]);
    expect(seen.input).not.toHaveProperty("removeScopes");
    const outcome = appOutcomeSchema.parse(JSON.parse(stdout));
    expect(outcome.data).toMatchObject({
      kept: [],
      added: ["whoop.recovery"],
      grantUnion: { status: "owner_unknown" },
    });
  });

  it("does not guess between two people who approved this app", async () => {
    const requests = storeWithApproval();
    requests.save({
      ...requests.get("dcr_earlier")!,
      requestId: "dcr_other",
      grantId: `0x${"22".repeat(32)}`,
    });
    const gw = liveGateway(["oura.sleep"]);
    const { seen, createController } = recordingController();
    await runAppRequest(
      { json: true, noInput: true, scopes: "whoop.recovery" },
      {
        resolveKey: () => appKey,
        requests,
        createClient: gw.createClient,
        createController,
      },
    );
    expect(gw.createClient).not.toHaveBeenCalled();
    expect(seen.scopes).toEqual(["whoop.recovery"]);
    const outcome = appOutcomeSchema.parse(JSON.parse(stdout));
    expect(outcome.data).toMatchObject({
      grantUnion: { status: "owner_ambiguous" },
    });
  });

  it("uses --owner to pick whose grant to extend", async () => {
    const gw = liveGateway(["oura.sleep"]);
    const { seen, createController } = recordingController();
    await runAppRequest(
      { json: true, noInput: true, scopes: "whoop.recovery", owner: OWNER },
      {
        resolveKey: () => appKey,
        requests: store(),
        createClient: gw.createClient,
        createController,
      },
    );
    expect(gw.client.getBuilder).toHaveBeenCalledWith(account.address);
    expect(seen.scopes).toEqual(["oura.sleep", "whoop.recovery"]);
  });

  it("sends --scopes verbatim with --no-merge-grant", async () => {
    const gw = liveGateway(["oura.sleep"]);
    const { seen, createController } = recordingController();
    await runAppRequest(
      {
        json: true,
        noInput: true,
        scopes: "whoop.recovery",
        mergeGrant: false,
      },
      {
        resolveKey: () => appKey,
        requests: storeWithApproval(),
        createClient: gw.createClient,
        createController,
      },
    );
    expect(gw.createClient).not.toHaveBeenCalled();
    expect(seen.scopes).toEqual(["whoop.recovery"]);
  });

  it("still creates the request when the gateway is down", async () => {
    const failing = {
      getGrant: vi.fn(async () => {
        throw new Error("ECONNREFUSED");
      }),
      listGrantsByUser: vi.fn(),
      getBuilder: vi.fn(),
    };
    const { seen, createController } = recordingController();
    const exitCode = await runAppRequest(
      { json: true, noInput: true, scopes: "whoop.recovery" },
      {
        resolveKey: () => appKey,
        requests: storeWithApproval(),
        createClient: () => failing as never,
        createController,
      },
    );
    expect(exitCode).toBe(7);
    expect(seen.scopes).toEqual(["whoop.recovery"]);
    const outcome = appOutcomeSchema.parse(JSON.parse(stdout));
    expect(outcome.data).toMatchObject({
      grantUnion: { status: "unavailable" },
    });
  });

  it("refuses a scope that is both requested and removed", async () => {
    const exitCode = await runAppRequest(
      {
        json: true,
        noInput: true,
        scopes: "whoop.recovery",
        removeScopes: "whoop.recovery",
      },
      {
        resolveKey: () => appKey,
        requests: store(),
        createController: () => {
          throw new Error("must not create a request");
        },
      },
    );
    expect(exitCode).toBe(2);
    expect(appOutcomeSchema.parse(JSON.parse(stdout)).message).toContain(
      "both requested and removed",
    );
  });

  it("refuses a malformed --remove-scopes entry before any call", async () => {
    const exitCode = await runAppRequest(
      {
        json: true,
        noInput: true,
        scopes: "whoop.recovery",
        removeScopes: "delete:oura.sleep",
      },
      {
        resolveKey: () => appKey,
        requests: store(),
        createClient: () => {
          throw new Error("must not read the gateway");
        },
        createController: () => {
          throw new Error("must not create a request");
        },
      },
    );
    expect(exitCode).toBe(2);
    expect(appOutcomeSchema.parse(JSON.parse(stdout)).message).toContain(
      "--remove-scopes delete:oura.sleep",
    );
  });

  it("leaves a live raw read of a question's source out of the request", async () => {
    // The service refuses a source that is also a raw read on the request.
    const gw = liveGateway(["github.repositories", "oura.sleep"]);
    const { seen, createController } = recordingController();
    const exitCode = await runAppRequest(
      {
        json: true,
        noInput: true,
        question: "Which languages?",
        derived: "myapp.languages",
        sources: "github.repositories",
      },
      {
        resolveKey: () => appKey,
        requests: storeWithApproval(),
        createClient: gw.createClient,
        createController,
      },
    );
    expect(exitCode).toBe(7);
    expect(seen.scopes).toEqual(["oura.sleep", "myapp.languages"]);
    const outcome = appOutcomeSchema.parse(JSON.parse(stdout));
    expect(outcome.data).toMatchObject({
      kept: ["oura.sleep"],
      grantUnion: { notCarried: ["github.repositories"] },
    });
  });

  it("rejects an --owner that is not an address", async () => {
    const exitCode = await runAppRequest(
      { json: true, noInput: true, scopes: "a.b", owner: "alice" },
      { resolveKey: () => appKey, requests: store() },
    );
    expect(exitCode).toBe(2);
  });
});
