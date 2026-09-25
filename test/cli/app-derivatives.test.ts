import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { privateKeyToAccount } from "viem/accounts";
import { runAppAsk } from "../../src/cli/app/ask.js";
import { runAppLineage, runAppStatus } from "../../src/cli/app/derivatives.js";
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
const GRANT =
  "0x1111111111111111111111111111111111111111111111111111111111111111";
const DERIVED = "myapp.summary";

let stdout: string;
let tempDir: string;

beforeEach(() => {
  // The fixtures below are moksha; mainnet is the default network.
  vi.stubEnv("VANA_NETWORK", "moksha");
  stdout = "";
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "vana-derivatives-"));
  vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
    stdout += String(chunk);
    return true;
  });
  vi.spyOn(process.stderr, "write").mockImplementation(() => true);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

/** A store already holding one approved request covering the derived scope. */
function storeWithGrant() {
  const store = createRequestsStore(path.join(tempDir, "requests.json"));
  store.save({
    requestId: "dcr_1",
    appAddress: account.address,
    network: "moksha",
    gatewayUrl: "https://dp-rpc.moksha.vana.org",
    scopes: ["spotify.history", DERIVED],
    approvalUrl: "https://app.vana.org/x",
    createdAt: new Date().toISOString(),
    status: "approved",
    updatedAt: new Date().toISOString(),
    grantId: GRANT,
    approvedScopes: ["spotify.history", DERIVED],
    personalServerUrl: "https://ps.example",
  });
  return store;
}

describe("vana app status", () => {
  it("resolves the grant and server from the local request index", async () => {
    let seen: Record<string, unknown> | undefined;
    const exitCode = await runAppStatus(
      DERIVED,
      { json: true },
      {
        resolveKey: () => appKey,
        requests: storeWithGrant(),
        status: (async (params: Record<string, unknown>) => {
          seen = params;
          return {
            derivedScope: DERIVED,
            status: "ready",
            derivedVersion: 3,
            lastComputedAt: "2026-09-12T00:00:00Z",
            errorCode: null,
            retryAfterSeconds: null,
            derivedCollectedAt: null,
          };
        }) as never,
      },
    );
    expect(exitCode).toBe(0);
    expect(seen).toMatchObject({
      grantId: GRANT,
      personalServerUrl: "https://ps.example",
      derivedScope: DERIVED,
    });
    const outcome = appOutcomeSchema.parse(JSON.parse(stdout));
    expect(outcome.data).toMatchObject({ state: "ready", version: 3 });
    expect(outcome.remedy).toContain(`--grant ${GRANT}`);
  });

  it("reports compute cost as unknown, not as free", async () => {
    // Compute emits no fee event today. null says unpriced; a price lands
    // here as a number without changing the payload shape.
    await runAppStatus(
      DERIVED,
      { json: true },
      {
        resolveKey: () => appKey,
        requests: storeWithGrant(),
        status: (async () => ({
          derivedScope: DERIVED,
          status: "ready",
          derivedVersion: 1,
          lastComputedAt: null,
          errorCode: null,
          retryAfterSeconds: null,
          derivedCollectedAt: null,
        })) as never,
      },
    );
    const outcome = appOutcomeSchema.parse(JSON.parse(stdout));
    expect(outcome.data).toHaveProperty("computeCost", null);
  });

  it("maps a pending answer to exit 6 with the server's own retry hint", async () => {
    const exitCode = await runAppStatus(
      DERIVED,
      { json: true },
      {
        resolveKey: () => appKey,
        requests: storeWithGrant(),
        status: (async () => ({
          derivedScope: DERIVED,
          status: "pending",
          derivedVersion: null,
          lastComputedAt: null,
          errorCode: null,
          retryAfterSeconds: 30,
          derivedCollectedAt: null,
        })) as never,
      },
    );
    expect(exitCode).toBe(6);
    const outcome = appOutcomeSchema.parse(JSON.parse(stdout));
    expect(outcome.remedy).toBe("retry in 30s");
  });

  it("maps a failed computation to the matching protocol code", async () => {
    const exitCode = await runAppStatus(
      DERIVED,
      { json: true },
      {
        resolveKey: () => appKey,
        requests: storeWithGrant(),
        status: (async () => ({
          derivedScope: DERIVED,
          status: "failed",
          derivedVersion: null,
          lastComputedAt: null,
          errorCode: "source_missing",
          retryAfterSeconds: null,
          derivedCollectedAt: null,
        })) as never,
      },
    );
    expect(exitCode).toBe(5);
    expect(appOutcomeSchema.parse(JSON.parse(stdout)).code).toBe(
      "scope_not_found",
    );
  });

  it("names the server version when the status route is missing", async () => {
    // A 404 on /v1/derivatives/status means personal-server-ts older than
    // 1.14.0, which is what an out-of-date Desktop app bundles. Saying
    // "Not found" sent people looking for a lost answer.
    const exitCode = await runAppStatus(
      DERIVED,
      { json: true },
      {
        resolveKey: () => appKey,
        requests: storeWithGrant(),
        status: (async () => {
          throw new Error("Derivative status read failed: Not found");
        }) as never,
      },
    );
    expect(exitCode).toBe(5);
    const outcome = appOutcomeSchema.parse(JSON.parse(stdout));
    expect(outcome.message).toContain("older than 1.14.0");
    expect(outcome.remedy).toContain("update");
  });

  it("refuses with exit 3 when nothing grants the scope", async () => {
    const exitCode = await runAppStatus(
      DERIVED,
      { json: true },
      {
        resolveKey: () => appKey,
        requests: createRequestsStore(path.join(tempDir, "empty.json")),
      },
    );
    expect(exitCode).toBe(3);
    const outcome = appOutcomeSchema.parse(JSON.parse(stdout));
    expect(outcome.code).toBe("grant_invalid");
    expect(outcome.remedy).toContain("vana app request");
  });
});

describe("vana app lineage", () => {
  it("returns the redacted view", async () => {
    const exitCode = await runAppLineage(
      DERIVED,
      { json: true },
      {
        resolveKey: () => appKey,
        requests: storeWithGrant(),
        lineage: (async () => ({
          nodes: [{ scope: "spotify.history" }],
        })) as never,
      },
    );
    expect(exitCode).toBe(0);
    expect(appOutcomeSchema.parse(JSON.parse(stdout)).data).toMatchObject({
      scope: DERIVED,
    });
  });
});

describe("vana app ask", () => {
  it("requires a question, sources and a derived scope", async () => {
    const exitCode = await runAppAsk("", { json: true }, {});
    expect(exitCode).toBe(2);
    expect(appOutcomeSchema.parse(JSON.parse(stdout)).code).toBe("bad_usage");
  });

  it("refuses --registered honestly instead of half-implementing it", async () => {
    const exitCode = await runAppAsk(
      "what?",
      {
        json: true,
        sources: "spotify.history",
        derived: DERIVED,
        registered: true,
      },
      {},
    );
    expect(exitCode).toBe(2);
    expect(appOutcomeSchema.parse(JSON.parse(stdout)).message).toContain(
      "read grant on every source scope",
    );
  });

  it("carries the question through consent and grants the derived scope too", async () => {
    let requested: Record<string, unknown> | undefined;
    const exitCode = await runAppAsk(
      "Which genres this month?",
      { json: true, sources: "spotify.history", derived: DERIVED },
      {
        request: (async (options: Record<string, unknown>) => {
          requested = options;
          return 0;
        }) as never,
        status: (async () => 0) as never,
        read: (async () => 0) as never,
      },
    );
    // The read leg fails to find a grant in this empty HOME, which is its
    // own tested path; what matters here is what the request carried.
    expect([0, 3]).toContain(exitCode);
    expect(requested).toMatchObject({
      question: "Which genres this month?",
      derived: DERIVED,
      // The derived scope must be granted as a plain read as well.
      scopes: `spotify.history,${DERIVED}`,
    });
  });

  it("stops at the request's own outcome when a person must act", async () => {
    const exitCode = await runAppAsk(
      "what?",
      { json: true, sources: "spotify.history", derived: DERIVED },
      {
        request: (async () => 7) as never,
        status: (async () => 0) as never,
        read: (async () => 0) as never,
      },
    );
    expect(exitCode).toBe(7);
  });
});
