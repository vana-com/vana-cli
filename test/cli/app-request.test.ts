import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { privateKeyToAccount } from "viem/accounts";
import { runAppRequest } from "../../src/cli/app/request.js";
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
      },
    );
    expect(exitCode).toBe(0);
    const outcome = appOutcomeSchema.parse(JSON.parse(stdout));
    expect(outcome.data).toMatchObject({
      status: "approved",
      grantId: GRANT,
      live: true,
    });
    // The refresh is written back, so a later offline show still knows.
    expect(requests.get(REQUEST_ID)?.grantId).toBe(GRANT);
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
