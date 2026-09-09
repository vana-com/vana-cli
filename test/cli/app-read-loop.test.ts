import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GatewayClient } from "@opendatalabs/vana-sdk";
import { privateKeyToAccount } from "viem/accounts";
import { runAppRead } from "../../src/cli/app/read.js";
import {
  InsufficientFundsError,
  runAppEscrowBalance,
  runAppEscrowFund,
} from "../../src/cli/app/escrow.js";
import { runAppOnchain } from "../../src/cli/app/onchain.js";
import { appOutcomeSchema } from "../../src/cli/app/outcome.js";
import { createReceiptsStore, receiptKey } from "../../src/core/receipts.js";
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
const OWNER = "0x2222222222222222222222222222222222222222";

function paymentRequiredError(amount: string): Error {
  const error = new Error("payment required");
  error.name = "PaymentRequiredError";
  (error as unknown as { details: unknown }).details = {
    amount,
    asset: "0x0000000000000000000000000000000000000000",
  };
  return error;
}

function grantClient(overrides: Partial<GatewayClient> = {}): GatewayClient {
  return {
    getGrant: async () => ({
      id: GRANT,
      grantorAddress: OWNER,
      granteeId: "g",
      scopes: ["github.repos"],
      status: "active",
      addedAt: "",
      expiresAt: null,
    }),
    listServersByOwner: async () => ({
      active: [
        {
          id: "s1",
          ownerAddress: OWNER,
          serverAddress: "0x3",
          publicKey: "0x04",
          serverUrl: "https://ps.example",
          status: "finalized",
          chainBlockHeight: null,
          addedAt: "",
          revokedAt: null,
        },
      ],
      revoked: [],
      count: 1,
    }),
    ...overrides,
  } as GatewayClient;
}

let stdout: string;
let tempDir: string;

beforeEach(() => {
  stdout = "";
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "vana-receipts-"));
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
  return createReceiptsStore(path.join(tempDir, "receipts.json"));
}

describe("receipts store", () => {
  it("keeps nonces monotonic across instances", () => {
    const file = path.join(tempDir, "receipts.json");
    expect(createReceiptsStore(file).nextNonce("0xAb")).toBe(1n);
    expect(createReceiptsStore(file).nextNonce("0xab")).toBe(2n);
    expect(createReceiptsStore(file).nextNonce("0xCD")).toBe(1n);
  });

  it("saves, returns and drops receipts", () => {
    const s = store();
    const key = receiptKey("moksha", GRANT, "github.repos");
    expect(s.getReceipt(key)).toBeNull();
    s.saveReceipt(key, {
      header: "h",
      amount: "1",
      asset: "0x0",
      capturedAt: "now",
    });
    expect(s.getReceipt(key)?.header).toBe("h");
    s.dropReceipt(key);
    expect(s.getReceipt(key)).toBeNull();
  });
});

describe("vana app read", () => {
  it("rejects a grant that does not cover the scope with exit 3", async () => {
    const exitCode = await runAppRead(
      "spotify.history",
      { json: true, grant: GRANT },
      {
        resolveKey: () => appKey,
        createClient: () => grantClient(),
        receipts: store(),
      },
    );
    expect(exitCode).toBe(3);
    const outcome = appOutcomeSchema.parse(JSON.parse(stdout));
    expect(outcome.code).toBe("grant_invalid");
    expect(outcome.remedy).toContain("github.repos");
  });

  it("reports owner_not_ready as exit 5 when no server is registered", async () => {
    const exitCode = await runAppRead(
      "github.repos",
      { json: true, grant: GRANT },
      {
        resolveKey: () => appKey,
        createClient: () =>
          grantClient({
            listServersByOwner: async () => ({
              active: [],
              revoked: [],
              count: 0,
            }),
          }),
        receipts: store(),
      },
    );
    expect(exitCode).toBe(5);
    expect(appOutcomeSchema.parse(JSON.parse(stdout)).code).toBe(
      "owner_not_ready",
    );
  });

  it("stops at exit 4 with the amount when --pay is not set", async () => {
    const exitCode = await runAppRead(
      "github.repos",
      { json: true, grant: GRANT },
      {
        resolveKey: () => appKey,
        createClient: () => grantClient(),
        receipts: store(),
        read: async () => {
          throw paymentRequiredError("250000000000000000");
        },
      },
    );
    expect(exitCode).toBe(4);
    const outcome = appOutcomeSchema.parse(JSON.parse(stdout));
    expect(outcome.code).toBe("payment_required");
    expect(outcome.data).toMatchObject({ amountVana: "0.25" });
    expect(outcome.remedy).toContain("--pay");
  });

  it("refuses fees above --max-fee with exit 4", async () => {
    const exitCode = await runAppRead(
      "github.repos",
      { json: true, grant: GRANT, pay: true, maxFee: "0.1" },
      {
        resolveKey: () => appKey,
        createClient: () => grantClient(),
        receipts: store(),
        read: async () => {
          throw paymentRequiredError("250000000000000000");
        },
      },
    );
    expect(exitCode).toBe(4);
    expect(appOutcomeSchema.parse(JSON.parse(stdout)).code).toBe(
      "max_fee_exceeded",
    );
  });

  it("pays once, captures the receipt, and replays it on the next read", async () => {
    const receipts = store();
    let calls = 0;
    const read = vi.fn(
      async (params: {
        escrow?: unknown;
        fetchFn?: (
          input: string,
          init: { method: string; headers: Record<string, string> },
        ) => Promise<unknown>;
      }) => {
        calls += 1;
        if (calls === 1) {
          // Probe without escrow: 402.
          throw paymentRequiredError("250000000000000000");
        }
        if (calls === 2) {
          // Paid attempt: the CLI's fetch wrapper sees the signed header.
          vi.stubGlobal(
            "fetch",
            vi.fn(async () => ({ ok: true, status: 200 })),
          );
          await params.fetchFn?.("https://ps.example/v1/data/github.repos", {
            method: "GET",
            headers: { "X-PAYMENT": "signed-header-1" },
          });
          return { data: { rows: 1 }, payment: { opId: "op-1" } };
        }
        // Replay probe on a later invocation: header comes from the store.
        vi.stubGlobal(
          "fetch",
          vi.fn(async () => ({ ok: true, status: 200 })),
        );
        const init = {
          method: "GET",
          headers: {} as Record<string, string>,
        };
        await params.fetchFn?.("https://ps.example/v1/data/github.repos", init);
        expect(init.headers["X-PAYMENT"]).toBeUndefined();
        return { data: { rows: 1, replay: true }, payment: undefined };
      },
    );

    const paidExit = await runAppRead(
      "github.repos",
      { json: true, grant: GRANT, pay: true },
      {
        resolveKey: () => appKey,
        createClient: () => grantClient(),
        receipts,
        read: read as never,
      },
    );
    expect(paidExit).toBe(0);
    const paidOutcome = appOutcomeSchema.parse(
      JSON.parse(stdout.trim().split("\n").pop() as string),
    );
    expect(paidOutcome.data).toMatchObject({ paid: true });

    const key = receiptKey("moksha", GRANT, "github.repos");
    expect(receipts.getReceipt(key)?.header).toBe("signed-header-1");

    // Next invocation: the stored header is offered to the probe read.
    stdout = "";
    const replayExit = await runAppRead(
      "github.repos",
      { json: true, grant: GRANT },
      {
        resolveKey: () => appKey,
        createClient: () => grantClient(),
        receipts,
        read: async (params) => {
          const fetchMock = vi.fn(async () => ({ ok: true, status: 200 }));
          vi.stubGlobal("fetch", fetchMock);
          await (
            params as {
              fetchFn: (
                input: string,
                init: { method: string; headers: Record<string, string> },
              ) => Promise<unknown>;
            }
          ).fetchFn("https://ps.example/v1/data/github.repos", {
            method: "GET",
            headers: {},
          });
          const sentInit = fetchMock.mock.calls[0]?.[1] as {
            headers: Record<string, string>;
          };
          expect(sentInit.headers["X-PAYMENT"]).toBe("signed-header-1");
          return { data: { ok: true } };
        },
      },
    );
    expect(replayExit).toBe(0);
    expect(appOutcomeSchema.parse(JSON.parse(stdout)).data).toMatchObject({
      paid: false,
      replayedReceipt: true,
    });
  });

  it("tries the next registration when a server is dead", async () => {
    const urls: string[] = [];
    const exitCode = await runAppRead(
      "github.repos",
      { json: true, grant: GRANT },
      {
        resolveKey: () => appKey,
        createClient: () =>
          grantClient({
            listServersByOwner: async () => ({
              active: [
                { serverUrl: "https://dead.example" },
                { serverUrl: "https://alive.example" },
              ] as never,
              revoked: [],
              count: 2,
            }),
          }),
        receipts: store(),
        read: async (params) => {
          urls.push(
            (params as { personalServerUrl: string }).personalServerUrl,
          );
          if (urls.length === 1) {
            throw new Error("fetch failed");
          }
          return { data: { ok: true } };
        },
      },
    );
    expect(exitCode).toBe(0);
    expect(urls).toEqual(["https://dead.example", "https://alive.example"]);
  });

  it("exits 5 when every registration fails", async () => {
    const exitCode = await runAppRead(
      "github.repos",
      { json: true, grant: GRANT },
      {
        resolveKey: () => appKey,
        createClient: () => grantClient(),
        receipts: store(),
        read: async () => {
          throw new Error("connect ECONNREFUSED");
        },
      },
    );
    expect(exitCode).toBe(5);
    expect(appOutcomeSchema.parse(JSON.parse(stdout)).code).toBe(
      "server_unavailable",
    );
  });
});

describe("vana app escrow", () => {
  it("prints the available balance", async () => {
    const exitCode = await runAppEscrowBalance(
      { json: true },
      {
        resolveKey: () => appKey,
        createClient: () =>
          ({
            getEscrowBalance: async () => ({
              account: appKey.address,
              balances: [
                {
                  asset: "0x0000000000000000000000000000000000000000",
                  balance: "1000000000000000000",
                  pendingAmount: "0",
                  authorizedAmount: "0",
                  availableAmount: "750000000000000000",
                  updatedAt: null,
                },
              ],
              deposits: { submitted: [], finalized: [], failed: [] },
            }),
          }) as never,
      },
    );
    expect(exitCode).toBe(0);
    const outcome = appOutcomeSchema.parse(JSON.parse(stdout));
    expect(outcome.message).toContain("0.75 VANA available");
  });

  it("requires --yes on mainnet with exit 7", async () => {
    const exitCode = await runAppEscrowFund(
      { json: true, network: "mainnet", amount: "1" },
      { resolveKey: () => appKey },
    );
    expect(exitCode).toBe(7);
    expect(appOutcomeSchema.parse(JSON.parse(stdout)).code).toBe(
      "confirmation_required",
    );
  });

  it("maps an empty wallet to exit 4 with the faucet remedy", async () => {
    const exitCode = await runAppEscrowFund(
      { json: true, amount: "1" },
      {
        resolveKey: () => appKey,
        sendDeposit: async () => {
          throw new InsufficientFundsError(0n, 10n ** 18n);
        },
      },
    );
    expect(exitCode).toBe(4);
    const outcome = appOutcomeSchema.parse(JSON.parse(stdout));
    expect(outcome.remedy).toContain("faucet");
  });

  it("runs both halves and reports the tx", async () => {
    const submitted: string[] = [];
    const exitCode = await runAppEscrowFund(
      { json: true, amount: "0.5" },
      {
        resolveKey: () => appKey,
        sendDeposit: async () => ({ txHash: "0xdeadbeef" as never }),
        createClient: () =>
          ({
            submitEscrowDeposit: async (params: { txHash: string }) => {
              submitted.push(params.txHash);
              return { status: "submitted" };
            },
          }) as never,
      },
    );
    expect(exitCode).toBe(0);
    expect(submitted).toEqual(["0xdeadbeef"]);
    expect(appOutcomeSchema.parse(JSON.parse(stdout)).data).toMatchObject({
      txHash: "0xdeadbeef",
      gatewayStatus: "submitted",
    });
  });
});

describe("vana app onchain", () => {
  it("requires --owner with exit 2", async () => {
    const exitCode = await runAppOnchain("github.repos", { json: true }, {});
    expect(exitCode).toBe(2);
  });

  it("maps a missing data point to exit 5", async () => {
    const exitCode = await runAppOnchain(
      "github.repos",
      { json: true, owner: OWNER },
      { createClient: () => ({ getDataPoint: async () => null }) as never },
    );
    expect(exitCode).toBe(5);
    expect(appOutcomeSchema.parse(JSON.parse(stdout)).code).toBe(
      "scope_not_found",
    );
  });

  it("prints the record when it exists", async () => {
    const exitCode = await runAppOnchain(
      "github.repos",
      { json: true, owner: OWNER },
      {
        createClient: () =>
          ({
            getDataPoint: async (id: string) => ({
              id,
              ownerAddress: OWNER,
              scope: "github.repos",
              dataHash: "0xd",
              metadataHash: "0xm",
              expectedVersion: "3",
              addedAt: "2026-09-01T00:00:00Z",
              deletedAt: null,
            }),
          }) as never,
      },
    );
    expect(exitCode).toBe(0);
    const outcome = appOutcomeSchema.parse(JSON.parse(stdout));
    expect(outcome.data).toMatchObject({ version: "3", scope: "github.repos" });
  });
});
