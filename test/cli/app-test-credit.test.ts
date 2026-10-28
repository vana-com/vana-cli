import fs from "node:fs";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { privateKeyToAccount } from "viem/accounts";
import { verifyWeb3Signed } from "@opendatalabs/vana-sdk/auth/web3-signed";
import {
  runAppRequest,
  type RequestCommandOptions,
} from "../../src/cli/app/request.js";
import {
  runAppRequestsList,
  runAppRequestsShow,
} from "../../src/cli/app/requests.js";
import { appOutcomeSchema } from "../../src/cli/app/outcome.js";
import { createRequestsStore } from "../../src/core/requests-store.js";

const privateKey =
  "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d";
const account = privateKeyToAccount(privateKey);
const txHash = `0x${"a".repeat(64)}`;
let directory: string;
let stdout: string;
let operationStatus: string;
let pendingBalance: string;
let availableBalance: string;
let refusal: string | undefined;
let lost: boolean;
let posts: string[];
let polls: number;
let operations: Map<string, string>;
let createConsent: ReturnType<typeof vi.fn>;
let fetchCredit: typeof fetch;

const store = () => createRequestsStore(path.join(directory, "requests.json"));
const operation = (id: string) => ({
  id,
  appAddress: account.address,
  status: operationStatus,
  reason: "first_setup",
  amountWei: "1000000000000000000",
  txHash: operationStatus === "reserved" ? null : txHash,
  lastError: null,
});

beforeEach(() => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), "vana-test-credit-"));
  stdout = "";
  operationStatus = "submitted";
  pendingBalance = "0";
  availableBalance = "1000000000000000000";
  refusal = undefined;
  lost = false;
  posts = [];
  polls = 0;
  operations = new Map();
  vi.stubEnv("VANA_ENV", "dev");
  vi.stubEnv("VANA_NETWORK", "moksha");
  vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
    stdout += String(chunk);
    return true;
  });
  vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  createConsent = vi.fn(async () => ({
    requestId: "dcr_credit",
    approvalUrl: "https://app-dev.vana.org/approve/credit",
    appAddress: account.address,
    network: "moksha",
  }));
  fetchCredit = vi.fn(
    async (url: string | URL | Request, init?: RequestInit) => {
      const target = new URL(String(url));
      if (target.pathname === "/v1/escrow/balance/sync") {
        expect(target.origin).toBe("https://dp-rpc-dev.vana.org");
        expect(target.searchParams.get("account")?.toLowerCase()).toBe(
          account.address.toLowerCase(),
        );
        expect(new Headers(init?.headers).has("authorization")).toBe(false);
        return Response.json({
          account: account.address,
          balances: [
            {
              asset: "0x0000000000000000000000000000000000000000",
              availableAmount: availableBalance,
              pendingAmount: pendingBalance,
            },
          ],
        });
      }
      const body = init?.body
        ? new Uint8Array(init.body as Uint8Array)
        : undefined;
      const verified = await verifyWeb3Signed({
        headerValue:
          new Headers(init?.headers).get("authorization") ?? undefined,
        expectedOrigin: "https://account-dev.vana.org",
        expectedMethod: init?.method ?? "GET",
        expectedPath: target.pathname,
        bodyBytes: body,
      });
      expect(verified.signer.toLowerCase()).toBe(account.address.toLowerCase());
      expect(target.origin).toBe("https://account-dev.vana.org");
      if (init?.method === "POST") {
        const { idempotencyKey } = JSON.parse(new TextDecoder().decode(body));
        // This is inspected at the external boundary, before accepting any funds.
        expect(
          fs.readFileSync(path.join(directory, "requests.json"), "utf8"),
        ).toContain(idempotencyKey);
        posts.push(idempotencyKey);
        if (refusal)
          return Response.json(
            { error: { code: refusal } },
            {
              status:
                refusal === "claim_required"
                  ? 403
                  : refusal.includes("cap")
                    ? 429
                    : refusal === "balance_sufficient" || refusal === "inactive"
                      ? 422
                      : 503,
              headers: { "retry-after": "3600" },
            },
          );
        if (!operations.has(idempotencyKey))
          operations.set(idempotencyKey, "credit_1");
        if (lost) throw new Error("funding accepted, response lost");
        return Response.json(operation(operations.get(idempotencyKey)!), {
          status: 202,
        });
      }
      polls += 1;
      return Response.json(
        operation(decodeURIComponent(target.pathname.split("/").at(-1)!)),
      );
    },
  ) as typeof fetch;
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  fs.rmSync(directory, { recursive: true, force: true });
});

const deps = () => ({
  requests: store(),
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
    getAccessRequestStatus: async () => ({ status: "pending" }),
  })) as never,
});
async function invoke(
  options: RequestCommandOptions = {},
  dependencies = deps(),
) {
  stdout = "";
  await runAppRequest({ json: true, noInput: true, ...options }, dependencies);
  expect(stdout.trim().split("\n")).toHaveLength(1);
  return appOutcomeSchema.parse(JSON.parse(stdout));
}
const fresh = { scopes: "github.repositories", mergeGrant: false };

it.each(["response lost", "saving the operation failed"])(
  "resumes the same funding after %s, then only polls the saved operation",
  async (failure) => {
    lost = failure === "response lost";
    const dependencies = deps();
    if (!lost)
      dependencies.requests.updateFunding = () => {
        throw new Error("disk full");
      };
    const first = await invoke(fresh, dependencies);
    expect(first.exitCode).toBe(lost ? 6 : 1);
    expect(createConsent).not.toHaveBeenCalled();
    const setupId = String(first.data?.setupId);
    lost = false;
    const second = await invoke({ resume: setupId });
    expect(second.exitCode).toBe(6);
    expect(posts).toEqual([posts[0], posts[0]]);
    expect(operations.size).toBe(1);
    expect(store().getIntent(setupId)?.fundingProgress?.operationId).toBe(
      "credit_1",
    );
    operationStatus = "confirmed";
    expect((await invoke({ resume: setupId })).exitCode).toBe(7);
    expect(posts).toHaveLength(2);
    expect(polls).toBe(1);
    expect(createConsent).toHaveBeenCalledTimes(1);
    expect((await invoke({ resume: setupId })).exitCode).toBe(7);
    expect(posts).toHaveLength(2);
    expect(polls).toBe(1);
    expect(createConsent).toHaveBeenCalledTimes(1);
    expect(
      fs.statSync(path.join(directory, "requests.json")).mode & 0o777,
    ).toBe(0o600);
  },
);

it("holds consent until finalization and exposes pending funding without submitting during inspection", async () => {
  const first = await invoke(fresh);
  const setupId = String(first.data?.setupId);
  expect(first.exitCode).toBe(6);
  expect(first.data?.reason).toBe("funding_pending");
  expect(first.remedy).toContain(
    `VANA_ENV=dev vana app request --network moksha --resume ${setupId}`,
  );
  expect(createConsent).not.toHaveBeenCalled();
  stdout = "";
  await runAppRequestsList({ json: true, network: "moksha" }, deps());
  expect(JSON.parse(stdout).data.setups[0]).toMatchObject({
    setupId,
    stage: "test_credit",
    funding: { status: "pending", operationId: "credit_1" },
  });
  stdout = "";
  await runAppRequestsShow(setupId, { json: true, network: "moksha" }, deps());
  expect(JSON.parse(stdout).data.funding.operationId).toBe("credit_1");
  expect(posts).toHaveLength(1);
  expect(polls).toBe(0);
  expect((await invoke({ resume: setupId })).exitCode).toBe(6);
  expect(createConsent).not.toHaveBeenCalled();
  operationStatus = "confirmed";
  expect((await invoke({ resume: setupId })).exitCode).toBe(7);
  expect(posts).toHaveLength(1);
});

it("waits interactively using the same operation, then creates consent", async () => {
  let time = 0;
  const dependencies = {
    ...deps(),
    now: () => time,
    createController: (() => ({
      createAccessRequest: createConsent,
      getAccessRequestStatus: async () => ({ status: "denied" }),
    })) as never,
    sleep: async (ms: number) => {
      time += ms;
      operationStatus = "confirmed";
    },
  };
  expect(
    (await invoke({ ...fresh, noInput: false, timeout: "10" }, dependencies))
      .exitCode,
  ).toBe(3);
  expect(posts).toHaveLength(1);
  expect(polls).toBe(1);
  expect(createConsent).toHaveBeenCalledTimes(1);
});

it("uses sufficient escrow without another deposit", async () => {
  refusal = "balance_sufficient";
  expect((await invoke(fresh)).exitCode).toBe(7);
  expect(operations.size).toBe(0);
  expect(createConsent).toHaveBeenCalledTimes(1);
});

it.each([
  "account_cap_reached",
  "global_cap_reached",
  "inactive",
  "test_credits_disabled",
  "test_credits_paused",
  "test_credits_unavailable",
])("keeps %s resumable without creating consent", async (reason) => {
  refusal = reason;
  const first = await invoke(fresh);
  expect(first.exitCode).toBe(6);
  expect(first.data?.reason).toBe(reason);
  if (reason.includes("cap")) expect(first.data?.retryAfterSeconds).toBe(3600);
  expect(createConsent).not.toHaveBeenCalled();
  operationStatus = "confirmed";
  refusal = undefined;
  expect((await invoke({ resume: String(first.data?.setupId) })).exitCode).toBe(
    7,
  );
  expect(posts[1]).toBe(posts[0]);
});

it("returns a claim link for the same app and resumes its original funding request", async () => {
  refusal = "claim_required";
  const registerBuilder = vi.fn(async () => ({}));
  const first = await invoke(fresh, {
    ...deps(),
    createClient: () => ({
      isRegisteredBuilder: async () => false,
      registerBuilder,
    }),
  } as never);
  expect(first.exitCode).toBe(7);
  expect(first.data?.reason).toBe("claim_required");
  const claimUrl = new URL(String(first.data?.claimUrl));
  expect(claimUrl.origin).toBe("https://account-dev.vana.org");
  expect(claimUrl.searchParams.get("address")).toBe(
    account.address.toLowerCase(),
  );
  expect(registerBuilder).toHaveBeenCalledTimes(1);
  expect(createConsent).not.toHaveBeenCalled();
  refusal = undefined;
  operationStatus = "confirmed";
  expect((await invoke({ resume: String(first.data?.setupId) })).exitCode).toBe(
    7,
  );
  expect(posts[1]).toBe(posts[0]);
});

it("does not request credit on mainnet", async () => {
  vi.stubEnv("VANA_ENV", "prod");
  createConsent.mockResolvedValueOnce({
    requestId: "dcr_mainnet",
    approvalUrl: "https://app.vana.org/approve/mainnet",
    appAddress: account.address,
    network: "mainnet",
  });
  expect((await invoke({ ...fresh, network: "mainnet" })).exitCode).toBe(7);
  expect(fetchCredit).not.toHaveBeenCalled();
  expect(createConsent).toHaveBeenCalledTimes(1);
});

it.each([
  { network: "mainnet" },
  { scopes: "github.issues" },
  { appName: "Another app" },
])(
  "refuses changed resume context %j before touching funding",
  async (changed) => {
    const first = await invoke(fresh);
    const result = await invoke({
      resume: String(first.data?.setupId),
      ...changed,
    } as RequestCommandOptions);
    expect(result.exitCode).toBe(2);
    expect(posts).toHaveLength(1);
    expect(polls).toBe(0);
  },
);

it("leaves a failed operation for inspection instead of requesting a replacement", async () => {
  const first = await invoke(fresh);
  operationStatus = "failed";
  const setupId = String(first.data?.setupId);
  expect((await invoke({ resume: setupId })).data?.reason).toBe(
    "funding_failed",
  );
  expect((await invoke({ resume: setupId })).data?.reason).toBe(
    "funding_failed",
  );
  expect(posts).toHaveLength(1);
  expect(polls).toBe(1);
  expect(createConsent).not.toHaveBeenCalled();
});

it("does not transmit credit or consent if setup cannot be saved", async () => {
  fs.mkdirSync(path.join(directory, "requests.json"));
  expect((await invoke(fresh)).exitCode).toBe(1);
  expect(fetchCredit).not.toHaveBeenCalled();
  expect(createConsent).not.toHaveBeenCalled();
});

it("adopts an already-running service operation and resumes with GET only", async () => {
  const first = await invoke(fresh, {
    ...deps(),
    fetchTestCredit: async () =>
      Response.json(
        {
          error: { code: "operation_in_progress" },
          operation: operation("credit_existing"),
        },
        { status: 409 },
      ),
  });
  expect(first.exitCode).toBe(6);
  expect(first.data?.operationId).toBe("credit_existing");
  operationStatus = "confirmed";
  expect((await invoke({ resume: String(first.data?.setupId) })).exitCode).toBe(
    7,
  );
  expect(posts).toHaveLength(0);
  expect(polls).toBe(1);
});

it.each([
  "wrong app",
  "changed operation",
  "unknown state",
  "missing transaction",
  "non-JSON response",
])(
  "retains pending funding after a %s response without creating consent",
  async (fault) => {
    const first = await invoke(fresh);
    const setupId = String(first.data?.setupId);
    operationStatus = "confirmed";
    const broken = {
      ...operation("credit_1"),
      ...(fault === "wrong app" ? { appAddress: `0x${"2".repeat(40)}` } : {}),
      ...(fault === "changed operation" ? { id: "credit_other" } : {}),
      ...(fault === "unknown state" ? { status: "done" } : {}),
      ...(fault === "missing transaction" ? { txHash: null } : {}),
    };
    const result = await invoke(
      { resume: setupId },
      {
        ...deps(),
        fetchTestCredit: async () =>
          fault === "non-JSON response"
            ? new Response("unavailable", { status: 503 })
            : Response.json(broken),
      },
    );
    expect(result.exitCode).toBe(6);
    expect(store().getIntent(setupId)?.fundingProgress).toEqual({
      status: "pending",
      operationId: "credit_1",
    });
    expect(createConsent).not.toHaveBeenCalled();
    expect((await invoke({ resume: setupId })).exitCode).toBe(7);
    expect(posts).toHaveLength(1);
  },
);

it("refuses another app and environment before querying the saved funding", async () => {
  const first = await invoke(fresh);
  const setupId = String(first.data?.setupId);
  const dependencies = deps();
  dependencies.resolveKey = () => ({
    ...deps().resolveKey(),
    address: `0x${"2".repeat(40)}`,
  });
  expect((await invoke({ resume: setupId }, dependencies)).exitCode).toBe(2);
  vi.stubEnv("VANA_ENV", "prod");
  expect((await invoke({ resume: setupId })).exitCode).toBe(2);
  expect(posts).toHaveLength(1);
  expect(polls).toBe(0);
});

it("rejects a changed saved funding endpoint without transmitting anything", async () => {
  const first = await invoke(fresh);
  const file = path.join(directory, "requests.json");
  const saved = JSON.parse(fs.readFileSync(file, "utf8"));
  saved.intents[0].funding.accountUrl = "https://another.example";
  fs.writeFileSync(file, JSON.stringify(saved));
  expect((await invoke({ resume: String(first.data?.setupId) })).exitCode).toBe(
    1,
  );
  expect(posts).toHaveLength(1);
  expect(polls).toBe(0);
});

it("recovers the saved environment without an override", async () => {
  const first = await invoke(fresh);
  delete process.env.VANA_ENV;
  delete process.env.VANA_NETWORK;
  operationStatus = "confirmed";
  expect((await invoke({ resume: String(first.data?.setupId) })).exitCode).toBe(
    7,
  );
  expect(posts).toHaveLength(1);
  expect(polls).toBe(1);
});

it("repeating the original command points at the saved funding instead of creating a new operation", async () => {
  const first = await invoke(fresh);
  const second = await invoke(fresh);
  expect(second.exitCode).toBe(6);
  expect(second.data?.setupId).toBe(first.data?.setupId);
  expect(second.remedy).toContain(`--resume ${first.data?.setupId}`);
  expect(posts).toHaveLength(1);
});

it("resumes a pre-funding v1 consent intent without adding a credit request", async () => {
  fs.copyFileSync(
    new URL("../fixtures/consent-intent-v1.json", import.meta.url),
    path.join(directory, "requests.json"),
  );
  const result = await invoke({
    resume: "setup_00000000-0000-4000-8000-000000000001",
  });
  expect(result.exitCode).toBe(7);
  expect(fetchCredit).not.toHaveBeenCalled();
  expect(createConsent).toHaveBeenCalledTimes(1);
});

it("does not transmit anything while another live command holds the request journal", async () => {
  installLockOwner(process.pid);
  expect((await invoke(fresh)).exitCode).toBe(6);
  expect(fetchCredit).not.toHaveBeenCalled();
  expect(createConsent).not.toHaveBeenCalled();
});

it("a stale index read still points at the existing unfinished funding request", async () => {
  const first = await invoke(fresh);
  const dependencies = deps();
  dependencies.requests.listIntents = () => [];
  const second = await invoke(fresh, dependencies);
  expect(second.exitCode).toBe(6);
  expect(second.data?.setupId).toBe(first.data?.setupId);
  expect(store().listIntents()).toHaveLength(1);
  expect(posts).toHaveLength(1);
});

it("recovers the saved funding after its journal writer was interrupted", async () => {
  const first = await invoke(fresh);
  const departed = spawnSync(process.execPath, ["-e", ""], { stdio: "ignore" });
  expect(departed.status).toBe(0);
  installLockOwner(departed.pid);
  operationStatus = "confirmed";
  expect((await invoke({ resume: String(first.data?.setupId) })).exitCode).toBe(
    7,
  );
  expect(posts).toHaveLength(1);
  expect(polls).toBe(1);
  expect(createConsent).toHaveBeenCalledTimes(1);
});

it("does not mistake balance_sufficient with an unsettled deposit for usable credit", async () => {
  refusal = "balance_sufficient";
  pendingBalance = "1000000000000000000";
  availableBalance = "0";
  const first = await invoke(fresh);
  expect(first.exitCode).toBe(6);
  expect(createConsent).not.toHaveBeenCalled();
  const setupId = String(first.data?.setupId);
  expect(store().getIntent(setupId)?.fundingProgress?.status).toBe("pending");
  pendingBalance = "0";
  availableBalance = "1000000000000000000";
  expect((await invoke({ resume: setupId })).exitCode).toBe(7);
  expect(posts).toEqual([posts[0], posts[0]]);
  expect(operations.size).toBe(0);
});

function installLockOwner(pid: number) {
  const lock = path.join(directory, "requests.json.lock");
  fs.mkdirSync(lock);
  const owner = path.join(lock, "fixture-owner.json");
  fs.writeFileSync(owner, JSON.stringify({ pid }));
  return owner;
}

it("does not steal a newer writer's lock while recovering a dead writer", async () => {
  const departed = spawnSync(process.execPath, ["-e", ""], { stdio: "ignore" });
  expect(departed.status).toBe(0);
  const oldOwner = installLockOwner(departed.pid);
  const lock = path.dirname(oldOwner);
  const unlink = fs.unlinkSync;
  let replaced = false;
  vi.spyOn(fs, "unlinkSync").mockImplementation((file) => {
    if (String(file) === oldOwner && !replaced) {
      replaced = true;
      unlink(oldOwner);
      fs.rmdirSync(lock);
      fs.mkdirSync(lock);
      fs.writeFileSync(
        path.join(lock, "successor.json"),
        JSON.stringify({ pid: process.pid }),
      );
    }
    unlink(file);
  });
  await invoke(fresh);
  expect(replaced).toBe(true);
  expect(fetchCredit).not.toHaveBeenCalled();
  expect(store().listIntents()).toHaveLength(0);
  expect(fs.existsSync(path.join(lock, "successor.json"))).toBe(true);
});
