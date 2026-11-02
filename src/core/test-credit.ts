/** App-key authenticated access to Account's Moksha test-credit service. */
import { randomUUID } from "node:crypto";
import { buildWeb3SignedHeader } from "@opendatalabs/vana-sdk/auth/web3-signed-builder";
import { privateKeyToAccount } from "viem/accounts";
import { z } from "zod";
import type { ResolvedNetwork } from "./network.js";
import { NATIVE_ASSET } from "./assets.js";

const CREATE_PATH = "/api/v1/moksha-test-credits";
const operationSchema = z.object({
  id: z.string().min(1).max(128),
  appAddress: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
  status: z.enum(["reserved", "signed", "submitted", "confirmed", "failed"]),
  reason: z.enum(["first_setup", "low_balance"]),
  amountWei: z.string().regex(/^\d+$/),
  txHash: z
    .string()
    .regex(/^0x[0-9a-fA-F]{64}$/)
    .nullable(),
  lastError: z.string().nullable(),
});

/** A funding operation; only Account's `confirmed` state means usable credit. */
export type TestCreditOperation = z.infer<typeof operationSchema>;

/** One service response, without hiding a retry or choosing a new funding key. */
export type TestCreditResponse =
  | { status: "operation"; operation: TestCreditOperation }
  | { status: "not_needed" }
  | { status: "pending" }
  | { status: "refused"; code: string; retryAfterSeconds?: number };

/**
 * Create/replay a funding request, or inspect a known operation with GET only.
 * The caller must persist the idempotency key before calling this function.
 */
export async function requestTestCredit(input: {
  network: ResolvedNetwork;
  privateKey: `0x${string}`;
  idempotencyKey: string;
  operationId?: string;
  fetchFn?: typeof fetch;
}): Promise<TestCreditResponse> {
  if (input.network.name !== "moksha")
    throw new Error("Test credit is only available on Moksha.");
  const account = privateKeyToAccount(input.privateKey);
  const origin = new URL(input.network.accountUrl).origin;
  const uri = input.operationId
    ? `${CREATE_PATH}/operations/${encodeURIComponent(input.operationId)}`
    : CREATE_PATH;
  const method = input.operationId ? "GET" : "POST";
  const body = input.operationId
    ? undefined
    : new TextEncoder().encode(
        JSON.stringify({ idempotencyKey: input.idempotencyKey }),
      );
  const response = await (input.fetchFn ?? fetch)(`${origin}${uri}`, {
    method,
    headers: {
      ...(body ? { "content-type": "application/json" } : {}),
      authorization: await buildWeb3SignedHeader({
        signMessage: (message) => account.signMessage({ message }),
        aud: origin,
        method,
        uri,
        body,
        nonce: randomUUID(),
      }),
    },
    body,
    redirect: "error",
    signal: AbortSignal.timeout(15_000),
  });
  const payload: unknown = await response.json();
  if (
    response.status === 200 ||
    (!input.operationId && response.status === 202) ||
    (!input.operationId && response.status === 409)
  ) {
    const operation = operationSchema.parse(
      response.status === 409
        ? z.object({ operation: operationSchema }).parse(payload).operation
        : payload,
    );
    if (
      operation.appAddress.toLowerCase() !== account.address.toLowerCase() ||
      (input.operationId && operation.id !== input.operationId) ||
      (operation.status === "confirmed" && !operation.txHash)
    )
      throw new Error("Conflicting test-credit operation identity.");
    return { status: "operation", operation };
  }
  const error = z
    .object({ error: z.object({ code: z.string() }) })
    .safeParse(payload);
  if (
    !input.operationId &&
    response.status === 422 &&
    error.success &&
    error.data.error.code === "balance_sufficient"
  ) {
    // Eligibility includes pending deposits to prevent another top-up. Only
    // finalized credit is spendable; reconcile existing deposits before setup
    // treats the refusal as readiness. This never transfers or pays funds.
    const synced = await (input.fetchFn ?? fetch)(
      `${input.network.gatewayUrl}/v1/escrow/balance/sync?account=${encodeURIComponent(account.address)}`,
      {
        method: "POST",
        cache: "no-store",
        redirect: "error",
        signal: AbortSignal.timeout(15_000),
      },
    );
    if (!synced.ok) throw new Error("Cannot reconcile existing test credit.");
    const balance = z
      .object({
        account: z.string(),
        balances: z.array(
          z.object({
            asset: z.string(),
            availableAmount: z.string().regex(/^\d+$/),
            pendingAmount: z.string().regex(/^\d+$/),
          }),
        ),
      })
      .parse(await synced.json());
    if (balance.account.toLowerCase() !== account.address.toLowerCase())
      throw new Error("Conflicting test-credit balance identity.");
    const native = balance.balances.find(
      (entry) => entry.asset.toLowerCase() === NATIVE_ASSET,
    );
    return native &&
      BigInt(native.availableAmount) > 0n &&
      BigInt(native.pendingAmount) === 0n
      ? { status: "not_needed" }
      : { status: "pending" };
  }
  const retryAfter = Number(response.headers.get("retry-after"));
  return {
    status: "refused",
    code: error.success ? error.data.error.code : `http_${response.status}`,
    ...(Number.isFinite(retryAfter) && retryAfter > 0
      ? { retryAfterSeconds: retryAfter }
      : {}),
  };
}
