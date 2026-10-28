import "server-only";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { createGatewayClient, CONTRACTS } from "@opendatalabs/vana-sdk";
import {
  createDefaultAccessRequestClient,
  parsePersonalServerPaymentRequired,
  readPersonalServerData,
  type AccessRequestClient,
  type PersonalServerFetch,
} from "@opendatalabs/vana-sdk/server";
import { privateKeyToAccount } from "viem/accounts";
import { parseEther, zeroAddress } from "viem";
import { ShelfStore, type Connection, type Thread } from "./store.js";
import {
  createShelfObserver,
  shelfReasons,
  type ShelfObserver,
  type ShelfObservation,
} from "./observability.js";

const SCOPE = "perplexity.conversations";
const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

export class DeliveryError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status = 409,
  ) {
    super(message);
  }
}

export interface DeliveryConfig {
  privateKey: `0x${string}`;
  environment: "dev" | "prod";
  approvalUrl: string;
  gatewayUrl: string;
  storageDirectory: string;
  allowPayment: boolean;
  maxFee?: string;
  maxTotal?: string;
  resumeRequestId?: string;
  observer?: ShelfObserver;
}

/** The selected connector emits a legacy envelope containing conversations records. */
function threadsFrom(data: unknown): Thread[] {
  const envelope = data as {
    scope?: unknown;
    data?: { conversations?: unknown };
  } | null;
  const records =
    envelope?.scope === SCOPE ? envelope.data?.conversations : undefined;
  if (!Array.isArray(records))
    throw new DeliveryError(
      "invalid_data",
      "The server did not return conversation records.",
      502,
    );
  const ids = new Set<string>();
  return records.map((record: unknown) => {
    if (
      !record ||
      typeof record !== "object" ||
      !("id" in record) ||
      typeof record.id !== "string" ||
      !record.id ||
      ids.has(record.id)
    ) {
      throw new DeliveryError(
        "invalid_data",
        "A conversation has a missing or duplicate ID.",
        502,
      );
    }
    const row = record as Record<string, unknown>;
    if (
      !(row.title === null || typeof row.title === "string") ||
      !(
        row.update_time === null ||
        (typeof row.update_time === "string" &&
          Number.isFinite(Date.parse(row.update_time)))
      )
    ) {
      throw new DeliveryError(
        "invalid_data",
        "A conversation has an invalid title or update time.",
        502,
      );
    }
    ids.add(record.id);
    return {
      id: record.id,
      title: row.title,
      updatedAt: row.update_time,
    } as Thread;
  });
}

/** Owns app-key reads, private persistence, bounded payment and delayed acknowledgement. */
export function createShelf(config: DeliveryConfig) {
  const account = privateKeyToAccount(config.privateKey);
  const gateway = createGatewayClient(config.gatewayUrl);
  const access: AccessRequestClient = createDefaultAccessRequestClient({
    baseUrl: config.approvalUrl,
    approvalBaseUrl: config.approvalUrl,
    env: config.environment === "dev" ? "dev" : "production",
    appAddress: account.address,
    signMessage: (message) => account.signMessage({ message }),
    fetchFn: async (url, init) => {
      const response = await fetch(url, {
        ...init,
        cache: "no-store",
        redirect: "error",
        signal: AbortSignal.timeout(30_000),
      });
      if (response.ok) {
        const body = await response.clone().json();
        if (body.network !== undefined && body.network !== "moksha")
          throw new DeliveryError(
            "network_refused",
            "This request belongs to a different network.",
            403,
          );
      }
      return response;
    },
  });
  const store = new ShelfStore(config.storageDirectory);
  const payments = new ShelfStore(`${config.storageDirectory}/payments`);
  interface PaymentLedger {
    format?: number;
    spent: string;
    payment?: { header: string; operation: string; amount: string };
    received?: {
      revision: string;
      receivedAt: string;
      body: unknown;
      paymentHeaderHash?: string;
    };
    history?: { header: string; operation: string; amount: string }[];
  }
  function paymentPolicy(amount: bigint, spent: bigint) {
    if (!config.allowPayment || !config.maxFee || !config.maxTotal)
      throw new DeliveryError(
        "payment_disabled",
        "Enable capped Moksha payments in the server configuration.",
        402,
      );
    if (
      amount > parseEther(config.maxFee) ||
      spent > parseEther(config.maxTotal)
    )
      throw new DeliveryError(
        "fee_cap_exceeded",
        "The test VANA fee exceeds the configured spending limit.",
        402,
      );
  }
  const uint = (value: string) =>
    /^(0|[1-9]\d*)$/.test(value) && BigInt(value) < 2n ** 256n;

  const observer = config.observer ?? createShelfObserver();
  interface ObservationContext {
    attempt: string;
    requestId?: string;
    grantId?: string;
    revision?: string;
  }
  function context(requestId?: string): ObservationContext {
    return { attempt: observer.attempt(), requestId };
  }
  async function observe(input: ShelfObservation) {
    try {
      await observer.observe(input);
    } catch {
      /* A local observer cannot change the operation's result. */
    }
  }
  function failureReason(
    error: unknown,
  ): NonNullable<ShelfObservation["reason"]> {
    if (
      error instanceof DeliveryError &&
      shelfReasons.some((reason) => reason === error.code)
    )
      return error.code as NonNullable<ShelfObservation["reason"]>;
    if (
      error instanceof Error &&
      (["TypeError", "AbortError", "TimeoutError"].includes(error.name) ||
        ("code" in error &&
          ["ECONNRESET", "ETIMEDOUT", "ECONNREFUSED", "EPIPE"].includes(
            String(error.code),
          )))
    )
      return "transport_error";
    if (
      error instanceof Error &&
      "status" in error &&
      typeof error.status === "number" &&
      error.status >= 400
    )
      return "http_error";
    return "unknown_error";
  }
  async function observed<T>(
    ctx: ObservationContext,
    boundary: ShelfObservation["boundary"],
    stage: ShelfObservation["stage"],
    run: () => Promise<T>,
    reason?: ShelfObservation["reason"],
  ): Promise<T> {
    const start = Date.now();
    await observe({ ...ctx, boundary, stage, outcome: "started", reason });
    try {
      const result = await run();
      await observe({
        ...ctx,
        boundary,
        stage,
        outcome: "ok",
        reason,
        durationMs: Date.now() - start,
      });
      return result;
    } catch (error) {
      const detected = failureReason(error);
      const reason =
        stage === "save"
          ? "save_failed"
          : stage === "ack" && detected === "unknown_error"
            ? "ack_failed"
            : detected;
      await observe({
        ...ctx,
        boundary,
        stage,
        outcome:
          stage === "read" && reason === "transport_error"
            ? "interrupted"
            : "failed",
        reason,
        durationMs: Date.now() - start,
      });
      throw error;
    }
  }
  async function paymentAttempt(
    ctx: ObservationContext,
    send: () => Promise<Response>,
  ) {
    const start = Date.now();
    await observe({
      ...ctx,
      boundary: "personal-server",
      stage: "payment",
      outcome: "started",
    });
    try {
      const response = await send();
      await observe({
        ...ctx,
        boundary: "personal-server",
        stage: "payment",
        outcome: response.ok ? "ok" : "failed",
        status: response.status,
        reason: response.ok ? undefined : "http_error",
        durationMs: Date.now() - start,
      });
      return response;
    } catch (error) {
      await observe({
        ...ctx,
        boundary: "personal-server",
        stage: "payment",
        outcome: "interrupted",
        reason: failureReason(error),
        durationMs: Date.now() - start,
      });
      throw error;
    }
  }
  async function approval(ctx: ObservationContext, requestId: string) {
    return observed(ctx, "approval", "approval", async () => {
      const result = await access.getAccessRequestStatus(requestId);
      ctx.grantId = result.grantId ?? ctx.grantId;
      const reason = shelfReasons.find((reason) => reason === result.status);
      await observe({
        ...ctx,
        boundary: "approval",
        stage: "approval",
        outcome: "ok",
        reason,
      });
      return result;
    });
  }

  async function connection(token: string): Promise<Connection> {
    const state = await store.read(token);
    if (
      !state ||
      !same(state.appAddress, account.address) ||
      state.environment !== config.environment
    ) {
      throw new DeliveryError(
        "connection_required",
        "Connect this browser with Vana first.",
        401,
      );
    }
    return state;
  }

  async function liveBinding(
    state: Connection,
    requireCompleted = false,
    ctx = context(state.requestId),
  ) {
    const status = await approval(ctx, state.requestId);
    if (!["approved", "ready_for_read", "completed"].includes(status.status)) {
      throw new DeliveryError(
        "approval_required",
        `The request is ${status.status}. Review access in Vana.`,
      );
    }
    if (requireCompleted && status.status !== "completed")
      throw new DeliveryError(
        "delivery_incomplete",
        "Confirm the original delivery before reading latest.",
      );
    const binding = state.binding;
    const grantId = binding?.grantId ?? status.grantId;
    const serverUrl = binding?.serverUrl ?? status.personalServerUrl;
    if (
      !grantId ||
      !serverUrl ||
      ((!binding || status.status !== "completed") &&
        !status.scopes?.includes(SCOPE)) ||
      (status.grantId && status.grantId !== grantId) ||
      (status.personalServerUrl && status.personalServerUrl !== serverUrl)
    ) {
      throw new DeliveryError(
        "approval_required",
        "The approved conversations or server binding are unavailable.",
      );
    }
    const [grant, builder] = await Promise.all([
      gateway.getGrant(grantId),
      gateway.getBuilder(account.address),
    ]);
    if (
      !grant ||
      !builder ||
      !same(grant.granteeId, builder.id) ||
      grant.revokedAt ||
      grant.expired ||
      (grant.expiresAt && Date.parse(grant.expiresAt) <= Date.now()) ||
      !grant.scopes.includes(SCOPE) ||
      (binding && !same(binding.owner, grant.grantorAddress))
    ) {
      throw new DeliveryError(
        "grant_invalid",
        "This app's grant is missing, expired, revoked or does not cover conversations.",
        403,
      );
    }
    const url = new URL(serverUrl);
    if (
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      url.pathname !== "/" ||
      url.search ||
      url.hash
    ) {
      throw new DeliveryError(
        "server_invalid",
        "The approved server URL is invalid.",
        403,
      );
    }
    const servers = await gateway.listServersByOwner(grant.grantorAddress);
    if (
      !servers.active.some(
        (server) =>
          same(server.ownerAddress, grant.grantorAddress) &&
          server.serverUrl.replace(/\/$/, "") === url.origin,
      )
    ) {
      throw new DeliveryError(
        "server_invalid",
        "The approved server is no longer registered to the data owner.",
        403,
      );
    }
    ctx.grantId = grantId;
    state.binding = {
      grantId,
      owner: grant.grantorAddress,
      serverUrl: url.origin,
    };
    return grant;
  }

  return {
    async connect(
      createRequest: () => Promise<{
        requestId: string;
        [key: string]: unknown;
      }>,
    ) {
      const ctx = context(config.resumeRequestId);
      const request = await observed(
        ctx,
        "approval",
        "approval",
        async () => {
          const created = config.resumeRequestId
            ? {
                requestId: config.resumeRequestId,
                approvalUrl: `${config.approvalUrl}/data-connection-requests/${config.resumeRequestId}?mode=page`,
                expiresAt: new Date(Date.now() + 300_000).toISOString(),
              }
            : await createRequest();
          if (!/^dcr_[a-z0-9_-]+$/i.test(created.requestId))
            throw new DeliveryError(
              "invalid_request",
              "Invalid access request.",
            );
          ctx.requestId = created.requestId;
          return created;
        },
        "request_created",
      );
      const token = randomBytes(32).toString("hex");
      const state: Connection = {
        requestId: request.requestId,
        appAddress: account.address,
        environment: config.environment,
      };
      if (config.resumeRequestId) await liveBinding(state, false, ctx);
      await observed(ctx, "consumer", "save", () => store.save(token, state));
      return { token, request };
    },
    async status(token: string, requestId: string) {
      const state = await connection(token);
      if (requestId !== state.requestId)
        throw new DeliveryError(
          "invalid_request",
          "This request does not belong to this browser.",
          403,
        );
      return approval(context(state.requestId), state.requestId);
    },
    async snapshot(token: string) {
      const state = await connection(token);
      await observe({
        ...context(state.requestId),
        grantId: state.binding?.grantId,
        revision: state.saved?.revision,
        boundary: "consumer",
        stage: "reload",
        outcome: state.saved ? "ok" : "unknown",
      });
      return {
        saved: state.saved,
        acknowledged:
          !!state.saved && state.acknowledged === state.saved.revision,
      };
    },
    async read(token: string, requestId?: string) {
      const ctx = context(requestId);
      return store.exclusive(token, async () => {
        const state = await connection(token);
        ctx.requestId = state.requestId;
        ctx.grantId = state.binding?.grantId;
        if (requestId && requestId !== state.requestId)
          throw new DeliveryError(
            "invalid_request",
            "This request does not belong to this browser.",
            403,
          );
        // A lost response can be recovered without another paid read.
        if (requestId && state.saved)
          return { scope: SCOPE, data: state.saved };
        // Recover a saved response lost in transport before attempting another paid read.
        if (
          !requestId &&
          state.saved &&
          state.acknowledged !== state.saved.revision
        )
          return { scope: SCOPE, data: state.saved };
        if (
          !requestId &&
          (!state.saved || state.acknowledged !== state.saved.revision)
        )
          throw new DeliveryError(
            "delivery_incomplete",
            "Save, display and confirm the initial delivery before reading latest.",
          );
        const grant = await liveBinding(state, !requestId, ctx);
        await store.save(token, state);
        const binding = state.binding!;
        const ledgerKey = createHash("sha256")
          .update(
            JSON.stringify([
              account.address.toLowerCase(),
              config.environment,
              binding.owner.toLowerCase(),
              binding.grantId.toLowerCase(),
              SCOPE,
            ]),
          )
          .digest("hex");
        return payments.exclusive(ledgerKey, async () => {
          const ledger = (await payments.read<PaymentLedger>(ledgerKey)) ?? {
            format: 2,
            spent: "0",
          };
          if (ledger.format !== undefined && ledger.format !== 2)
            throw new DeliveryError(
              "storage_version",
              "This payment store needs a compatible demo version.",
            );
          if (ledger.format === undefined) {
            // BUI-931 had no fresh-read endpoint: an acknowledged saved revision
            // matching its received body proves which existing header delivered it.
            if (
              ledger.payment &&
              ledger.received &&
              state.saved?.revision === ledger.received.revision &&
              state.acknowledged === state.saved.revision &&
              JSON.stringify(state.saved.threads) ===
                JSON.stringify(threadsFrom(ledger.received.body))
            ) {
              ledger.received.paymentHeaderHash = createHash("sha256")
                .update(ledger.payment.header)
                .digest("hex");
            }
            if (!ledger.received || ledger.received.paymentHeaderHash) {
              ledger.format = 2;
              await payments.save(ledgerKey, ledger);
            }
          }
          async function saveReceived() {
            const received = ledger.received!;
            state.saved = {
              revision: received.revision,
              savedAt: received.receivedAt,
              threads: threadsFrom(received.body),
            };
            ctx.revision = state.saved.revision;
            await observed(ctx, "consumer", "save", () =>
              store.save(token, state),
            );
            return { scope: SCOPE, data: state.saved };
          }
          // Recover a delivered body after decoder/save failure without another paid read.
          if (
            ledger.received &&
            (requestId || ledger.received.revision !== state.saved?.revision)
          )
            return saveReceived();
          const previousDelivered =
            !!ledger.payment &&
            ledger.received?.paymentHeaderHash ===
              createHash("sha256").update(ledger.payment.header).digest("hex");
          let challengeOperation: string | undefined;
          const fetchRead: PersonalServerFetch = async (input, init) => {
            const headers = { ...init.headers };
            const outgoing = headers["X-PAYMENT"];
            if (outgoing) {
              if (!challengeOperation)
                throw new DeliveryError(
                  "payment_invalid",
                  "Payment has no validated challenge.",
                  402,
                );
              const payment = JSON.parse(
                Buffer.from(outgoing, "base64").toString("utf8"),
              );
              const amount: string = payment.payload.message.amount;
              if (ledger.payment) (ledger.history ??= []).push(ledger.payment);
              ledger.payment = {
                header: outgoing,
                operation: challengeOperation,
                amount,
              };
              ledger.spent = (BigInt(ledger.spent) + BigInt(amount)).toString();
              // Persist before transmission: an uncertain response must not authorize another fee.
              await payments.save(ledgerKey, ledger);
            } else if (ledger.payment && (requestId || !previousDelivered)) {
              paymentPolicy(
                BigInt(ledger.payment.amount),
                BigInt(ledger.spent),
              );
              headers["X-PAYMENT"] = ledger.payment.header;
            }
            const send = () =>
              fetch(input, {
                ...init,
                headers,
                signal: AbortSignal.timeout(30_000),
                cache: "no-store",
                redirect: "error",
              });
            const response = headers["X-PAYMENT"]
              ? await paymentAttempt(ctx, send)
              : await send();
            if (response.status === 402) {
              const required = await parsePersonalServerPaymentRequired(
                response.clone(),
                binding.grantId,
              );
              if (
                required.network !== "vana:14800" ||
                required.opType !== "grant" ||
                !same(required.asset, zeroAddress) ||
                !uint(required.amount) ||
                required.grantId !== binding.grantId
              )
                throw new DeliveryError(
                  "payment_invalid",
                  "The payment challenge does not match this Moksha grant and native VANA asset.",
                  402,
                );
              const raw = required.raw as
                | {
                    accepts?: { message?: { payerAddress?: string } }[];
                    payerAddress?: string;
                  }
                | undefined;
              const payer =
                raw?.accepts?.find((offer) => offer.message?.payerAddress)
                  ?.message?.payerAddress ?? raw?.payerAddress;
              if (payer && !same(payer, account.address))
                throw new DeliveryError(
                  "payment_invalid",
                  "The challenge names a different paying app.",
                  402,
                );
              const amount = BigInt(required.amount);
              paymentPolicy(amount, BigInt(ledger.spent) + amount);
              const operation = `${required.opId}:${required.accessRecord?.dataPointId ?? ""}:${required.accessRecord?.version ?? ""}`;
              if (
                ledger.payment &&
                (outgoing || requestId || !previousDelivered)
              )
                throw new DeliveryError(
                  "payment_unconfirmed",
                  "The previous payment is unconfirmed. Its receipt is retained; no new payment was authorized.",
                  402,
                );
              const balance = await gateway.getEscrowBalance(account.address);
              const available =
                balance.balances.find((entry) => same(entry.asset, zeroAddress))
                  ?.availableAmount ?? "0";
              if (!uint(available) || BigInt(available) < amount)
                throw new DeliveryError(
                  "funding_required",
                  "The app needs more finalized Moksha escrow funds.",
                  402,
                );
              if (
                !same(grant.fee.asset, zeroAddress) ||
                !uint(grant.fee.totalDue) ||
                amount > BigInt(grant.fee.totalDue)
              )
                throw new DeliveryError(
                  "fee_quote_changed",
                  "The challenge exceeds the gateway's current grant fee quote.",
                  402,
                );
              challengeOperation = operation;
            }
            return response;
          };
          const result = await observed(ctx, "personal-server", "read", () =>
            readPersonalServerData({
              personalServerUrl: binding.serverUrl,
              scope: SCOPE,
              grantId: binding.grantId,
              payerAddress: account.address,
              signMessage: (message) => account.signMessage({ message }),
              escrow: {
                chainId: 14800,
                escrowContract:
                  CONTRACTS.DataPortabilityEscrow.addresses[14800],
                signTypedData: (typed) =>
                  account.signTypedData(
                    typed as Parameters<typeof account.signTypedData>[0],
                  ),
              },
              fetchFn: fetchRead,
              transportRetry: { attempts: 1 },
            }),
          );
          ledger.received = {
            revision: randomUUID(),
            receivedAt: new Date().toISOString(),
            body: result.data,
            paymentHeaderHash: ledger.payment
              ? createHash("sha256").update(ledger.payment.header).digest("hex")
              : undefined,
          };
          await payments.save(ledgerKey, ledger);
          return saveReceived();
        });
      });
    },
    async acknowledge(token: string, revision: string) {
      const ctx = context();
      ctx.revision = revision;
      return observed(ctx, "consumer", "ack", () =>
        store.exclusive(token, async () => {
          const state = await connection(token);
          ctx.requestId = state.requestId;
          ctx.grantId = state.binding?.grantId;
          if (!state.saved || state.saved.revision !== revision)
            throw new DeliveryError(
              "save_required",
              "Save and display this result before confirming it.",
            );
          if (state.acknowledged === revision) return;
          await access.acknowledgeRead!(state.requestId);
          state.acknowledged = revision;
          await store.save(token, state);
        }),
      );
    },
  };
}
