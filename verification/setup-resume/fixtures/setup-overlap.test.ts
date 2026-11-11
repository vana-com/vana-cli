import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { privateKeyToAccount } from "viem/accounts";
import { runAppRequest } from "../../src/cli/app/request.js";
import { createRequestsStore } from "../../src/core/requests-store.js";
import { appOutcomeSchema } from "../../src/cli/app/outcome.js";

// Public test key, also used by the owning recovery tests.
const privateKey =
  "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d";
const account = privateKeyToAccount(privateKey);
let directory: string;
let outcomes: ReturnType<typeof appOutcomeSchema.parse>[];

beforeEach(() => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), "vana-setup-overlap-"));
  outcomes = [];
  vi.stubEnv("VANA_ENV", "dev");
  vi.stubEnv("VANA_NETWORK", "moksha");
  vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
    outcomes.push(appOutcomeSchema.parse(JSON.parse(String(chunk))));
    return true;
  });
  vi.spyOn(process.stderr, "write").mockImplementation(() => true);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  fs.rmSync(directory, { recursive: true, force: true });
});

it("does not transmit after a pre-POST journal write failure", async () => {
  const requests = createRequestsStore(path.join(directory, "requests.json"));
  requests.saveIntent = () => {
    throw new Error("fixture: rename failed");
  };
  const fetchCredit = vi.fn(async () => {
    throw new Error("unexpected transmission");
  });
  const createConsent = vi.fn(async () => {
    throw new Error("unexpected consent");
  });
  const result = await runAppRequest(
    { json: true, noInput: true, scopes: "github.repositories" },
    {
      requests,
      resolveKey: () => ({
        privateKey,
        address: account.address,
        publicKey: account.publicKey,
        source: "env" as const,
      }),
      readProfile: () => ({}),
      fetchTestCredit: fetchCredit,
      createController: (() => ({
        createAccessRequest: createConsent,
      })) as never,
    },
  );
  expect(result).toBe(1);
  expect(fetchCredit).not.toHaveBeenCalled();
  expect(createConsent).not.toHaveBeenCalled();
});

it.each([
  ["known operation", "confirmed"],
  ["unknown operation", "confirmed"],
  ["known operation", "failed"],
  ["unknown operation", "failed"],
])(
  "retains terminal funding when overlapping resumes reorder %s / %s",
  async (identity, terminal) => {
    const requests = createRequestsStore(path.join(directory, "requests.json"));
    const fundingKeys = new Set<string>();
    const consentKeys = new Set<string>();
    let initial = true;
    let calls = 0;
    let posts = 0;
    let gets = 0;
    let releaseStale!: () => void;
    let reachedStale!: () => void;
    const staleReached = new Promise<void>((resolve) => {
      reachedStale = resolve;
    });
    const staleRelease = new Promise<void>((resolve) => {
      releaseStale = resolve;
    });
    const operation = (status: string) =>
      Response.json(
        {
          id: "credit_overlap",
          appAddress: account.address,
          status,
          reason: "first_setup",
          amountWei: "1000000000000000000",
          txHash: `0x${"a".repeat(64)}`,
          lastError: null,
        },
        { status: 200 },
      );
    const fetchCredit: typeof fetch = async (url, init) => {
      const target = new URL(String(url));
      expect(target.origin).toBe("https://account-dev.vana.org");
      if (init?.method === "POST") {
        expect(target.pathname).toBe("/api/v1/moksha-test-credits");
        const body = JSON.parse(
          new TextDecoder().decode(init.body as Uint8Array),
        );
        expect(
          fs.readFileSync(path.join(directory, "requests.json"), "utf8"),
        ).toContain(body.idempotencyKey);
        fundingKeys.add(body.idempotencyKey);
        posts += 1;
      } else {
        expect(target.pathname).toBe(
          "/api/v1/moksha-test-credits/operations/credit_overlap",
        );
        gets += 1;
      }
      if (initial) {
        if (identity === "unknown operation")
          throw new Error("fixture accepted funding; response lost");
        return operation("submitted");
      }
      calls += 1;
      if (calls === 1) {
        reachedStale();
        await staleRelease;
        return operation("submitted");
      }
      return operation(terminal);
    };
    const deps = {
      requests,
      resolveKey: () => ({
        privateKey,
        address: account.address,
        publicKey: account.publicKey,
        source: "env" as const,
      }),
      readProfile: () => ({}),
      fetchTestCredit: fetchCredit,
      createController: (() => ({
        createAccessRequest: async (input: { idempotencyKey: string }) => {
          consentKeys.add(input.idempotencyKey);
          return {
            requestId: "dcr_overlap",
            approvalUrl: "https://app-dev.vana.org/approve/overlap",
            appAddress: account.address,
            network: "moksha",
          };
        },
        getAccessRequestStatus: async () => ({ status: "pending" }),
      })) as never,
    };
    await runAppRequest(
      { json: true, noInput: true, scopes: "github.repositories" },
      deps,
    );
    expect(outcomes.at(-1)?.exitCode).toBe(6);
    const setupId = requests.listIntents()[0].setupId;
    initial = false;
    const resume = () =>
      runAppRequest({ json: true, noInput: true, resume: setupId }, deps);
    const stale = resume();
    await staleReached;
    await resume();
    releaseStale();
    await stale;
    const expected = terminal === "confirmed" ? "funded" : "failed";
    expect(requests.getIntent(setupId)?.fundingProgress?.status).toBe(expected);
    expect(outcomes.slice(1).map((outcome) => outcome.exitCode)).toEqual(
      terminal === "confirmed" ? [7, 7] : [6, 6],
    );
    expect(fundingKeys.size).toBe(1);
    expect(consentKeys.size).toBe(terminal === "confirmed" ? 1 : 0);
    expect(posts).toBe(identity === "known operation" ? 1 : 3);
    expect(gets).toBe(identity === "known operation" ? 2 : 0);
    const callsBefore = calls;
    await resume();
    expect(calls).toBe(callsBefore);
    expect(consentKeys.size).toBe(terminal === "confirmed" ? 1 : 0);
  },
);
